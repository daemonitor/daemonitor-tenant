// The fleet's average cpu and mem over a window.
import { fleet } from "../../utils/fleet"
import { requireIdentity } from "../../utils/session"

export default defineEventHandler(async (event) => {
  const q = getQuery(event)
  const str = (v: unknown) => (typeof v === "string" ? v : "")
  const r = await fleet(event).overviewHistory(await requireIdentity(event), str(q.range) || "24h")
  if (!r.ok) throw createError({ statusCode: r.statusCode, message: r.message })
  return r.value
})
