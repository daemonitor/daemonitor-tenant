// One service's detail series, for a range or an explicit from/to.
import { fleet } from "../../utils/fleet"
import { requireIdentity } from "../../utils/session"

export default defineEventHandler(async (event) => {
  const q = getQuery(event)
  const str = (v: unknown) => (typeof v === "string" ? v : "")
  const r = await fleet(event).serviceHistory(await requireIdentity(event), { id: str(q.id), range: str(q.range), from: str(q.from), to: str(q.to), limit: Number(q.limit) || 0 })
  if (!r.ok) throw createError({ statusCode: r.statusCode, message: r.message })
  return r.value
})
