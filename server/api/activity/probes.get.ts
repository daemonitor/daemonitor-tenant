// Daily probe counts for every zone the caller can see.
import { fleet } from "../../utils/fleet"
import { requireIdentity } from "../../utils/session"

export default defineEventHandler(async (event) => {
  const r = await fleet(event).probes(await requireIdentity(event))
  if (!r.ok) throw createError({ statusCode: r.statusCode, message: r.message })
  return r.value
})
