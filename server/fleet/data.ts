/**
 * The records people edit in the app: groups, clusters, incidents, web
 * monitors, saved views, members and grants. The browser wrote these straight
 * to Postgres and RLS decided what it could do. Here one policy per table says
 * who may read, who may write, which columns a write may set, and what has to
 * hold, and every write goes through it.
 *
 * Writes use the query builder, so they reach open browsers over the live feed.
 */
import { atLeast, ownerId, type Role, type Scope } from "./access"
import { COLUMNS } from "./schema"
import { HttpError } from "./ctx"
import type { Identity } from "./jwt"
import type { Db } from "./db"

type Row = Record<string, any>

interface Ctx {
  db: Db
  who: Identity
  scope: Scope
  role: Role | null
  /** Groups shared with a grantee. Empty for members, who see every group. */
  groups: Set<string>
}

interface Policy {
  /** Who may change rows. Reads are separate. */
  write: Role
  /** Columns a write may set. Anything else in the body is refused. */
  columns: string[]
  /** Columns a delete may match on besides id. */
  matchOn?: string[]
  /** An insert that meets an existing row on these columns updates it instead. */
  upsertOn?: string[]
  /** Values a column may take. */
  enums?: Record<string, string[]>
  /** Set on insert, whatever the body says. */
  stamp?: (c: Ctx) => Promise<Row> | Row
  /** Rows a caller may read, as a filter on the list. Default: members only. */
  read?: (c: Ctx, rows: Row[]) => Promise<Row[]> | Row[]
  /** What has to hold for a row about to be written. Throws HttpError. */
  check?: (c: Ctx, row: Row, existing: Row | null) => Promise<void> | void
  /** Done before deleting these rows: what Postgres did with FKs and triggers. */
  beforeDelete?: (c: Ctx, rows: Row[]) => Promise<void>
  order?: [string, boolean][]
  /** A row may only be written by the user it belongs to (saved views). */
  ownRows?: boolean
}

const owner = async (c: Ctx) => {
  const id = await ownerId(c.db)
  if (!id) throw new HttpError(409, "This tenant hasn't been claimed yet")
  return { user_id: id }
}
const membersOnly = (c: Ctx, rows: Row[]) => (c.scope.all ? rows : [])
const exists = async (db: Db, table: string, id: unknown, what: string) => {
  const { data } = await db.from(table).select("id").eq("id", String(id ?? "")).maybeSingle()
  if (!data) throw new HttpError(400, `No such ${what}`)
}

/** group:<id> rows make groups nest. Refuse a member that would put a group inside itself. */
async function noGroupLoop(db: Db, groupId: string, serviceId: string) {
  if (!serviceId.startsWith("group:")) return
  const child = serviceId.slice("group:".length)
  await exists(db, "groups", child, "group")
  const seen = new Set<string>()
  const stack = [child]
  while (stack.length) {
    const g = stack.pop()!
    if (g === groupId) throw new HttpError(400, "That would put the group inside itself")
    if (seen.has(g)) continue
    seen.add(g)
    const { data } = await db.from("group_members").select("service_id").eq("group_id", g).like("service_id", "group:%")
    for (const m of data || []) stack.push(m.service_id.slice("group:".length))
  }
}

async function incidentsVisible(c: Ctx, rows: Row[]) {
  if (c.scope.all) return rows
  // can_read_incident(): an incident naming a system the caller can see.
  const { data: targets } = await c.db.from("incident_targets").select("incident_id, system_id").in("system_id", [...c.scope.systems])
  const ids = new Set((targets || []).map((t: Row) => t.incident_id))
  return rows.filter((r) => ids.has(r.id))
}

