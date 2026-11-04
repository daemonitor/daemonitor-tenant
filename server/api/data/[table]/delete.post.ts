// Delete by { id } or by the table's match columns, e.g. { group_id, service_id }.
// POST, not DELETE: Nitro on Workers drops a DELETE's body.
import { fleet } from "../../../utils/fleet"
import { requireIdentity } from "../../../utils/session"

export default defineEventHandler(async (event) => {
  const r = await fleet(event).data(await requireIdentity(event), "delete", getRouterParam(event, "table") || "", { body: await readBody(event) })
  if (!r.ok) throw createError({ statusCode: r.statusCode, message: r.message })
  return r.value
})
