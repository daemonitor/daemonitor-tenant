// A group inside a group is a member whose service_id is `group:<id>`. Everything that
// draws a group wants the services inside it, however deep, so that lives here. Pure,
// so the browser and the external API read a nested group the same way.

export type GroupMemberRow = { service_id: string; part?: string | null }
/** One service inside a group, and the domain to scope it to. */
export type GroupLeaf = { service_id: string; part?: string | null; domain?: string | null }

export const groupRef = (id: string) => `group:${id}`
export const groupOfRef = (serviceId: string) => (serviceId.startsWith('group:') ? serviceId.slice(6) : null)

/** The ids of the groups held directly by a group. */
export const childGroupIds = (rows: GroupMemberRow[] = []) =>
  rows.map((m) => groupOfRef(m.service_id)).filter((id): id is string => !!id)

/** A group's own id and every group below it. The visited set is what stops a cycle. */
export function groupsInside(id: string, byGroup: Map<string, GroupMemberRow[]>, seen = new Set<string>()) {
  if (seen.has(id)) return seen
  seen.add(id)
  for (const child of childGroupIds(byGroup.get(id))) groupsInside(child, byGroup, seen)
  return seen
}

/**
 * Every service inside a group, once each. A member takes its nearest group's domain, so a
 * site's AdSense row stays that site's under a parent. Reached through two domains, it is
 * shown unscoped: it stands for both, and picking one would read as the parent's total.
 */
export function groupLeaves(
  id: string,
  byGroup: Map<string, GroupMemberRow[]>,
  domainOf: (id: string) => string | null | undefined = () => null,
): GroupLeaf[] {
  const out = new Map<string, GroupLeaf>()
  const seen = new Set<string>()
  const walk = (gid: string, inherited?: string | null) => {
    if (seen.has(gid)) return
    seen.add(gid)
    const domain = domainOf(gid) || inherited || null
    for (const m of byGroup.get(gid) || []) {
      const child = groupOfRef(m.service_id)
      if (child) { walk(child, domain); continue }
      const had = out.get(m.service_id)
      if (!had) out.set(m.service_id, { service_id: m.service_id, part: m.part, domain })
      else if (had.domain !== domain) had.domain = null
    }
  }
  walk(id)
  return [...out.values()]
}

/** A flat list of groups, each child after its parent, with how deep it sits. */
export function treeOrder<T extends { id: string }>(items: T[], byGroup: Map<string, GroupMemberRow[]>): (T & { depth: number })[] {
  const byId = new Map(items.map((g) => [g.id, g]))
  const nested = new Set(items.flatMap((g) => childGroupIds(byGroup.get(g.id))))
  const seen = new Set<string>()
  const out: (T & { depth: number })[] = []
  const visit = (g: T, depth: number) => {
    if (seen.has(g.id)) return
    seen.add(g.id)
    out.push({ ...g, depth })
    for (const c of childGroupIds(byGroup.get(g.id))) {
      const child = byId.get(c)
      if (child) visit(child, depth + 1)
    }
  }
  for (const g of items) if (!nested.has(g.id)) visit(g, 0)
  // Only a cycle has no root to be reached from.
  for (const g of items) visit(g, 0)
  return out
}
