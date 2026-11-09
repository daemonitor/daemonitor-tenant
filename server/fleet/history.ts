/**
 * History reads, ported from the frontend's routes: clientstate/history,
 * history-batch, cf-history, suspects, overview/history, activity/probes and
 * system/events. Same response shapes.
 *
 * The two Postgres series functions (history_batch_series and
 * history_value_series) took the latest sample in each of N equal buckets per
 * service and derived numbers from it in SQL. Here that's one indexed lookup
 * per bucket and the same derivations in JS, so a wide window still reads
 * N rows per service, not every report in it.
 */
import { clientStateToService } from "~/utils/fleetAdapter"
import { chartValue } from "~/utils/fleet"
import { memPct, osTimes, directCpu } from "~/server/utils/metrics"
import { SUSPECT_THREE_MONTHS_DAYS } from "~/utils/suspectNetworks"
import { seesService, type Scope } from "./access"
import { HttpError } from "./ctx"
import type { Db } from "./db"

const BAR_TYPES = ["os", "pm2", "docker", "lxc", "lxc-container"]
// Services with one number worth watching. cloudflare-domain is left out on
// purpose: its sparkline is the daily threat series the adapter builds.
const VALUE_TYPES = ["web", "website", "cloudflare-worker-script", "cloudflare-project", "device"]
const BATCH_RANGE_MIN: Record<string, number> = { "1h": 60, "24h": 1440, "7d": 10080, "30d": 43200 }
const BATCH_POINTS = 48

type Pair = { id: string; unique_id: string; system_id: string; type: string }
type Sample = { data: any; created_at: string }

/** The latest sample in each of `buckets` equal slices of [since, now), oldest first. */
export function sampled(sql: SqlStorage, pair: { unique_id: string; system_id: string }, sinceMs: number, buckets: number): Sample[] {
  const sec = Math.max(1, (Date.now() - sinceMs) / 1000 / Math.max(1, buckets))
  const out: Sample[] = []
  for (let b = 0; b < buckets; b++) {
    const from = new Date(sinceMs + b * sec * 1000).toISOString()
    const to = new Date(sinceMs + (b + 1) * sec * 1000).toISOString()
    const row = sql.exec<{ data: string; created_at: string }>(
      `select data, created_at from client_state_history
       where unique_id = ? and system_id = ? and created_at >= ? and created_at < ?
       order by created_at desc limit 1`,
      pair.unique_id, pair.system_id, from, to,
    ).toArray()[0]
    if (row) out.push({ data: JSON.parse(row.data), created_at: row.created_at })
  }
  return out
}

/** history_batch_series for one service: cpu (os as a delta between samples), mem, disk, net. */
export function barSeries(type: string, samples: Sample[]) {
  const out: { cpu: number | null; mem: number | null; disk: number | null; net: number | null }[] = []
  let prev: { idle: number; total: number } | null = null
  for (const s of samples) {
    const d = s.data || {}
    if (type === "os") {
      const t = osTimes(d)
      const cpu = prev && t.total > prev.total ? Math.max(0, Math.min(100, Math.round((1 - (t.idle - prev.idle) / (t.total - prev.total)) * 100))) : null
      prev = t
      const disks = Array.isArray(d.disks) ? d.disks : []
      out.push({
        cpu,
        mem: memPct(d),
        disk: disks.reduce((m: number, x: any) => Math.max(m, Math.max(0, Math.min(100, Math.round(Number(x?.pct) || 0)))), 0),
        // Only from samples that recorded network at all.
        net: d.network ? (Number(d.network.rxRate) || 0) + (Number(d.network.txRate) || 0) : null,
      })
    } else {
      const nw = type === "lxc-container" ? d.container?.network : null
      out.push({ cpu: directCpu(type, d), mem: null, disk: null, net: nw ? (Number(nw.rxRate) || 0) + (Number(nw.txRate) || 0) : null })
    }
  }
  return out
}

