// Camera frames: an agent stores the latest JPEG for its own camera row, and a
// viewer reads it back only for a camera inside their scope.
import assert from "node:assert/strict"
import { sqlClient } from "../server/fleet/db"
import { freshSql } from "./sqlite"
import { ingest } from "../server/fleet/ingest"
import { hashKey } from "../server/fleet/keys"
import { getFrame, MAX_FRAME_BYTES, putFrame, type FrameStore } from "../server/fleet/frames"

const sql = freshSql()
const db = sqlClient(sql)
const ctx = { push: async () => {} }
const kv = new Map<string, unknown>()
const store: FrameStore = {
  get: async (k) => kv.get(k) as any,
  put: async (k, v) => { kv.set(k, v) },
  delete: async (k) => kv.delete(k),
}

const KEY = "sk_test_cam"
const OTHER = "sk_test_other"
const { data: a } = await db.from("systems").insert({ user_id: "owner", name: "office", slug: "office", key_hash: await hashKey(KEY) }).select("id").single()
const { data: b } = await db.from("systems").insert({ user_id: "owner", name: "home", slug: "home", key_hash: await hashKey(OTHER) }).select("id").single()
const report = (body: any, key = KEY, type = "camera", uid = "camera-lobby") =>
  ingest(db, ctx, { headers: { "x-system-key": key, "x-unique-id": uid, "x-type": type }, body, clientIp: null })
const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9])
const put = (over: any = {}) => putFrame(db, store, { key: KEY, uniqueId: "camera-lobby", bytes: jpeg, ...over })

// No row yet: the plugin reports before its first frame.
await assert.rejects(put(), /reports before its first frame/)

await report({ name: "Lobby", reachable: true, width: 1280, height: 720 })
const { data: row } = await db.from("client_states").select("id, status").eq("unique_id", "camera-lobby").single()
assert.equal(row.status, "online")

await assert.rejects(put({ key: "wrong" }), /System not found/)
await assert.rejects(put({ key: OTHER }), /No camera/, "another system's key can't write this camera")
await assert.rejects(put({ bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]) }), /must be a JPEG/)
await assert.rejects(put({ bytes: new Uint8Array(MAX_FRAME_BYTES + 1).fill(0xff) }), /at most/)

const { at } = await put()
const owner = { all: true as const, role: "owner" as const }
const got = await getFrame(db, store, owner, row.id)
assert.deepEqual(got.bytes, jpeg)
assert.equal(got.at, at)

// A grantee of the other system can't read it, and gets the same 404 as a bad id.
const outsider = { all: false as const, systems: new Set([b.id]), services: new Set<string>(), alertSystems: new Set([b.id]) }
await assert.rejects(getFrame(db, store, outsider, row.id), /Not found/)
await assert.rejects(getFrame(db, store, owner, "nope"), /Not found/)
// A system grantee can.
const grantee = { all: false as const, systems: new Set([a.id]), services: new Set<string>(), alertSystems: new Set([a.id]) }
assert.deepEqual((await getFrame(db, store, grantee, row.id)).bytes, jpeg)

// Another type with the same unique id is not a camera.
await report({ name: "x" }, KEY, "os", "camera-os")
const { data: osRow } = await db.from("client_states").select("id").eq("unique_id", "camera-os").single()
await assert.rejects(getFrame(db, store, owner, osRow.id), /Not found/)

// An unreachable camera is an error with the plugin's reason.
await report({ name: "Lobby", reachable: false, error: "snapshot: HTTP 503" })
const { data: down } = await db.from("client_states").select("status, status_reason").eq("id", row.id).single()
assert.equal(down.status, "error")
assert.equal(down.status_reason, "Lobby: snapshot: HTTP 503")

console.log("frames check: ok")
