// Google Indexing API and Search Console URL Inspection on a service account.
//
// Pure on purpose: WebCrypto and fetch only, no Node imports, so the agent
// plugin (IndexingPlugin) and the tenant Worker (MCP tools) share this file.
// The tenant vendors it through scripts/sync-shared.sh.
//
// The service account must be an Owner of the Search Console property for
// publish to count, and a user of it (any level) for inspection.

export interface ServiceAccountKey {
  client_email: string
  private_key: string
  token_uri?: string
}

export const SCOPES = {
  indexing: "https://www.googleapis.com/auth/indexing",
  inspect: "https://www.googleapis.com/auth/webmasters.readonly",
}
const TOKEN_URL = "https://oauth2.googleapis.com/token"
const INDEXING = "https://indexing.googleapis.com/v3/urlNotifications"
const INSPECT = "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect"

type Fetch = typeof fetch

const b64url = (bytes: Uint8Array | string) => {
  const s = typeof bytes === "string" ? bytes : String.fromCharCode(...bytes)
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}
const utf8 = (s: string) => new TextEncoder().encode(s)

export function parseKey(json: string | object): ServiceAccountKey {
  const k: any = typeof json === "string" ? JSON.parse(json) : json
  if (!k?.client_email || !k?.private_key) throw new Error("service account key needs client_email and private_key")
  return k
}

/** A signed RS256 JWT asking Google's token endpoint for these scopes. */
export async function signAssertion(key: ServiceAccountKey, scopes: string[], now = Math.floor(Date.now() / 1000)): Promise<string> {
  const der = Uint8Array.from(atob(key.private_key.replace(/-----[^-]+-----|\s/g, "")), (c) => c.charCodeAt(0))
  const pk = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"])
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))
  const claims = b64url(JSON.stringify({
    iss: key.client_email,
    scope: scopes.join(" "),
    aud: key.token_uri || TOKEN_URL,
    iat: now,
    exp: now + 3600,
  }))
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pk, utf8(`${head}.${claims}`)))
  return `${head}.${claims}.${b64url(sig)}`
}

async function json(res: Response): Promise<any> {
  const body: any = await res.json().catch(() => ({}))
  if (!res.ok) {
    const e: any = new Error(body?.error_description || body?.error?.message || (typeof body?.error === "string" ? body.error : "") || `HTTP ${res.status}`)
    e.status = res.status
    e.code = typeof body?.error === "string" ? body.error : body?.error?.status
    throw e
  }
  return body
}

// One token per key and scope set, reused until five minutes before it ends.
const tokens = new Map<string, { token: string; until: number }>()

export async function accessToken(key: ServiceAccountKey, scopes: string[], f: Fetch = fetch): Promise<string> {
  const id = `${key.client_email} ${scopes.join(" ")}`
  const had = tokens.get(id)
  if (had && had.until > Date.now()) return had.token
  const r = await json(await f(key.token_uri || TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: await signAssertion(key, scopes),
    }).toString(),
  }))
  tokens.set(id, { token: r.access_token, until: Date.now() + (Number(r.expires_in) || 3600) * 1000 - 300_000 })
  return r.access_token
}

// ---- URL Inspection ---------------------------------------------------------

export interface Inspection {
  url: string
  verdict: string
  coverageState: string
  indexingState?: string
  lastCrawlTime?: string
  pageFetchState?: string
  robotsTxtState?: string
  googleCanonical?: string
  userCanonical?: string
  crawledAs?: string
  /** The GSC page for this inspection. It carries an opaque id, so a raw URL can't stand in for it. */
  link?: string
}

/** Coverage states that mean Google knows of the page, or should, and hasn't indexed it. */
export const NOT_INDEXED = [
  "Discovered - currently not indexed",
  "URL is unknown to Google",
  "Crawled - currently not indexed",
]
export const isStuck = (coverageState?: string) => !!coverageState && NOT_INDEXED.some((s) => s.toLowerCase() === coverageState.toLowerCase())