/** history_value_series for one sample: the one number a non-bar service charts. */
export function valueOf(type: string, d: any): number | null {
  if (type === "web" || type === "website") return Math.round(Number(d?.duration) || 0)
  if (type === "cloudflare-worker-script") return Number(d?.script?.requests) || 0
  if (type === "cloudflare-project") return Number(d?.project?.analytics?.requests) || 0
  if (type === "device") {
    const sw = d?.sources?.tplinkswitch || (d?.sources?.snmp?.kind === "switch" ? d.sources.snmp : null)
    if (!Array.isArray(sw?.interfaces)) return null
    return sw.interfaces.reduce((s: number, i: any) => s + (Number(i?.inBps) || 0) + (Number(i?.outBps) || 0), 0)
  }
  return null
}

/** Bucket-average down to at most `max` points. */
function downsample(arr: number[], max: number, round = true): number[] {
  if (arr.length <= max) return arr
  const bucket = arr.length / max
  const out: number[] = []
  for (let i = 0; i < max; i++) {
    const start = Math.floor(i * bucket)
    const end = Math.max(start + 1, Math.floor((i + 1) * bucket))
    let s = 0, n = 0
    for (let j = start; j < end && j < arr.length; j++) { s += arr[j]; n++ }
    out.push(n ? (round ? Math.round(s / n) : s / n) : arr[start])
  }
  return out
}

async function visibleStates(db: Db, scope: Scope, types: string[]): Promise<Pair[]> {
  let q = db.from("client_states").select("id, unique_id, system_id, type").in("type", types).eq("archived", false)
  if (!scope.all) q = q.in("system_id", [...scope.systems])
  const { data } = await q
  return (data || []).filter((r: any) => seesService(scope, r))
}

/** One service the caller may see, or null: the same answer for "no such" and "not yours". */
async function visibleState(db: Db, scope: Scope, id: string) {
  const { data } = await db.from("client_states").select("id, unique_id, system_id, type").eq("id", id).maybeSingle()
  return data && seesService(scope, data) ? data : null
}

/** clientstate/history-batch: short series for every service on the board. */
export async function historyBatch(db: Db, sql: SqlStorage, scope: Scope, range: string) {
  const windowMin = BATCH_RANGE_MIN[range] ?? 60
  const sinceMs = Date.now() - windowMin * 60_000
  const states = await visibleStates(db, scope, [...BAR_TYPES, ...VALUE_TYPES])
  const out: Record<string, { cpu?: number[]; mem?: number[]; disk?: number[]; net?: number[]; val?: number[] }> = {}
  const done = new Map<string, Sample[]>()
  const samplesOf = (p: Pair) => {
    const k = `${p.unique_id}|${p.system_id}`
    if (!done.has(k)) done.set(k, sampled(sql, p, sinceMs, BATCH_POINTS))
    return done.get(k)!
  }
  for (const p of states) {
    if (BAR_TYPES.includes(p.type)) {
      // A null cpu is an os sample with no delta (the first, or after a reboot);
      // skipped so cpu, mem and disk stay aligned.
      const rows = barSeries(p.type, samplesOf(p)).filter((r) => r.cpu != null)
      if (!rows.length) continue
      out[p.id] = {
        cpu: downsample(rows.map((r) => r.cpu!), BATCH_POINTS),
        mem: downsample(rows.filter((r) => r.mem != null).map((r) => r.mem!), BATCH_POINTS),
        disk: downsample(rows.filter((r) => r.disk != null).map((r) => r.disk!), BATCH_POINTS),
        net: downsample(rows.filter((r) => r.net != null).map((r) => r.net!), BATCH_POINTS),
      }
    } else {
      const vals = samplesOf(p).map((s) => valueOf(p.type, s.data)).filter((v): v is number => v != null)
      if (vals.length) out[p.id] = { val: downsample(vals, BATCH_POINTS) }
    }
  }
  return out
}

