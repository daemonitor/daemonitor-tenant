// The ported ingest on real SQLite: a fault alerts once on its second report,
// stays deduped while it holds, and resolves when it clears. Findings open one
// alert each and close when the service stops reporting them.
import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"
import { migrate } from "../server/fleet/schema"
import { sqlClient } from "../server/fleet/db"
import { ingest } from "../server/fleet/ingest"
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
const pushed: string[] = []
const ctx = { push: async (_u: string, p: { title: string }) => { pushed.push(p.title) } }

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

// a recurrence inside the 30-minute cooldown is recorded but not pushed
await report("docker", "docker-app", bad)
await report("docker", "docker-app", bad)
assert.equal((await open()).length, 1)
assert.equal(pushed.length, 1, "cooldown holds the push")
await report("docker", "docker-app", good)

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

console.log("ingest.check: ok")
