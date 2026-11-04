import type { H3Event } from "h3"
import { verifyToken, TokenError, type Identity } from "../fleet/jwt"

/** The issuer's public keys, kept for ten minutes per isolate. */
let cache: { at: number; issuer: string; keys: JsonWebKey[] } | null = null
const KEYS_TTL_MS = 10 * 60 * 1000

function issuerOf(event: H3Event): string {
  const env = event.context.cloudflare.env as any
  return String(env.DAEMONITOR_ISSUER || "https://daemonitor.com").replace(/\/$/, "")
}

async function jwks(issuer: string, refresh = false): Promise<JsonWebKey[]> {
  if (!refresh && cache && cache.issuer === issuer && Date.now() - cache.at < KEYS_TTL_MS) return cache.keys
  // A refresh is asked for when a token names a key we don't have. Don't let a
  // stream of junk tokens turn that into a fetch per request.
  if (refresh && cache && cache.issuer === issuer && Date.now() - cache.at < 60_000) return cache.keys
  const res = await fetch(`${issuer}/api/auth/jwks`)
  if (!res.ok) throw new Error(`JWKS fetch failed: HTTP ${res.status}`)
  const keys = ((await res.json()) as { keys?: JsonWebKey[] }).keys || []
  cache = { at: Date.now(), issuer, keys }
  return keys
}

/**
 * Who is calling, from the daemonitor.com token in Authorization. Only says
 * who; what they may do is decided by the fleet DO from its members table.
 */
export async function requireIdentity(event: H3Event): Promise<Identity> {
  const token = getRequestHeader(event, "authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]
  if (!token) throw createError({ statusCode: 401, message: "Sign in to daemonitor.com first" })
  const issuer = issuerOf(event)
  try {
    return await verifyToken(token, { issuer, audience: getRequestURL(event).origin, jwks: (r) => jwks(issuer, r) })
  } catch (e: any) {
    if (e instanceof TokenError) throw createError({ statusCode: 401, message: `Invalid session: ${e.message}` })
    throw createError({ statusCode: 503, message: `Can't check sessions right now: ${e?.message || e}` })
  }
}
