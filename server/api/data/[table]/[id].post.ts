// Update one row by id with the fields in the body. Returns the row.
import { fleet } from "../../../utils/fleet"
import { requireIdentity } from "../../../utils/session"

export default defineEventHandler(async (event) => {
  const r = await fleet(event).data(await requireIdentity(event), "update", getRouterParam(event, "table") || "", {
    id: getRouterParam(event, "id") || "",
    body: await readBody(event),
  })
  if (!r.ok) throw createError({ statusCode: r.statusCode, message: r.message })
  return r.value
})
