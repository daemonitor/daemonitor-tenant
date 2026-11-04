/**
 * Who may do what in this tenant. The token only says who someone is; this
 * decides, from the tenant's own members table.
 */
import type { Identity } from "./jwt"
import type { Db } from "./db"

export type Role = "owner" | "manager" | "viewer"

const RANK: Record<Role, number> = { viewer: 1, manager: 2, owner: 3 }

/**
 * The caller's role, or null. A member invited by email is matched on the
 * token's verified email the first time they arrive, and bound to their user
 * id from then on, so a later change of email doesn't lock them out.
 */
export async function roleOf(db: Db, who: Identity): Promise<Role | null> {
  const { data: byId } = await db.from("members").select("role").eq("user_id", who.sub).maybeSingle()
  if (byId) return byId.role
  if (!who.email || !who.emailVerified) return null
  const { data: bound } = await db.from("members")
    .update({ user_id: who.sub })
    .eq("email", who.email)
    .is("user_id", null)
    .select("role")
  return bound?.[0]?.role ?? null
}

export function atLeast(role: Role | null, need: Role): boolean {
  return !!role && RANK[role] >= RANK[need]
}

/** The tenant owner's user id: who a system belongs to, and who alerts reach first. */
export async function ownerId(db: Db): Promise<string | null> {
  const { data } = await db.from("members").select("user_id").eq("role", "owner").not("user_id", "is", null).limit(1)
  return data?.[0]?.user_id ?? null
}

/**
 * Everything a caller may read, decided once per request or socket.
 *
 * A member sees the whole tenant. Someone holding only grants sees:
 * - a system grant: that system and all its services;
 * - a group grant: the services in that group (not nested groups: sharing a
 *   parent never shared its children) and the systems they run on.
 * Alerts and events are system-level, so only system grants show them; a group
 * grantee would otherwise read about services they were never given.
 */
export type Scope =
  | { all: true; role: Role }
  | { all: false; systems: Set<string>; services: Set<string>; alertSystems: Set<string> }

export async function scopeOf(db: Db, who: Identity): Promise<Scope | null> {
  const role = await roleOf(db, who)
  if (role) return { all: true, role }

  if (who.email && who.emailVerified) {
    await db.from("grants").update({ grantee_id: who.sub }).eq("grantee_email", who.email).is("grantee_id", null)
  }
  const { data: grants } = await db.from("grants").select("resource_type, resource_id").eq("grantee_id", who.sub)
  if (!grants?.length) return null

  const alertSystems = new Set<string>(grants.filter((g: any) => g.resource_type === "system").map((g: any) => g.resource_id))
  const groupIds = grants.filter((g: any) => g.resource_type === "group").map((g: any) => g.resource_id)
  const services = new Set<string>()
  const systems = new Set<string>(alertSystems)
  if (groupIds.length) {
    const { data: members } = await db.from("group_members").select("service_id").in("group_id", groupIds)
    const ids = (members || []).map((m: any) => m.service_id).filter((id: string) => !id.includes(":"))
    const { data: states } = await db.from("client_states").select("id, system_id").in("id", ids)
    for (const s of states || []) {
      services.add(s.id)
      systems.add(s.system_id)
    }
  }
  return { all: false, systems, services, alertSystems }
}

/** Whether a client_states row is inside the scope. */
export function seesService(scope: Scope, row: { id: string; system_id: string }): boolean {
  return scope.all || scope.alertSystems.has(row.system_id) || scope.services.has(row.id)
}
