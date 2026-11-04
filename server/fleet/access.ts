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
