/**
 * Checking a daemonitor.com session token.
 *
 * daemonitor.com signs who you are, and publishes the public half of its key
 * as a JWKS. The tenant checks the signature, that the token was issued by the
 * issuer it trusts, that it was issued for THIS tenant (aud is the tenant's
 * origin), and that it hasn't expired. Who may do what is the tenant's own
 * decision, made from its members table, never from the token.
 *
 * The aud check is what stops a hostile tenant's operator from taking a
 * visitor's token and replaying it against someone else's tenant.
 */

export interface Identity {
  sub: string
  email: string | null
  emailVerified: boolean
  /** When the token stops being good, in epoch seconds. A live socket is closed then. */
  exp?: number
}

type Jwk = JsonWebKey & { kid?: string; alg?: string }

/** Clock skew allowed on exp and nbf, in seconds. */
const LEEWAY = 60

const b64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0))
const json = (s: string) => JSON.parse(new TextDecoder().decode(b64url(s)))

function algFor(jwk: Jwk): { importAlg: any; verifyAlg: any } | null {
  if (jwk.kty === "OKP" && jwk.crv === "Ed25519") return { importAlg: { name: "Ed25519" }, verifyAlg: { name: "Ed25519" } }
  if (jwk.kty === "EC" && jwk.crv === "P-256") return { importAlg: { name: "ECDSA", namedCurve: "P-256" }, verifyAlg: { name: "ECDSA", hash: "SHA-256" } }
  return null
}

export class TokenError extends Error {}

/**
 * Verify `token` against the keys `jwks()` returns.
 * `jwks(true)` asks for a fresh copy, used once when the token's kid is unknown
 * (the issuer rotated its key since the last fetch).
 */
export async function verifyToken(
  token: string,
  opts: { issuer: string; audience: string; jwks: (refresh?: boolean) => Promise<Jwk[]>; now?: number },
): Promise<Identity> {
  const parts = token.split(".")
  if (parts.length !== 3) throw new TokenError("malformed token")
  let header: any, claims: any
  try {
    header = json(parts[0])
    claims = json(parts[1])
  } catch {
    throw new TokenError("malformed token")
  }

  let keys = await opts.jwks()
  let jwk = keys.find((k) => k.kid === header.kid)
  if (!jwk) {
    keys = await opts.jwks(true)
    jwk = keys.find((k) => k.kid === header.kid)
  }
  if (!jwk) throw new TokenError("unknown signing key")
  const alg = algFor(jwk)
  // The token's own alg header only ever picks among OUR keys, never the algorithm.
  if (!alg) throw new TokenError("unsupported key type")

  // Key material only. A published key's alg, key_ops or use can disagree with
  // what this runtime expects (Node writes alg "Ed25519", workerd wants "EdDSA";
  // a key exported from its private half says key_ops ["sign"]), and kty/crv
  // already decide everything.
  const material = jwk.kty === "OKP" ? { kty: jwk.kty, crv: jwk.crv, x: (jwk as any).x } : { kty: jwk.kty, crv: jwk.crv, x: (jwk as any).x, y: (jwk as any).y }
  const key = await crypto.subtle.importKey("jwk", material, alg.importAlg, false, ["verify"])
  const ok = await crypto.subtle.verify(alg.verifyAlg, key, b64url(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`))
  if (!ok) throw new TokenError("bad signature")

  const now = Math.floor((opts.now ?? Date.now()) / 1000)
  if (claims.iss !== opts.issuer) throw new TokenError("wrong issuer")
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  if (!aud.includes(opts.audience)) throw new TokenError("token is for another tenant")
  if (typeof claims.exp !== "number" || claims.exp + LEEWAY < now) throw new TokenError("token expired")
  if (typeof claims.nbf === "number" && claims.nbf - LEEWAY > now) throw new TokenError("token not yet valid")
  if (typeof claims.sub !== "string" || !claims.sub) throw new TokenError("token has no subject")

  return { sub: claims.sub, email: typeof claims.email === "string" ? claims.email.toLowerCase() : null, emailVerified: claims.email_verified === true, exp: claims.exp }
}
