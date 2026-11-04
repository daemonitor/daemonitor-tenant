// The query builder against real SQLite (node:sqlite standing in for the DO's
// storage.sql), covering every builder call the alerting code makes.
import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"
import { migrate } from "../server/fleet/schema"
import { sqlClient } from "../server/fleet/db"

const raw = new DatabaseSync(":memory:")
const sql = {
  exec(q: string, ...args: any[]) {
    const rows = raw.prepare(q).all(...args) as any[]
    return { toArray: () => rows, one: () => rows[0] }
  },
} as unknown as SqlStorage

migrate(sql)
migrate(sql) // a second run applies nothing
const db = sqlClient(sql)

// insert fills the id; json and bool round-trip
const { data: sys } = await db.from("systems").insert({
  user_id: "u1", name: "pi5a", slug: "pi5a", key_hash: "h1", metrics: { cpu: 3 }, archived: false,
}).select("id, name, metrics, archived, os").single()
assert.match(sys.id, /^[0-9a-f-]{36}$/)
assert.deepEqual(sys.metrics, { cpu: 3 })
assert.equal(sys.archived, false)
assert.equal(sys.os.type, "other") // json default

// or() over two columns, as findSystemByKey does
const { data: byKey } = await db.from("systems").select("id").or(`key_hash.eq.nope,previous_key_hash.eq.nope`)
assert.equal(byKey.length, 0)
await db.from("systems").update({ previous_key_hash: "old" }).eq("id", sys.id)
const { data: byOld } = await db.from("systems").select("id, previous_key_hash").or(`key_hash.eq.old,previous_key_hash.eq.old`).limit(1)
assert.equal(byOld[0].id, sys.id)

// upsert on (unique_id, system_id) updates in place and keeps the id
const row = { unique_id: "docker-a", system_id: sys.id, type: "docker", data: { containers: [1] }, status: "online" }
const { data: first } = await db.from("client_states").upsert(row, { onConflict: "unique_id, system_id" }).select("id")
const { data: second } = await db.from("client_states").upsert({ ...row, status: "error", data: { containers: [] } }, { onConflict: "unique_id, system_id" }).select("id")
assert.equal(first[0].id, second[0].id)
const { data: cs } = await db.from("client_states").select("status, data").eq("unique_id", "docker-a").eq("system_id", sys.id).limit(1)
assert.equal(cs[0].status, "error")
assert.deepEqual(cs[0].data, { containers: [] })

// notify's dedupe: is(null), json path eq, and the partial unique index as 23505
const alert = { user_id: "u1", system_id: sys.id, title: "t", message: "m", type: "error", source: "web", source_detail: "web:down:x", metadata: { service: "web-1" } }
const ins1 = await db.from("notifications").insert(alert).select("id").single()
assert.equal(ins1.error, null)
const ins2 = await db.from("notifications").insert(alert).select("id").single()
assert.equal(ins2.error?.code, "23505")
const { data: open } = await db.from("notifications").select("id, source_detail")
  .eq("system_id", sys.id).eq("source", "web").eq("metadata->>service", "web-1").is("resolved_at", null)
assert.equal(open.length, 1)

// resolving re-arms: update ... returning, then a fresh insert is allowed
const now = new Date().toISOString()
const { data: closed } = await db.from("notifications").update({ read: true, resolved_at: now })
  .eq("system_id", sys.id).in("source_detail", ["web:down:x"]).is("resolved_at", null).select("id, type, metadata")
assert.equal(closed.length, 1)
assert.deepEqual(closed[0].metadata, { service: "web-1" })
assert.equal((await db.from("notifications").insert(alert).select("id").single()).error, null)

// cooldown read: gte on a timestamp
const { data: recent } = await db.from("notifications").select("id").eq("system_id", sys.id).gte("resolved_at", new Date(Date.now() - 60_000).toISOString()).limit(1)
assert.equal(recent.length, 1)

// not(col, is, null), in() with [] matches nothing, count + head, range, order
await db.from("members").insert([{ user_id: "u1", role: "owner" }, { email: "pending@x", role: "manager" }])
const { data: who } = await db.from("members").select("user_id").in("role", ["owner", "manager"]).not("user_id", "is", null)
assert.deepEqual(who, [{ user_id: "u1" }])
assert.deepEqual((await db.from("members").select("user_id").in("role", [])).data, [])
const counted = await db.from("notifications").select("*", { count: "exact", head: true }).eq("system_id", sys.id)
assert.equal(counted.count, 2)
assert.equal(counted.data, null)
for (let i = 0; i < 5; i++) {
  await db.from("client_state_history").insert({ unique_id: "p", system_id: sys.id, type: "patroni", data: { lagBytes: i }, created_at: new Date(Date.now() - i * 1000).toISOString() })
}
const { data: page } = await db.from("client_state_history").select("data, created_at").eq("unique_id", "p").order("created_at", { ascending: false }).range(1, 2)
assert.deepEqual(page.map((r: any) => r.data.lagBytes), [1, 2])

// filter() with a json path, and a bool column compared as a bool
assert.equal((await db.from("client_state_history").select("id").filter("data->lagBytes", "eq", 3)).data.length, 1)
assert.equal((await db.from("systems").select("id").eq("archived", false)).data.length, 1)

// maybeSingle on nothing is null without an error; single on nothing is an error
const none = await db.from("systems").select("id").eq("id", "none").maybeSingle()
assert.equal(none.data, null)
assert.equal(none.error, null)
assert.ok((await db.from("systems").select("id").eq("id", "none").single()).error)

// delete returning
const { data: gone } = await db.from("client_states").delete().eq("unique_id", "docker-a").select("id")
assert.equal(gone.length, 1)

// a column that doesn't exist fails loudly rather than matching nothing
await assert.rejects(async () => { await db.from("systems").select("id").eq("nope", 1) }, /no column systems.nope/)

console.log("db.check: ok")
