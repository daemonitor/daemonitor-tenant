// An agent's report. Same path, headers and response as before the move, so
// agents only change their endpoint. The judging happens inside the fleet's DO.
import { fleet } from "../../utils/fleet"

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  if (JSON.stringify(body ?? null).length > 1_048_576) {
    throw createError({ statusCode: 413, message: "Too large for a report" })
  }
  const headers = getRequestHeaders(event)
  const r = await fleet(event).ingest({
    headers,
    body,
    clientIp: headers["cf-connecting-ip"] || headers["x-forwarded-for"] || null,
  })
  if (!r.ok) throw createError({ statusCode: r.statusCode, message: r.message })
  return r.value
})