/**
 * overview/history: the fleet's average cpu and mem per bucket.
 *
 * The frontend route read every report in the window and averaged all of them.
 * A day of a whole fleet's full reports is hundreds of MB, past a DO's 128 MB,
 * so this averages each service's sampled value per bucket instead, the same
 * sampling as the board's sparklines.
 */
export async function overviewHistory(db: Db, sql: SqlStorage, scope: Scope, rangeKey: string) {
  const BUCKETS = 60
  const windowMin = BATCH_RANGE_MIN[rangeKey] ?? 1440
  const sinceMs = Date.now() - windowMin * 60_000
  const bucketMs = (windowMin * 60_000) / BUCKETS
  const states = await visibleStates(db, scope, BAR_TYPES)
  const cpuSum = Array(BUCKETS).fill(0), cpuCnt = Array(BUCKETS).fill(0)
  const memSum = Array(BUCKETS).fill(0), memCnt = Array(BUCKETS).fill(0)
  const seen = new Set<string>()
  for (const p of states) {
    const k = `${p.unique_id}|${p.system_id}`
    if (seen.has(k)) continue
    seen.add(k)
    const samples = sampled(sql, p, sinceMs, BUCKETS)
    barSeries(p.type, samples).forEach((r, i) => {
      const bi = Math.max(0, Math.min(BUCKETS - 1, Math.floor((Date.parse(samples[i].created_at) - sinceMs) / bucketMs)))
      if (r.cpu != null) { cpuSum[bi] += r.cpu; cpuCnt[bi]++ }
      if (r.mem != null) { memSum[bi] += r.mem; memCnt[bi]++ }
    })
  }
  // Carry the last value across empty buckets, so a sparse window reads as a line.
  const fill = (sum: number[], cnt: number[]) => {
    let last = 0
    return sum.map((s, i) => (cnt[i] ? (last = Math.round(s / cnt[i])) : last))
  }
  return { range: rangeKey, buckets: BUCKETS, cpu: fill(cpuSum, cpuCnt), mem: fill(memSum, memCnt) }
}

const DETAIL_RANGE_MIN: Record<string, number> = { "1h": 60, "6h": 360, "24h": 1440, "7d": 10080, "30d": 43200 }
const MAX_POINTS = 200

export interface HistoryQuery { id: string; range?: string; from?: string; to?: string; limit?: number }

