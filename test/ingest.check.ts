// The ported ingest on real SQLite: a fault alerts once on its second report,
// stays deduped while it holds, and resolves when it clears. Findings open one
// alert each and close when the service stops reporting them.
import assert from "node:assert/strict"
import { sqlClient } from "../server/fleet/db"
import { freshSql } from "./sqlite"
import { ingest } from "../server/fleet/ingest"
import { hashKey } from "../server/fleet/keys"
import { clientStateToService, scopeToDomain } from "~/utils/fleetAdapter"

const sql = freshSql()
const db = sqlClient(sql)
const pushed: string[] = []
const ctx = { push: async (p: { title: string }) => { pushed.push(p.title) } }

const KEY = "sk_test_ingest"
const { data: sys } = await db.from("systems").insert({
  user_id: "owner", name: "pi5a", slug: "pi5a", key_hash: await hashKey(KEY),
}).select("id").single()

const report = (type: string, uid: string, body: any, key = KEY) =>
  ingest(db, ctx, { headers: { "x-system-key": key, "x-unique-id": uid, "x-type": type }, body, clientIp: "10.0.0.1" })
const open = async () => (await db.from("notifications").select("source, source_detail, type").is("resolved_at", null)).data

// unknown key
await assert.rejects(report("os", "os", {}, "wrong"), /System not found/)

// os report updates the system row
await report("os", "os", { cpu: 12, memory: { usedPercent: 40 }, platform: "linux" })
const { data: s1 } = await db.from("systems").select("last_seen, os").eq("id", sys.id).single()
assert.ok(s1.last_seen)
assert.equal(s1.os.type, "linux")

// docker: first bad report holds, second alerts, third is deduped, good resolves
const bad = { project: "app", containers: [{ name: "web", running: false, exitCode: 1 }] }
const good = { project: "app", containers: [{ name: "web", running: true }] }
await report("docker", "docker-app", good)
await report("docker", "docker-app", bad)
assert.equal((await open()).length, 0, "first bad report is held")
await report("docker", "docker-app", bad)
assert.deepEqual(await open(), [{ source: "docker", source_detail: "docker-app", type: "error" }])
assert.equal(pushed.length, 1)
await report("docker", "docker-app", bad)
assert.equal((await open()).length, 1, "still one alert")
assert.equal(pushed.length, 1, "not pushed again")
await report("docker", "docker-app", good)
assert.equal((await open()).length, 0, "resolved on recovery")
assert.equal(pushed.length, 2, "recovery pushed")
assert.match(pushed[1], /^Recovered: /)

// a recurrence inside the 30-minute cooldown is recorded but not pushed
await report("docker", "docker-app", bad)
await report("docker", "docker-app", bad)
assert.equal((await open()).length, 1)
assert.equal(pushed.length, 2, "cooldown holds the push")
await report("docker", "docker-app", good)
assert.equal(pushed.length, 2, "a quiet alert's recovery is not pushed")

// web findings: one alert per finding, closed when no longer reported
await report("web", "web-shop", { name: "shop", ok: false, status: 503 })
assert.deepEqual((await open()).map((r: any) => r.source_detail), ["web:fail:shop"])
await report("web", "web-shop", { name: "shop", ok: true, responseTime: 120 })
assert.equal((await open()).length, 0)

// history rows written per report, current state upserted to one row
const { count: hist } = await db.from("client_state_history").select("*", { count: "exact", head: true }).eq("unique_id", "docker-app")
assert.equal(hist, 8)
const { count: states } = await db.from("client_states").select("*", { count: "exact", head: true }).eq("unique_id", "docker-app")
assert.equal(states, 1)

// device merge: snmp and netscan for one IP become one device row
await report("netscan", "ns-1", { name: "qnap", ip: "10.0.0.5", up: true, latency: 3 })
await report("snmp", "snmp-1", { name: "QNAP", ip: "10.0.0.5", reachable: true, memPct: 20 })
const { data: dev } = await db.from("client_states").select("type, data").eq("unique_id", "dev-10-0-0-5").single()
assert.equal(dev.type, "device")
assert.deepEqual(Object.keys(dev.data.sources).sort(), ["netscan", "snmp"])

// Google: a transient API failure keeps the last good reading and warns; an
// auth failure is still an error and replaces it.
const ga = { name: "Google Analytics", properties: 1, accounts: [{ id: "1", name: "A", properties: [{ id: "9", name: "Site", domains: ["site.example"], today: { users: 5 }, last7: { users: 40 } }] }] }
const gaRow = async () => (await db.from("client_states").select("id, type, status, status_reason, data, updated_at").eq("unique_id", "ga4-0").single()).data
// What a website group holding the account shows: the stored row through the adapter, scoped to the group's domain.
const siteLevel = async () => scopeToDomain(clientStateToService(await gaRow(), { id: sys.id, name: "pi5a" }), "site.example").level
await report("ga4", "ga4-0", ga)
assert.equal((await gaRow()).status, "online")
const outage = { error: "The service is currently unavailable.", transient: true }
await report("ga4", "ga4-0", outage)
let row = await gaRow()
assert.equal(row.status, "warning")
assert.match(row.status_reason, /showing the last reading/)
assert.deepEqual(row.data.accounts, ga.accounts, "figures kept")
assert.equal(await siteLevel(), "ok", "a GA 503 leaves the site's group green")
assert.equal(row.data.error, undefined)
const since = row.data.stale.since
await report("ga4", "ga4-0", outage)
row = await gaRow()
assert.equal(row.data.stale.since, since, "stale since the first failure")
assert.equal((await open()).filter((r: any) => r.source === "ga4").every((r: any) => r.type === "warning"), true, "a held outage pages a warning at most")
await report("ga4", "ga4-0", ga)
row = await gaRow()
assert.equal(row.status, "online")
assert.equal(row.data.stale, undefined)
assert.equal((await open()).filter((r: any) => r.source === "ga4").length, 0)
await report("ga4", "ga4-0", { error: "Token has been expired or revoked.", authExpired: true })
row = await gaRow()
assert.equal(row.status, "error")
assert.equal(row.data.authExpired, true)
assert.equal(await siteLevel(), "crit", "an auth failure still reaches the site")
await report("ga4", "ga4-0", { error: "User does not have sufficient permissions" })
assert.equal((await gaRow()).status, "error", "a non-transient API error is still an error")
// a transient failure with no good reading before it warns, without figures
await report("adsense", "adsense-0", { error: "Backend Error", transient: true })
const ad = (await db.from("client_states").select("status, status_reason").eq("unique_id", "adsense-0").single()).data
assert.equal(ad.status, "warning")
assert.match(ad.status_reason, /no reading yet/)

console.log("ingest.check: ok")
