// One archived month, streamed from R2 still gzipped. Members only.
import { runOp } from "../../../utils/op"

export default defineEventHandler(async (event) => {
  const account = getRouterParam(event, "account") || ""
  const month = (getRouterParam(event, "month") || "").replace(/\.json(\.gz)?$/, "")
  if (!/^\d{4}-\d{2}$/.test(month)) throw createError({ statusCode: 400, statusMessage: "Bad month" })
  await runOp(event, "archiveAccess", {}, "session")
  const obj = await ((event.context.cloudflare.env as any).ARCHIVE as R2Bucket).get(`${account}/${month}.json.gz`)
  if (!obj) throw createError({ statusCode: 404, statusMessage: "No archive for that month" })
  setHeader(event, "Content-Type", "application/json")
  setHeader(event, "Content-Encoding", "gzip")
  setHeader(event, "Cache-Control", "private, max-age=3600")
  return obj.body
})
