// The remaining routes: API keys act as their maker, the external API stays
// inside that person's scope, channels never leak their secrets, and the role
// gates on systems, channels and keys hold.
import assert from "node:assert/strict"
import { freshSql } from "./sqlite"
import { sqlClient } from "../server/fleet/db"
import { scopeOf } from "../server/fleet/access"
import * as ops from "../server/fleet/ops"
import * as external from "../server/fleet/external"
import { mintEnrollment } from "../server/fleet/enroll"

// No network from a check: Slack answers as it would to a token it doesn't know.
const realFetch = globalThis.fetch
globalThis.fetch = (async (url: any, init?: any) => {
  if (String(url).includes("slack.com")) return new Response(JSON.stringify({ ok: false, error: "invalid_auth" }), { headers: { "content-type": "application/json" } })
  throw new Error(`unexpected network call in a check: ${url}`)
}) as typeof fetch

const sql = freshSql()
const db = sqlClient(sql)
await db.from("members").insert([{ user_id: "owner", role: "owner" }, { user_id: "mgr", role: "manager" }, { user_id: "viewer", role: "viewer" }])
const mkSys = async (name: string) => (await db.from("systems").insert({ user_id: "owner", name, slug: name, key_hash: `kh-${name}`, last_seen: new Date().toISOString() }).select("id").single()).data.id
const A = await mkSys("a")
const B = await mkSys("b")
const state = async (system_id: string, unique_id: string, type: string, data: any = {}) =>
  (await db.from("client_states").insert({ system_id, unique_id, type, data }).select("id").single()).data.id
const aOs = await state(A, "os", "os", { hostname: "a" })
await state(A, "pm2-api-0", "pm2", { name: "api", pm_id: 0, monit: { cpu: 1 } })
await state(A, "pm2-api-1", "pm2", { name: "api", pm_id: 1, monit: { cpu: 3 } })
const bWeb = await state(B, "web-shop", "web", { name: "shop", duration: 80 })
await db.from("grants").insert({ resource_type: "system", resource_id: B, grantee_email: "g@x.test", grantee_id: "grantee", role: "viewer" })

const ctx = async (sub: string | null): Promise<ops.OpCtx> => {
  const who = sub ? { sub, email: null, emailVerified: false } : null
  const scope = who ? await scopeOf(db, who) : null
  return { db, sql, env: { APP_URL: "https://daemonitor.test/app" }, who, scope, role: scope?.all ? scope.role : null }
}
const [owner, mgr, viewer, grantee] = await Promise.all(["owner", "mgr", "viewer", "grantee"].map(ctx))

// API keys: shown once, stored hashed, act as their maker, and die with their access
await assert.rejects(ops.createKey(viewer, { name: "x", permissions: ["read", "manage"] }), /manager or above/)
const { apiKey } = await ops.createKey(grantee, { name: "portal" })
assert.equal(apiKey.key.length, 48)
const { data: stored } = await db.from("api_keys").select("key_hash").eq("id", apiKey.id).single()
assert.notEqual(stored.key_hash, apiKey.key)
assert.equal((await ops.identifyKey(db, apiKey.key, "read")).sub, "grantee")
await assert.rejects(ops.identifyKey(db, apiKey.key, "manage"), /Insufficient permissions/)
await assert.rejects(ops.identifyKey(db, "nope", "read"), /Unauthorized/)
assert.equal((await ops.listKeys(owner)).apiKeys.length, 0, "keys are each person's own")

// the external API, as the grantee's key: system B only
const gScope = grantee.scope!
assert.deepEqual((await external.fleet(db, gScope)).systems.map((s: any) => s.name), ["b"])
await assert.rejects(external.fleetSystem(db, gScope, A), /System not found/)
assert.equal((await external.systems(db, gScope))[0].key_hash, undefined, "no key hashes")
assert.deepEqual((await external.history(db, gScope, A, aOs, 10)).points, [], "a service outside the scope reads as empty")
const all = await external.fleet(db, owner.scope!)
const sysA = all.systems.find((s: any) => s.name === "a")
assert.equal(sysA.services.filter((s: any) => s.plugins.includes("pm2")).length, 1, "pm2 instances combined")

