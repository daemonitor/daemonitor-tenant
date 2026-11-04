/**
 * The tenant's remaining routes, as operations: the agent's monitor feed, the
 * inbox, systems, cluster suggestions, delivery channels and API keys. Each is
 * the frontend route's logic with RLS and share_grants replaced by the
 * caller's scope and role. The Worker routes are thin and all call op().
 */
import { classifyMember } from "~/utils/clusterEval"
import { listSlackConversations, postSlackMessage } from "~/server/utils/slack"
import { deliverWebhook, newWebhookSecret, webhookUrlProblem } from "~/server/utils/webhook"
import { atLeast, type Role, type Scope } from "./access"
import { findSystemByKey, hashKey } from "./keys"
import { HttpError } from "./ctx"
import type { Identity } from "./jwt"
import type { Db } from "./db"

export interface OpCtx {
  db: Db
  sql: SqlStorage
  env: any
  who: Identity | null
  scope: Scope | null
  role: Role | null
}

const need = (c: OpCtx, role: Role) => {
  if (!atLeast(c.role, role)) throw new HttpError(403, role === "owner" ? "Only the owner can do that" : `Only a ${role} or above can do that`)
  return c.who!
}
const signedIn = (c: OpCtx) => {
  if (!c.who || !c.scope) throw new HttpError(403, "You don't have access to this tenant")
  return { who: c.who, scope: c.scope }
}
const appUrl = (c: OpCtx) => String(c.env?.APP_URL || "").replace(/\/$/, "") || undefined
const LEVELS = ["info", "warning", "error"]

// --- agents -------------------------------------------------------------------

/** monitors/for-client: the web checks an agent runs, by its system key. */
export async function monitorsForClient(c: OpCtx, a: { key: string }) {
  if (!a.key) throw new HttpError(400, "Missing system key")
  const { system } = await findSystemByKey(c.db, a.key, "id")
  if (!system) throw new HttpError(404, "System not found")
  const { data } = await c.db.from("web_monitors").select("name, url, config, interval_ms")
    .eq("system_id", system.id).eq("enabled", true).order("sort", { ascending: true })
  return {
    endpoints: (data || []).map((m: any) => {
      const k = m.config || {}
      return {
        name: m.name, url: m.url, expectedStrings: k.expectedStrings, unexpectedStrings: k.unexpectedStrings,
        expectedStatusCode: k.expectedStatusCode, timeout: k.timeout, headers: k.headers, origin: k.origin, originOnly: k.originOnly,
      }
    }),
  }
}

// --- inbox --------------------------------------------------------------------

/** notifications/markAsRead: one by id, or all (optionally for one system). Shared read state, see reads.ts. */
export async function markRead(c: OpCtx, a: { notificationId?: string; all?: boolean; systemId?: string }) {
  const { scope } = signedIn(c)
  const now = new Date().toISOString()
  const visible = (q: any) => (scope.all ? q : q.in("system_id", [...scope.alertSystems]))
  if (a.all) {
    let q = visible(c.db.from("notifications").update({ read: true, read_at: now })).eq("read", false)
    if (a.systemId) q = q.eq("system_id", a.systemId)
    const { data } = await q.select("id")
    return { success: true, message: `Marked ${data.length} notifications as read`, modifiedCount: data.length }
  }
  if (!a.notificationId) throw new HttpError(400, "Missing notification ID")
  const { data } = await visible(c.db.from("notifications").update({ read: true, read_at: now })).eq("id", a.notificationId).select("*")
  if (!data.length) throw new HttpError(404, "Notification not found or access denied")
  return { success: true, notification: data[0] }
}

// --- systems ------------------------------------------------------------------