/** clientstate/history: one service's detail series. The derivations are the frontend route's, unchanged. */
export async function serviceHistory(db: Db, scope: Scope, q: HistoryQuery) {
  if (!q.id) throw new HttpError(400, "Missing service id")
  const cs = await visibleState(db, scope, q.id)
  if (!cs) return { cpu: [], mem: [] }
  const id = q.id
  const windowMin = DETAIL_RANGE_MIN[String(q.range || "24h")] ?? 1440
  const fromMs = Date.parse(String(q.from || ""))
  const toMs = Date.parse(String(q.to || ""))
  const explicit = Number.isFinite(fromMs) && Number.isFinite(toMs) && toMs > fromMs
  const since = explicit ? new Date(fromMs).toISOString() : new Date(Date.now() - windowMin * 60_000).toISOString()
  const until = explicit ? new Date(toMs).toISOString() : null
  const legacyLimit = Number(q.limit) || 0
  const hist = (select: string) => db.from("client_state_history").select(select).eq("unique_id", cs.unique_id).eq("system_id", cs.system_id)

  // A Worker's day by the hour: the median of the reports in each hour, because
  // Cloudflare's analytics lag and one report can catch an hour half counted.
  if (cs.type === "cloudflare-worker-script") {
    const now = Date.now(), HOUR = 3_600_000
    const { data } = await hist("rq:data->script->recentRequests, re:data->script->recentErrors, created_at")
      .gte("created_at", new Date(now - 24 * HOUR).toISOString()).order("created_at", { ascending: true })
    const median = (a: number[]) => { const b = [...a].sort((x, y) => x - y); return b.length ? b[b.length >> 1]! : 0 }
    const requests: number[] = [], errors: number[] = []
    for (let k = 23; k >= 0; k--) {
      const end = now - k * HOUR
      const inHour = (data || []).filter((r: any) => { const t = Date.parse(r.created_at); return t <= end && t > end - HOUR })
      requests.push(median(inHour.map((r: any) => Number(r.rq) || 0)))
      errors.push(median(inHour.map((r: any) => Number(r.re) || 0)))
    }
    return { cpu: [], mem: [], hours: { requests, errors } }
  }
  // A Pages project's deploys over 30 days: each report names its latest.
  if (cs.type === "cloudflare-project") {
    const { data } = await hist("dep:data->project->latest_deployment, created_at")
      .gte("created_at", new Date(Date.now() - 30 * 24 * 3_600_000).toISOString()).order("created_at", { ascending: false })
    const seen = new Map<string, { at: number; status: string; built: number | null }>()
    for (const r of (data || []) as any[]) {
      const d = r.dep
      if (!d?.id || seen.has(d.id)) continue
      const built = Date.parse(d.deployed_at) - Date.parse(d.created_on)
      seen.set(d.id, { at: Date.parse(d.deployed_at || d.created_on || r.created_at), status: String(d.status || ""), built: built > 0 ? built : null })
    }
    return { cpu: [], mem: [], deploys: [...seen.values()].filter((x) => Number.isFinite(x.at)).sort((a, b) => a.at - b.at) }
  }

  // A zone's history is only read for its suspect share and suspects.
  const zone = cs.type === "cloudflare-domain"
  const sn = "data->domain->trafficQuality->suspectNetworks"
  const cols = zone ? `share:${sn}->suspectShare, suspects:${sn}->suspects, created_at` : "data, created_at"
  let rows: any[]
  if (legacyLimit) {
    const { data } = await hist(cols).order("created_at", { ascending: false }).limit(Math.min(legacyLimit, 2000))
    rows = (data || []).slice().reverse()
  } else {
    const { data } = await hist(cols).gte("created_at", since).lte("created_at", until ?? new Date().toISOString())
      .order("created_at", { ascending: true }).limit(5000)
    rows = data || []
  }
  if (zone) rows = rows.map((r: any) => ({ ...r, data: { domain: { trafficQuality: { suspectNetworks: r.share == null ? undefined : { suspectShare: r.share, suspects: r.suspects } } } } }))

  const cpu: number[] = [], mem: number[] = [], disk: number[] = [], net: number[] = [], netIn: number[] = [], netOut: number[] = []
  const ports: Record<string, number[]> = {}
  const portTimes: number[] = []
  const boxes = new Map<string, { cpu: number[]; mem: number[]; net: number[] }>()
  const metricSeries: Record<string, number[]> = {}
  const tqSamples: { total: number; by: Map<string, number> }[] = []
  const procs = new Map<string, { cpu: number[]; mem: number[] }>()
  let procSamples = 0
  let samples = 0
  let prev: { idle: number; total: number } | null = null
  for (const r of rows) {
    const d = r.data || {}
    if (cs.type === "cloudflare-domain") {
      const s = d?.domain?.trafficQuality?.suspectNetworks
      if (typeof s?.suspectShare === "number") {
        ;(metricSeries.SUSPECT ||= []).push(s.suspectShare)
        const list: any[] = Array.isArray(s.suspects) ? s.suspects : []
        tqSamples.push({ total: s.suspectShare, by: new Map(list.map((x) => [String(x.asn), Number(x.share) || 0])) })
      }
    }
    if (!cs.type.startsWith("cloudflare")) {
      try {
        for (const m of clientStateToService({ id, type: cs.type, data: d } as any, { id: cs.system_id, name: "" } as any).metrics || []) {
          const v = chartValue(String(m.value))
          // A reading that stops being a number (PING DOWN) charts as 0, so the drop shows.
          if (v != null) (metricSeries[m.label] ||= []).push(v)
          else metricSeries[m.label]?.push(0)
        }
      } catch {
        // An old sample the adapter can't read adds nothing.
      }
    }
    if (cs.type === "os") {
      const t = osTimes(d)
      if (prev && t.total > prev.total) cpu.push(Math.max(0, Math.min(100, Math.round((1 - (t.idle - prev.idle) / (t.total - prev.total)) * 100))))
      prev = t
      mem.push(memPct(d))
      const disks = Array.isArray(d?.disks) ? d.disks : []
      disk.push(disks.reduce((m: number, x: any) => Math.max(m, Math.min(100, Math.round(Number(x?.pct) || 0))), 0))
      const rx = Number(d?.network?.rxRate) || 0
      const tx = Number(d?.network?.txRate) || 0
      netIn.push(rx)
      netOut.push(tx)
      net.push(rx + tx)
      for (const p of Array.isArray(d?.processes) ? d.processes : []) {
        const name = String(p?.name || "")
        if (!name) continue
        let b = procs.get(name)
        if (!b) procs.set(name, (b = { cpu: Array(procSamples).fill(0), mem: Array(procSamples).fill(0) }))
        b.cpu[procSamples] = Number(p.cpu) || 0
        b.mem[procSamples] = Number(p.mem) || 0
      }
      procSamples++
      for (const b of procs.values()) for (const k of ["cpu", "mem"] as const) if (b[k].length < procSamples) b[k].push(0)
    } else if (cs.type === "device") {
      const sw = d?.sources?.tplinkswitch || (d?.sources?.snmp?.kind === "switch" ? d.sources.snmp : null)
      const ifs: any[] = Array.isArray(sw?.interfaces) ? sw.interfaces : []
      if (ifs.length) portTimes.push(Date.parse(r.created_at))
      for (const i of ifs) {
        const name = String(i?.name || "")
        if (name) (ports[name] ||= []).push((Number(i.inBps) || 0) + (Number(i.outBps) || 0))
      }
    } else {
      cpu.push(directCpu(cs.type, d))
      if (cs.type === "lxc-container") {
        const rx = Number(d?.container?.network?.rxRate) || 0
        const tx = Number(d?.container?.network?.txRate) || 0
        netIn.push(rx)
        netOut.push(tx)
        net.push(rx + tx)
      }
      if (cs.type === "docker" || cs.type === "lxc") {
        for (const c of Array.isArray(d?.containers) ? d.containers : []) {
          const name = String(c?.service || c?.name || "")
          if (!name) continue
          let b = boxes.get(name)
          if (!b) boxes.set(name, (b = { cpu: Array(samples).fill(0), mem: Array(samples).fill(0), net: Array(samples).fill(0) }))
          b.cpu[samples] = Number(c.cpu) || 0
          b.mem[samples] = Number(c.mem) || 0
          b.net[samples] = (Number(c.netIn ?? c.network?.rxRate) || 0) + (Number(c.netOut ?? c.network?.txRate) || 0)
        }
        samples++
        for (const b of boxes.values()) for (const k of ["cpu", "mem", "net"] as const) if (b[k].length < samples) b[k].push(0)
      }
    }
  }
  // os mem and net lead cpu by one point (cpu needs a prior sample); align.
  if (cs.type === "os") {
    for (const arr of [mem, disk, net, netIn, netOut, ...[...procs.values()].flatMap((b) => [b.cpu, b.mem])]) {
      if (arr.length > cpu.length) arr.splice(0, arr.length - cpu.length)
    }
  }

  return {
    cpu: downsample(cpu, MAX_POINTS),
    mem: downsample(mem, MAX_POINTS),
    disk: downsample(disk, MAX_POINTS),
    net: downsample(net, MAX_POINTS),
    netIn: downsample(netIn, MAX_POINTS),
    netOut: downsample(netOut, MAX_POINTS),
    ...(Object.keys(ports).length
      ? { ports: Object.fromEntries(Object.entries(ports).map(([k, v]) => [k, downsample(v, MAX_POINTS)])), portTimes: downsample(portTimes, MAX_POINTS) }
      : {}),
    ...(tqSamples.length
      ? {
        suspects: {
          total: downsample(tqSamples.map((x) => x.total), MAX_POINTS, false),
          byAsn: Object.fromEntries([...new Set(tqSamples.flatMap((x) => [...x.by.keys()]))]
            .map((a) => [a, downsample(tqSamples.map((x) => x.by.get(a) ?? 0), MAX_POINTS, false)])),
        },
      }
      : {}),
    ...(Object.keys(metricSeries).length
      ? { metrics: Object.fromEntries(Object.entries(metricSeries).map(([k, v]) => [k, downsample(v, MAX_POINTS, false)])) }
      : {}),
    ...(procs.size
      ? { processes: Object.fromEntries([...procs].map(([k, b]) => [k, { cpu: downsample(b.cpu.map((v) => v * 10), MAX_POINTS).map((v) => v / 10), mem: downsample(b.mem, MAX_POINTS) }])) }
      : {}),
    ...(boxes.size
      ? {
        containers: Object.fromEntries([...boxes].map(([k, b]) => [k, {
          cpu: downsample(b.cpu.map((v) => v * 10), MAX_POINTS).map((v) => v / 10),
          mem: downsample(b.mem, MAX_POINTS),
          net: downsample(b.net, MAX_POINTS),
        }])),
      }
      : {}),
  }
}

