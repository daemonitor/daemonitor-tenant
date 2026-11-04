// The inbox, newest first, with the unread count.
import { fleet } from "../../utils/fleet"
import { requireIdentity } from "../../utils/session"

export default defineEventHandler(async (event) => {
  const q = getQuery(event)
  const r = await fleet(event).listNotifications(await requireIdentity(event), {
    limit: Number(q.limit) || undefined,
    offset: Number(q.offset) || undefined,
    unreadOnly: q.unreadOnly === "true",
    systemId: typeof q.systemId === "string" ? q.systemId : undefined,
    type: typeof q.type === "string" ? q.type : undefined,
  })
  if (!r.ok) throw createError({ statusCode: r.statusCode, message: r.message })
  return r.value
})
