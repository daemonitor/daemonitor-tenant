// The app's own records: who may write what, which values are refused, and the
// integrity rules Postgres enforced with foreign keys and triggers.
import assert from "node:assert/strict"
import { freshDb } from "./sqlite"
import { scopeOf } from "../server/fleet/access"
import { insert, list, makeCtx, remove, update } from "../server/fleet/data"

const db = freshDb()
await db.from("members").insert([
  { user_id: "u-owner", role: "owner" },
  { user_id: "u-mgr", role: "manager" },
  { user_id: "u-view", role: "viewer" },
])
const sys = (await db.from("systems").insert({ user_id: "u-owner", name: "a", slug: "a", key_hash: "k" }).select("id").single()).data.id
const svc = (await db.from("client_states").insert({ system_id: sys, unique_id: "os", type: "os", data: {} }).select("id").single()).data.id
const other = (await db.from("systems").insert({ user_id: "u-owner", name: "b", slug: "b", key_hash: "k2" }).select("id").single()).data.id

const as = async (sub: string, email: string | null = null) => {
  const who = { sub, email, emailVerified: !!email }
  const scope = await scopeOf(db, who)
  if (!scope) throw new Error(`${sub} has no scope`)
  return makeCtx(db, who, scope, scope.all ? scope.role : null)
}
const owner = await as("u-owner")
const mgr = await as("u-mgr")
const viewer = await as("u-view")
const refused = (p: Promise<unknown>, re: RegExp) => assert.rejects(p, re)