const POLICIES: Record<string, Policy> = {
  groups: {
    write: "manager",
    columns: ["name", "description", "cf_zone", "color", "sort", "kind"],
    enums: { kind: ["website", "application", "blank"] },
    stamp: owner,
    order: [["sort", true], ["name", true]],
    read: (c, rows) => {
      if (c.scope.all) return rows
      return rows.filter((r) => c.groups.has(r.id))
    },
    beforeDelete: async (c, rows) => {
      const ids = rows.map((r) => r.id)
      // Its own members go with it, and wherever it sat as a child, it leaves:
      // its children become top-level rather than vanishing.
      await c.db.from("group_members").delete().in("group_id", ids)
      await c.db.from("group_members").delete().in("service_id", ids.map((id) => `group:${id}`))
    },
  },
  group_members: {
    write: "manager",
    columns: ["group_id", "service_id", "label", "part"],
    matchOn: ["group_id", "service_id"],
    upsertOn: ["group_id", "service_id"],
    read: (c, rows) => (c.scope.all ? rows : rows.filter((r) => c.groups.has(r.group_id))),
    check: async (c, row) => {
      await exists(c.db, "groups", row.group_id, "group")
      const sid = String(row.service_id || "")
      if (sid.startsWith("group:")) await noGroupLoop(c.db, row.group_id, sid)
      else if (sid.startsWith("cluster:")) await exists(c.db, "clusters", sid.slice("cluster:".length), "cluster")
      else await exists(c.db, "client_states", sid, "service")
    },
  },
  clusters: {
    write: "manager",
    columns: ["name", "description", "kind", "grace_seconds"],
    enums: { kind: ["generic", "patroni"] },
    stamp: owner,
    order: [["name", true]],
    beforeDelete: async (c, rows) => {
      const ids = rows.map((r) => r.id)
      const { data: rules } = await c.db.from("cluster_services").select("id").in("cluster_id", ids)
      await c.db.from("cluster_service_history").delete().in("cluster_service_id", (rules || []).map((r: Row) => r.id))
      await c.db.from("cluster_services").delete().in("cluster_id", ids)
      await c.db.from("cluster_members").delete().in("cluster_id", ids)
      await c.db.from("group_members").delete().in("service_id", ids.map((id) => `cluster:${id}`))
    },
  },
  cluster_members: {
    write: "manager",
    columns: ["cluster_id", "system_id"],
    check: async (c, row) => {
      await exists(c.db, "clusters", row.cluster_id, "cluster")
      await exists(c.db, "systems", row.system_id, "system")
    },
  },
  cluster_services: {
    write: "manager",
    columns: ["cluster_id", "name", "match_type", "match_unique_id", "match_container", "placement", "min_running", "max_running", "enabled"],
    enums: { placement: ["singleton", "leader", "all", "quorum"] },
    order: [["name", true]],
    check: (c, row) => exists(c.db, "clusters", row.cluster_id, "cluster"),
    beforeDelete: async (c, rows) => {
      await c.db.from("cluster_service_history").delete().in("cluster_service_id", rows.map((r) => r.id))
    },
  },
  incidents: {
    write: "manager",
    columns: ["title", "severity", "status", "started_at", "ended_at", "summary", "solution", "client_visible"],
    stamp: owner,
    order: [["started_at", false]],
    read: incidentsVisible,
    check: (_c, row) => {
      if (!row.started_at) throw new HttpError(400, "An incident needs a start")
      if (row.ended_at && row.ended_at < row.started_at) throw new HttpError(400, "An incident can't end before it starts")
    },
    beforeDelete: async (c, rows) => {
      const ids = rows.map((r) => r.id)
      await c.db.from("incident_targets").delete().in("incident_id", ids)
      await c.db.from("incident_entries").delete().in("incident_id", ids)
    },
  },
  incident_targets: {
    write: "manager",
    columns: ["incident_id", "target_type", "target_id", "label", "system_id"],
    matchOn: ["incident_id"],
    enums: { target_type: ["system", "service", "group", "cluster"] },
    read: async (c, rows) => {
      const ok = new Set((await incidentsVisible(c, rows.map((r) => ({ id: r.incident_id })))).map((r) => r.id))
      return rows.filter((r) => ok.has(r.incident_id))
    },
    check: (c, row) => exists(c.db, "incidents", row.incident_id, "incident"),
  },
  incident_entries: {
    write: "manager",
    columns: ["incident_id", "kind", "body", "url", "status", "occurred_at", "client_visible"],
    enums: { kind: ["note", "status", "link"] },
    stamp: (c) => ({ author_id: c.who.sub }),
    read: async (c, rows) => {
      const ok = new Set((await incidentsVisible(c, rows.map((r) => ({ id: r.incident_id })))).map((r) => r.id))
      return rows.filter((r) => ok.has(r.incident_id))
    },
    check: (c, row) => exists(c.db, "incidents", row.incident_id, "incident"),
  },
  web_monitors: {
    write: "manager",
    columns: ["system_id", "name", "url", "config", "interval_ms", "enabled", "sort"],
    stamp: owner,
    order: [["sort", true], ["name", true]],
    check: (_c, row) => {
      if (!/^https?:\/\/[^\s]+$/i.test(String(row.url || ""))) throw new HttpError(400, "A monitor needs an http(s) URL")
      if (row.interval_ms != null && row.interval_ms < 30_000) throw new HttpError(400, "Check at most every 30 seconds")
    },
  },
  views: {
    // Saved views are personal: anyone who can see the tenant keeps their own.
    write: "viewer",
    columns: ["name", "template", "sort"],
    ownRows: true,
    stamp: (c) => ({ user_id: c.who.sub }),
    order: [["sort", true], ["created_at", true]],
    read: (c, rows) => rows.filter((r) => r.user_id === c.who.sub),
  },
  members: {
    // Who's in the tenant is the owner's call. The owner's own row can't be
    // changed here: a tenant without an owner can't be managed at all.
    write: "owner",
    columns: ["email", "role"],
    matchOn: ["email", "user_id"],
    enums: { role: ["viewer", "manager"] },
    read: (c, rows) => (atLeast(c.role, "manager") ? rows : []),
    check: (_c, row, existing) => {
      if (existing?.role === "owner") throw new HttpError(400, "The owner's membership can't be changed")
      if (row.email) row.email = String(row.email).trim().toLowerCase()
      if (!/^[^@\s]+@[^@\s]+$/.test(String(row.email || existing?.email || ""))) throw new HttpError(400, "A member needs an email address")
    },
    beforeDelete: async (_c, rows) => {
      if (rows.some((r) => r.role === "owner")) throw new HttpError(400, "The owner's membership can't be removed")
    },
  },
  grants: {
    write: "owner",
    columns: ["resource_type", "resource_id", "grantee_email", "role"],
    enums: { resource_type: ["system", "group"], role: ["viewer", "manager"] },
    read: (c, rows) => (atLeast(c.role, "manager") ? rows : []),
    check: async (c, row) => {
      row.grantee_email = String(row.grantee_email || "").trim().toLowerCase()
      if (!/^[^@\s]+@[^@\s]+$/.test(row.grantee_email)) throw new HttpError(400, "A grant needs an email address")
      await exists(c.db, row.resource_type === "group" ? "groups" : "systems", row.resource_id, row.resource_type)
    },
  },
}

