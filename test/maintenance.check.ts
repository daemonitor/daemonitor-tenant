// Housekeeping: the reaper, thinning, the cluster purge, and the monthly
// archive read back the way the frontend reads it.
import assert from "node:assert/strict"
import { gunzipSync } from "node:zlib"
import { freshSql } from "./sqlite"
import { sqlClient } from "../server/fleet/db"
import { ageOut, exportMonth, exportMonths, purgeClusterHistory, reapStaleServices, thinHistory } from "../server/fleet/maintenance"
import { resolveArchived } from "~/utils/suspectNetworks"

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR
const iso = (ms: number) => new Date(ms).toISOString()
const sql = freshSql()
const db = sqlClient(sql)
const now = Date.UTC(2026, 10, 1, 2, 7) // 1 Nov 2026, 02:07, when the archive runs

const sys = async (name: string, lastSeen: number) =>
  (await db.from("systems").insert({ user_id: "acct-1", name, slug: name, key_hash: name, last_seen: iso(lastSeen) }).select("id").single()).data.id
const alive = await sys("alive", now - 5 * MIN)
const dead = await sys("dead", now - 3 * HOUR)
const svc = async (system_id: string, unique_id: string, updated: number, extra: any = {}) =>
  (await db.from("client_states").insert({ system_id, unique_id, type: "docker", data: {}, updated_at: iso(updated), ...extra }).select("id").single()).data.id

// --- reaper
const gone = await svc(alive, "stopped-reporting", now - 3 * HOUR)
const fresh = await svc(alive, "fresh", now - MIN)
const deadHosts = await svc(dead, "agent-is-down", now - 3 * HOUR)
const switchedOff = await svc(alive, "module-off", now - 3 * HOUR, { archived: true, archived_module: "servers" })
const { data: g } = await db.from("groups").insert({ user_id: "acct-1", name: "g" }).select("id").single()
await db.from("group_members").insert([{ group_id: g.id, service_id: gone }, { group_id: g.id, service_id: fresh }])
assert.equal(await reapStaleServices(db, sql, now), 1)
const left = (await db.from("client_states").select("id")).data.map((r: any) => r.id).sort()
assert.deepEqual(left, [fresh, deadHosts, switchedOff].sort(), "only the service a live agent stopped reporting")
assert.deepEqual((await db.from("group_members").select("service_id")).data, [{ service_id: fresh }], "its membership went with it")

// --- thinning: 40 reports an hour apart on 3 Oct, 2010 in the last hours
const put = (at: number, data: any = { n: at }) => sql.exec(
  "insert into client_state_history (id, unique_id, system_id, type, data, created_at) values (?,?,?,?,?,?)",
  crypto.randomUUID(), "fresh", alive, "docker", JSON.stringify(data), iso(at))
const oct3 = Date.UTC(2026, 9, 3)
for (let i = 0; i < 40; i++) put(oct3 + i * 30 * MIN)
for (let i = 0; i < 2010; i++) put(now - i * 20_000)
await thinHistory(sql, now)
const count = (where: string, ...args: any[]) => sql.exec<{ n: number }>(`select count(*) as n from client_state_history where ${where}`, ...args).one().n
assert.equal(count("substr(created_at, 1, 10) = '2026-10-03'"), 24, "24 a day beyond 24h")
assert.equal(sql.exec<{ t: string }>("select min(created_at) as t from client_state_history where substr(created_at, 1, 10) = '2026-10-03'").one().t, "2026-10-03T08:00:00.000Z", "the newest 24 of the day kept")
assert.equal(count("created_at >= ?", iso(now - DAY)), 2000, "2000 within 24h")

// --- cluster purge and age-out
sql.exec("insert into cluster_service_history (id, cluster_service_id, level, running_count, member_count, created_at) values ('old','c','ok',1,1,?), ('new','c','ok',1,1,?)", iso(now - 15 * DAY), iso(now - DAY))
assert.equal(purgeClusterHistory(sql, now), 1)

// --- the archive
class FakeR2 {
  objects = new Map<string, { body: Uint8Array; uploaded: Date }>()
  aborted = 0
  async head(key: string) { const o = this.objects.get(key); return o ? { uploaded: o.uploaded } : null }
  async createMultipartUpload(key: string) {
    const parts: { n: number; body: Uint8Array }[] = []
    return {
      uploadPart: async (n: number, body: Uint8Array) => { parts.push({ n, body }); return { partNumber: n, etag: String(n) } },
      complete: async () => {
        const bytes = Buffer.concat(parts.sort((a, b) => a.n - b.n).map((p) => p.body))
        this.objects.set(key, { body: bytes, uploaded: new Date() })
      },
      abort: async () => { this.aborted++ },
    }
  }
}
const r2 = new FakeR2()
// October for this account: a big analytics block repeated in every report, and a small changing part
const analytics = { zones: Array.from({ length: 30 }, (_, i) => ({ day: i, requests: i * 1000, path: "/some/long/path/that/repeats".repeat(2) })) }
for (let day = 10; day < 12; day++) for (let i = 0; i < 30; i++) put(Date.UTC(2026, 9, day, 0, i * 40), { tick: i, analytics })
const octRows = count("substr(created_at, 1, 7) = '2026-10'")

const out = await exportMonth(sql, r2 as any, "acct-1", "2026-10")
const file = JSON.parse(gunzipSync(r2.objects.get("acct-1/2026-10.json.gz")!.body).toString())
assert.equal(file.format, 2)
assert.deepEqual(file.systems.map((s: any) => s.name).sort(), ["alive", "dead"])
const perDay = new Map<string, number>()
for (const r of file.rows) perDay.set(r.created_at.slice(0, 10), (perDay.get(r.created_at.slice(0, 10)) || 0) + 1)
assert.ok([...perDay.values()].every((n) => n <= 24), "24 per service per day")
assert.equal(out.rows, file.rows.length)
assert.ok(file.rows.length < octRows, "thinned on the way out")
const tenth = file.rows.filter((r: any) => r.created_at.startsWith("2026-10-10")).map((r: any) => resolveArchived(r.data, file.blobs))
assert.deepEqual(tenth.at(-1), { tick: 29, analytics }, "a report resolves back to exactly what was stored")
assert.ok(Object.keys(file.blobs).length <= 3, "the repeated analytics stored once")

// exportMonths: skips the current month and finished exports, redoes a partial one
assert.deepEqual((await exportMonths(sql, r2 as any, now)).done, [], "October already exported after its end")
r2.objects.set("acct-1/2026-10.json.gz", { body: new Uint8Array(), uploaded: new Date(Date.UTC(2026, 9, 20)) })
assert.equal((await exportMonths(sql, r2 as any, now)).done.length, 1, "an export from inside its month is partial: redone")
put(now - MIN)
assert.ok(!r2.objects.has("acct-1/2026-11.json.gz"), "never the month still being written")

// the age-out takes what's older than 30 days, and nothing newer
const before = count("created_at >= ?", iso(now - 30 * DAY))
ageOut(sql, now)
assert.equal(count("created_at < ?", iso(now - 30 * DAY)), 0)
assert.equal(count("created_at >= ?", iso(now - 30 * DAY)), before)

console.log("maintenance.check: ok")
