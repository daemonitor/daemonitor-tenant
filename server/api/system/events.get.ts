// A system's alerts, open and resolved.
import { fleet } from "../../utils/fleet"
import { requireIdentity } from "../../utils/session"

export default defineEventHandler(async (event) => {
  const q = getQuery(event)
  const str = (v: unknown) => (typeof v === "string" ? v : "")
  const r = await fleet(event).systemEvents(await requireIdentity(event), { id: str(q.id), systemId: str(q.systemId), limit: Number(q.limit) || undefined, offset: Number(q.offset) || undefined, source: str(q.source), detail: str(q.detail), service: str(q.service) })
  if (!r.ok) throw createError({ statusCode: r.statusCode, message: r.message })
  return r.value
})