/** system/create: a system and its key, for adding by hand rather than enrolling. */
export async function createSystem(c: OpCtx, a: any) {
  need(c, "manager")
  if (!a?.name) throw new HttpError(400, "System name is required")
  const { data: ownerRow } = await c.db.from("members").select("user_id").eq("role", "owner").limit(1)
  const owner = ownerRow?.[0]?.user_id
  if (!owner) throw new HttpError(409, "This tenant hasn't been claimed yet")
  const key = [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("")
  const { data, error } = await c.db.from("systems").insert({
    name: String(a.name).slice(0, 120),
    slug: String(a.slug || a.name).toLowerCase().replace(/[^\w-]+/g, "-"),
    description: String(a.description || "").slice(0, 500),
    key_hash: await hashKey(key),
    user_id: owner,
    group_name: a.group || a.group_name || "Default",
    tags: Array.isArray(a.tags) ? a.tags.map(String) : [],
    type: String(a.type || "other"),
    status: "pending",
  }).select("id, name").single()
  if (error) throw new HttpError(500, error.message)
  await c.db.from("notifications").insert({
    user_id: owner, system_id: data.id, title: "System created", type: "info", source: "system",
    message: `System "${data.name}" has been created. Add this system to your monitoring client to start collecting data.`,
  })
  return { success: true, system: data, key }
}

/** system/update: name, description, group. */
export async function updateSystem(c: OpCtx, a: any) {
  need(c, "manager")
  const id = String(a?.systemId || "")
  if (!id) throw new HttpError(400, "Missing systemId")
  const patch: Record<string, any> = { updated_at: new Date().toISOString() }
  if (a.name != null) {
    const n = String(a.name).trim().slice(0, 120)
    if (!n) throw new HttpError(400, "Name cannot be empty")
    patch.name = n
  }
  if (a.description !== undefined) patch.description = a.description ? String(a.description).slice(0, 500) : null
  if (a.group_name !== undefined) patch.group_name = a.group_name ? String(a.group_name).slice(0, 120) : null
  const { data } = await c.db.from("systems").update(patch).eq("id", id).select("id")
  if (!data.length) throw new HttpError(404, "System not found")
  return { success: true }
}

/** system/archive: hide a system, or bring it back. */
export async function archiveSystem(c: OpCtx, a: any) {
  need(c, "manager")
  if (!a?.id) throw new HttpError(400, "Missing system id")
  const archived = a.archived !== false
  const { data } = await c.db.from("systems").update({ archived }).eq("id", String(a.id)).select("id")
  if (!data.length) throw new HttpError(404, "System not found")
  return { success: true, id: a.id, archived }
}

/** clientstate/archive: hide a service (all instances of a pm2 process together), or bring it back. */
export async function archiveService(c: OpCtx, a: any) {
  need(c, "manager")
  if (!a?.id) throw new HttpError(400, "Missing service id")
  const archived = a.archived !== false
  const { data: cs } = await c.db.from("client_states").select("id, system_id, type, data").eq("id", String(a.id)).maybeSingle()
  if (!cs) throw new HttpError(404, "Service not found")
  const name = cs.type === "pm2" ? cs.data?.name : null
  const q = c.db.from("client_states").update({ archived })
  const { data } = await (name ? q.eq("system_id", cs.system_id).eq("type", "pm2").eq("data->>name", name) : q.eq("id", cs.id)).select("id")
  return { success: true, archived, count: data.length }
}

/** system/archivable: the settings page's list of hidden (or visible) systems and services. */
export async function archivable(c: OpCtx, a: { archived?: boolean }) {
  need(c, "manager")
  const archived = a.archived !== false
  const { data: systems } = await c.db.from("systems").select("id, name, archived, user_id").order("name")
  const names = new Map((systems || []).map((s: any) => [s.id, s.name]))
  const ownerOf = new Map((systems || []).map((s: any) => [s.id, s.user_id]))
  const { data: rows } = await c.db.from("client_states")
    .select("id, system_id, type, unique_id, updated_at, name:data->>name, project:data->project, script:data->script, hostname:data->>hostname, domain:data->domain->>name")
    .eq("archived", archived).order("id")
  const services = new Map<string, any>()
  for (const r of rows || []) {
    const label = (v: any) => (typeof v === "string" ? v : v?.name || v?.id)
    const name = r.name || label(r.project) || label(r.script) || r.domain || r.hostname || r.unique_id || r.type
    // pm2 instances of one process are one row here, as on the board.
    const key = r.type === "pm2" && r.name ? `${r.system_id}|pm2|${r.name}` : r.id
    const seen = services.get(key)
    if (seen) {
      seen.count++
      if (r.updated_at > seen.updated_at) seen.updated_at = r.updated_at
    } else {
      services.set(key, { id: r.id, system_id: r.system_id, system: names.get(r.system_id) || "", owner: ownerOf.get(r.system_id) || null, type: r.type, name, updated_at: r.updated_at, count: 1 })
    }
  }
  return {
    archived,
    systems: (systems || []).filter((s: any) => s.archived === archived).map((s: any) => ({ id: s.id, name: s.name, owner: s.user_id })),
    services: [...services.values()],
  }
}

// --- clusters -----------------------------------------------------------------

/**
 * clusters/suggest: placements read off the fleet's current shape, for the
 * operator to accept or not. Never applied automatically: one snapshot can't
 * tell a singleton from a service that just died on two hosts.
 */
export async function clusterSuggest(c: OpCtx, a: { clusterId: string }) {
  need(c, "manager")
  if (!a.clusterId) throw new HttpError(400, "Missing cluster_id")
  const { data: cluster } = await c.db.from("clusters").select("id, name").eq("id", a.clusterId).maybeSingle()
  if (!cluster) throw new HttpError(404, "Cluster not found")
  const [{ data: memberRows }, { data: declared }] = await Promise.all([
    c.db.from("cluster_members").select("system_id").eq("cluster_id", a.clusterId),
    c.db.from("cluster_services").select("match_type, match_unique_id, match_container").eq("cluster_id", a.clusterId),
  ])
  const memberIds = (memberRows || []).map((m: any) => m.system_id)
  if (memberIds.length < 2) return { suggestions: [], note: "A cluster needs at least two members before placement means anything." }
  const [{ data: systems }, { data: states }] = await Promise.all([
    c.db.from("systems").select("id, name, last_seen").in("id", memberIds),
    c.db.from("client_states").select("system_id, type, unique_id, status, status_reason, updated_at, data").in("system_id", memberIds).eq("archived", false),
  ])
  const sysById = new Map((systems || []).map((s: any) => [s.id, s]))
  const already = new Set((declared || []).map((d: any) => `${d.match_type}|${d.match_unique_id}|${d.match_container || ""}`))
  const byKey = new Map<string, any[]>()
  for (const cs of states || []) {
    const k = `${cs.type}|${cs.unique_id}`
    byKey.set(k, [...(byKey.get(k) || []), cs])
  }
  const candidates: { type: string; uniqueId: string; container: string | null; rows: any[] }[] = []
  for (const [key, rows] of byKey) {
    const sep = key.indexOf("|")
    const type = key.slice(0, sep)
    const uniqueId = key.slice(sep + 1)
    if (type === "docker" || type === "lxc") {
      const names = new Set<string>()
      for (const r of rows) for (const ct of Array.isArray(r.data?.containers) ? r.data.containers : []) {
        const n = String(ct?.service || ct?.name || "")
        if (n) names.add(n)
      }
      for (const container of names) candidates.push({ type, uniqueId, container, rows })
    } else candidates.push({ type, uniqueId, container: null, rows })
  }
  const now = Date.now()
  const suggestions: any[] = []
  for (const { type, uniqueId, container, rows } of candidates) {
    if (already.has(`${type}|${uniqueId}|${container || ""}`) || rows.length < 2) continue
    const members = memberIds.map((id: string) => {
      const system = sysById.get(id)
      const state = rows.find((r) => r.system_id === id) || null
      if (!system) return { systemId: id, systemName: id.slice(0, 8), state: "unknown" as const, seen: !!state }
      const { state: placement } = classifyMember({ system, state } as any, now, container)
      return { systemId: id, systemName: system.name, state: placement, seen: !!state }
    })
    const placed = members.filter((m: any) => m.state === "running" || m.state === "degraded").length
    const total = members.length
    const [placement, rationale] =
      placed === 1 ? ["singleton", `running on 1 of ${total} members — looks like an active/passive singleton`]
      : placed === total ? ["all", `running on all ${total} members`]
      : placed === 0 ? ["singleton", "running on no member right now — check this is not simply down before declaring it"]
      : ["quorum", `running on ${placed} of ${total} members`]
    const project = rows[0]?.data?.project || rows[0]?.data?.name || uniqueId.replace(/^docker-|^lxc-/, "")
    suggestions.push({
      name: container ? `${project}/${container}` : project, match_type: type, match_unique_id: uniqueId, match_container: container,
      placement, min_running: placement === "quorum" ? placed : 1, placedCount: placed, memberCount: total, rationale, members,
    })
  }
  const rank: Record<string, number> = { singleton: 0, leader: 0, quorum: 1, all: 2 }
  suggestions.sort((x, y) => (rank[x.placement] ?? 9) - (rank[y.placement] ?? 9) || x.name.localeCompare(y.name))
  return { cluster, suggestions }
}

// --- delivery channels (each person's own) -------------------------------------

async function ownChannel(c: OpCtx, id: string) {
  const { who } = signedIn(c)
  if (!id) throw new HttpError(400, "Missing channel id")
  const { data } = await c.db.from("notification_channels").select("*").eq("id", id).eq("user_id", who.sub).maybeSingle()
  if (!data) throw new HttpError(404, "Channel not found")
  return data
}

const hostOf = (url?: string) => { try { return url ? new URL(url).host : null } catch { return null } }

/**
 * channels/list: the caller's channels without their secrets. Slack's
 * availability is daemonitor.com's to say (it holds the Slack app), so this
 * leaves it to the app.
 */
export async function listChannels(c: OpCtx) {
  const { who } = signedIn(c)
  const { data } = await c.db.from("notification_channels").select("id, kind, enabled, min_level, label, config, created_at")
    .eq("user_id", who.sub).order("created_at", { ascending: true })
  return {
    slackAvailable: null,
    pending: false,
    channels: (data || []).map((ch: any) => ({
      id: ch.id, kind: ch.kind, enabled: ch.enabled, minLevel: ch.min_level, label: ch.label,
      team: ch.kind === "slack" ? ch.config?.team_name ?? null : null,
      channelId: ch.kind === "slack" ? ch.config?.channel_id ?? null : null,
      channelName: ch.kind === "slack" ? ch.config?.channel_name ?? null : null,
      target: ch.kind === "webhook" ? hostOf(ch.config?.url) : null,
    })),
  }
}

/** channels/update: on/off, severity floor, and which Slack channel. The token is never writable. */
export async function updateChannel(c: OpCtx, a: any) {
  const existing = await ownChannel(c, String(a?.id || ""))
  const patch: Record<string, any> = {}
  if (typeof a.enabled === "boolean") patch.enabled = a.enabled
  if (typeof a.minLevel === "string") {
    if (!LEVELS.includes(a.minLevel)) throw new HttpError(400, `minLevel must be one of ${LEVELS.join(", ")}`)
    patch.min_level = a.minLevel
  }
  if (existing.kind === "slack" && typeof a.channelId === "string" && a.channelId) {
    const channelName = typeof a.channelName === "string" ? a.channelName : null
    patch.config = { ...(existing.config || {}), channel_id: a.channelId, channel_name: channelName }
    patch.label = channelName ? `#${channelName} · ${existing.config?.team_name || "Slack"}` : existing.config?.team_name || "Slack"
  }
  if (!Object.keys(patch).length) return { success: true, unchanged: true }
  patch.updated_at = new Date().toISOString()
  await c.db.from("notification_channels").update(patch).eq("id", existing.id)
  return { success: true }
}

export async function deleteChannel(c: OpCtx, a: any) {
  const existing = await ownChannel(c, String(a?.id || ""))
  await c.db.from("notification_channels").delete().eq("id", existing.id)
  return { success: true }
}

/** channels/test: one message through one channel, with the provider's own error if it fails. */
export async function testChannel(c: OpCtx, a: any) {
  const row = await ownChannel(c, String(a?.id || ""))
  const title = "daemonitor test"
  const message = "Delivery is working. Real alerts will look like this."
  try {
    if (row.kind === "slack") {
      if (!row.config?.bot_token) throw new Error("No stored token — reconnect the workspace")
      if (!row.config?.channel_id) throw new Error("No channel selected yet")
      await postSlackMessage({ token: row.config.bot_token, channel: row.config.channel_id, title, message, level: "info", url: appUrl(c) })
    } else if (row.kind === "webhook") {
      await deliverWebhook(row.config, { event: "test", level: "info", title, message, url: appUrl(c), at: new Date().toISOString() })
    } else throw new Error(`Unsupported channel kind: ${row.kind}`)
  } catch (e: any) {
    throw new HttpError(502, e?.message || "Delivery failed")
  }
  return { success: true }
}

/** channels/webhook: add a signed webhook. The secret is returned this once. */
export async function addWebhook(c: OpCtx, a: any) {
  const { who } = signedIn(c)
  const url = typeof a?.url === "string" ? a.url.trim() : ""
  const problem = webhookUrlProblem(url)
  if (problem) throw new HttpError(400, problem)
  const secret = newWebhookSecret()
  const { data } = await c.db.from("notification_channels").insert({
    user_id: who.sub, kind: "webhook", enabled: true,
    min_level: LEVELS.includes(a?.minLevel) ? a.minLevel : "warning",
    label: new URL(url).host, config: { url, secret },
  }).select("id").single()
  return { id: data.id, secret }
}

/**
 * channels/slack: a Slack install, handed over by daemonitor.com's OAuth relay
 * on the user's behalf. daemonitor.com holds the Slack app's secret and never
 * stores the bot token; it lives here, with the alerts it delivers. Reconnecting
 * a workspace keeps the channel it was posting to.
 */
export async function connectSlack(c: OpCtx, a: any) {
  const { who } = signedIn(c)
  const teamId = String(a?.teamId || "")
  const botToken = String(a?.botToken || "")
  if (!teamId || !botToken.startsWith("xoxb-")) throw new HttpError(400, "Expected a Slack team and bot token")
  const { data: existing } = await c.db.from("notification_channels").select("id, config")
    .eq("user_id", who.sub).eq("kind", "slack").eq("config->>team_id", teamId).maybeSingle()
  let channelId: string | null = existing?.config?.channel_id ?? null
  let channelName: string | null = existing?.config?.channel_name ?? null
  if (!channelId) {
    try {
      const list = await listSlackConversations(botToken)
      const pick = list.find((x) => x.name === "alerts") || list.find((x) => x.name === "general") || list[0]
      if (pick) { channelId = pick.id; channelName = pick.name }
    } catch (e: any) {
      console.error("slack connect: could not list conversations:", e?.message || e)
    }
  }
  const teamName = String(a?.teamName || "Slack")
  const row = {
    user_id: who.sub, kind: "slack", enabled: true,
    label: channelName ? `#${channelName} · ${teamName}` : teamName,
    config: { team_id: teamId, team_name: teamName, channel_id: channelId, channel_name: channelName, bot_token: botToken, scope: a?.scope ?? null, authed_user: a?.authedUser ?? null },
  }
  if (existing) await c.db.from("notification_channels").update({ ...row, updated_at: new Date().toISOString() }).eq("id", existing.id)
  else await c.db.from("notification_channels").insert(row)
  return { success: true, channelName }
}

/** slack/channels: the picker's list, fetched with the stored token so it never reaches the browser. */
export async function slackChannels(c: OpCtx, a: any) {
  const row = await ownChannel(c, String(a?.id || ""))
  if (row.kind !== "slack") throw new HttpError(404, "Slack channel not found")
  if (!row.config?.bot_token) throw new HttpError(409, "Slack connection has no token — reconnect the workspace")
  try {
    const list = await listSlackConversations(row.config.bot_token)
    return { conversations: list.map((x) => ({ id: x.id, name: x.name, isPrivate: x.isPrivate })) }
  } catch (e: any) {
    throw new HttpError(502, e?.message || "Could not list Slack channels")
  }
}

// --- API keys -----------------------------------------------------------------

/**
 * The identity an API key acts as: the person who made it, with whatever they
 * can see now. A key outlives nothing: remove the person from the tenant and
 * their keys stop working, because their scope is gone.
 */
export async function identifyKey(db: Db, key: string, want: "read" | "manage"): Promise<Identity> {
  if (!key) throw new HttpError(401, "API key required")
  const { data: row } = await db.from("api_keys").select("id, user_id, permissions, expires_at").eq("key_hash", await hashKey(key)).maybeSingle()
  if (!row) throw new HttpError(401, "Unauthorized")
  if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) throw new HttpError(401, "API key expired")
  if (!(row.permissions || []).includes(want)) throw new HttpError(403, "Insufficient permissions")
  await db.from("api_keys").update({ last_used_at: new Date().toISOString() }).eq("id", row.id)
  return { sub: row.user_id, email: null, emailVerified: false }
}

