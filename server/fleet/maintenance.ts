/**
 * The fleet's housekeeping, ported from what pg_cron and the Pi's archive timer
 * did (definitions in docs/postgres-functions.sql and the frontend's
 * scripts/ops/daemonitor-archive-export):
 *
 * - reapStaleServices: hourly. A service the agent stopped reporting while the
 *   agent itself is alive goes, with its group memberships.
 * - thinHistory: daily. Beyond 24h keep the 24 newest reports per service per
 *   day (what the archive keeps); within 24h keep the 2000 newest.
 * - purgeClusterHistory: daily. Verdict history older than 14 days.
 * - checkOffline: every 5 minutes. A host whose agent went quiet raises a crit.
 * - exportMonths + ageOut: monthly. Each finished month to R2, then history
 *   older than 30 days is deleted, and only if every export succeeded.
 */
import type { Db } from "./db"
import type { FleetCtx } from "./ctx"
import { notify, resolveNotifications } from "./notify"

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const iso = (ms: number) => new Date(ms).toISOString()
/** Rows a statement changed. The cursor runs lazily, so drain it first. */
const written = (c: SqlStorageCursor<any>) => { c.toArray(); return c.rowsWritten }
/** Let queued requests (agent reports) in between batches of a long job. */
const yieldToRequests = () => new Promise((r) => setTimeout(r, 0))

/**
 * reap_stale_services(): the agent reported within 15 minutes, this service
 * not for 2 hours, and no module switch archived it (the module would restore
 * those). Goes through the query builder so open browsers see the rows leave.
 */
export async function reapStaleServices(db: Db, sql: SqlStorage, now = Date.now()) {
  const doomed = sql.exec<{ id: string }>(
    `select cs.id from client_states cs join systems s on s.id = cs.system_id
     where s.last_seen > ? and cs.updated_at < ? and cs.archived_module is null`,
    iso(now - 15 * MIN), iso(now - 2 * HOUR),
  ).toArray().map((r) => r.id)
  if (!doomed.length) return 0
  await db.from("group_members").delete().in("service_id", doomed)
  await db.from("client_states").delete().in("id", doomed)
  return doomed.length
}

/** purge_history_thin_batched(), in batches of 2000 with a yield between them. */
export async function thinHistory(sql: SqlStorage, now = Date.now()) {
  const cutoff = iso(now - DAY)
  let removed = 0
  const batch = (query: string) => {
    const n = written(sql.exec(query, cutoff, 2000))
    removed += n
    return n
  }
  // Beyond 24h: the 24 newest per service per (UTC) day.
  while (batch(`delete from client_state_history where id in (
      select id from (
        select id, row_number() over (partition by unique_id, system_id, substr(created_at, 1, 10) order by created_at desc) as rn
        from client_state_history where created_at < ?
      ) where rn > 24 limit ?)`) > 0) await yieldToRequests()
  // Within 24h: the 2000 newest per service.
  while (batch(`delete from client_state_history where id in (
      select id from (
        select id, row_number() over (partition by unique_id, system_id order by created_at desc) as rn
        from client_state_history where created_at >= ?
      ) where rn > 2000 limit ?)`) > 0) await yieldToRequests()
  return removed
}

/** purge_cluster_service_history(): verdicts older than 14 days. */
export function purgeClusterHistory(sql: SqlStorage, now = Date.now()) {
  return written(sql.exec("delete from cluster_service_history where created_at < ?", iso(now - 14 * DAY)))
}

/** purge_history_age_out(): history older than 30 days. Only ever after a clean export. */
export function ageOut(sql: SqlStorage, now = Date.now()) {
  return written(sql.exec("delete from client_state_history where created_at < ?", iso(now - 30 * DAY)))
}

// --- the monthly archive ------------------------------------------------------

/**
 * Sub-objects of at least this many characters are stored once in the file's
 * `blobs` map and replaced by {"__b": id}. A zone's report carries ~60KB of
 * analytics that barely changes between samples, so a month interns to a few
 * percent of its raw size. Same rule as the Pi exporter.
 */
const INTERN_MIN = 200
/** R2 multipart parts must be at least 5 MiB, except the last. */
const PART_BYTES = 6 * 1024 * 1024
const PAGE_ROWS = 500

/** Compact JSON with sorted keys, so equal objects intern to one blob. */
function stableText(node: any): string {
  if (Array.isArray(node)) return `[${node.map(stableText).join(",")}]`
  if (node && typeof node === "object") {
    return `{${Object.keys(node).sort().map((k) => `${JSON.stringify(k)}:${stableText(node[k])}`).join(",")}}`
  }
  return JSON.stringify(node) ?? "null"
}