const CF_RANGE_DAYS: Record<string, number> = { "30d": 30, "90d": 90, "180d": 180, "1y": 365, "all": 3650 }

/** clientstate/cf-history: a zone's accumulated daily traffic. */
export async function cfHistory(db: Db, scope: Scope, id: string, range: string) {
  if (!id) throw new HttpError(400, "Missing service id")
  const cs = await visibleState(db, scope, id)
  if (!cs) return { series: [] }
  const since = new Date(Date.now() - (CF_RANGE_DAYS[range] ?? 90) * 86_400_000).toISOString().slice(0, 10)
  const { data } = await db.from("cf_zone_daily").select("day, requests, bandwidth, threats, uniques")
    .eq("unique_id", cs.unique_id).eq("system_id", cs.system_id).gte("day", since).order("day", { ascending: true }).limit(4000)
  return {
    series: (data || []).map((r: any) => ({
      timestamp: r.day,
      requests: Number(r.requests) || 0,
      bandwidth: Number(r.bandwidth) || 0,
      threats: Number(r.threats) || 0,
      uniques: Number(r.uniques) || 0,
    })),
  }
}

const SUSPECT_RANGE_DAYS: Record<string, number> = { "7d": 7, "30d": 30, "3m": SUSPECT_THREE_MONTHS_DAYS }

