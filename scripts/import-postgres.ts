/**
 * Copy one account's fleet from the Postgres database into its tenant.
 *
 *   TENANT_SIGNING_JWK='{...}' pnpm exec tsx scripts/import-postgres.ts \
 *     --owner <user uuid> --tenant https://fleet.example.com [--claim <code>] [--only systems,groups] [--skip history]
 *
 * Read-only on Postgres: it runs `select row_to_json(...)` through PSQL (default:
 * psql on the Patroni leader over ssh, via frontend/scripts/ops/_ops.sh) and
 * streams the rows to the tenant's owner-only /api/tenant/import in batches.
 * Each table is emptied on its first batch, so a rerun replaces, never doubles.
 *
 * It signs its own owner tokens with TENANT_SIGNING_JWK (daemonitor.com's key),
 * issuer DAEMONITOR_ISSUER (default https://daemonitor.com). The tenant must be
 * claimed by the owner: --claim <CLAIM_CODE> does that first on a fresh one.
 *
 * Organisations and account shares become members; system and group shares
 * become grants. Push devices aren't fleet data (daemonitor.com keeps them).
 */
import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { parseArgs } from "node:util"
import { COLUMNS } from "../server/fleet/schema"

const { values: o } = parseArgs({ options: { owner: { type: "string" }, tenant: { type: "string" }, only: { type: "string" }, skip: { type: "string" }, claim: { type: "string" } } })
const U = o.owner || ""
if (!/^[0-9a-f-]{36}$/.test(U) || !o.tenant) throw new Error("usage: --owner <uuid> --tenant <origin> [--only a,b] [--skip a,b]")
const TENANT = new URL(o.tenant).origin
const ISS = (process.env.DAEMONITOR_ISSUER || "https://daemonitor.com").replace(/\/$/, "")
const PSQL = process.env.PSQL || `bash -c '. ${new URL("../../frontend/scripts/ops/_ops.sh", import.meta.url).pathname} && psql_leader daemonitor -tA -v FETCH_COUNT=2000'`
const BATCH_BYTES = 4_000_000

const S = `(select id from systems where user_id = '${U}')`
const G = `(select id from groups where user_id = '${U}')`
const C = `(select id from clusters where user_id = '${U}')`
const I = `(select id from incidents where user_id = '${U}')`
const rows = (from: string) => `select row_to_json(t)::text from ${from} t`

// Order matters only for reading the output: the biggest goes last.
const TABLES: [string, string][] = [
  ["systems", `${rows("systems")} where user_id = '${U}'`],
  ["client_states", `${rows("client_states")} where system_id in ${S}`],
  ["cf_zone_daily", `${rows("cf_zone_daily")} where system_id in ${S}`],
  ["notifications", `${rows("notifications")} where system_id in ${S} or (system_id is null and user_id = '${U}')`],
  ["events", `${rows("events")} where system_id in ${S} or user_id = '${U}'`],
  ["groups", `${rows("groups")} where user_id = '${U}'`],
  ["group_members", `${rows("group_members")} where group_id in ${G}`],
  ["clusters", `${rows("clusters")} where user_id = '${U}'`],
  ["cluster_members", `${rows("cluster_members")} where cluster_id in ${C}`],
  ["cluster_services", `${rows("cluster_services")} where cluster_id in ${C}`],
  ["cluster_service_history", `${rows("cluster_service_history")} where cluster_service_id in (select id from cluster_services where cluster_id in ${C})`],
  ["incidents", `${rows("incidents")} where user_id = '${U}'`],
  ["incident_targets", `${rows("incident_targets")} where incident_id in ${I}`],
  ["incident_entries", `${rows("incident_entries")} where incident_id in ${I}`],
  ["web_monitors", `${rows("web_monitors")} where user_id = '${U}'`],
  ["views", `${rows("views")} where user_id = '${U}'`],
  ["enrollment_tokens", `${rows("enrollment_tokens")} where user_id = '${U}'`],
  ["api_keys", `${rows("api_keys")} where user_id = '${U}'`],
  ["notification_channels", `${rows("notification_channels")} where user_id = '${U}'`],
  ["members", `select json_build_object('id', g.id, 'user_id', g.grantee_id, 'email', lower(g.grantee_email), 'role', g.role, 'created_at', g.created_at)::text
               from share_grants g where g.resource_type = 'account' and g.resource_id::text = '${U}'
               union all
               select json_build_object('id', gen_random_uuid(), 'user_id', m.user_id, 'email', lower(u.email), 'role', case when m.role in ('owner', 'admin') then 'manager' else 'viewer' end, 'created_at', m.created_at)::text
               from organization_members m join organizations o on o.id = m.org_id join auth.users u on u.id = m.user_id
               where o.created_by = '${U}' and m.user_id != '${U}'`],
  ["grants", `select json_build_object('id', id, 'resource_type', resource_type, 'resource_id', resource_id, 'grantee_email', lower(grantee_email), 'grantee_id', grantee_id, 'role', role, 'created_at', created_at)::text
              from share_grants where owner_id = '${U}' and resource_type in ('system', 'group')`],
  ["client_state_history", `${rows("client_state_history")} where system_id in ${S}`],
]

