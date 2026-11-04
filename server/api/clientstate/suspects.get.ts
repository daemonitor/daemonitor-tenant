// A zone's suspect-network reports, whole.
import { fleet } from "../../utils/fleet"
import { requireIdentity } from "../../utils/session"

export default defineEventHandler(async (event) => {
  const q = getQuery(event)
  const str = (v: unknown) => (typeof v === "string" ? v : "")
  const r = await fleet(event).suspects(await requireIdentity(event), str(q.id), str(q.range))
  if (!r.ok) throw createError({ statusCode: r.statusCode, message: r.message })
  return r.value
})
