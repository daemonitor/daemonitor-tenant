/**
 * The external API (/api/external/*) that the client portal, the CLI and MCP
 * read, with an API key. Response shapes are the frontend's, unchanged.
 *
 * A key acts as the person who made it, so what it sees is that person's
 * scope: everything for a member, their slice for a grantee. Organization-
 * scoped keys are gone with organizations; a tenant is one account.
 *
 * The fleet bundle (one system's services, normalized) is the frontend's
 * server/utils/fleetCompute.ts with the database calls swapped, and no cache:
 * it reads local SQLite now.
 */
import { clientStateToService, systemPlaceholderService, fmtBytes, type ClusterMemberHint } from "~/utils/fleetAdapter"
import { classifyMember } from "~/utils/clusterEval"
import { groupLeaves } from "~/utils/groupTree"
import { memPct, osTimes, directCpu } from "~/server/utils/metrics"
import type { Level, Metric, Service, Unit } from "~/types/fleet"
import { getClusterContexts, findClusterService } from "./clusters"
import { seesService, type Scope } from "./access"
import { publicSystem } from "./reads"
import { HttpError } from "./ctx"
import type { Db } from "./db"

// --- the fleet bundle (fleetCompute.ts) ----------------------------------------

function worstLevel(levels: Level[]): Level {
  if (levels.includes("crit")) return "crit"
  if (levels.includes("warn")) return "warn"
  if (levels.includes("ok")) return "ok"
  return "standby"
}

/** pm2 instances of one app become one row, as on the board. */
function combinePm2(list: Service[]): Service[] {
  const groups = new Map<string, Service[]>()
  for (const s of list) {
    if (!s.plugins.includes("pm2")) continue
    const key = `${s.stack}|${s.name}`
    groups.set(key, [...(groups.get(key) || []), s])
  }
  const emitted = new Set<string>()
  const out: Service[] = []
  for (const s of list) {
    if (!s.plugins.includes("pm2")) { out.push(s); continue }
    const key = `${s.stack}|${s.name}`
    if (emitted.has(key)) continue
    emitted.add(key)
    const arr = groups.get(key)!
    if (arr.length === 1) { out.push(arr[0]); continue }
    const online = arr.filter((x) => x.level === "ok").length
    const units: Unit[] = arr.map((x, i) => ({ name: `#${i}`, state: x.statusWord, value: `${x.cpu}%`, level: x.level }))
    const mem = arr.reduce((acc, x) => acc + (x.memBytes || 0), 0)
    const restarts = arr.reduce((acc, x) => acc + (x.restarts || 0), 0)
    const metrics: Metric[] = [
      { label: "STATUS", value: `${online}/${arr.length} ONLINE`, level: worstLevel(arr.map((x) => x.level)) },
      { label: "MEM", value: fmtBytes(mem), level: "ok" },
      { label: "RESTARTS", value: String(restarts), level: restarts > 5 ? "warn" : "ok" },
    ]
    out.push({
      ...arr[0], level: worstLevel(arr.map((x) => x.level)), cpu: Math.round(arr.reduce((acc, x) => acc + x.cpu, 0) / arr.length),
      hasBars: false, badge: `×${arr.length}`, statusWord: `${online}/${arr.length} online`, unitLabel: "INSTANCES",
      units, metrics, sparkline: [], age: Math.min(...arr.map((x) => x.age)),
    })
  }
  return out
}

/** Containers carry their host's disk, which they share. */
function finalizeServices(list: Service[]): Service[] {
  const osDisk = new Map<string, number>()
  for (const s of list) if (s.plugins.includes("os") && s.disk != null) osDisk.set(s.stack, s.disk)
  const out = combinePm2(list)
  for (const s of out) {
    if (s.plugins.includes("docker") || s.plugins.includes("lxc") || s.plugins.includes("lxc-container")) {
      const hd = osDisk.get(s.stack)
      if (hd != null) s.hostDisk = hd
    }
  }
  return out
}

function cfProjectStatus(project: any) {
  const d = project.latest_deployment
  let status = "online"
  let statusReason: string | null = null
  if (d) {
    const failed = Array.isArray(d.stages) ? d.stages.find((s: any) => s.status === "failure" || s.status === "error") : null
    if (failed) { status = "warning"; statusReason = `Failed at ${failed.name} stage` }
    if (d.status !== "success" && d.status !== "queued" && d.status !== "initializing") {
      status = "warning"
      statusReason = statusReason || `Deployment status: ${d.status}`
    }
  }
  return { status, statusReason }
}