export function parseInspection(url: string, r: any): Inspection {
  const idx = r?.inspectionResult?.indexStatusResult || {}
  const out: Inspection = {
    url,
    verdict: String(idx.verdict || "VERDICT_UNSPECIFIED"),
    coverageState: String(idx.coverageState || ""),
  }
  const opt = {
    indexingState: idx.indexingState, lastCrawlTime: idx.lastCrawlTime, pageFetchState: idx.pageFetchState,
    robotsTxtState: idx.robotsTxtState, googleCanonical: idx.googleCanonical, userCanonical: idx.userCanonical,
    crawledAs: idx.crawledAs, link: r?.inspectionResult?.inspectionResultLink,
  }
  for (const [k, v] of Object.entries(opt)) if (v) (out as any)[k] = String(v)
  return out
}

export async function inspectUrl(token: string, url: string, siteUrl: string, f: Fetch = fetch): Promise<Inspection> {
  const r = await json(await f(INSPECT, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ inspectionUrl: url, siteUrl, languageCode: "en-US" }),
  }))
  return parseInspection(url, r)
}

// ---- Indexing API -----------------------------------------------------------

export type NotifyType = "URL_UPDATED" | "URL_DELETED"

export interface NotifyMetadata {
  url: string
  /** Last URL_UPDATED Google recorded for this URL. */
  updated?: string
  /** Last URL_DELETED. */
  deleted?: string
}

/**
 * urlNotificationMetadata -> the notify times. Google often answers a publish
 * with only `{ url }` and no latestUpdate, and metadata for that URL then 404s:
 * the call was accepted (it counts against quota) but nothing was recorded.
 */
export function parseMetadata(url: string, r: any): NotifyMetadata {
  const m = r?.urlNotificationMetadata || r || {}
  const out: NotifyMetadata = { url: String(m.url || url) }
  if (m.latestUpdate?.notifyTime) out.updated = String(m.latestUpdate.notifyTime)
  if (m.latestRemove?.notifyTime) out.deleted = String(m.latestRemove.notifyTime)
  return out
}

export async function publishUrl(token: string, url: string, type: NotifyType = "URL_UPDATED", f: Fetch = fetch): Promise<NotifyMetadata & { recorded: boolean }> {
  const r = await json(await f(`${INDEXING}:publish`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ url, type }),
  }))
  const m = parseMetadata(url, r)
  return { ...m, recorded: !!(m.updated || m.deleted) }
}

/** Notify history for one URL, or null when Google has none on record (404). */
export async function urlMetadata(token: string, url: string, f: Fetch = fetch): Promise<NotifyMetadata | null> {
  try {
    return parseMetadata(url, await json(await f(`${INDEXING}/metadata?url=${encodeURIComponent(url)}`, {
      headers: { Authorization: `Bearer ${token}` },
    })))
  } catch (e: any) {
    if (e?.status === 404) return null
    throw e
  }
}

/** Is this URL inside the Search Console property? sc-domain:x covers x and its subdomains. */
export function inProperty(url: string, siteUrl: string): boolean {
  let u: URL
  try { u = new URL(url) } catch { return false }
  if (siteUrl.startsWith("sc-domain:")) {
    const d = siteUrl.slice(10).toLowerCase()
    const h = u.hostname.toLowerCase()
    return h === d || h.endsWith(`.${d}`)
  }
  return url.startsWith(siteUrl)
}

// ---- sitemaps ---------------------------------------------------------------

/** A urlset sitemap -> its URLs with lastmod, newest first. */
export function parseSitemap(xml: string): { url: string; lastmod?: string }[] {
  const out: { url: string; lastmod?: string }[] = []
  for (const m of xml.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
    const loc = /<loc>\s*([^<]+?)\s*<\/loc>/.exec(m[1])?.[1]
    const lastmod = /<lastmod>\s*([^<]+?)\s*<\/lastmod>/.exec(m[1])?.[1]
    if (loc) out.push({ url: loc.replace(/&amp;/g, "&"), ...(lastmod ? { lastmod } : {}) })
  }
  return out.sort((a, b) => (Date.parse(b.lastmod || "") || 0) - (Date.parse(a.lastmod || "") || 0))
}
