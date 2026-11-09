// History reads: the sampled series' derivations, scoping, and the shapes the
// detail views read. (The series were also compared against Postgres's own
// history_batch_series and history_value_series on real data: identical.)
import assert from "node:assert/strict"
import { freshSql } from "./sqlite"
import { sqlClient } from "../server/fleet/db"
import { scopeOf } from "../server/fleet/access"
import { barSeries, cfHistory, historyBatch, overviewHistory, probes, serviceHistory, systemEvents } from "../server/fleet/history"

const sql = freshSql()
const db = sqlClient(sql)
const sys = async (name: string) => (await db.from("systems").insert({ user_id: "owner", name, slug: name, key_hash: name }).select("id").single()).data.id
const A = await sys("a")
const B = await sys("b")
const state = async (system_id: string, unique_id: string, type: string) =>
  (await db.from("client_states").insert({ system_id, unique_id, type, data: {} }).select("id").single()).data.id
const os = await state(A, "os", "os")
const dock = await state(A, "docker-app", "docker")
const web = await state(B, "web-x", "web")
const zone = await state(B, "cf-domain-z", "cloudflare-domain")

// 30 minutes of reports, one a minute
const t0 = Date.now() - 30 * 60_000
for (let i = 0; i < 30; i++) {
  const at = new Date(t0 + i * 60_000).toISOString()
  const row = (system_id: string, unique_id: string, type: string, data: any) =>
    db.from("client_state_history").insert({ system_id, unique_id, type, data, created_at: at })
  // cpu times grow by 100 per sample, 25 of it idle: 75% busy
  await row(A, "os", "os", { cpus: [{ times: { user: 75 * i, idle: 25 * i } }], totalmem: 100, available: 40, disks: [{ pct: 12 }, { pct: 71.6 }], network: { rxRate: 3, txRate: 4 } })
  await row(A, "docker-app", "docker", { containers: [{ name: "web", cpu: 1.5, mem: 100 }, { name: "db", cpu: 2.25, mem: 200 }] })
  await row(B, "web-x", "web", { duration: 120.4 })
  await row(B, "cf-domain-z", "cloudflare-domain", { domain: { trafficQuality: { suspectNetworks: { suspectShare: 0.25, suspects: [{ asn: 45102, share: 0.2 }] } } } })
}
await db.from("cf_zone_daily").insert({ system_id: B, unique_id: "cf-domain-z", day: new Date().toISOString().slice(0, 10), requests: 9, probes: 3, probe_paths: ["/xmlrpc.php"] })
await db.from("notifications").insert({ user_id: "owner", system_id: B, title: "t", message: "m", type: "error", source: "web", source_detail: "web:fail:x" })

await db.from("members").insert({ user_id: "owner", role: "owner" })
const { data: g } = await db.from("groups").insert({ user_id: "owner", name: "g" }).select("id").single()
await db.from("group_members").insert({ group_id: g.id, service_id: web })
await db.from("grants").insert({ resource_type: "group", resource_id: g.id, grantee_email: "g@x.test", grantee_id: "grp", role: "viewer" })
const owner = (await scopeOf(db, { sub: "owner", email: null, emailVerified: false }))!
const grp = (await scopeOf(db, { sub: "grp", email: null, emailVerified: false }))!

// the board's sparklines
const batch = await historyBatch(db, sql, owner, "1h")
assert.ok(batch[os].cpu!.every((v) => v === 75), "os cpu from the delta between samples")
assert.ok(batch[os].mem!.every((v) => v === 60))
assert.ok(batch[os].disk!.every((v) => v === 72), "the fullest mount, rounded")
assert.ok(batch[os].net!.every((v) => v === 7))
assert.ok(batch[dock].cpu!.every((v) => v === 4), "containers summed and rounded")
assert.ok(batch[web].val!.every((v) => v === 120))
assert.equal(batch[zone], undefined, "zones chart their daily threats, not this")
assert.deepEqual(Object.keys(await historyBatch(db, sql, grp, "1h")), [web], "a group grantee gets only the grouped service")

const overview = await overviewHistory(db, sql, owner, "1h")
assert.equal(overview.cpu.length, 60)
assert.ok(overview.cpu.at(-1)! > 0)

// one service's detail
const detail: any = await serviceHistory(db, owner, { id: dock, range: "1h" })
assert.deepEqual(Object.keys(detail.containers).sort(), ["db", "web"])
assert.equal(detail.containers.db.cpu[0], 2.25, "under the point cap, values pass through")
const osDetail: any = await serviceHistory(db, owner, { id: os, range: "1h" })
assert.equal(osDetail.cpu.length, osDetail.mem.length, "os mem aligned to cpu")
const zoneDetail: any = await serviceHistory(db, owner, { id: zone, range: "1h" })
assert.deepEqual(Object.keys(zoneDetail.suspects.byAsn), ["45102"])
assert.deepEqual(await serviceHistory(db, grp, { id: os, range: "1h" }), { cpu: [], mem: [] }, "not yours reads as empty")

// zones: daily traffic and probes
assert.equal((await cfHistory(db, owner, zone, "30d")).series[0].requests, 9)
assert.deepEqual((await probes(db, owner)).rows.map((r: any) => [r.probes, r.paths]), [[3, ["/xmlrpc.php"]]])
assert.deepEqual((await probes(db, grp)).rows, [], "the zone isn't in the grantee's group")

// a system's event log: members yes, group grantees no
assert.equal((await systemEvents(db, owner, { systemId: B })).total, 1)
// Narrowed to one service: its findings, its status alerts, and cluster rows.
await db.from("notifications").insert([
  { user_id: "owner", system_id: B, title: "t", message: "m", type: "error", source: "web", source_detail: "web:fail:y", metadata: { service: "other" } },
  { user_id: "owner", system_id: B, title: "t", message: "m", type: "error", source: "status", source_detail: "web-x" },
  { user_id: "owner", system_id: B, title: "t", message: "m", type: "error", source: "cluster", source_detail: "c1" },
  { user_id: "owner", system_id: B, title: "t", message: "m", type: "error", source: "web", source_detail: "web:fail:z", metadata: { service: "web-x" } },
])
const narrowed = await systemEvents(db, owner, { systemId: B, service: "web-x", limit: 2 })
assert.equal(narrowed.total, 3)
assert.equal(narrowed.events.length, 2)
assert.equal((await systemEvents(db, owner, { systemId: B })).total, 5)
await assert.rejects(systemEvents(db, grp, { systemId: B }), /System not found/)

// An lxc container's net comes from data.container.network; a sample without it stays null.
assert.deepEqual(
  barSeries("lxc-container", [
    { data: { container: { cpu: 5, network: { rxRate: 100, txRate: 20 } } } },
    { data: { container: { cpu: 5 } } },
  ] as any).map((x) => x.net),
  [120, null],
)

console.log("history.check: ok")
