// A Slack alert is edited in place when it resolves: the raise records the
// message's ts, the recovery rewrites that message with when the fault started
// and how long it lasted. Slack's API is faked.
import assert from "node:assert/strict"
import { sqlClient } from "../server/fleet/db"
import { freshSql } from "./sqlite"
import { ingest } from "../server/fleet/ingest"
import { hashKey } from "../server/fleet/keys"
import { fmtDuration, resolvedFooter } from "../vendor/frontend/server/utils/slack"

assert.equal(fmtDuration(45_000), "45s")
assert.equal(fmtDuration(12 * 60_000), "12m")
assert.equal(fmtDuration((2 * 60 + 14) * 60_000), "2h 14m")
assert.equal(fmtDuration(3 * 86400_000 + 4 * 3600_000), "3d 4h")
assert.match(resolvedFooter("2026-11-05T01:00:00Z", "2026-11-05T03:14:00Z"), /lasted \*2h 14m\*/)
assert.match(resolvedFooter("2026-11-05T01:00:00Z", "2026-11-05T03:14:00Z"), /<!date\^1793840400\^/)

const calls: { method: string; body: any }[] = []
globalThis.fetch = (async (url: any, init: any) => {
  const method = String(url).split("/").pop()!
  const body = JSON.parse(init.body)
  calls.push({ method, body })
  return new Response(JSON.stringify({ ok: true, channel: body.channel, ts: method === "chat.postMessage" ? "1793840400.000100" : body.ts }))
}) as any

const db = sqlClient(freshSql())
const KEY = "sk_test_slack"
await db.from("systems").insert({ user_id: "owner", name: "pi5a", slug: "pi5a", key_hash: await hashKey(KEY) }).select("id").single()
await db.from("notification_channels").insert({ user_id: "owner", kind: "slack", enabled: true, min_level: "warning", config: { bot_token: "xoxb-test", channel_id: "C1", team_id: "T1" } })
const ctx = { push: async () => {} }
const report = (body: any) => ingest(db, ctx, { headers: { "x-system-key": KEY, "x-unique-id": "docker-app", "x-type": "docker" }, body, clientIp: null })
const bad = { project: "app", containers: [{ name: "web", running: false, exitCode: 1 }] }
const good = { project: "app", containers: [{ name: "web", running: true }] }

await report(good)
await report(bad)
await report(bad)
const posts = calls.filter((c) => c.method === "chat.postMessage")
assert.equal(posts.length, 1, "one alert posted")
const { data: row } = await db.from("notifications").select("metadata").is("resolved_at", null).single()
assert.deepEqual(row.metadata.slack, [{ ch: row.metadata.slack[0].ch, channel: "C1", ts: "1793840400.000100" }], "raise records where it landed")

await report(good)
const edits = calls.filter((c) => c.method === "chat.update")
assert.equal(edits.length, 1, "recovery edits the message")
assert.equal(edits[0].body.ts, "1793840400.000100")
assert.equal(edits[0].body.channel, "C1")
assert.match(JSON.stringify(edits[0].body.blocks), /Resolved/)
assert.match(JSON.stringify(edits[0].body.blocks), /started <!date/)
assert.match(JSON.stringify(edits[0].body.blocks), /lasted \*\d+s\*/)
assert.equal(calls.filter((c) => c.method === "chat.postMessage").length, 1, "no new message for the recovery")

console.log("slackResolve check: ok")
