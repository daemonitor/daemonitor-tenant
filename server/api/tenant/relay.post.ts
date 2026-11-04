// The secret this tenant signs relay calls to daemonitor.com with (push).
// Sent by daemonitor.com on the owner's behalf; owner only.
import { fleet } from "../../utils/fleet"
import { requireIdentity } from "../../utils/session"

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const r = await fleet(event).setRelaySecret(await requireIdentity(event), String(body?.secret || ""), getRequestURL(event).origin)
  if (!r.ok) throw createError({ statusCode: r.statusCode, message: r.message })
  return r.value
})