/**
 * Replace big sub-objects with refs, depth first. The index is the only copy
 * of each blob's text (insertion order is ref order), since on a real month it
 * is most of what an export holds in memory.
 */
function intern(node: any, index: Map<string, string>): any {
  if (Array.isArray(node)) node = node.map((v) => intern(v, index))
  else if (node && typeof node === "object") node = Object.fromEntries(Object.entries(node).map(([k, v]) => [k, intern(v, index)]))
  else return node
  const text = stableText(node)
  if (text.length < INTERN_MIN) return node
  let ref = index.get(text)
  if (ref === undefined) {
    ref = index.size.toString(16)
    index.set(text, ref)
  }
  return { __b: ref }
}

/** The account key an archive is filed under: the same rule the Pi used, so old and new months sit together. */
const ACCOUNT_OF = "coalesce(s.org_id, s.user_id)"

/** Months with history, per account, oldest first. */
function monthsWithHistory(sql: SqlStorage): { month: string; account: string }[] {
  return sql.exec<{ month: string; account: string }>(
    `select substr(h.created_at, 1, 7) as month, ${ACCOUNT_OF} as account
     from client_state_history h join systems s on s.id = h.system_id
     group by 1, 2 order by 1, 2`,
  ).toArray()
}

function monthBounds(month: string): [string, string, number] {
  const [y, m] = month.split("-").map(Number)
  const end = Date.UTC(y, m, 1)
  return [`${month}-01T00:00:00.000Z`, iso(end), end]
}

/**
 * One account-month to R2 as format 2: { format, account, month, generated_at,
 * systems, rows, blobs }. Streamed: rows are read a page at a time, interned,
 * gzipped and uploaded in parts, so memory holds one page plus the blob index,
 * not the month. `blobs` comes after `rows`; readers JSON.parse the whole file,
 * so the order of keys doesn't matter to them.
 */
export async function exportMonth(sql: SqlStorage, bucket: R2Bucket, account: string, month: string) {
  const key = `${account}/${month}.json.gz`
  const [from, to] = monthBounds(month)
  const systemIds = sql.exec<{ id: string }>(`select s.id from systems s where ${ACCOUNT_OF} = ?`, account).toArray().map((r) => r.id)
  const systems = sql.exec(`select id, name, slug, type from systems s where ${ACCOUNT_OF} = ?`, account).toArray()

  // Which rows the archive keeps: the 24 newest per service per day, decided on
  // light columns only so the month's report bodies are never all in memory.
  const keep = new Set(sql.exec<{ id: string }>(
    `select id from (
       select h.id, row_number() over (partition by h.unique_id, h.system_id, substr(h.created_at, 1, 10) order by h.created_at desc) as rn
       from client_state_history h join systems s on s.id = h.system_id
       where h.created_at >= ? and h.created_at < ? and ${ACCOUNT_OF} = ?
     ) where rn <= 24`, from, to, account,
  ).toArray().map((r) => r.id))

  const upload = await bucket.createMultipartUpload(key, { httpMetadata: { contentType: "application/json", contentEncoding: "gzip" } })
  try {
    const gzip = new CompressionStream("gzip")
    const writer = gzip.writable.getWriter()
    const enc = new TextEncoder()
    const parts: R2UploadedPart[] = []
    let pending: Uint8Array[] = []
    let pendingBytes = 0
    const flush = async (last: boolean) => {
      if (!pendingBytes || (!last && pendingBytes < PART_BYTES)) return
      const body = new Uint8Array(pendingBytes)
      let at = 0
      for (const c of pending) { body.set(c, at); at += c.length }
      pending = []
      pendingBytes = 0
      parts.push(await upload.uploadPart(parts.length + 1, body))
    }
    const pump = (async () => {
      const reader = gzip.readable.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        pending.push(value)
        pendingBytes += value.length
        await flush(false)
      }
      await flush(true)
    })()
    const write = (s: string) => writer.write(enc.encode(s))

    await write(`{"format":2,"account":${JSON.stringify(account)},"month":${JSON.stringify(month)},"generated_at":${JSON.stringify(new Date().toISOString())},"systems":${JSON.stringify(systems)},"rows":[`)
    const index = new Map<string, string>()
    let rows = 0
    let after = { at: "", id: "" }
    for (;;) {
      // Keyset paging on (created_at, id): each page is a fresh query, so no
      // cursor is held open while agent reports come in between pages.
      const page = systemIds.length
        ? sql.exec<any>(
          `select id, created_at, system_id, unique_id, type, status, data from client_state_history
           where created_at >= ? and created_at < ? and (created_at > ? or (created_at = ? and id > ?))
             and system_id in (${systemIds.map(() => "?").join(",")})
           order by created_at, id limit ${PAGE_ROWS}`,
          from, to, after.at, after.at, after.id, ...systemIds,
        ).toArray()
        : []
      if (!page.length) break
      let chunk = ""
      for (const r of page) {
        if (!keep.has(r.id)) continue
        const row = { created_at: r.created_at, system_id: r.system_id, unique_id: r.unique_id, type: r.type, status: r.status, data: intern(JSON.parse(r.data), index) }
        chunk += (rows++ ? "," : "") + JSON.stringify(row)
      }
      if (chunk) await write(chunk)
      after = { at: page[page.length - 1].created_at, id: page[page.length - 1].id }
      await yieldToRequests()
    }
    await write(`],"blobs":{`)
    let first = true
    let chunk = ""
    for (const [text, ref] of index) {
      chunk += `${first ? "" : ","}${JSON.stringify(ref)}:${text}`
      first = false
      if (chunk.length > 256_000) { await write(chunk); chunk = "" }
    }
    await write(chunk + "}}")
    await writer.close()
    await pump
    await upload.complete(parts)
    return { key, rows, blobs: index.size }
  } catch (e) {
    await upload.abort().catch(() => {})
    throw e
  }
}

