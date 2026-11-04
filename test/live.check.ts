// Who sees what, over the list routes and the live feed: members see the
// tenant, grantees see their slice, nobody sees key hashes or Slack tokens.
import assert from "node:assert/strict"
import { freshSql } from "./sqlite"
import { sqlClient } from "../server/fleet/db"
import { scopeOf } from "../server/fleet/access"
import { liveMessage } from "../server/fleet/live"
import { listClientStates, listNotifications, listSystems } from "../server/fleet/reads"

const feed: { table: string; op: string; row: any }[] = []
const db = sqlClient(freshSql(), (table, op, rows) => rows.forEach((row) => feed.push({ table, op, row })))

// two systems, a service on each, a group holding one service, an alert on each
const sys = async (name: string) => (await db.from("systems").insert({ user_id: "owner", name, slug: name, key_hash: `h-${name}` }).select("id").single()).data.id
const A = await sys("a")
const B = await sys("b")
const svc = async (system_id: string, unique_id: string) =>
  (await db.from("client_states").upsert({ system_id, unique_id, type: "docker", data: { n: 1 } }, { onConflict: "unique_id, system_id" }).select("id")).data[0].id
const a1 = await svc(A, "a1")
const a2 = await svc(A, "a2")
const b1 = await svc(B, "b1")
const { data: g } = await db.from("groups").insert({ user_id: "owner", name: "site" }).select("id").single()
await db.from("group_members").insert([{ group_id: g.id, service_id: b1 }, { group_id: g.id, service_id: "group:nested" }])
await db.from("notifications").insert([
  { user_id: "owner", system_id: A, title: "a", message: "a", type: "error", source: "docker", source_detail: "a1" },
  { user_id: "owner", system_id: B, title: "b", message: "b", type: "error", source: "docker", source_detail: "b1" },
])
await db.from("notification_channels").insert({ user_id: "owner", kind: "slack", config: { bot_token: "xoxb-secret" } })

// the feed carries full rows even when the write only selected the id
const upsertEvent = feed.find((e) => e.table === "client_states" && e.row.id === a1)!
assert.equal(upsertEvent.op, "INSERT")
assert.deepEqual(upsertEvent.row.data, { n: 1 })

// people
await db.from("members").insert([{ user_id: "owner", role: "owner" }, { user_id: "viewer", role: "viewer" }])
await db.from("grants").insert([
  { resource_type: "system", resource_id: A, grantee_email: "sys@x.test", role: "viewer" },
  { resource_type: "group", resource_id: g.id, grantee_email: "grp@x.test", role: "viewer" },
])
const who = (sub: string, email: string | null = null) => ({ sub, email, emailVerified: !!email })
const owner = (await scopeOf(db, who("owner")))!
const viewer = (await scopeOf(db, who("viewer")))!
const sysGrantee = (await scopeOf(db, who("u-sys", "sys@x.test")))!
const grpGrantee = (await scopeOf(db, who("u-grp", "grp@x.test")))!
assert.equal(await scopeOf(db, who("nobody", "no@x.test")), null)
assert.equal(await scopeOf(db, { sub: "u-unverified", email: "sys@x.test", emailVerified: false }), null, "a grant binds only on a verified email")

const ids = (r: any) => r.items.map((i: any) => i.id).sort()
const sorted = (...xs: string[]) => xs.sort()

// list routes
assert.deepEqual(ids(await listSystems(db, owner)), sorted(A, B))
assert.equal((await listSystems(db, owner)).items[0].key_hash, undefined, "no key hashes")
assert.deepEqual(ids(await listSystems(db, sysGrantee)), [A])
assert.deepEqual(ids(await listSystems(db, grpGrantee)), [B], "a group grant shows the member's system")
assert.deepEqual(ids(await listClientStates(db, sysGrantee)), sorted(a1, a2))
assert.deepEqual(ids(await listClientStates(db, grpGrantee)), [b1], "only the grouped service")
assert.deepEqual((await listNotifications(db, owner, {})).unreadCount, 2)
assert.deepEqual((await listNotifications(db, sysGrantee, {})).notifications.map((n: any) => n.system_id), [A])
assert.deepEqual((await listNotifications(db, grpGrantee, {})).notifications, [], "group grantees don't get system alerts")

// the live feed, per viewer
const sees = (scope: any, table: string, row: any) => !!liveMessage(scope, table, "UPDATE", row)
const sysRow = (await db.from("systems").select("*").eq("id", A).single()).data
const msg = liveMessage(owner, "systems", "UPDATE", sysRow)!
assert.equal(msg.new.key_hash, undefined, "no key hash over the socket")
assert.equal(msg.eventType, "UPDATE")
assert.equal(sees(owner, "notification_channels", { id: "c", config: { bot_token: "x" } }), false, "never Slack tokens")
assert.equal(sees(owner, "api_keys", { id: "k" }), false)
assert.equal(sees(owner, "client_state_history", { id: "h" }), false)
assert.equal(sees(viewer, "members", { id: "m" }), false, "viewers don't see the invite list")
assert.equal(sees(owner, "members", { id: "m" }), true)
assert.equal(sees(sysGrantee, "client_states", { id: a2, system_id: A }), true)
assert.equal(sees(sysGrantee, "client_states", { id: b1, system_id: B }), false)
assert.equal(sees(grpGrantee, "client_states", { id: b1, system_id: B }), true)
assert.equal(sees(grpGrantee, "notifications", { id: "n", system_id: B }), false)
assert.equal(sees(grpGrantee, "groups", { id: g.id }), false, "whole-account tables go by REST to grantees")
const del = liveMessage(owner, "client_states", "DELETE", { id: a2, system_id: A })!
assert.deepEqual(del.old, { id: a2, system_id: A })

console.log("live.check: ok")
