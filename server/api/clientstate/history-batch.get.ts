// Short series for every service on the board, keyed by client_states.id.
import { fleet } from "../../utils/fleet"
import { requireIdentity } from "../../utils/session"

export default defineEventHandler(async (event) => {
  const q = getQuery(event)
  const str = (v: unknown) => (typeof v === "string" ? v : "")
  const r = await fleet(event).historyBatch(await requireIdentity(event), str(q.range) || "1h")
  if (!r.ok) throw createError({ statusCode: r.statusCode, message: r.message })
  return r.value
})
