/**
 * Camera frames: the latest still from each camera, nothing older.
 *
 * Kept in the DO's key-value storage, one value per camera, so no table and no
 * schema version. A value tops out at 2 MB, hence MAX_FRAME_BYTES. Frames stay
 * out of client_states on purpose: a report is copied into history, and a frame
 * every 10 seconds would fill it.
 *
 * ponytail: a frame outlives its camera's row until the next upload or read
 * finds the row gone. Sweep `frame:` keys in maintenance if that ever adds up.
 */
import type { Db } from "./db"
import { HttpError } from "./ctx"
import { findSystemByKey } from "./keys"
import { seesService, type Scope } from "./access"

export const MAX_FRAME_BYTES = 1_900_000

/** The slice of DurableObjectStorage frames need. */
export interface FrameStore {
  get<T = unknown>(key: string): Promise<T | undefined>
  put<T>(key: string, value: T): Promise<void>
  delete(key: string): Promise<boolean>
}

export interface Frame {
  bytes: Uint8Array
  /** When the tenant received it, epoch ms. The camera's own clock is not trusted. */
  at: number
}

export interface FrameUpload {
  key: string
  uniqueId: string
  bytes: Uint8Array
}

const isJpeg = (b: Uint8Array) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8

/** An agent's upload. The camera must already have its row, from the plugin's first report. */
export async function putFrame(db: Db, store: FrameStore, up: FrameUpload) {
  if (!up.key) throw new HttpError(400, "Missing system key")
  if (!up.uniqueId) throw new HttpError(400, "Missing unique id")
  if (up.bytes.length > MAX_FRAME_BYTES) throw new HttpError(413, `A frame may be at most ${MAX_FRAME_BYTES} bytes`)
  if (!isJpeg(up.bytes)) throw new HttpError(415, "A frame must be a JPEG")
  const { system } = await findSystemByKey(db, up.key, "id")
  if (!system) throw new HttpError(404, "System not found")
  const { data } = await db
    .from("client_states")
    .select("id")
    .eq("system_id", system.id)
    .eq("unique_id", up.uniqueId)
    .eq("type", "camera")
    .eq("archived", false)
    .limit(1)
  const row = data?.[0]
  if (!row) throw new HttpError(404, "No camera with that unique id on this system; it reports before its first frame")
  const at = Date.now()
  await store.put<Frame>(`frame:${row.id}`, { bytes: up.bytes, at })
  return { at }
}

/** The latest frame of a camera the caller can see. Anything else is a 404, so ids can't be probed. */
export async function getFrame(db: Db, store: FrameStore, scope: Scope, id: string): Promise<Frame> {
  const { data } = await db.from("client_states").select("id, system_id, type, archived").eq("id", id).limit(1)
  const row = data?.[0]
  if (!row || row.type !== "camera" || !seesService(scope, row)) {
    if (!row) await store.delete(`frame:${id}`)
    throw new HttpError(404, "Not found")
  }
  const frame = await store.get<Frame>(`frame:${id}`)
  if (!frame) throw new HttpError(404, "No frame yet")
  return frame
}
