// An agent trading its single-use enrollment token for a system key.
import { fleet } from "../../utils/fleet"

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const ip = getRequestHeader(event, "cf-connecting-ip") || getRequestHeader(event, "x-forwarded-for") || null
  const r = await fleet(event).claimEnrollment(body, ip, getRequestURL(event).origin)
  if (!r.ok) throw createError({ statusCode: r.statusCode, message: r.message })
  return r.value
})