/** The read-only series a cluster card draws, for anyone who can see clusters. */
const READ_ONLY = new Set(["cluster_service_history"])

function policyFor(table: string): Policy {
  const p = POLICIES[table]
  if (!p) throw new HttpError(404, `No such table: ${table}`)
  return p
}

/** A body's values, checked against the policy's columns, their kinds and enums. */
function clean(table: string, p: Policy, body: Row, partial: boolean): Row {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "Expected an object")
  const kinds = COLUMNS[table]
  const out: Row = {}
  for (const [k, v] of Object.entries(body)) {
    if (k === "id" || k === "user_id" || k === "created_at" || k === "updated_at") continue
    if (!p.columns.includes(k)) throw new HttpError(400, `${k} can't be set on ${table}`)
    const kind = kinds[k]
    if (v === null) { out[k] = null; continue }
    const bad = () => new HttpError(400, `${k} has the wrong type`)
    if (kind === "json") { if (typeof v !== "object") throw bad() }
    else if (kind === "bool") { if (typeof v !== "boolean") throw bad() }
    else if (kind === "int" || kind === "real") { if (typeof v !== "number" || !Number.isFinite(v)) throw bad() }
    else if (kind === "ts") { if (typeof v !== "string" || !Number.isFinite(Date.parse(v))) throw bad(); out[k] = new Date(v).toISOString(); continue }
    else if (typeof v !== "string" || v.length > 20_000) throw bad()
    if (p.enums?.[k] && !p.enums[k].includes(v as string)) throw new HttpError(400, `${k} must be one of ${p.enums[k].join(", ")}`)
    out[k] = v
  }
  if (!partial && !Object.keys(out).length) throw new HttpError(400, "Nothing to write")
  return out
}

async function canWrite(c: Ctx, p: Policy) {
  if (!atLeast(c.role, p.write)) throw new HttpError(403, `Only ${p.write === "owner" ? "the owner" : `a ${p.write} or above`} can change this`)
}

async function load(c: Ctx, table: string, id: string): Promise<Row> {
  const { data } = await c.db.from(table).select("*").eq("id", id).maybeSingle()
  const visible = data && (await read(c, table, [data])).length
  if (!visible) throw new HttpError(404, "Not found")
  return data
}

async function read(c: Ctx, table: string, rows: Row[]): Promise<Row[]> {
  const p = POLICIES[table]
  return p?.read ? p.read(c, rows) : membersOnly(c, rows)
}