// groups: managers write, viewers don't; the owner owns the row; only known columns and values
await refused(insert(viewer, "groups", { name: "x" }), /manager or above/)
const [site] = await insert(mgr, "groups", { name: "site", kind: "website" })
assert.equal(site.user_id, "u-owner")
await refused(insert(mgr, "groups", { name: "x", user_id: "evil", key_hash: "x" }), /key_hash can't be set/)
await refused(insert(mgr, "groups", { name: "x", kind: "spaceship" }), /kind must be one of/)
await refused(insert(mgr, "groups", { name: 5 }), /wrong type/)
await refused(insert(mgr, "nope", {}), /No such table/)
const renamed = await update(mgr, "groups", site.id, { name: "site 2" })
assert.equal(renamed.name, "site 2")
assert.ok(renamed.updated_at > site.updated_at || renamed.updated_at === site.updated_at)

// members of a group: real things only, no loops, upsert on the pair, delete by the pair
await refused(insert(mgr, "group_members", { group_id: site.id, service_id: "no-such-service" }), /No such service/)
await insert(mgr, "group_members", { group_id: site.id, service_id: svc, label: "one" })
await insert(mgr, "group_members", { group_id: site.id, service_id: svc, label: "two" })
assert.deepEqual((await list(mgr, "group_members")).map((m: any) => m.label), ["two"], "the same pair updates")
const [parent] = await insert(mgr, "groups", { name: "parent" })
await insert(mgr, "group_members", { group_id: parent.id, service_id: `group:${site.id}` })
await refused(insert(mgr, "group_members", { group_id: site.id, service_id: `group:${parent.id}` }), /inside itself/)
await refused(insert(mgr, "group_members", { group_id: site.id, service_id: `group:${site.id}` }), /inside itself/)
await refused(remove(mgr, "group_members", { label: "two" }), /Can't delete group_members by label/)

// deleting a group takes its members and its place in parents, not its children
await remove(mgr, "groups", { id: site.id })
assert.deepEqual((await list(mgr, "group_members")).length, 0)
assert.equal((await list(mgr, "groups")).length, 1)

// clusters: deleting one takes its members, rules and their history
const [cl] = await insert(mgr, "clusters", { name: "pis", kind: "patroni" })
await insert(mgr, "cluster_members", { cluster_id: cl.id, system_id: sys })
await refused(insert(mgr, "cluster_members", { cluster_id: cl.id, system_id: "nope" }), /No such system/)
const [rule] = await insert(mgr, "cluster_services", { cluster_id: cl.id, name: "renderer", match_type: "docker", match_unique_id: "docker-x", placement: "all" })
await refused(insert(mgr, "cluster_services", { cluster_id: cl.id, name: "x", match_type: "d", match_unique_id: "y", placement: "everywhere" }), /placement must be/)
await db.from("cluster_service_history").insert({ cluster_service_id: rule.id, level: "ok", running_count: 3, member_count: 3 })
assert.equal((await list(owner, "cluster_service_history", { ids: [rule.id] })).length, 1)
await remove(mgr, "clusters", { id: cl.id })
for (const t of ["cluster_members", "cluster_services", "cluster_service_history"]) {
  assert.equal(((await db.from(t).select("*")).data || []).length, 0, `${t} went with the cluster`)
}

// incidents: span rule, nested targets and entries, authorship, visibility for grantees
const started = new Date(Date.now() - 3_600_000).toISOString()
await refused(insert(mgr, "incidents", { title: "x", started_at: started, ended_at: new Date(Date.now() - 7_200_000).toISOString() }), /can't end before it starts/)
const [inc] = await insert(mgr, "incidents", { title: "outage", started_at: started })
const [inc2] = await insert(mgr, "incidents", { title: "elsewhere", started_at: started })
await insert(mgr, "incident_targets", [{ incident_id: inc.id, target_type: "system", target_id: sys, system_id: sys }])
await insert(mgr, "incident_targets", [{ incident_id: inc2.id, target_type: "system", target_id: other, system_id: other }])
const [entry] = await insert(mgr, "incident_entries", { incident_id: inc.id, kind: "status", status: "monitoring", body: "fixed" })
assert.equal(entry.author_id, "u-mgr")
const listed = await list(viewer, "incidents")
assert.equal(listed.find((i: any) => i.id === inc.id).targets.length, 1)
assert.equal(listed.find((i: any) => i.id === inc.id).entries.length, 1)
await db.from("grants").insert({ resource_type: "system", resource_id: sys, grantee_email: "g@x.test", grantee_id: "u-grantee" })
const grantee = await as("u-grantee")
assert.deepEqual((await list(grantee, "incidents")).map((i: any) => i.title), ["outage"], "only incidents naming a system they can see")
await refused(insert(grantee, "incidents", { title: "x", started_at: started }), /manager or above/)
await remove(mgr, "incident_targets", { incident_id: inc.id })
await remove(mgr, "incidents", { id: inc.id })
assert.equal(((await db.from("incident_entries").select("*")).data || []).length, 0)

// web monitors
await refused(insert(mgr, "web_monitors", { name: "x", url: "ftp://x" }), /http\(s\) URL/)
await refused(insert(mgr, "web_monitors", { name: "x", url: "https://x.test", interval_ms: 1000 }), /30 seconds/)
await insert(mgr, "web_monitors", { name: "shop", url: "https://shop.example.test", config: { expected: ["Add to cart"] } })

// saved views are personal
const [mine] = await insert(viewer, "views", { name: "mine", template: { cols: 2 } })
await insert(mgr, "views", { name: "theirs", template: {} })
assert.deepEqual((await list(viewer, "views")).map((v: any) => v.name), ["mine"])
await refused(update(mgr, "views", mine.id, { name: "hijack" }), /Not found/)
await remove(viewer, "views", { id: mine.id })

// members and grants: the owner's call; the owner's own row is fixed
await refused(insert(mgr, "members", { email: "new@x.test", role: "viewer" }), /the owner can change/)
const [added] = await insert(owner, "members", { email: "New@X.test", role: "manager" })
assert.equal(added.email, "new@x.test")
await refused(insert(owner, "members", { email: "boss@x.test", role: "owner" }), /role must be one of/)
const ownerRow = (await db.from("members").select("id").eq("role", "owner").single()).data
await refused(update(owner, "members", ownerRow.id, { role: "viewer" }), /can't be changed/)
await refused(remove(owner, "members", { user_id: "u-owner" }), /can't be removed/)
assert.deepEqual(await list(viewer, "members"), [], "viewers don't see who's invited")
await refused(insert(owner, "grants", { resource_type: "system", resource_id: "nope", grantee_email: "a@b.c" }), /No such system/)
const [gr] = await insert(owner, "grants", { resource_type: "system", resource_id: sys, grantee_email: "Pat@Example.TEST" })
assert.equal(gr.grantee_email, "pat@example.test")

console.log("data.check: ok")
