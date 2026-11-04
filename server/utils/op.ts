import type { H3Event } from "h3"
import { fleet } from "./fleet"
import { requireIdentity } from "./session"
import type { OpAuth } from "../fleet/FleetDO"

export type AuthMode = "session" | "key" | "manage-key" | "none"

/** The API key a caller sent: x-api-key, or Bearer for MCP clients. */
export function apiKeyOf(event: H3Event): string {
  return getRequestHeader(event, "x-api-key") || getRequestHeader(event, "authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] || ""
}

/** Run one named operation in the fleet DO, as a session, an API key, or nobody (agents). */
export async function runOp(event: H3Event, name: string, args: unknown, mode: AuthMode) {
  const auth: OpAuth =
    mode === "session" ? { kind: "session", who: await requireIdentity(event) }
    : mode === "none" ? { kind: "none" }
    : { kind: "key", key: apiKeyOf(event), want: mode === "manage-key" ? "manage" : "read" }
  const r = await fleet(event).op(auth, name, args)
  if (!r.ok) throw createError({ statusCode: r.statusCode, message: r.message })
  return r.value
}
