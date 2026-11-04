// A Cloudflare reporter's push. Same path, headers and response as before the
// move. The judging happens inside the fleet's DO.
import { fleet } from "../../utils/fleet"

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  if (JSON.stringify(body ?? null).length > 8_388_608) {
    throw createError({ statusCode: 413, message: "Too large for a Cloudflare push" })
  }
  const headers = getRequestHeaders(event)
  const alias = getQuery(event).alias
  const r = await fleet(event).cloudflarePush({
    headers,
    alias: typeof alias === "string" && alias ? alias : null,
    body,
    clientIp: headers["cf-connecting-ip"] || headers["x-forwarded-for"] || null,
  })
  if (!r.ok) throw createError({ statusCode: r.statusCode, message: r.message })
  return r.value
})
