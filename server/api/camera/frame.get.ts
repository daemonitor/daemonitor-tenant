// A camera's latest frame, as a JPEG. `id` is the camera's client_states id.
import { runOp } from "../../utils/op"

export default defineEventHandler(async (event) => {
  const frame = (await runOp(event, "cameraFrame", { id: getQuery(event).id }, "key")) as { bytes: Uint8Array; at: number }
  setResponseHeaders(event, {
    "content-type": "image/jpeg",
    "cache-control": "private, no-store",
    "x-frame-at": String(frame.at),
    "access-control-expose-headers": "x-frame-at",
  })
  return frame.bytes
})