/**
 * Every finished month not yet in R2, or in R2 but written before its month
 * ended (a partial export). The current month is never exported. Returns
 * whether every export succeeded; the age-out only runs if it did.
 */
export async function exportMonths(sql: SqlStorage, bucket: R2Bucket, now = Date.now()) {
  const thisMonth = iso(now).slice(0, 7)
  const done: string[] = []
  let ok = true
  for (const { month, account } of monthsWithHistory(sql)) {
    if (month >= thisMonth) continue
    const key = `${account}/${month}.json.gz`
    const head = await bucket.head(key)
    if (head && head.uploaded.getTime() >= monthBounds(month)[2]) continue
    try {
      const r = await exportMonth(sql, bucket, account, month)
      done.push(`${r.key} rows=${r.rows} blobs=${r.blobs}`)
    } catch (e: any) {
      ok = false
      console.error(`archive: ${key} failed:`, e?.message || e)
    }
  }
  return { ok, done }
}

/** Silence that makes a host OFFLINE: past the board's 300s for an agent, with room for one slow report. */
export const OFFLINE_AFTER = 10 * MIN
/**
 * Services that are polled from somewhere else, not reported by an agent on
 * the host. A system holding only these has no heartbeat to lose, so its
 * silence pages nobody (the board still paints the services OFFLINE).
 */
const POLLED = ["adsense", "ga4", "workspace", "cost", "indexing", "wordpress", "nagios"]

/**
 * A host that stopped reporting. Raised through notify(), so it reaches Slack,
 * webhooks and push like any alert, and closed by the first check that sees a
 * report again (so recovery shows up within 5 minutes).
 *
 * Only hosts heard from in the last day: on the first run, a box switched off
 * weeks ago must not page as if it just died.
 */
export async function checkOffline(db: Db, ctx: FleetCtx, sql: SqlStorage, now = Date.now()) {
  const hosts = sql.exec<{ id: string; name: string; user_id: string; last_seen: string }>(
    `select s.id, s.name, s.user_id, s.last_seen from systems s
     where s.archived = 0 and s.last_seen > ?
       and exists (select 1 from client_states cs where cs.system_id = s.id and cs.archived = 0
                   and cs.type not like 'cloudflare%' and cs.type not in (${POLLED.map(() => "?").join(",")}))`,
    iso(now - DAY), ...POLLED,
  ).toArray()
  const open = new Set(sql.exec<{ system_id: string }>(
    `select system_id from notifications where source = 'offline' and resolved_at is null`,
  ).toArray().map((r) => r.system_id))
  let raised = 0, resolved = 0
  for (const h of hosts) {
    const silent = now - Date.parse(h.last_seen)
    if (silent > OFFLINE_AFTER) {
      if (open.has(h.id)) continue
      const min = Math.round(silent / MIN)
      if (await notify(ctx, {
        client: db, system: h, type: "error", source: "offline", sourceDetail: h.id,
        title: `${h.name}: OFFLINE`,
        message: `No report from the agent for ${min} minutes`,
      })) raised++
    } else if (open.has(h.id)) {
      resolved += await resolveNotifications(ctx, db, h, "offline", h.id)
    }
  }
  return { raised, resolved }
}
