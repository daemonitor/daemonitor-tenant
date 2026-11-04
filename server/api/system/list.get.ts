// The systems the caller may see, without the key hashes.
import { fleet } from "../../utils/fleet"
import { requireIdentity } from "../../utils/session"

export default defineEventHandler(async (event) => {
  const r = await fleet(event).listSystems(await requireIdentity(event))
  if (!r.ok) throw createError({ statusCode: r.statusCode, message: r.message })
  return r.value
})
