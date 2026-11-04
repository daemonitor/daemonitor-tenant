/**
 * The board's reads, with the frontend routes' response shapes so the stores
 * don't change: system/list, clientstate/list, notifications/list.
 *
 * What RLS did in Postgres is done here from the caller's scope.
 */
import { seesService, type Scope } from "./access"
import type { Db } from "./db"

/** Never sent to a browser: the hash of the key agents post with. */
export const SYSTEM_SECRET_COLUMNS = ["key_hash", "previous_key_hash"]

export function publicSystem<T extends Record<string, any>>(row: T): T {
  const out: Record<string, any> = { ...row }
  for (const c of SYSTEM_SECRET_COLUMNS) delete out[c]
  return out as T
}

export async function listSystems(db: Db, scope: Scope) {
  let q = db.from("systems").select("*").eq("archived", false).order("created_at", { ascending: false })
  if (!scope.all) q = q.in("id", [...scope.systems])
  const { data, error } = await q
  if (error) throw new Error(error.message)
  return { success: true, items: (data || []).map(publicSystem) }
}

export async function listClientStates(db: Db, scope: Scope) {
  let q = db.from("client_states").select("*").eq("archived", false).order("updated_at", { ascending: false })
  if (!scope.all) q = q.in("system_id", [...scope.systems])
  const { data, error } = await q
  if (error) throw new Error(error.message)
  const rows = (data || []).filter((r: any) => seesService(scope, r))
  return { success: true, items: rows.flatMap(expandCloudflare) }
}

/**
 * The list's reshaping, unchanged from the frontend route: the legacy
 * "cloudflare" type becomes one item per Pages project plus the account, and
 * each domain row gets its name.
 */
function expandCloudflare(item: any): any[] {
  if (item.type === "cloudflare" && item.data?.pages?.projects) {
    const projects = [...item.data.pages.projects].sort((a: any, b: any) => (a.name?.toLowerCase() || "").localeCompare(b.name?.toLowerCase() || ""))
    const out = projects.map((project: any) => {
      const deployment = project.latest_deployment
      let status = "online"
      let statusReason: string | null = null
      if (deployment) {
        const failedStage = deployment.stages?.find((s: any) => s.status === "failure" || s.status === "error")
        if (failedStage) {
          status = "warning"
          statusReason = `Failed at ${failedStage.name} stage`
        }
        if (deployment.status !== "success" && deployment.status !== "queued" && deployment.status !== "initializing") {
          status = "warning"
          statusReason = statusReason || `Deployment status: ${deployment.status}`
        }
      }
      return {
        ...item,
        id: `${item.id}-${project.id}`,
        unique_id: `${item.unique_id}-${project.name}`,
        type: "cloudflare-project",
        data: { ...item.data, project, name: project.name, accountId: item.data.account, alias: item.data.alias || "cloudflare" },
        status,
        status_reason: statusReason,
      }
    })
    return [...out, item]
  }
  if (item.type === "cloudflare-domain" && item.data?.domain) {
    return [{ ...item, data: { ...item.data, name: item.data.domain.name || "Unknown Domain" } }]
  }
  return [item]
}

export interface NotificationQuery {
  limit?: number
  offset?: number
  unreadOnly?: boolean
  systemId?: string
  type?: string
}

/**
 * The inbox. Notifications belong to systems now, not to one user, so every
 * member sees the same rows and the same read state.
 * ponytail: shared read state. Per-user read marks need a reads table keyed
 * on (notification, user) once more than one person works the inbox.
 */
export async function listNotifications(db: Db, scope: Scope, q: NotificationQuery) {
  const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 500)
  const offset = Math.max(Number(q.offset) || 0, 0)
  const visible = (query: any) => (scope.all ? query : query.in("system_id", [...scope.alertSystems]))

  let rows = visible(db.from("notifications").select("*")).order("created_at", { ascending: false }).range(offset, offset + limit - 1)
  if (q.unreadOnly) rows = rows.eq("read", false)
  if (q.systemId) rows = rows.eq("system_id", q.systemId)
  if (q.type) rows = rows.eq("type", q.type)
  const { data, error } = await rows
  if (error) throw new Error(error.message)

  const { count } = await visible(db.from("notifications").select("*", { count: "exact", head: true })).eq("read", false)
  return { success: true, unreadCount: count || 0, count: data.length, notifications: data }
}
