// The tenant's archived months in its R2 bucket. Members only.
import { runOp } from "../../utils/op"

export default defineEventHandler(async (event) => {
  await runOp(event, "archiveAccess", {}, "session")
  const bucket = (event.context.cloudflare.env as any).ARCHIVE as R2Bucket
  const items: { account: string; month: string; size: number; uploaded: string }[] = []
  let cursor: string | undefined
  do {
    const listed = await bucket.list({ cursor })
    for (const o of listed.objects) {
      const m = o.key.match(/^(.+)\/(\d{4}-\d{2})\.json\.gz$/)
      if (m) items.push({ account: m[1], month: m[2], size: o.size, uploaded: o.uploaded.toISOString() })
    }
    cursor = listed.truncated ? listed.cursor : undefined
  } while (cursor)
  items.sort((a, b) => b.month.localeCompare(a.month))
  return { items }
})