/** clientstate/suspects: a zone's suspect-network reports, whole, for the detail view. */
export async function suspects(db: Db, scope: Scope, id: string, range: string) {
  if (!id) throw new HttpError(400, "Missing service id")
  const cs = await visibleState(db, scope, id)
  if (!cs) throw new HttpError(404, "Service not found")
  const { data: sys } = await db.from("systems").select("user_id, org_id").eq("id", cs.system_id).maybeSingle()
  const sn = "data->domain->trafficQuality->suspectNetworks"
  const since = new Date(Date.now() - (SUSPECT_RANGE_DAYS[range] ?? 30) * 86_400_000).toISOString()
  const { data } = await db.from("client_state_history")
    .select(`share:${sn}->suspectShare, suspects:${sn}->suspects, created_at`)
    .eq("unique_id", cs.unique_id).eq("system_id", cs.system_id).gte("created_at", since).order("created_at", { ascending: true })
  const samples = (data || [])
    .filter((r: any) => typeof r.share === "number")
    .map((r: any) => ({ at: Date.parse(r.created_at), share: r.share, suspects: Array.isArray(r.suspects) ? r.suspects : [] }))
  // `account` names whose archived months to read: the key the export used.
  return { samples, systemId: cs.system_id, uniqueId: cs.unique_id, account: sys ? (sys.org_id ?? sys.user_id) : null }
}

