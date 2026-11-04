import type { H3Event } from "h3"
import { TokenError, type Identity } from "../fleet/jwt"
import { identify } from "../fleet/issuer"

/**
 * Who is calling, from the daemonitor.com token in Authorization. Only says
 * who; what they may do is decided by the fleet DO from its members table.
 */
export async function requireIdentity(event: H3Event): Promise<Identity> {
  const token = getRequestHeader(event, "authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]
  if (!token) throw createError({ statusCode: 401, message: "Sign in to daemonitor.com first" })
  try {
    return await identify(token, event.context.cloudflare.env, getRequestURL(event).origin)
  } catch (e: any) {
    if (e instanceof TokenError) throw createError({ statusCode: 401, message: `Invalid session: ${e.message}` })
    throw createError({ statusCode: 503, message: `Can't check sessions right now: ${e?.message || e}` })
  }
}
