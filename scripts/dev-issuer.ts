/**
 * A stand-in for daemonitor.com's token issuer, for local dev and the checks,
 * until the real one exists. It signs the same shape of token Better Auth's JWT
 * plugin will (Ed25519, kid, iss, aud, sub, email, email_verified, exp) and
 * serves its public key at /api/auth/jwks.
 *
 *   pnpm dev:issuer                       serve on :8792, key kept in .dev-issuer.json
 *   pnpm dev:token <aud> [sub] [email]    print a 10-minute token for that tenant
 *
 * Point a local tenant at it with DAEMONITOR_ISSUER=http://localhost:8792 in .dev.vars.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"

const b64url = (b: Uint8Array | string) =>
  Buffer.from(typeof b === "string" ? new TextEncoder().encode(b) : b).toString("base64url")

export async function makeIssuer(iss: string, saved?: { kid: string; privateJwk: JsonWebKey; publicJwk: JsonWebKey }) {
  let kid: string, privateJwk: JsonWebKey, publicJwk: JsonWebKey
  if (saved) ({ kid, privateJwk, publicJwk } = saved)
  else {
    const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair
    privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey)
    publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey)
    kid = crypto.randomUUID()
  }
  const key = await crypto.subtle.importKey("jwk", privateJwk, { name: "Ed25519" }, false, ["sign"])
  return {
    saved: { kid, privateJwk, publicJwk },
    jwks: { keys: [{ ...publicJwk, kid, alg: "EdDSA", use: "sig" }] },
    async sign(claims: Record<string, unknown>, ttlSec = 600): Promise<string> {
      const now = Math.floor(Date.now() / 1000)
      const head = b64url(JSON.stringify({ alg: "EdDSA", typ: "JWT", kid }))
      const body = b64url(JSON.stringify({ iss, iat: now, exp: now + ttlSec, ...claims }))
      const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key, new TextEncoder().encode(`${head}.${body}`)))
      return `${head}.${body}.${b64url(sig)}`
    },
  }
}

const isMain = process.argv[1]?.endsWith("dev-issuer.ts")
if (isMain) {
  const PORT = 8792
  const ISS = `http://localhost:${PORT}`
  const FILE = new URL("../.dev-issuer.json", import.meta.url)
  const issuer = await makeIssuer(ISS, existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : undefined)
  writeFileSync(FILE, JSON.stringify(issuer.saved))

  const [mode, aud, sub = "dev-owner", email = "owner@example.test"] = process.argv.slice(2)
  if (mode === "token") {
    if (!aud) throw new Error("usage: pnpm dev:token <tenant origin> [sub] [email]")
    console.log(await issuer.sign({ aud, sub, email, email_verified: true }))
  } else {
    createServer((req, res) => {
      if (req.url === "/api/auth/jwks") {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify(issuer.jwks))
      } else {
        res.writeHead(404).end()
      }
    }).listen(PORT, () => console.log(`dev issuer on ${ISS}`))
  }
}
