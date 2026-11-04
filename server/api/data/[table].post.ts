// Insert one row or several. Returns the rows written.
import { fleet } from "../../utils/fleet"
import { requireIdentity } from "../../utils/session"

export default defineEventHandler(async (event) => {
  const r = await fleet(event).data(await requireIdentity(event), "insert", getRouterParam(event, "table") || "", { body: await readBody(event) })
  if (!r.ok) throw createError({ statusCode: r.statusCode, message: r.message })
  return r.value
})
