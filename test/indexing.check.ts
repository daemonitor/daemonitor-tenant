// Google indexing: the service-account JWT verifies against its public key, the
// token exchange sends a jwt-bearer grant, replies parse (including Google's bare
// `{ url }` publish reply and a 404 metadata), and ingest raises one alert per
// URL stuck past staleHours, keeps it through a failed poll, and closes it once
// the page is indexed.
import assert from "node:assert/strict"
import { generateKeyPairSync, createVerify } from "node:crypto"
import {
  accessToken, inProperty, isStuck, parseInspection, parseSitemap, parseSitemapIndex, publishUrl, signAssertion, urlMetadata,
} from "../vendor/plugins/plugins/monitoring/googleIndexing"
import { sqlClient } from "../server/fleet/db"
import { freshSql } from "./sqlite"
import { ingest } from "../server/fleet/ingest"
import { hashKey } from "../server/fleet/keys"

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
const key = { client_email: "sa@p.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }) as string }

// JWT
const jwt = await signAssertion(key, ["s1", "s2"], 1000)
const [h, c, sig] = jwt.split(".")
const dec = (s: string) => JSON.parse(Buffer.from(s, "base64url").toString())
assert.deepEqual(dec(h), { alg: "RS256", typ: "JWT" })
assert.deepEqual(dec(c), { iss: key.client_email, scope: "s1 s2", aud: "https://oauth2.googleapis.com/token", iat: 1000, exp: 4600 })
assert.ok(createVerify("RSA-SHA256").update(`${h}.${c}`).verify(publicKey, Buffer.from(sig, "base64url")), "signature verifies")

// token exchange, cached per scope
let posts = 0
const fake = (routes: Record<string, (init: any) => [number, any]>) => (async (u: any, init: any = {}) => {
  const k = Object.keys(routes).find((r) => String(u).startsWith(r))!
  const [status, body] = routes[k](init)
  return new Response(JSON.stringify(body), { status })
}) as typeof fetch
const tokenFetch = fake({ "https://oauth2.googleapis.com/token": (init) => {
  posts++
  const p = new URLSearchParams(init.body)
  assert.equal(p.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer")
  assert.equal(p.get("assertion")!.split(".").length, 3)
  return [200, { access_token: "ya29.x", expires_in: 3599 }]
} })
assert.equal(await accessToken(key, ["s1"], tokenFetch), "ya29.x")
assert.equal(await accessToken(key, ["s1"], tokenFetch), "ya29.x")
assert.equal(posts, 1, "token reused")

// inspection
const insp = parseInspection("https://jobs.example.com/job/a/", {
  inspectionResult: {
    inspectionResultLink: "https://search.google.com/search-console/inspect?resource_id=sc-domain:example.com&id=abc",
    indexStatusResult: { verdict: "NEUTRAL", coverageState: "Discovered - currently not indexed", robotsTxtState: "ROBOTS_TXT_STATE_UNSPECIFIED", indexingState: "INDEXING_STATE_UNSPECIFIED", pageFetchState: "PAGE_FETCH_STATE_UNSPECIFIED" },
  },
})
assert.equal(insp.coverageState, "Discovered - currently not indexed")
assert.equal(insp.lastCrawlTime, undefined)
assert.match(insp.link!, /id=abc/)
assert.ok(isStuck(insp.coverageState) && isStuck("URL is unknown to Google") && !isStuck("Submitted and indexed"))

// publish: Google's bare { url } reply is accepted but not recorded
const g = fake({
  "https://indexing.googleapis.com/v3/urlNotifications:publish": () => [200, { urlNotificationMetadata: { url: "https://jobs.example.com/job/a/" } }],
  "https://indexing.googleapis.com/v3/urlNotifications/metadata?url=https%3A%2F%2Fjobs.example.com%2Fjob%2Fa%2F": () => [404, { error: { code: 404, message: "Requested entity was not found.", status: "NOT_FOUND" } }],
  "https://indexing.googleapis.com/v3/urlNotifications/metadata": () => [200, { url: "https://jobs.example.com/job/b/", latestUpdate: { type: "URL_UPDATED", notifyTime: "2026-11-03T10:00:00Z" } }],
})
assert.deepEqual(await publishUrl("t", "https://jobs.example.com/job/a/", "URL_UPDATED", g), { url: "https://jobs.example.com/job/a/", recorded: false })
assert.equal(await urlMetadata("t", "https://jobs.example.com/job/a/", g), null)
assert.deepEqual(await urlMetadata("t", "https://jobs.example.com/job/b/", g), { url: "https://jobs.example.com/job/b/", updated: "2026-11-03T10:00:00Z" })

// property scope and sitemaps
assert.ok(inProperty("https://jobs.example.com/x", "sc-domain:example.com"))
assert.ok(!inProperty("https://example.com.evil.net/x", "sc-domain:example.com"))
assert.ok(!inProperty("https://other.com/", "https://example.com/"))
const sm = parseSitemap(`<urlset><url><loc>https://a/1</loc><lastmod>2026-09-01T00:00:00Z</lastmod></url><url><loc>https://a/2?x=1&amp;y=2</loc><lastmod>2026-10-01T00:00:00Z</lastmod></url></urlset>`)
assert.deepEqual(sm.map((e) => e.url), ["https://a/2?x=1&y=2", "https://a/1"])
const idx = parseSitemapIndex(`<sitemapindex><sitemap><loc>https://a/post-sitemap.xml</loc><lastmod>2026-01-01T00:00:00Z</lastmod></sitemap><sitemap><loc>https://a/post-sitemap9.xml</loc><lastmod>2026-11-05T00:00:00Z</lastmod></sitemap></sitemapindex>`)
assert.deepEqual(idx.map((e) => e.url), ["https://a/post-sitemap9.xml", "https://a/post-sitemap.xml"], "index children, newest first")
assert.deepEqual(parseSitemapIndex("<urlset><url><loc>https://a/1</loc></url></urlset>"), [], "a urlset is not an index")

// ingest
const db = sqlClient(freshSql())
const KEY = "sk_test_indexing"
await db.from("systems").insert({ user_id: "owner", name: "origin", slug: "origin", key_hash: await hashKey(KEY) }).select("id").single()
const ctx = { push: async () => {} }
const report = (body: any) => ingest(db, ctx, { headers: { "x-system-key": KEY, "x-unique-id": "indexing-0", "x-type": "indexing" }, body, clientIp: "10.0.0.1" })
const open = async () => (await db.from("notifications").select("source_detail, type, title").is("resolved_at", null)).data
const old = new Date(Date.now() - 5 * 86400_000).toISOString()
const fresh = new Date().toISOString()
const url = (u: string, since: string, stuck = true) => ({ url: u, since, stuck, verdict: stuck ? "NEUTRAL" : "PASS", coverageState: stuck ? "Discovered - currently not indexed" : "Submitted and indexed", notify: null })

await report({ site: "sc-domain:example.com", staleHours: 72, urls: [url("https://jobs.example.com/old", old), url("https://jobs.example.com/new", fresh)] })
let o = await open()
assert.equal(o.length, 1, "only the URL past staleHours alerts")
assert.equal(o[0].source_detail, "idx:https://jobs.example.com/old")
assert.match(o[0].title, /Not indexed after 5d/)
const { data: cs } = await db.from("client_states").select("status, status_reason").eq("unique_id", "indexing-0").single()
assert.equal(cs.status, "warning")

await report({ site: "sc-domain:example.com", error: "HTTP 500" })
assert.ok((await open()).some((n: any) => n.source_detail === "idx:https://jobs.example.com/old"), "a failed poll does not resolve the URL alert")

await report({ site: "sc-domain:example.com", staleHours: 72, urls: [url("https://jobs.example.com/old", old, false)] })
assert.ok(!(await open()).some((n: any) => n.source_detail.startsWith("idx:")), "indexed resolves")

console.log("indexing check: ok")