/** One system and its services, normalized, limited to what the scope may see. */
async function systemBundle(db: Db, scope: Scope, systemId: string) {
  const { data: raw } = await db.from("systems").select("*").eq("id", systemId).maybeSingle()
  if (!raw || raw.archived) return null
  const system = publicSystem(raw)
  const { data: states } = await db.from("client_states").select("*").eq("system_id", systemId).eq("archived", false).order("updated_at", { ascending: false })
  const contexts = await getClusterContexts(db, systemId)
  const now = Date.now()
  const hint = (cs: any): ClusterMemberHint | undefined => {
    const hit = contexts.length ? findClusterService(contexts, cs.type, cs.unique_id) : undefined
    if (!hit) return undefined
    const { state } = classifyMember({ system, state: cs } as any, now, hit.svc.match_container)
    return { clusterName: hit.ctx.cluster.name, placed: state === "running" || state === "degraded" }
  }
  const services: Service[] = []
  for (const cs of (states || []).filter((r: any) => seesService(scope, r))) {
    if (cs.type === "cloudflare-workers") continue
    if (cs.type === "cloudflare" && cs.data?.pages?.projects) {
      const projects = [...cs.data.pages.projects].sort((a: any, b: any) => String(a.name || "").toLowerCase().localeCompare(String(b.name || "").toLowerCase()))
      for (const project of projects) {
        const { status, statusReason } = cfProjectStatus(project)
        services.push(clientStateToService({
          ...cs, id: `${cs.id}-${project.id}`, type: "cloudflare-project",
          data: { ...cs.data, project, name: project.name, accountId: cs.data.account, alias: cs.data.alias || "cloudflare" },
          status, status_reason: statusReason,
        } as any, system as any))
      }
    }
    services.push(clientStateToService(cs as any, system as any, hint(cs)))
  }
  // A system that has never reported still shows, as a placeholder row.
  if (!services.length) services.push(systemPlaceholderService(system as any))
  return { system, services: finalizeServices(services) }
}

const visibleSystemIds = async (db: Db, scope: Scope) =>
  scope.all ? ((await db.from("systems").select("id").eq("archived", false)).data || []).map((s: any) => s.id) : [...scope.systems]

// --- the routes ---------------------------------------------------------------

/** external/fleet: every visible system with its normalized services. */
export async function fleet(db: Db, scope: Scope) {
  const systems = []
  for (const id of await visibleSystemIds(db, scope)) {
    const b = await systemBundle(db, scope, id)
    if (b) systems.push({ ...b.system, services: b.services })
  }
  return { version: 1, generatedAt: new Date().toISOString(), systems }
}

/** external/fleet/:id */
export async function fleetSystem(db: Db, scope: Scope, systemId: string) {
  if (!scope.all && !scope.systems.has(systemId)) throw new HttpError(404, "System not found")
  const b = await systemBundle(db, scope, systemId)
  if (!b) throw new HttpError(404, "System not found")
  return { version: 1, generatedAt: new Date().toISOString(), system: b.system, services: b.services }
}

/** external/systems: raw rows with their raw states. */
export async function systems(db: Db, scope: Scope) {
  const ids = await visibleSystemIds(db, scope)
  const { data: rows } = await db.from("systems").select("*").in("id", ids).eq("archived", false)
  const { data: states } = await db.from("client_states").select("*").in("system_id", ids).eq("archived", false).order("updated_at", { ascending: false })
  const seen = (states || []).filter((s: any) => seesService(scope, s))
  return (rows || []).map((s: any) => ({ ...publicSystem(s), states: seen.filter((x: any) => x.system_id === s.id) }))
}

/** external/systems/:id */
export async function system(db: Db, scope: Scope, systemId: string) {
  const all = await systems(db, scope)
  const one = all.find((s: any) => s.id === systemId)
  if (!one) throw new HttpError(404, "System not found")
  return one
}

/** external/systems/:id/events: system alerts, for members and system grantees only. */
export async function events(db: Db, scope: Scope, systemId: string, q: { limit?: number; offset?: number; open?: boolean }) {
  if (!(scope.all || scope.alertSystems.has(systemId))) throw new HttpError(404, "System not found")
  const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200)
  const offset = Math.max(Number(q.offset) || 0, 0)
  let query = db.from("notifications").select("id, type, title, message, source, source_detail, created_at, resolved_at", { count: "exact" })
    .eq("system_id", systemId).order("created_at", { ascending: false }).range(offset, offset + limit - 1)
  if (q.open) query = query.is("resolved_at", null)
  const { data, count } = await query
  return { total: count ?? 0, events: data || [] }
}

