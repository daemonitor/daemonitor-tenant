// Claiming a tenant, roles from the members table, and an agent enrolling
// all the way to a report accepted with the key it was given.
import assert from "node:assert/strict"
import { freshDb } from "./sqlite"
import { claimTenant, claimEnrollment, mintEnrollment } from "../server/fleet/enroll"
import { roleOf } from "../server/fleet/access"
import { ingest } from "../server/fleet/ingest"

const db = freshDb()
const ORIGIN = "https://fleet.acme.test"
const owner = { sub: "u-owner", email: "owner@acme.test", emailVerified: true }
const stranger = { sub: "u-stranger", email: "x@else.test", emailVerified: true }

// claiming
await assert.rejects(claimTenant(db, owner, "abc", undefined), /no CLAIM_CODE/)
await assert.rejects(claimTenant(db, owner, "wrong", "s3cret"), /Wrong claim code/)
await assert.rejects(mintEnrollment(db, owner, {}, ORIGIN), /Only an owner or manager/)
assert.deepEqual(await claimTenant(db, owner, "s3cret", "s3cret"), { role: "owner" })
await assert.rejects(claimTenant(db, stranger, "s3cret", "s3cret"), /already has an owner/)
assert.equal(await roleOf(db, owner), "owner")
assert.equal(await roleOf(db, stranger), null)

// an invite by email binds on first arrival, only with a verified email
await db.from("members").insert({ email: "mgr@acme.test", role: "manager" })
assert.equal(await roleOf(db, { sub: "u-mgr", email: "mgr@acme.test", emailVerified: false }), null)
assert.equal(await roleOf(db, { sub: "u-mgr", email: "mgr@acme.test", emailVerified: true }), "manager")
assert.equal(await roleOf(db, { sub: "u-mgr", email: "changed@acme.test", emailVerified: true }), "manager", "bound by id now")
await db.from("members").insert({ email: "view@acme.test", role: "viewer" })
const viewer = { sub: "u-view", email: "view@acme.test", emailVerified: true }
await assert.rejects(mintEnrollment(db, viewer, {}, ORIGIN), /Only an owner or manager/)

// a manager adds a system; it belongs to the tenant owner
const minted = await mintEnrollment(db, { sub: "u-mgr", email: null, emailVerified: false }, { plugins: ["docker"] }, ORIGIN)
assert.match(minted.command, /^npx @daemonitor\/client --token dmk_enroll_\S+ --endpoint https:\/\/fleet\.acme\.test\/api$/)
const { data: pending } = await db.from("systems").select("user_id, status").eq("id", minted.systemId).single()
assert.deepEqual(pending, { user_id: "u-owner", status: "pending" })

// the agent claims it: named by its hostname, config pointed at this tenant
const claim = (token: string) => claimEnrollment(db, { token, hostname: "pi5c", os: { type: "linux" }, detected: ["os", "pm2"] }, "10.0.0.9", ORIGIN)
await assert.rejects(claim("dmk_enroll_nope"), /not recognized/)
const got = await claim(minted.token)
assert.equal(got.name, "pi5c")
assert.equal(got.config.web, undefined)
assert.deepEqual(got.config.plugins, ["os", "docker"], "the operator's choice beats what was detected")
await assert.rejects(claim(minted.token), /already used/)

// an expired token says so
const late = await mintEnrollment(db, owner, { systemId: minted.systemId }, ORIGIN)
await db.from("enrollment_tokens").update({ expires_at: new Date(Date.now() - 1000).toISOString() }).eq("system_id", minted.systemId).is("claimed_at", null)
await assert.rejects(claim(late.token), /expired/)

// and the key it got is accepted by ingest
const r: any = await ingest(db, { push: async () => {} }, {
  headers: { "x-system-key": got.systemKey, "x-unique-id": "os", "x-type": "os" },
  body: { cpu: 5, platform: "linux" },
  clientIp: "10.0.0.9",
})
assert.equal(r.success, true)
const { data: live } = await db.from("systems").select("name, last_seen").eq("id", minted.systemId).single()
assert.equal(live.name, "pi5c")
assert.ok(live.last_seen)

console.log("enroll.check: ok")
