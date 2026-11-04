/**
 * Live updates: every write to a watched table, sent to the open sockets that
 * may see it, in Supabase Realtime's payload shape ({ eventType, new, old }) so
 * the stores' handlers keep working.
 *
 * Replaces the Postgres publication plus a realtime server pinned to one Pi.
 */
import { seesService, type Scope } from "./access"
import { publicSystem } from "./reads"
import type { ChangeOp } from "./db"
import { TokenError, type Identity } from "./jwt"
import { identify } from "./issuer"

/**
 * The tables the old publication carried. Anything holding a secret
 * (notification_channels has Slack tokens, api_keys and enrollment_tokens have
 * hashes) or bulk history is deliberately not here.
 */
const LIVE_TABLES = new Set([
  "systems", "client_states", "notifications",
  "groups", "group_members", "views", "web_monitors",
  "clusters", "cluster_members", "cluster_services",
  "incidents", "incident_entries", "incident_targets",
  "members", "grants",
])

/** The payload for one changed row, or null if this viewer mustn't see it. */
export function liveMessage(scope: Scope, table: string, op: ChangeOp, row: Record<string, any>): Record<string, any> | null {
  if (!LIVE_TABLES.has(table)) return null
  const rec = table === "systems" ? publicSystem(row) : row
  const payload = { table, eventType: op, new: op === "DELETE" ? {} : rec, old: op === "DELETE" ? rec : { id: rec.id } }
  if (scope.all) {
    // Who's been invited is for the people who can invite.
    if ((table === "members" || table === "grants") && scope.role === "viewer") return null
    return payload
  }
  // A grantee sees only their slice. Groups, clusters and incidents are
  // whole-account records, so they reach grantees on the next REST resync,
  // filtered there, never raw over the socket.
  if (table === "systems") return scope.systems.has(row.id) ? payload : null
  if (table === "client_states") return seesService(scope, row as any) ? payload : null
  if (table === "notifications") return scope.alertSystems.has(row.system_id) ? payload : null
  return null
}

/** What a socket remembers across hibernation. */
export interface LiveAttachment {
  scope: { all: true; role: string } | { all: false; systems: string[]; services: string[]; alertSystems: string[] }
  /** Token expiry, epoch seconds. Past it the socket is closed with 4001 and the browser reconnects with a fresh token. */
  exp: number
}

export function toAttachment(scope: Scope, exp: number): LiveAttachment {
  return {
    exp,
    scope: scope.all
      ? { all: true, role: scope.role }
      : { all: false, systems: [...scope.systems], services: [...scope.services], alertSystems: [...scope.alertSystems] },
  }
}

export function fromAttachment(a: LiveAttachment): Scope {
  return a.scope.all
    ? { all: true, role: a.scope.role as any }
    : { all: false, systems: new Set(a.scope.systems), services: new Set(a.scope.services), alertSystems: new Set(a.scope.alertSystems) }
}

/** The subprotocol the browser offers alongside its token, and that we accept. */
export const LIVE_PROTOCOL = "daemonitor.v1"

/**
 * The Worker's half of opening a socket: check the token, then hand the
 * upgrade to the DO with the identity attached. Browsers can't set headers on
 * a WebSocket, so the token comes as the second offered subprotocol:
 * new WebSocket(url, ["daemonitor.v1", token]).
 */
export async function upgradeLive(request: Request, env: any, stub: { fetch(r: Request): Promise<Response> }): Promise<Response> {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("Expected a WebSocket", { status: 426 })
  const offered = (request.headers.get("sec-websocket-protocol") || "").split(",").map((s) => s.trim())
  const token = offered[0] === LIVE_PROTOCOL ? offered[1] : undefined
  if (!token) return new Response("Missing token", { status: 401 })
  let who: Identity
  try {
    who = await identify(token, env, new URL(request.url).origin)
  } catch (e: any) {
    return new Response(e instanceof TokenError ? `Invalid session: ${e.message}` : "Can't check sessions right now", { status: e instanceof TokenError ? 401 : 503 })
  }
  const headers = new Headers(request.headers)
  headers.set("x-daemonitor-identity", JSON.stringify(who))
  return stub.fetch(new Request(request.url, { headers }))
}
