// Run one housekeeping job now (reap, thin, clusterPurge, archive). Owner only.
import { fleet } from "../../utils/fleet"
import { requireIdentity } from "../../utils/session"

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const r = await fleet(event).runJob(await requireIdentity(event), String(body?.job || "") as any)
  if (!r.ok) throw createError({ statusCode: r.statusCode, message: r.message })
  return r.value
})
