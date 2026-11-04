// List a table's rows the caller may see. cluster_service_history takes ?ids=a,b&since=&limit=.
import { fleet } from "../../utils/fleet"
import { requireIdentity } from "../../utils/session"

export default defineEventHandler(async (event) => {
  const q = getQuery(event)
  const r = await fleet(event).data(await requireIdentity(event), "list", getRouterParam(event, "table") || "", {
    query: {
      ids: typeof q.ids === "string" && q.ids ? q.ids.split(",") : undefined,
      since: typeof q.since === "string" ? q.since : undefined,
      limit: Number(q.limit) || undefined,
    },
  })
  if (!r.ok) throw createError({ statusCode: r.statusCode, message: r.message })
  return r.value
})