// incidents for the portal: opted in, naming a visible system, client-visible entries only
const started = new Date(Date.now() - 3_600_000).toISOString()
const inc = async (title: string, system: string, client_visible: boolean) => {
  const { data } = await db.from("incidents").insert({ user_id: "owner", title, started_at: started, client_visible }).select("id").single()
  await db.from("incident_targets").insert({ incident_id: data.id, target_type: "system", target_id: system, system_id: system })
  return data.id
}
const shown = await inc("b outage", B, true)
await inc("b internal", B, false)
await inc("a outage", A, true)
await db.from("incident_entries").insert([
  { incident_id: shown, kind: "status", body: "fixed", client_visible: true, author_id: "mgr" },
  { incident_id: shown, kind: "note", body: "root cause was me", client_visible: false },
])
const portal = await external.incidents(db, gScope, {})
assert.deepEqual(portal.incidents.map((i: any) => i.title), ["b outage"])
assert.deepEqual(portal.incidents[0].updates.map((u: any) => u.body), ["fixed"])
assert.ok(!JSON.stringify(portal).includes("mgr"), "author ids never leave")

// enrolling with a manage key needs a manager behind it
await assert.rejects(mintEnrollment(db, grantee.who!, {}, "https://t.test"), /owner or manager/)

// the agent's monitor feed, by system key
const sysKey = "agent-key-a"
await db.from("systems").update({ key_hash: await (await import("../server/fleet/keys")).hashKey(sysKey) }).eq("id", A)
await db.from("web_monitors").insert([
  { user_id: "owner", system_id: A, name: "shop", url: "https://shop.test", config: { expectedStrings: ["Cart"] } },
  { user_id: "owner", system_id: A, name: "off", url: "https://off.test", enabled: false },
])
assert.deepEqual((await ops.monitorsForClient(await ctx(null), { key: sysKey })).endpoints.map((e: any) => [e.name, e.expectedStrings]), [["shop", ["Cart"]]])
await assert.rejects(ops.monitorsForClient(await ctx(null), { key: "wrong" }), /System not found/)

// read marks stay inside the scope
await db.from("notifications").insert([
  { user_id: "owner", system_id: A, title: "a", message: "a", type: "error", source: "x", source_detail: "a" },
  { user_id: "owner", system_id: B, title: "b", message: "b", type: "error", source: "x", source_detail: "b" },
])
assert.equal((await ops.markRead(grantee, { all: true })).modifiedCount, 2 - 1, "the grantee marks only system B's")

// systems: managers change them, viewers don't
await assert.rejects(ops.createSystem(viewer, { name: "x" }), /manager or above/)
const made = await ops.createSystem(mgr, { name: "new box" })
assert.equal(made.key.length, 48)
await ops.archiveService(mgr, { id: (await db.from("client_states").select("id").eq("unique_id", "pm2-api-0").single()).data.id })
assert.equal((await db.from("client_states").select("id").eq("type", "pm2").eq("archived", true)).data.length, 2, "both instances of the process")
const hidden = await ops.archivable(mgr, { archived: true })
assert.deepEqual(hidden.services.map((s: any) => [s.name, s.count]), [["api", 2]])

// channels: each person's own, secrets never returned, Slack token never writable
const hook = await ops.addWebhook(mgr, { url: "https://hooks.example.com/alerts" })
assert.match(hook.secret, /^whsec_/)
await ops.connectSlack(mgr, { teamId: "T1", teamName: "Acme", botToken: "xoxb-not-real" })
const listed = await ops.listChannels(mgr)
assert.equal(listed.channels.length, 2)
assert.ok(!JSON.stringify(listed).includes("xoxb") && !JSON.stringify(listed).includes("whsec"), "no secrets in the list")
await assert.rejects(ops.updateChannel(owner, { id: hook.id, enabled: false }), /Channel not found/, "not yours")
const slack = listed.channels.find((c: any) => c.kind === "slack")
await ops.updateChannel(mgr, { id: slack.id, channelId: "C9", channelName: "ops", config: { bot_token: "xoxb-evil" } })
const { data: kept } = await db.from("notification_channels").select("config, label").eq("id", slack.id).single()
assert.equal(kept.config.bot_token, "xoxb-not-real", "the token isn't writable")
assert.equal(kept.label, "#ops · Acme")
await assert.rejects(ops.connectSlack(mgr, { teamId: "T1", botToken: "not-a-bot-token" }), /bot token/)
await ops.connectSlack(mgr, { teamId: "T1", teamName: "Acme", botToken: "xoxb-rotated" })
assert.equal((await db.from("notification_channels").select("config").eq("id", slack.id).single()).data.config.channel_id, "C9", "reconnecting keeps the channel")
await ops.deleteChannel(mgr, { id: hook.id })
assert.equal((await ops.listChannels(mgr)).channels.length, 1)

globalThis.fetch = realFetch
console.log("ops.check: ok")
