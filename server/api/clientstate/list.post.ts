// Every service the caller may see, shaped as the frontend route shaped them.
import { fleet } from "../../utils/fleet"
import { requireIdentity } from "../../utils/session"

export default defineEventHandler(async (event) => {
  const r = await fleet(event).listClientStates(await requireIdentity(event))
  if (!r.ok) throw createError({ statusCode: r.statusCode, message: r.message })
  return r.value
})
