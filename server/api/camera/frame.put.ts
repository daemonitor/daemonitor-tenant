// An agent's camera frame: a JPEG body, the same key and unique id headers as a report.
import { fleet } from "../../utils/fleet"
import { MAX_FRAME_BYTES } from "../../fleet/frames"

export default defineEventHandler(async (event) => {
  if (Number(getRequestHeader(event, "content-length") || 0) > MAX_FRAME_BYTES) {
    throw createError({ statusCode: 413, message: `A frame may be at most ${MAX_FRAME_BYTES} bytes` })
  }
  const body = await readRawBody(event, false)
  const r = await fleet(event).putFrame({
    key: getRequestHeader(event, "x-system-key") || "",
    uniqueId: getRequestHeader(event, "x-unique-id") || "",
    bytes: new Uint8Array(body || []),
  })
  if (!r.ok) throw createError({ statusCode: r.statusCode, message: r.message })
  return r.value
})