/** activity/probes: daily probe counts for every zone the caller can see. Paths only on each zone's newest day. */
export async function probes(db: Db, scope: Scope) {
  const zones = await visibleStates(db, scope, ["cloudflare-domain"])
  if (!zones.length) return { rows: [] }
  const idFor = new Map(zones.map((z) => [`${z.system_id}|${z.unique_id}`, z.id]))
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10)
  const { data } = await db.from("cf_zone_daily")
    .select("system_id, unique_id, day, probes, probes_cms, probes_served, probe_paths")
    .in("system_id", [...new Set(zones.map((z) => z.system_id))]).gte("day", since).not("probes", "is", null)
    .order("day", { ascending: false }).order("unique_id", { ascending: true })
  const rows: any[] = []
  const seen = new Set<string>()
  for (const r of data || []) {
    const key = `${r.system_id}|${r.unique_id}`
    const id = idFor.get(key)
    if (!id) continue
    rows.push({ id, day: r.day, probes: Number(r.probes) || 0, cms: Number(r.probes_cms) || 0, served: Number(r.probes_served) || 0, paths: seen.has(key) ? undefined : r.probe_paths || [] })
    seen.add(key)
  }
  return { rows }
}

export interface EventsQuery { id?: string; systemId?: string; limit?: number; offset?: number; source?: string; detail?: string; service?: string }

/**
 * system/events: every alert a system raised, open or resolved. Events belong
 * to the system; group grantees don't get them, since a system-level alert can
 * name services they weren't given.
 */
export async function systemEvents(db: Db, scope: Scope, q: EventsQuery) {
  const uuid = /^[0-9a-f-]{36}$/i
  const eventId = String(q.id || "")
  let systemId = String(q.systemId || "")
  const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200)
  const offset = Math.max(Number(q.offset) || 0, 0)
  if (uuid.test(eventId)) {
    const { data: row } = await db.from("notifications").select("system_id").eq("id", eventId).maybeSingle()
    systemId = row?.system_id || ""
    if (!systemId) throw new HttpError(404, "Event not found")
  }
  if (!uuid.test(systemId)) throw new HttpError(400, "Missing systemId")
  const { data: system } = await db.from("systems").select("id").eq("id", systemId).maybeSingle()
  // Same answer for "no such system" and "not yours".
  if (!system || !(scope.all || scope.alertSystems.has(systemId))) throw new HttpError(404, "System not found")
  let rows = db.from("notifications")
    .select("id, system_id, type, title, message, source, source_detail, metadata, created_at, resolved_at", { count: "exact" })
    .eq("system_id", systemId).order("created_at", { ascending: false }).range(offset, offset + limit - 1)
  if (uuid.test(eventId)) rows = rows.eq("id", eventId)
  if (q.source) rows = rows.eq("source", String(q.source))
  if (q.detail) rows = rows.eq("source_detail", String(q.detail))
  // One service's events, by the system page's rule: a finding names its
  // service in metadata.service, a status alert carries it as source_detail,
  // and cluster alerts (filed on a member host) stay.
  if (q.service) {
    const uid = String(q.service)
    // or() splits on commas and parens; a unique id holding one can't be expressed.
    if (/[,()]/.test(uid)) throw new HttpError(400, "Unsupported service id")
    rows = rows.or(`metadata->>service.eq.${uid},source_detail.eq.${uid},source.eq.cluster`)
  }
  const { data, count } = await rows
  return { success: true, events: data || [], total: count ?? 0 }
}
