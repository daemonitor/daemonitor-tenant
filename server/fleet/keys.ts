import type { Db } from "./db"

/** Hex SHA-256, the same hash the frontend stored as key_hash. */
export async function hashKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

/**
 * The system a key belongs to. Keys are stored as a SHA-256 hash. While a key
 * is being rotated the old one still works, and using it is recorded in
 * previous_key_used_at so the rotation can tell when the agent has moved on.
 */
export async function findSystemByKey(db: Db, key: string, columns: string) {
  const hash = await hashKey(key)
  const { data, error } = await db
    .from("systems")
    .select(`${columns}, previous_key_hash`)
    .or(`key_hash.eq.${hash},previous_key_hash.eq.${hash}`)
    .limit(1)
  const system = data?.[0] ?? null
  if (system?.previous_key_hash === hash) {
    await db.from("systems").update({ previous_key_used_at: new Date().toISOString() }).eq("id", system.id)
  }
  return { system, error }
}