const b64url = (b: Uint8Array | string) => Buffer.from(typeof b === "string" ? new TextEncoder().encode(b) : b).toString("base64url")
const jwk = JSON.parse(process.env.TENANT_SIGNING_JWK || "null")
if (!jwk?.d || !jwk?.kid) throw new Error("Set TENANT_SIGNING_JWK to daemonitor.com's Ed25519 private JWK")
const key = await crypto.subtle.importKey("jwk", { kty: jwk.kty, crv: jwk.crv, x: jwk.x, d: jwk.d }, { name: "Ed25519" }, false, ["sign"])

let ownerEmail = ""
async function token() {
  const now = Math.floor(Date.now() / 1000)
  const head = b64url(JSON.stringify({ alg: "EdDSA", typ: "JWT", kid: jwk.kid }))
  const body = b64url(JSON.stringify({ iss: ISS, aud: TENANT, sub: U, email: ownerEmail, email_verified: true, iat: now, exp: now + 300 }))
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key, new TextEncoder().encode(`${head}.${body}`)))
  return `${head}.${body}.${b64url(sig)}`
}

/** Lines from one query, as they arrive. */
async function* query(sql: string): AsyncGenerator<string> {
  const p = spawn(PSQL, { shell: true, stdio: ["pipe", "pipe", "inherit"] })
  p.stdin.end(sql + ";\n")
  for await (const line of createInterface({ input: p.stdout })) if (line.trim()) yield line
  const code = await new Promise<number | null>((r) => (p.exitCode !== null ? r(p.exitCode) : p.on("close", r)))
  if (code) throw new Error(`psql exited ${code}`)
}

/** Postgres writes "2026-11-04 12:00:00.123456+00"; the tenant stores Date.toISOString(). */
function normalise(table: string, row: Record<string, any>) {
  for (const [k, kind] of Object.entries(COLUMNS[table])) {
    if (kind === "ts" && typeof row[k] === "string") row[k] = new Date(row[k]).toISOString()
  }
  return row
}

async function send(table: string, batch: object[], reset: boolean) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${TENANT}/api/tenant/import`, {
      method: "POST",
      headers: { authorization: `Bearer ${await token()}`, "content-type": "application/json" },
      body: JSON.stringify({ table, rows: batch, reset }),
    }).catch((e) => ({ ok: false, status: 0, text: async () => String(e) }) as const)
    if (res.ok) return
    const text = await res.text()
    if (attempt >= 3 || (res.status >= 400 && res.status < 500)) throw new Error(`${table}: ${res.status} ${text.slice(0, 300)}`)
    await new Promise((r) => setTimeout(r, 2000 * attempt))
  }
}

for await (const line of query(`select email from auth.users where id = '${U}'`)) ownerEmail = line.trim()
if (!ownerEmail) throw new Error(`No user ${U}`)
console.log(`${ownerEmail} -> ${TENANT}`)

if (o.claim) {
  const res = await fetch(`${TENANT}/api/tenant/claim`, {
    method: "POST",
    headers: { authorization: `Bearer ${await token()}`, "content-type": "application/json" },
    body: JSON.stringify({ code: o.claim }),
  })
  console.log(`claim: ${res.status} ${(await res.text()).slice(0, 200)}`)
}

const only = o.only?.split(",")
const skip = o.skip?.split(",") || []
for (const [table, sql] of TABLES) {
  if ((only && !only.includes(table)) || skip.includes(table)) continue
  const started = Date.now()
  let batch: object[] = []
  let bytes = 0
  let total = 0
  let first = true
  for await (const line of query(sql)) {
    batch.push(normalise(table, JSON.parse(line)))
    bytes += line.length
    if (bytes >= BATCH_BYTES) {
      await send(table, batch, first)
      total += batch.length
      first = false
      batch = []
      bytes = 0
      process.stdout.write(`\r${table}: ${total}`)
    }
  }
  if (batch.length || first) await send(table, batch, first)
  total += batch.length
  console.log(`\r${table}: ${total} rows in ${((Date.now() - started) / 1000).toFixed(1)}s`)
}