export async function makeCtx(db: Db, who: Identity, scope: Scope, role: Role | null): Promise<Ctx> {
  let groups = new Set<string>()
  if (!scope.all) {
    const { data } = await db.from("grants").select("resource_id").eq("grantee_id", who.sub).eq("resource_type", "group")
    groups = new Set((data || []).map((g: Row) => g.resource_id))
  }
  return { db, who, scope, role, groups }
}

export interface ListQuery {
  /** cluster_service_history only: which rules, and how far back. */
  ids?: string[]
  since?: string
  limit?: number
}

export async function list(c: Ctx, table: string, q: ListQuery = {}) {
  if (READ_ONLY.has(table)) {
    if (!c.scope.all) return []
    const { data } = await c.db.from(table).select("cluster_service_id, running_count, created_at")
      .in("cluster_service_id", q.ids || []).gte("created_at", q.since || new Date(Date.now() - 6 * 3_600_000).toISOString())
      .order("created_at", { ascending: false }).limit(Math.min(Number(q.limit) || 1000, 20_000))
    return data || []
  }
  const p = policyFor(table)
  let query = c.db.from(table).select("*")
  for (const [col, asc] of p.order || []) query = query.order(col, { ascending: asc })
  const { data } = await query
  const rows = await read(c, table, data || [])
  if (table !== "incidents") return rows
  // The incidents store reads each with its targets and entries.
  const ids = rows.map((r) => r.id)
  const [targets, entries] = await Promise.all([
    c.db.from("incident_targets").select("*").in("incident_id", ids),
    c.db.from("incident_entries").select("*").in("incident_id", ids),
  ])
  return rows.map((r) => ({
    ...r,
    targets: (targets.data || []).filter((t: Row) => t.incident_id === r.id),
    entries: (entries.data || []).filter((e: Row) => e.incident_id === r.id),
  }))
}

export async function insert(c: Ctx, table: string, body: Row | Row[]) {
  const p = policyFor(table)
  await canWrite(c, p)
  const out: Row[] = []
  for (const one of Array.isArray(body) ? body : [body]) {
    const row = { ...clean(table, p, one, false), ...(p.stamp ? await p.stamp(c) : {}) }
    let existing: Row | null = null
    if (p.upsertOn) {
      let q = c.db.from(table).select("*")
      for (const k of p.upsertOn) q = q.eq(k, row[k])
      existing = (await q.maybeSingle()).data
    }
    await p.check?.(c, row, existing)
    const { data, error } = existing
      ? await c.db.from(table).update(row).eq("id", existing.id).select("*")
      : await c.db.from(table).insert(row).select("*")
    if (error) throw new HttpError(error.code === "23505" ? 409 : 500, error.code === "23505" ? "That already exists" : error.message)
    out.push(...data)
  }
  return out
}

export async function update(c: Ctx, table: string, id: string, body: Row) {
  const p = policyFor(table)
  await canWrite(c, p)
  const existing = await load(c, table, id)
  if (p.ownRows && existing.user_id !== c.who.sub) throw new HttpError(403, "That's someone else's")
  const patch = clean(table, p, body, true)
  if (COLUMNS[table].updated_at) patch.updated_at = new Date().toISOString()
  await p.check?.(c, { ...existing, ...patch }, existing)
  const { data, error } = await c.db.from(table).update(patch).eq("id", id).select("*")
  if (error) throw new HttpError(error.code === "23505" ? 409 : 500, error.code === "23505" ? "That already exists" : error.message)
  return data[0]
}

/** Delete by id, or by the policy's match columns: { group_id, service_id }, { incident_id }. */
export async function remove(c: Ctx, table: string, match: Row) {
  const p = policyFor(table)
  await canWrite(c, p)
  const keys = Object.keys(match || {})
  if (!keys.length) throw new HttpError(400, "Say what to delete")
  for (const k of keys) if (k !== "id" && !p.matchOn?.includes(k)) throw new HttpError(400, `Can't delete ${table} by ${k}`)
  let q = c.db.from(table).select("*")
  for (const k of keys) q = q.eq(k, String(match[k]))
  const rows = await read(c, table, (await q).data || [])
  if (p.ownRows && rows.some((r) => r.user_id !== c.who.sub)) throw new HttpError(403, "That's someone else's")
  if (!rows.length) return { deleted: 0 }
  await p.beforeDelete?.(c, rows)
  let d = c.db.from(table).delete()
  for (const k of keys) d = d.eq(k, String(match[k]))
  await d
  return { deleted: rows.length }
}
