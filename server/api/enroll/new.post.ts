// Mint an enrollment token, creating the system if this is a new one. Returns
// the one command to run on the host.
import { fleet } from "../../utils/fleet"
import { requireIdentity } from "../../utils/session"

export default defineEventHandler(async (event) => {
  const who = await requireIdentity(event)
  const body = await readBody(event)
  const r = await fleet(event).mintEnrollment(who, {
    systemId: body?.systemId ? String(body.systemId) : undefined,
    name: typeof body?.name === "string" ? body.name : "",
    plugins: Array.isArray(body?.plugins) ? body.plugins : [],
  }, getRequestURL(event).origin)
  if (!r.ok) throw createError({ statusCode: r.statusCode, message: r.message })
  return r.value
})
