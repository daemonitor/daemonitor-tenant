// The first sign-in to a freshly deployed tenant, with its claim code.
import { fleet } from "../../utils/fleet"
import { requireIdentity } from "../../utils/session"

export default defineEventHandler(async (event) => {
  const who = await requireIdentity(event)
  const body = await readBody(event)
  const r = await fleet(event).claimTenant(who, typeof body?.code === "string" ? body.code : "")
  if (!r.ok) throw createError({ statusCode: r.statusCode, message: r.message })
  return r.value
})
