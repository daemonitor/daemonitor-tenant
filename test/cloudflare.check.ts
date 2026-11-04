// The ported Cloudflare push on real SQLite: per-resource rows and alerts,
// inventory reconciliation, carried-over worker metadata, and the zone's
// daily rows with probes kept apart from traffic.
import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"
import { migrate } from "../server/fleet/schema"
import { sqlClient } from "../server/fleet/db"
import { cloudflarePush } from "../server/fleet/cloudflare"
import { hashKey } from "../server/fleet/keys"

const raw = new DatabaseSync(":memory:")
const sql = {
  exec(q: string, ...args: any[]) {
    const rows = raw.prepare(q).all(...args) as any[]
    return { toArray: () => rows, one: () => rows[0] }
  },
} as unknown as SqlStorage
migrate(sql)
const db = sqlClient(sql)
const ctx = { push: async () => {} }

const KEY = "sk_test_cf"
const { data: sys } = await db.from("systems").insert({
  user_id: "owner", name: "HERETIC", slug: "heretic", key_hash: await hashKey(KEY),
}).select("id").single()

const push = (body: any, headers: Record<string, string> = { authorization: `Bearer ${KEY}` }) =>
  cloudflarePush(db, ctx, { headers, alias: null, body: { account: "acct1", alias: "cloudflare", timestamp: new Date().toISOString(), ...body }, clientIp: null })
const open = async () =>
  (await db.from("notifications").select("source, source_detail, type").is("resolved_at", null).order("source_detail")).data
const state = async (uid: string) =>
  (await db.from("client_states").select("status, status_reason, archived, data").eq("unique_id", uid).maybeSingle()).data

// auth and validation
await assert.rejects(push({}, {}), /Missing or invalid reporting key/)
await assert.rejects(cloudflarePush(db, ctx, { headers: { authorization: `Bearer ${KEY}` }, alias: null, body: { account: "a" }, clientIp: null }), /missing required fields/)
// the X-System-Key fallback works too
await push({}, { "x-system-key": KEY })

const today = new Date().toISOString().slice(0, 10)
const zone = (status: string, extra: any = {}) => ({
  id: "z1", name: "example.com", status,
  detailedAnalytics: { timeseries: [{ timestamp: `${today}T00:00:00Z`, requests: 100, bandwidth: 5, threats: 1, uniques: 9 }] },
  ...extra,
})
const workers = (byScript: any[], scripts: any[] = []) => ({ summary: {}, scripts, byScript })
const inventory = (scripts: string[]) => ({ workers: { complete: true, scripts } })

// push 1: a failed Pages build, a pending zone, a worker erroring now, and a
// worker in this shard carrying its deployments
await push({
  pages: { projects: [{ id: "p1", name: "site", latest_deployment: { status: "failure", stages: [{ name: "build", status: "failure" }] } }] },
  domains: [zone("pending", { probes: { total: 7, cms: 2, served: 1, paths: ["/wp-login.php"] } })],
  workers: workers(
    [{ script: "api", requests: 10, errors: 3, recentRequests: 5, recentErrors: 2 }, { script: "cron", requests: 1, errors: 0 }],
    [{ id: "cron", recent_deployments: [{ id: "d1" }], usage: { model: "standard" } }],
  ),
  inventory: inventory(["api", "cron", "idle"]),
})
assert.deepEqual((await open()).map((r: any) => `${r.source}|${r.source_detail}|${r.type}`), [
  "cloudflare-project|cf-pages:p1|warning",
  "cloudflare-domain|cf-zone:z1|warning",
  "cloudflare|cf-acct1-cloudflare|warning",
].sort((a, b) => a.split("|")[1].localeCompare(b.split("|")[1])))
assert.equal((await state("cf-worker-script-api")).status, "warning")
assert.equal((await state("cf-worker-script-idle")).data.script.requests, 0, "idle worker seeded from inventory")
assert.equal((await state("cf-domain-z1")).status, "warning")

// the daily row keeps traffic and probes side by side
const { data: day } = await db.from("cf_zone_daily").select("requests, probes, probe_paths").eq("unique_id", "cf-domain-z1").single()
assert.equal(day.requests, 100)
assert.equal(day.probes, 7)
assert.deepEqual(day.probe_paths, ["/wp-login.php"])

// push 2: everything healthy; cron is outside this shard so its deployments
// carry over; "idle" was deleted at Cloudflare and is retired
await push({
  pages: { projects: [{ id: "p1", name: "site", latest_deployment: { status: "success", stages: [] } }] },
  domains: [zone("active")],
  workers: workers([{ script: "api", requests: 20, errors: 3, recentRequests: 9, recentErrors: 0 }, { script: "cron", requests: 2, errors: 0 }]),
  inventory: inventory(["api", "cron"]),
})
assert.deepEqual(await open(), [], "everything resolved")
assert.equal((await state("cf-worker-script-api")).status, "online")
const cron = await state("cf-worker-script-cron")
assert.deepEqual(cron.data.script.recent_deployments, [{ id: "d1" }], "deployments carried over")
assert.deepEqual(cron.data.script.usage, { model: "standard" })
const idle = await state("cf-worker-script-idle")
assert.equal(idle.archived, true)
assert.equal(idle.status, "retired")

// push 3: "idle" is back at Cloudflare and comes back to life
await push({ workers: workers([]), inventory: inventory(["api", "cron", "idle"]) })
assert.equal((await state("cf-worker-script-idle")).archived, false)

// the second push's traffic for today replaced the first, without nulling probes
const { data: day2 } = await db.from("cf_zone_daily").select("requests, probes").eq("unique_id", "cf-domain-z1").single()
assert.equal(day2.probes, 7)

const { data: s } = await db.from("systems").select("last_seen, os").eq("id", sys.id).single()
assert.ok(s.last_seen)
assert.equal(s.os.name, "Cloudflare")

console.log("cloudflare.check: ok")