/** external/systems/:id/history?state=: one service's recent points, newest reports first then reversed. */
export async function history(db: Db, scope: Scope, systemId: string, stateId: string, limitIn: number) {
  if (!stateId) throw new HttpError(400, "system id and ?state= are required")
  const empty = { points: [], label: "", unit: "", cpu: [], mem: [] }
  const { data: cs } = await db.from("client_states").select("id, unique_id, system_id, type").eq("id", stateId).eq("system_id", systemId).maybeSingle()
  if (!cs || !seesService(scope, cs)) return empty
  const limit = Math.min(Number(limitIn) || 60, 240)
  const { data: rows } = await db.from("client_state_history").select("data, created_at")
    .eq("unique_id", cs.unique_id).eq("system_id", cs.system_id).order("created_at", { ascending: false }).limit(cs.type === "os" ? limit + 1 : limit)
  const cpu: number[] = [], mem: number[] = [], web: number[] = [], reqs: number[] = []
  let prev: { idle: number; total: number } | null = null
  for (const r of (rows || []).slice().reverse()) {
    const d = r.data || {}
    if (cs.type === "os") {
      const t = osTimes(d)
      if (prev && t.total > prev.total) cpu.push(Math.max(0, Math.min(100, Math.round((1 - (t.idle - prev.idle) / (t.total - prev.total)) * 100))))
      prev = t
      mem.push(memPct(d))
    } else if (cs.type === "web") web.push(Number(d?.duration) || 0)
    else if (cs.type === "cloudflare-project") reqs.push(Number(d?.project?.analytics?.requests) || 0)
    else cpu.push(directCpu(cs.type, d))
  }
  if (cs.type === "os" && mem.length > cpu.length) mem.splice(0, mem.length - cpu.length)
  if (cs.type === "web") return { points: web, label: "Response", unit: "ms", cpu, mem }
  if (cs.type === "cloudflare-project") return { points: reqs, label: "Requests", unit: "", cpu, mem }
  return { points: cpu, label: "CPU", unit: "%", cpu, mem }
}

/** external/groups: visible groups with their leaf members, nested groups walked. */
export async function groups(db: Db, scope: Scope, grantedGroups: Set<string>) {
  const { data: all } = await db.from("groups").select("id, name, description, color, sort, user_id, kind, cf_zone")
  const rows = (all || []).filter((g: any) => scope.all || grantedGroups.has(g.id))
  const { data: members } = await db.from("group_members").select("group_id, service_id")
  const byGroup = new Map<string, { service_id: string }[]>()
  for (const m of members || []) byGroup.set(m.group_id, [...(byGroup.get(m.group_id) || []), m])
  return rows.map((g: any) => ({ ...g, members: groupLeaves(g.id, byGroup).map((l) => l.service_id) }))
    .sort((a: any, b: any) => (a.sort ?? 0) - (b.sort ?? 0))
}

/**
 * external/incidents: what the client portal pulls. Only incidents opted in
 * with client_visible, naming a system the key can see, and only their
 * client-visible entries. Author ids never leave.
 */
export async function incidents(db: Db, scope: Scope, q: { since?: string; open?: boolean }) {
  const visible = new Set(await visibleSystemIds(db, scope))
  if (!visible.size) return { version: 1, generatedAt: new Date().toISOString(), incidents: [] }
  let query = db.from("incidents").select("*").eq("client_visible", true).order("started_at", { ascending: false }).limit(200)
  if (q.since) query = query.gte("updated_at", new Date(q.since).toISOString())
  if (q.open) query = query.is("ended_at", null)
  const { data: rows } = await query
  const ids = (rows || []).map((i: any) => i.id)
  const [{ data: targets }, { data: entries }] = await Promise.all([
    db.from("incident_targets").select("*").in("incident_id", ids),
    db.from("incident_entries").select("*").in("incident_id", ids).eq("client_visible", true),
  ])
  const out = (rows || []).map((i: any) => ({
    i,
    targets: (targets || []).filter((t: any) => t.incident_id === i.id && t.system_id && visible.has(t.system_id)),
  })).filter((x: any) => x.targets.length).map(({ i, targets: ts }: any) => ({
    id: i.id, title: i.title, severity: i.severity, status: i.status, startedAt: i.started_at, endedAt: i.ended_at,
    summary: i.summary, solution: i.solution, updatedAt: i.updated_at,
    targets: ts.map((t: any) => ({ type: t.target_type, id: t.target_id, label: t.label, systemId: t.system_id })),
    updates: (entries || []).filter((e: any) => e.incident_id === i.id)
      .sort((a: any, b: any) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at))
      .map((e: any) => ({ id: e.id, kind: e.kind, body: e.body, url: e.url, status: e.status, at: e.occurred_at })),
  }))
  return { version: 1, generatedAt: new Date().toISOString(), incidents: out }
}
