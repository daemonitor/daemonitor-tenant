/**
 * daemonitor.com's public keys, cached per isolate, and the one call that turns
 * a bearer token into an Identity for this tenant. Plain fetch and env, so the
 * WebSocket upgrade can use it outside Nitro.
 */
import { verifyToken, type Identity } from "./jwt"

let cache: { at: number; issuer: string; keys: JsonWebKey[] } | null = null
const KEYS_TTL_MS = 10 * 60 * 1000

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

export function issuerOf(env: any): string {
  return String(env?.DAEMONITOR_ISSUER || "https://daemonitor.com").replace(/\/$/, "")
}

/** Throws TokenError for a bad token, anything else when the issuer can't be reached. */
export function identify(token: string, env: any, origin: string): Promise<Identity> {
  const issuer = issuerOf(env)
  return verifyToken(token, { issuer, audience: origin, jwks: (r) => jwks(issuer, r) })
}