export async function listKeys(c: OpCtx) {
  const { who } = signedIn(c)
  const { data } = await c.db.from("api_keys").select("id, name, permissions, created_at, expires_at, last_used_at")
    .eq("user_id", who.sub).order("created_at", { ascending: false })
  return { apiKeys: data || [] }
}

/** me/api-keys/create: shown once. A manage key enrolls systems, so it needs a manager. */
export async function createKey(c: OpCtx, a: any) {
  const { who } = signedIn(c)
  if (!a?.name) throw new HttpError(400, "API key name is required")
  const permissions = Array.isArray(a.permissions) && a.permissions.length ? a.permissions.map(String) : ["read"]
  if (permissions.some((p: string) => p !== "read" && p !== "manage")) throw new HttpError(400, "permissions are read and manage")
  if (permissions.includes("manage")) need(c, "manager")
  const key = [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("")
  const { data } = await c.db.from("api_keys").insert({
    user_id: who.sub, name: String(a.name).slice(0, 120), key_hash: await hashKey(key), permissions,
    expires_at: a.expires_at ? new Date(a.expires_at).toISOString() : null,
  }).select("id, name, permissions, created_at, expires_at").single()
  return { apiKey: { ...data, key } }
}

export async function deleteKey(c: OpCtx, a: any) {
  const { who } = signedIn(c)
  if (!a?.id) throw new HttpError(400, "API key ID is required")
  await c.db.from("api_keys").delete().eq("id", String(a.id)).eq("user_id", who.sub)
  return { success: true }
}

