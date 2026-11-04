// Token checks: right issuer, right tenant, unexpired, signed by a published key.
import assert from "node:assert/strict"
import { verifyToken } from "../server/fleet/jwt"
import { makeIssuer } from "../scripts/dev-issuer"

const ISS = "https://daemonitor.test"
const AUD = "https://fleet.acme.test"
const issuer = await makeIssuer(ISS)
let fetches = 0
const jwks = async () => { fetches++; return issuer.jwks.keys }
const check = (token: string, over: Partial<Parameters<typeof verifyToken>[1]> = {}) =>
  verifyToken(token, { issuer: ISS, audience: AUD, jwks, ...over })

const good = await issuer.sign({ aud: AUD, sub: "u1", email: "Owner@Acme.test", email_verified: true })
const id = await check(good)
assert.deepEqual({ ...id, exp: undefined }, { sub: "u1", email: "owner@acme.test", emailVerified: true, exp: undefined })
assert.ok(id.exp! > Date.now() / 1000, "carries the expiry for live sockets")

// the tenant's own origin, nothing else
await assert.rejects(check(await issuer.sign({ aud: "https://other.test", sub: "u1" })), /another tenant/)
await assert.rejects(check(good, { issuer: "https://evil.test" }), /wrong issuer/)
await assert.rejects(check(await issuer.sign({ aud: AUD, sub: "u1" }, -120)), /expired/)
await assert.rejects(check(await issuer.sign({ aud: AUD })), /no subject/)

// a signature from a key the issuer didn't publish
const stranger = await makeIssuer(ISS)
const forged = await stranger.sign({ aud: AUD, sub: "u1" })
const [h, p] = forged.split(".")
await assert.rejects(check(`${h}.${p}.${good.split(".")[2]}`), /unknown signing key|bad signature/)
// same kid, wrong key: tamper with the claims of a good token
const [gh, , gs] = good.split(".")
const tampered = `${gh}.${Buffer.from(JSON.stringify({ iss: ISS, aud: AUD, sub: "admin", exp: 9e9 })).toString("base64url")}.${gs}`
await assert.rejects(check(tampered), /bad signature/)

// an unknown kid asks for a fresh key set exactly once
fetches = 0
await assert.rejects(check(forged), /unknown signing key/)
assert.equal(fetches, 2)

await assert.rejects(check("not.a.token"), /malformed/)

console.log("auth.check: ok")
