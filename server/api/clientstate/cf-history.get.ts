// A zone's accumulated daily traffic.
import { fleet } from "../../utils/fleet"
import { requireIdentity } from "../../utils/session"

export default defineEventHandler(async (event) => {
  const q = getQuery(event)
  const str = (v: unknown) => (typeof v === "string" ? v : "")
  const r = await fleet(event).cfHistory(await requireIdentity(event), str(q.id), str(q.range) || "90d")
  if (!r.ok) throw createError({ statusCode: r.statusCode, message: r.message })
  return r.value
})
