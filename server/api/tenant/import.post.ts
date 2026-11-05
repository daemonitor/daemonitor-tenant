// Rows from the Postgres fleet, one table's batch at a time: { table, rows, reset }.
// Owner only. See scripts/import-postgres.ts.
import { fleet } from "../../utils/fleet"
import { requireIdentity } from "../../utils/session"

export default defineEventHandler(async (event) => {
  const who = await requireIdentity(event)
  const body = await readBody(event)
  if (typeof body?.table !== "string" || !Array.isArray(body?.rows)) throw createError({ statusCode: 400, message: "Send { table, rows }" })
  const r = await fleet(event).importRows(who, body.table, body.rows, !!body.reset)
  if (!r.ok) throw createError({ statusCode: r.statusCode, message: r.message })
  return r.value
})
