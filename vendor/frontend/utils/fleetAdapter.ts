// Maps real `systems` + `client_states` rows into the observatory `Service`/`Stack` shape.
// stack = a registered system; service = one client_state (a CF project/domain/worker,
// an OS/PM2 host metric, a website check, etc.). Pure functions — no store access.

import type { Level, Service, Unit, Metric, EventLine, ServiceLink, DiskInfo, ProcessInfo, CloudflareDetail, AdsenseDetail, Ga4Detail, CostDetail } from '~/types/fleet'
// Explicit import (not just Nuxt app auto-import): this module is also imported
// from the tenant (tenant/server/fleet/external.ts), and the server does not
// auto-import app-level utils/, so these would be undefined server-side otherwise.
import { cpuLevel, memLevel, diskLevel, fmtAge, fmtCores, containerCpuLevel, parseQuantity, webThrottled } from '~/utils/fleet'

// ---- generic helpers ----------------------------------------------------

const STATUS_LEVEL: Record<string, Level> = {
  online: 'ok', ok: 'ok', healthy: 'ok', active: 'ok', success: 'ok',
  warning: 'warn', warn: 'warn', degraded: 'warn',
  error: 'crit', crit: 'crit', critical: 'crit', failure: 'crit', failed: 'crit', offline: 'crit', down: 'crit',
  pending: 'standby', standby: 'standby', unknown: 'standby',
}

export function toLevel(status?: string | null): Level {
  if (!status) return 'standby'
  return STATUS_LEVEL[String(status).toLowerCase()] ?? 'standby'
}

const WORD: Record<Level, string> = { ok: 'ONLINE', warn: 'DEGRADED', crit: 'ERROR', standby: 'PENDING' }

// Cloudflare records that describe INVENTORY rather than a live agent: a Pages
// project and a Worker script exist whether or not they appear in the latest
// push. Pages projects/zones are collected in modulo shards, and the per-script
// Worker analytics only list scripts with traffic in the last 24h — so a gap in
// updates says nothing about health. Treated separately from the OFFLINE rule.
const CF_INVENTORY = new Set(['cloudflare-project', 'cloudflare-worker-script'])
// A Worker drops out of the analytics push once it serves no traffic; past this
// much silence its last-known request/error counts are history, not current.
const CF_WORKER_IDLE_AFTER = 26 * 3600

function secondsSince(ts?: string | number | null): number {
  if (!ts) return 0
  const t = typeof ts === 'number' ? ts : Date.parse(ts)
  if (!t || Number.isNaN(t)) return 0
  return Math.max(0, Math.floor((Date.now() - t) / 1000))
}

/** compact integer: 1771318 -> "1.8M", 12345 -> "12.3K" */
export function compact(n?: number | null): string {
  const v = Number(n) || 0
  if (v >= 1e9) return (v / 1e9).toFixed(1).replace(/\.0$/, '') + 'B'
  if (v >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'M'
  if (v >= 1e3) return (v / 1e3).toFixed(1).replace(/\.0$/, '') + 'K'
  return String(v)
}

/** bytes -> human size */
export function fmtBytes(b?: number | null): string {
  let v = Number(b) || 0
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  let i = 0
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${u[i]}`
}

function osCpuPct(data: any): number {
  const cpus = data?.cpus
  if (!Array.isArray(cpus) || !cpus.length) return 0
  let idle = 0, total = 0
  for (const c of cpus) {
    const t = c?.times || {}
    const sum = (t.user || 0) + (t.nice || 0) + (t.sys || 0) + (t.idle || 0) + (t.irq || 0)
    idle += t.idle || 0
    total += sum
  }
  if (!total) return 0
  return Math.round((1 - idle / total) * 100)
}

// ---- per-type field mapping --------------------------------------------

interface CS {
  id: string
  type: string
  data: any
  status?: string | null
  status_reason?: string | null
  updated_at?: string | null
  client_ip?: string | null
}

interface Sys {
  id: string
  name: string
  user_id?: string | null
  group_name?: string | null
  type?: string | null
  status?: string | null
  status_reason?: string | null
  last_seen?: string | null
  ip_address?: string | null
}

interface Mapped {
  name: string
  kindLabel: string
  badge: string
  hasBars: boolean
  cpu: number
  /** Preformatted CPU string when '%' is the wrong unit (container groups
   *  aggregate to cores). Consumers fall back to `cpu` + '%'. */
  cpuDisplay?: string
  /** Level matching cpuDisplay's unit, so views don't re-threshold in %. */
  cpuLevelHint?: Level
  mem: number
  ping: number
  /** A switch's every port, in order. `units` stops at 16, which is no faceplate. */
  ports?: Level[]
  unitLabel: string
  units: Unit[]
  metrics: Metric[]
  events?: EventLine[]
  sparkline?: number[]
  disk?: number
  disks?: DiskInfo[]
  processes?: ProcessInfo[]
  cf?: CloudflareDetail
  adsense?: AdsenseDetail
  ga4?: Ga4Detail
  cost?: CostDetail
  /** Set when the record is dormant rather than reporting — shown in place of the status word. */
  idleWord?: string
  memBytes?: number
  memory?: Service['memory']
  restarts?: number
}

function normProcesses(raw: any): ProcessInfo[] {
  return Array.isArray(raw)
    ? raw.map((p: any) => ({ name: String(p.name || ''), count: Number(p.count) || 0, cpu: Number(p.cpu) || 0, mem: Number(p.mem) || 0 }))
    : []
}

function fmtUptime(secs: number): string {
  if (!secs || secs < 0) return '—'
  const d = Math.floor(secs / 86400), h = Math.floor((secs % 86400) / 3600), m = Math.floor((secs % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

export const COST_PROVIDER_LABEL: Record<string, string> = {
  openai: 'OpenAI', anthropic: 'Anthropic', aws: 'AWS', vercel: 'Vercel', fastly: 'Fastly',
  cloudflare: 'Cloudflare', posthog: 'PostHog', gcp: 'Google Cloud', workspace: 'Google Workspace', 'google-ads': 'Google Ads', 'meta-ads': 'Meta Ads',
}

const COST_BILLING_URL: Record<string, string> = {
  openai: 'https://platform.openai.com/usage', anthropic: 'https://console.anthropic.com/usage',
  aws: 'https://console.aws.amazon.com/cost-management/home', vercel: 'https://vercel.com/dashboard/usage',
  fastly: 'https://manage.fastly.com/account/billing', cloudflare: 'https://dash.cloudflare.com/?to=/:account/billing',
  posthog: 'https://us.posthog.com/organization/billing', gcp: 'https://console.cloud.google.com/billing/reports',
  workspace: 'https://admin.google.com/ac/billing/subscriptions', 'google-ads': 'https://ads.google.com/aw/billing',
  'meta-ads': 'https://business.facebook.com/billing_hub',
}

/**
 * One total for a set of services' spend: amounts summed, daily series summed
 * by date. Undefined when none of them is a cost row, or when they bill in
 * different currencies, which a plain sum would get wrong.
 */
export function sumCosts(services: Service[]): CostDetail | undefined {
  const cs = services.filter((s) => s.cost).map((s) => ({ s, c: s.cost! }))
  if (!cs.length || new Set(cs.map((x) => x.c.currency)).size > 1) return undefined
  const byDay = new Map<string, number>()
  for (const { c } of cs) for (const d of c.daily) byDay.set(d.date, (byDay.get(d.date) || 0) + d.amount)
  const sum = (f: (c: CostDetail) => number | undefined) => cs.reduce((n, { c }) => n + (f(c) || 0), 0)
  // A total budget only means something when every member has one.
  const budgeted = cs.every(({ c }) => c.budget)
  const first = cs[0]!.c
  return {
    provider: new Set(cs.map((x) => x.c.provider)).size === 1 ? first.provider : 'mixed',
    currency: first.currency,
    asOf: first.asOf,
    monthToDate: sum((c) => c.monthToDate),
    projected: sum((c) => c.projected),
    budget: budgeted ? sum((c) => c.budget) : undefined,
    yesterday: sum((c) => c.yesterday),
    today: sum((c) => c.today),
    daily: [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, amount]) => ({ date, amount })),
    parts: cs.map(({ s, c }) => ({ name: s.name, provider: c.provider, monthToDate: c.monthToDate, projected: c.projected, budget: c.budget }))
      .sort((a, b) => b.monthToDate - a.monthToDate),
  }
}

/** Currency with cents under 100, whole units above: "$4.12", "$1,284". */
export function fmtMoney(n: number, currency = 'USD'): string {
  const big = Math.abs(n) >= 100
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency, maximumFractionDigits: big ? 0 : 2, minimumFractionDigits: big ? 0 : 2,
  }).format(n)
}

/** AdSense's figures, for a whole account or one domain's share of it. */
function adsenseMetrics(d: any, ok: boolean, currency = 'USD'): Metric[] {
  const money = (n: any) => ok ? new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(Number(n) || 0) : '—'
  return [
    metric('TODAY', money(d.today), 'ok'),
    metric('YESTERDAY', money(d.yesterday), ok && Number(d.yesterday) === 0 ? 'warn' : 'ok'),
    metric('7 DAYS', money(d.last7), 'ok'),
    metric('MONTH', money(d.monthToDate), 'ok'),
    metric('PAGE RPM', money(d.rpm), 'ok'),
  ]
}

/**
 * A group with a domain shows its own share of an account-wide member, not the
 * account's. The domain has to match what the provider reports, so archpaper.com
 * doesn't take in jobs.archpaper.com. A domain the provider didn't list (AdSense
 * lists the top 20 earners; Analytics, a property's web streams) shows dashes: the
 * account's totals would read as the site's.
 * For display only: a group grant still lets its grantee read the whole row.
 */
export function scopeToDomain(s: Service, domain?: string | null): Service {
  if (!domain) return s
  const host = (x: string) => x.trim().toLowerCase().replace(/^www\./, '')
  // Google Analytics: the property whose web stream is this domain. An old copy
  // of a site's property can claim the same stream, so the busiest one is the site.
  // A stream's URL can go stale when a site moves (TechPlus still says
  // techplusexpo.com), so failing that, the property reporting pages on this host.
  if (s.ga4) {
    const props = s.ga4.accounts.flatMap((x) => (x.properties || []) as any[])
    const busiest = (list: any[]) => list.sort((x, y) => (y.last7?.users || 0) - (x.last7?.users || 0))[0]
    const onHost = (p: any) => [...(p.pages?.popular || []), ...(p.pages?.trending || [])].some((x: any) => host(x.host) === host(domain))
    const prop = busiest(props.filter((p) => (p.domains || []).some((d: string) => host(d) === host(domain)))) ?? busiest(props.filter(onHost))
    const own = (list?: any[]) => (list || []).filter((p) => host(p.host) === host(domain))
    const show = (n?: number) => (prop ? compact(n || 0) : '—')
    // With figures present, warn only ever means some properties failed, and that
    // verdict belongs to the account's own row. OFFLINE still reaches every site.
    const partial = s.level === 'warn' ? { level: 'ok' as Level, statusWord: WORD.ok, statusReason: undefined } : {}
    return {
      ...s,
      ...partial,
      name: 'Analytics',
      kindLabel: `${s.kindLabel} · ${host(domain)}`,
      metrics: [metric('ACTIVE NOW', show(prop?.activeNow), 'ok'), metric('USERS TODAY', show(prop?.today?.users), 'ok'), metric('USERS 7D', show(prop?.last7?.users), 'ok'), metric('VIEWS 7D', show(prop?.last7?.views), 'ok')],
      unitLabel: '',
      units: [],
      ga4: undefined,
      ga4Site: prop ? { activeNow: prop.activeNow, yesterday: prop.yesterday, last7: prop.last7, users: prop.daily?.users ?? [], popular: own(prop.pages?.popular), trending: own(prop.pages?.trending) } : undefined,
    } as Service
  }
  const a = s.adsense
  if (!a) return s
  const site = a.sites?.find((x) => host(x.domain) === host(domain))
  return {
    ...s,
    // The account's name ("The Architect's Newspaper") isn't this site's.
    name: 'AdSense',
    kindLabel: `${s.kindLabel} · ${host(domain)}`,
    metrics: adsenseMetrics(site ?? {}, !!site, a.currency),
    sparkline: site?.daily ?? [],
    adsense: undefined,
  }
}

function metric(label: string, value: string, level: Level = 'standby'): Metric {
  return { label, value, level }
}

// Compact HTTP-status segments (2xx/3xx/4xx/5xx) for a stat card's mini bar.
// Colors match the fuller breakdown in DetailCloudflare. Returns undefined when
// there's no status data so the card can fall back to a plain text metric.
const STATUS_SEG_COLOR: Record<string, string> = {
  '2xx': '#3fb950', '3xx': '#2f81f7', '4xx': '#d29922', '5xx': '#f85149',
}
function statusSegments(sc?: Record<string, number>): Metric['segments'] {
  const c = sc || {}
  const keys = ['2xx', '3xx', '4xx', '5xx']
  const total = keys.reduce((a, k) => a + (Number(c[k]) || 0), 0)
  if (!total) return undefined
  return keys
    .map((k) => ({ key: k, count: Number(c[k]) || 0, pct: ((Number(c[k]) || 0) / total) * 100, color: STATUS_SEG_COLOR[k] }))
    .filter((s) => s.pct > 0)
}

/** Health level for a single docker/lxc container. */
function containerLevel(c: any): Level {
  const health = String(c.health || '').toLowerCase()
  if (health === 'unhealthy') return 'crit'
  if (!c.running) return (Number(c.exitCode) || 0) !== 0 ? 'crit' : 'warn'
  if (health === 'starting') return 'warn'
  return 'ok'
}

/**
 * Shared mapping for a container group (one docker compose project or one lxc
 * group). Payload shape: { project, host, running, total, containers: [...] }.
 * Containers become units; unhealthy/stopped ones also surface as events.
 */
function mapContainerGroup(d: any, engine: 'docker' | 'lxc'): Partial<Mapped> {
  const c: any[] = Array.isArray(d.containers) ? d.containers : []
  const running = typeof d.running === 'number' ? d.running : c.filter((x) => x.running).length
  const total = typeof d.total === 'number' ? d.total : c.length
  const sumCpu = Math.round(c.reduce((s, x) => s + (Number(x.cpu) || 0), 0))
  const sumMem = c.reduce((s, x) => s + (Number(x.mem) || 0), 0)
  // Aggregate net + block IO rates across containers (bytes/sec). Present only
  // once the plugin has a rate (second poll onward); undefined → metric omitted.
  const anyIo = c.some((x) => x.netIn != null || x.netOut != null)
  const anyBlk = c.some((x) => x.blkRead != null || x.blkWrite != null)
  const sumNet = c.reduce((s, x) => s + (Number(x.netIn) || 0) + (Number(x.netOut) || 0), 0)
  const sumBlk = c.reduce((s, x) => s + (Number(x.blkRead) || 0) + (Number(x.blkWrite) || 0), 0)
  const label = engine === 'lxc' ? 'LXC' : 'Docker'

  const units: Unit[] = c.map((x) => ({
    name: x.service || x.name || 'container',
    state: x.running ? (String(x.health || 'running')) : (x.state || 'stopped'),
    value: x.running ? `${Math.round(Number(x.cpu) || 0)}%` : (x.state || 'stopped'),
    level: containerLevel(x),
  }))

  const events: EventLine[] = c
    .filter((x) => containerLevel(x) !== 'ok')
    .slice(0, 8)
    .map((x) => ({
      time: String(x.service || x.name || '').slice(0, 12),
      severity: containerLevel(x),
      message: `${x.name}: ${x.status || x.state || 'stopped'}`,
    }))

  return {
    name: d.project || d.name || engine,
    kindLabel: d.host ? `${label} · ${d.host}` : label,
    badge: `×${total}`,
    hasBars: false,
    cpu: sumCpu,
    cpuDisplay: fmtCores(sumCpu),
    cpuLevelHint: containerCpuLevel(sumCpu),
    mem: 0,
    unitLabel: engine === 'lxc' ? 'INSTANCES' : 'CONTAINERS',
    units,
    events,
    metrics: [
      metric('RUNNING', `${running}/${total}`, running < total ? 'warn' : 'ok'),
      metric('CPU', fmtCores(sumCpu), containerCpuLevel(sumCpu)),
      metric('MEM', fmtBytes(sumMem), 'ok'),
      ...(anyIo ? [metric('NET', fmtRate(sumNet), 'ok')] : []),
      ...(anyBlk ? [metric('DISK I/O', fmtRate(sumBlk), 'ok')] : []),
    ],
  }
}

/**
 * Does `value` breach a Nagios threshold range? "10" means outside 0..10,
 * "10:" below 10, "~:10" above 10, "10:20" outside 10..20, and a leading "@"
 * inverts it to inside the range. Unparseable ranges never breach.
 */
export function nagiosBreach(range: string | undefined, value: number): boolean {
  if (!range) return false
  const inside = range.startsWith('@')
  const r = inside ? range.slice(1) : range
  const [lo, hi] = r.includes(':') ? r.split(':') : ['0', r]
  const low = lo === '~' ? -Infinity : lo === '' ? 0 : Number(lo)
  const high = hi === '' || hi === undefined ? Infinity : Number(hi)
  if (Number.isNaN(low) || Number.isNaN(high)) return false
  const within = value >= low && value <= high
  return inside ? within : !within
}

function nagiosFields(d: any): Partial<Mapped> {
  const state = String(d.state || 'unknown')
  const level: Level = state === 'ok' ? 'ok' : state === 'warning' ? 'warn' : state === 'critical' ? 'crit' : 'warn'
  const perf: any[] = Array.isArray(d.perfdata) ? d.perfdata : []
  const perfLevel = (p: any): Level => (nagiosBreach(p.crit, p.value) ? 'crit' : nagiosBreach(p.warn, p.value) ? 'warn' : 'ok')
  const show = (p: any) => `${Number(p.value).toLocaleString('en-US', { maximumFractionDigits: 3 })}${p.uom || ''}`
  return {
    name: d.name || 'check',
    kindLabel: `Check · ${d.command || 'nagios'}`,
    badge: 'check',
    metrics: [
      metric('STATE', state.toUpperCase(), level),
      // The first few perfdata values as tiles; all of them as units below.
      ...perf.slice(0, 3).map((p) => metric(String(p.label).toUpperCase(), show(p), perfLevel(p))),
      ...(typeof d.durationMs === 'number' ? [metric('RAN IN', d.durationMs < 1000 ? `${d.durationMs}ms` : `${(d.durationMs / 1000).toFixed(1)}s`, d.timedOut ? 'crit' : 'ok')] : []),
    ],
    unitLabel: perf.length > 3 ? 'PERFDATA' : '',
    units: perf.length > 3
      ? perf.map((p) => ({ name: String(p.label), state: show(p), value: [p.warn && `warn ${p.warn}`, p.crit && `crit ${p.crit}`].filter(Boolean).join(' · '), level: perfLevel(p), kind: 'metric' }))
      : [],
  }
}

// Render one SNMP datapoint object (printer / switch / qnap) into display fields.
// Shared by the legacy `snmp` type and the merged `device` type (data.sources.snmp).
function snmpFields(d: any): Partial<Mapped> {
  const kind = d.kind || (d.supplies ? 'printer' : 'device')
  const up = d.reachable !== false

  if (kind === 'printer') {
    const supplies = Array.isArray(d.supplies) ? d.supplies : []
    const tonerLvl = (pct: number | null): Level =>
      pct == null ? 'standby' : pct <= (d.warnPct ?? 10) ? 'crit' : pct <= 25 ? 'warn' : 'ok'
    return {
      name: d.name || 'printer',
      kindLabel: `Printer · ${d.model || 'SNMP'}`,
      badge: 'printer',
      metrics: [
        metric('PAGES', d.pages != null ? compact(d.pages) : '—', 'ok'),
        metric('STATUS', up ? String(d.status || 'ok').toUpperCase() : 'UNREACHABLE', up ? 'ok' : 'crit'),
      ],
      unitLabel: 'SUPPLIES',
      units: supplies.map((s: any) => ({
        name: String(s.name || '').replace(/\s*(Cartridge|HP)\s*/gi, ' ').trim() || 'supply',
        state: s.pct != null ? `${s.pct}%` : '—', value: '', level: tonerLvl(s.pct), kind: 'supply',
      })),
    }
  }

  if (kind === 'qnap') {
    const disks = Array.isArray(d.disks) ? d.disks : []
    const vols = Array.isArray(d.volumes) ? d.volumes : []
    const tw = d.tempWarnC ?? 70
    const tempLvl = (c: number | undefined): Level => (c == null ? 'standby' : c >= tw ? 'crit' : c >= tw - 10 ? 'warn' : 'ok')
    const diskLvl = (dd: any): Level =>
      (dd.status != null && dd.status !== 0) || (dd.smart && !/good|normal/i.test(dd.smart))
        ? 'crit' : dd.tempC != null && dd.tempC >= tw ? 'warn' : 'ok'
    return {
      name: d.name || 'nas',
      kindLabel: `NAS · ${d.model || 'QNAP'}`,
      badge: 'nas',
      metrics: [
        metric('CPU', d.cpuPct != null ? `${d.cpuPct}%` : '—', d.cpuPct != null && d.cpuPct >= 90 ? 'warn' : 'ok'),
        ...(d.memPct != null ? [metric('RAM', `${d.memPct}%`, d.memPct >= 90 ? 'warn' : 'ok')] : []),
        metric('CPU °C', d.cpuTempC != null ? `${d.cpuTempC}°` : '—', tempLvl(d.cpuTempC)),
        ...(d.sysTempC != null ? [metric('SYS °C', `${d.sysTempC}°`, tempLvl(d.sysTempC))] : []),
        ...(d.fanRpm != null ? [metric('FAN', `${d.fanRpm}rpm`, d.fanRpm > 0 ? 'ok' : 'crit')] : []),
      ],
      disks: vols.map((v: any) => ({
        mount: String(v.mount || '').split('/').pop() || String(v.mount || ''),
        fstype: '', pct: v.pct || 0, used: (v.usedGB || 0) * 1e9, total: (v.totalGB || 0) * 1e9,
      })),
      unitLabel: 'DISKS',
      units: disks.map((dd: any) => ({
        name: `${dd.descr || `Slot ${dd.slot}`}${dd.model ? ` · ${String(dd.model).slice(0, 20)}` : ''}`,
        state: dd.tempC != null ? `${dd.tempC}°C` : (dd.capacity || ''),
        value: dd.smart || (dd.status === 0 ? 'OK' : dd.status != null ? `status ${dd.status}` : ''),
        level: diskLvl(dd), kind: 'disk',
      })),
    }
  }

  // An admin-disabled port is deliberately off (standby, not a fault); an enabled
  // port with no link is a real link-down. Loop state is reported by switches that
  // detect it (tplinkswitch). An empty port is idle, not broken: the server raises
  // nothing for it, so the card must not paint it red. Only a named uplink that lost
  // link (tplinkswitch's downUplinks) is a fault.
  const portLevel = (i: any): Level => {
    if (i.loop === 'loop') return 'crit'
    if (i.loop === 'blocked') return 'warn'
    if (i.adminUp === false) return 'standby'
    if (i.up !== false) return 'ok'
    return Array.isArray(d.downUplinks) && d.downUplinks.includes(String(i.name)) ? 'crit' : 'standby'
  }

  // switch / generic SNMP device
  return {
    name: d.name || d.sysName || 'device',
    ...(Array.isArray(d.interfaces) && d.interfaces.length ? { ports: d.interfaces.map(portLevel) } : {}),
    kindLabel: `${kind === 'switch' ? 'Switch' : 'Device'} · ${(d.sysDescr ? String(d.sysDescr).split(',')[0] : '') || 'SNMP'}`,
    badge: kind === 'switch' ? 'switch' : 'snmp',
    metrics: [
      ...(d.cpuPct != null ? [metric('CPU', `${d.cpuPct}%`, d.cpuPct >= 90 ? 'crit' : d.cpuPct >= 75 ? 'warn' : 'ok')] : []),
      ...(d.memPct != null ? [metric('RAM', `${d.memPct}%`, d.memPct >= 90 ? 'crit' : d.memPct >= 80 ? 'warn' : 'ok')] : []),
      // Separate cards rather than one combined figure: on a router the two
      // directions are the interesting comparison, and cramming "↓x ↑y" into a
      // single stat value wraps badly. These are the WAN link alone (see the
      // plugin) — summing all interfaces double-counts transit traffic.
      ...(d.netIn != null || d.netOut != null
        ? [
            metric(d.wanInterface ? `NET ↓ IN · ${d.wanInterface}` : 'NET ↓ IN', fmtRate(d.netIn ?? 0), 'ok'),
            metric(d.wanInterface ? `NET ↑ OUT · ${d.wanInterface}` : 'NET ↑ OUT', fmtRate(d.netOut ?? 0), 'ok'),
          ]
        : []),
      ...(d.load1 != null ? [(() => {
        // Load per core: divide by core count so a parked kernel thread (common
        // ~1.0 baseline on routers) reads as fraction-of-a-core, not "busy".
        const cores = d.cpuCores > 0 ? d.cpuCores : 1
        const per = (d.loadavg && d.loadavg.length ? d.loadavg : [d.load1]).map((n: number) => (n / cores).toFixed(2))
        const worst = Math.max(...per.map(Number))
        return metric(cores > 1 ? 'LOAD/CORE' : 'LOAD', per.join(' '), worst >= 1 ? 'crit' : worst >= 0.7 ? 'warn' : 'ok')
      })()] : []),
      ...(d.portsTotal != null ? [metric('PORTS', `${d.portsUp ?? 0}/${d.portsTotal}`, up ? ((d.portsUp ?? 0) > 0 ? 'ok' : 'warn') : 'crit')] : []),
      metric('UPTIME', d.uptimeSecs != null ? fmtUptime(d.uptimeSecs) : up ? 'up' : '—', up ? 'ok' : 'crit'),
    ],
    // Per-link throughput — shows where traffic actually flows (and makes the
    // WAN-vs-LAN mirroring legible instead of hiding it in one summed number).
    ...(Array.isArray(d.interfaces) && d.interfaces.length
      ? {
          unitLabel: 'INTERFACES',
          units: d.interfaces
            .slice(0, 16)
            .map((i: any) => {
              const adminDown = i.adminUp === false
              const linkDown = !adminDown && i.up === false
              const lvl = portLevel(i)
              const rate = i.inBps == null && i.outBps == null
                ? ''
                : `↓ ${fmtRate(i.inBps ?? 0)}  ↑ ${fmtRate(i.outBps ?? 0)}`
              return {
                name: String(i.name) + (i.name === d.wanInterface ? ' · WAN' : ''),
                state: i.loop === 'loop' ? 'LOOP' : i.loop === 'blocked' ? 'BLOCKED' : adminDown ? 'disabled' : linkDown ? 'LINK DOWN' : (i.speed || 'up'),
                value: rate,
                level: lvl,
                kind: 'interface',
              }
            }),
        }
      : {}),
  }
}

// TP-Link extender fields. Shared by the standalone `tplink` service and the
// merged `device` entity (where it arrives under data.sources.tplink alongside
// the netscan ping datapoint for the same physical box).
function tplinkFields(d: any): Partial<Mapped> {
  const up = d.reachable !== false && !d.error
  const uplink = d.uplinkUp !== false
  const radiosOn = [d.radio2g !== false, d.radio5g !== false].filter(Boolean).length
  const clients: any[] = Array.isArray(d.clients) ? d.clients : []
  return {
    name: d.name || d.ip || 'extender',
    kindLabel: `Extender${d.model ? ` · ${d.model}` : ''}`,
    badge: 'wifi',
    metrics: [
      metric('UPLINK', !up ? '—' : uplink ? 'UP' : 'DOWN', !up ? 'standby' : uplink ? 'ok' : 'crit'),
      metric('RADIOS', up ? `${radiosOn}/2` : '—', radiosOn === 2 ? 'ok' : radiosOn === 0 ? 'crit' : 'warn'),
      metric('CLIENTS', d.clientCount != null ? String(d.clientCount) : '—', 'ok'),
      ...(d.firmware ? [metric('FIRMWARE', String(d.firmware).split(' ')[0], 'ok')] : []),
    ],
    unitLabel: clients.length ? 'CONNECTED CLIENTS' : '',
    units: clients.slice(0, 12).map((c) => ({
      name: String(c.name || 'device'),
      state: String(c.band || ''),
      value: String(c.mac || ''),
      level: 'ok' as Level,
      kind: 'client',
    })),
  }
}

function mapByType(cs: CS): Mapped {
  const d = cs.data || {}
  const base: Mapped = {
    name: d?.name || 'service', kindLabel: cs.type, badge: cs.type,
    hasBars: false, cpu: 0, mem: 0, ping: 0, unitLabel: '', units: [], metrics: [],
  }

  switch (cs.type) {
    case 'cloudflare-project': {
      const p = d.project || {}
      const a = p.analytics || {}
      // Pages deploy states: "success" = live; active/building/etc. = in progress
      // (not a problem); failure/canceled = failed. Show a plain-English label.
      const deployRaw = String(p.latest_deployment?.status || p.latest_deployment?.latest_stage?.status || 'unknown').toLowerCase()
      const inProgress = ['active', 'building', 'deploying', 'initializing', 'queued', 'running'].includes(deployRaw)
      const failed = ['failure', 'error', 'canceled', 'cancelled'].includes(deployRaw)
      const deployLabel = deployRaw === 'success' ? 'LIVE' : inProgress ? 'BUILDING' : failed ? 'FAILED' : deployRaw.toUpperCase()
      const deployLevel: Level = deployRaw === 'success' ? 'ok' : failed ? 'crit' : 'standby'
      return {
        ...base,
        name: p.name || 'project',
        kindLabel: 'Cloudflare · Pages',
        badge: 'pages',
        metrics: [
          metric('DEPLOY', deployLabel, deployLevel),
          metric('REQUESTS', compact(a.requests), 'ok'),
          metric('ERRORS', compact(a.errors), (a.errors || 0) > 0 ? 'crit' : 'ok'),
        ],
      }
    }
    case 'cloudflare-domain': {
      const dom = d.domain || {}
      const s = dom.analytics?.summary || dom.detailedAnalytics?.summary || {}
      const threats = s.threats || 0
      const sec = dom.security || {}
      // daily series (detailedAnalytics.timeseries: { threats, requests, timestamp })
      const ts: any[] = Array.isArray(dom.detailedAnalytics?.timeseries) ? dom.detailedAnalytics.timeseries : []
      const sparkline = ts.map((t) => Number(t.threats) || 0)
      const events: EventLine[] = ts
        .slice(-8)
        .reverse()
        .map((t) => ({
          time: String(t.timestamp || '').slice(5), // MM-DD
          severity: (Number(t.threats) || 0) > 0 ? 'warn' : 'ok',
          message: `${compact(t.threats)} threats · ${compact(t.requests)} requests`,
        }))

      // Cache hit ratio: prefer the worker's derived value; fall back to a live
      // compute from cached/total requests for payloads from older workers.
      const cacheHit = typeof s.cacheHitRatio === 'number'
        ? s.cacheHitRatio
        : (s.totalRequests > 0 ? Math.round((s.cachedRequests / s.totalRequests) * 1000) / 10 : 0)
      const errorRate = typeof s.errorRate === 'number' ? s.errorRate : 0
      const serverErr = typeof s.serverErrorRate === 'number' ? s.serverErrorRate : 0
      const mitigated = Number(sec.mitigated) || 0

      // Turnstile is only present when the reporter runs with INCLUDE_TURNSTILE
      // and the zone actually has widgets — leave it undefined otherwise rather
      // than emitting zeroes that would read as "no traffic".
      const turnstile = dom.turnstile && (dom.turnstile.widgets || dom.turnstile.error)
        ? dom.turnstile
        : undefined

      const cf: CloudflareDetail = {
        cacheHitRatio: cacheHit,
        bandwidthSaved: s.bandwidthSaved,
        encryptedShare: s.encryptedShare,
        errorRate,
        serverErrorRate: serverErr,
        statusClasses: s.statusClasses,
        topCountries: Array.isArray(s.topCountries) ? s.topCountries : undefined,
        countries24h: Array.isArray(s.countries24h) ? s.countries24h : undefined,
        // `unavailable` is a third state alongside data and error: the plan
        // can't serve firewall events, so the panel says which plan it needs
        // rather than falling through to "no events in window", which would
        // read as "you're clean" when it means "we can't see".
        security: sec.totalEvents != null || sec.error || sec.unavailable ? sec : undefined,
        cache: dom.cache && (dom.cache.byStatus || dom.cache.error) ? dom.cache : undefined,
        turnstile,
        // Bot Management (Enterprise) — only when the worker returned real data.
        bot: dom.bot && (dom.bot.total != null || dom.bot.error) ? dom.bot : undefined,
        // Networks rendering pages without reading articles (worker: suspect-networks.js).
        suspectNetworks: dom.trafficQuality?.suspectNetworks || undefined,
        pageviews: typeof s.pageviews === 'number' && s.pageviews > 0 ? s.pageviews : undefined,
        visits: typeof s.visits === 'number' && s.visits > 0 ? s.visits : undefined,
        timeseries: ts.length ? ts : undefined,
      }

      return {
        ...base,
        name: dom.name || 'domain',
        kindLabel: 'Cloudflare · Zone',
        badge: dom.plan && dom.plan !== 'Free Website' ? 'pro' : 'zone',
        metrics: [
          metric('REQUESTS', compact(s.totalRequests), 'ok'),
          // Cache hit % — headline caching metric.
          metric('CACHE', `${cacheHit}%`, 'ok'),
          // Threats/blocked are informational — the service level flips to warn
          // only on a spike (detected at ingest), not on their mere presence.
          metric('THREATS', compact(threats), 'ok'),
          metric('BLOCKED', compact(mitigated), 'ok'),
          // Compact HTTP-status card in place of a plain ERRORS number: a mini
          // 2xx/3xx/4xx/5xx bar with the critical (5xx) rate as its caption.
          // Falls back to a text ERRORS % when there's no status breakdown.
          ((): Metric => {
            const segments = statusSegments(s.statusClasses)
            return segments
              // Same thresholds as the ERRORS fallback below: a 0.1% trickle of
              // 5xx is normal for a busy zone and must not paint the tile red.
              ? { label: 'HTTP STATUS', value: `${serverErr}% 5xx`, level: serverErr >= 5 ? 'crit' : serverErr >= 1 ? 'warn' : 'ok', segments }
              : metric('ERRORS', `${errorRate}%`, serverErr >= 5 ? 'crit' : errorRate >= 10 ? 'warn' : 'ok')
          })(),
          metric('BANDWIDTH', fmtBytes(s.bandwidth?.total), 'ok'),
        ],
        events,
        sparkline,
        cf,
      }
    }
    case 'cloudflare-workers': {
      const w = d.workers || {}
      const sum = w.analytics?.summary || w.analytics || {}
      const errors = sum.totalErrors || 0
      return {
        ...base,
        name: 'Workers',
        kindLabel: 'Cloudflare · Workers',
        badge: `×${w.summary?.total ?? 0}`,
        unitLabel: 'WORKERS',
        metrics: [
          metric('REQUESTS', compact(sum.totalRequests), 'ok'),
          metric('ERRORS', compact(errors), errors > 0 ? 'crit' : 'ok'),
          metric('CPU·P95', `${Math.round((sum.p95CpuTime || 0) / 1000)}ms`, 'ok'),
        ],
      }
    }
    case 'cloudflare-account':
    case 'cloudflare': {
      const pages = d.pages?.summary || {}
      const zones = d.zones?.summary || {}
      const workers = d.workers?.summary || {}
      const wa = d.workers?.analytics || {}
      // Per-script requests/errors (24h). Lets the card name the worker that is
      // actually erroring instead of only showing an account-wide total.
      const byScript: any[] = Array.isArray(d.workers?.byScript) ? d.workers.byScript : []
      const erroring = byScript.filter((s) => (s?.errors || 0) > 0)
      const totalErrors = Number(wa.totalErrors) || 0
      return {
        ...base,
        name: 'Cloudflare account',
        kindLabel: 'Cloudflare · Account',
        badge: 'cloudflare',
        metrics: [
          metric('PAGES', String(pages.total_all ?? pages.total ?? 0), 'ok'),
          metric('ZONES', String(zones.total_all ?? zones.total ?? 0), 'ok'),
          metric('WORKERS', String(workers.total_all ?? workers.total ?? 0), 'ok'),
          ...(wa.totalRequests != null ? [metric('WORKER REQS', compact(wa.totalRequests), 'ok')] : []),
          ...(wa.totalErrors != null ? [metric('WORKER ERRORS', String(totalErrors), totalErrors > 0 ? 'warn' : 'ok')] : []),
        ],
        // Per-worker breakdown, worst first — the erroring scripts are named.
        ...(byScript.length
          ? {
              unitLabel: 'WORKERS · 24H',
              units: [...byScript]
                .sort((a, b) => (b.errors || 0) - (a.errors || 0) || (b.requests || 0) - (a.requests || 0))
                .slice(0, 12)
                .map((s) => ({
                  name: String(s.script || 'worker'),
                  state: `${compact(s.requests || 0)} reqs`,
                  value: (s.errors || 0) > 0 ? `${s.errors} err` : 'ok',
                  level: ((s.errors || 0) > 0 ? 'warn' : 'ok') as Level,
                  kind: 'worker',
                  // Deep-link to the worker in the Cloudflare dashboard, where the
                  // actual logs/exceptions for the failing script live.
                  ...(d.account && s.script
                    ? { href: `${CF_DASH}/${d.account}/workers/services/view/${s.script}/production` }
                    : {}),
                })),
            }
          : {}),
        events: erroring.slice(0, 5).map((s) => ({
          time: '24h',
          severity: 'warn' as Level,
          message: `${s.script}: ${s.errors} error${s.errors === 1 ? '' : 's'} in ${compact(s.requests || 0)} requests`,
        })),
      }
    }
    case 'os': {
      const totalmem = d.totalmem || 0
      // Prefer MemAvailable (reclaimable cache counted as free); fall back to
      // freemem for hosts still on the old plugin that don't emit `available`.
      const freeish = d.available ?? d.freemem ?? 0
      const mem = totalmem ? Math.round(((totalmem - freeish) / totalmem) * 100) : 0
      // Real drives (plugin already filters out pseudo filesystems). Headline
      // figure is the fullest drive; the full list feeds the detail page.
      const disks: DiskInfo[] = Array.isArray(d.disks)
        ? d.disks.map((x: any) => ({
            mount: String(x.mount || ''), fstype: String(x.fstype || ''),
            pct: Number(x.pct) || 0, used: Number(x.used) || 0, total: Number(x.total) || 0,
          }))
        : []
      const diskPct = disks.length ? Math.max(...disks.map((x) => x.pct)) : 0
      // Network throughput (bytes/sec, rx+tx) from the OS plugin's /proc/net/dev
      // delta. undefined on the first poll or off-Linux → tiles show "—".
      const hasNet = d.network && typeof d.network.rxRate === 'number'
      const netIn = hasNet ? (d.network.rxRate || 0) : undefined
      const netOut = hasNet ? (d.network.txRate || 0) : undefined
      const netRate = hasNet ? (netIn as number) + (netOut as number) : undefined
      return {
        ...base,
        name: d.hostname || 'host',
        kindLabel: `OS · ${d.platform || d.type || 'system'}`,
        badge: 'os',
        hasBars: true,
        cpu: osCpuPct(d),
        mem,
        memory: totalmem ? {
          used: totalmem - freeish, total: totalmem, cached: d.memory?.cached,
          swapUsed: d.memory?.swapUsed, swapTotal: d.memory?.swapTotal,
        } : undefined,
        disk: disks.length ? diskPct : undefined,
        disks,
        net: netRate,
        netIn,
        netOut,
        processes: normProcesses(d.processes),
        metrics: [
          // Raw load means nothing without the core count: 5.75 is idle on a
          // 16-core box and queueing on a 4-core Pi. Judged on the 5m average so
          // one busy minute doesn't flip the tile.
          (() => {
            const la: number[] = Array.isArray(d.loadavg) ? d.loadavg : []
            if (!la.length) return metric('LOAD', '—', 'ok')
            const cores = Array.isArray(d.cpus) && d.cpus.length ? d.cpus.length : 1
            const per = (la[1] ?? la[0]) / cores
            const txt = cores > 1 ? `${la[0].toFixed(2)} · ${per.toFixed(2)}/core` : la[0].toFixed(2)
            return metric('LOAD', txt, per >= 2 ? 'crit' : per >= 1 ? 'warn' : 'ok')
          })(),
          ...(totalmem ? [metric('MEM', `${fmtBytes(totalmem - freeish)} / ${fmtBytes(totalmem)}`, memLevel(mem))] : []),
          ...(d.memory?.swapTotal ? [metric('SWAP', `${fmtBytes(d.memory.swapUsed)} / ${fmtBytes(d.memory.swapTotal)}`, 'ok')] : []),
          metric('NET', netRate != null ? fmtRate(netRate) : '—', 'ok'),
          metric('UPTIME', d.uptime ? fmtUptime(d.uptime) : '—', 'ok'),
          ...(disks.length ? [metric('DISK', `${diskPct}%`, diskLevel(diskPct))] : []),
        ],
      }
    }
    case 'pm2': {
      const m = d.monit || {}
      const lvl = toLevel(d.status)
      const restarts = Number(d.restarts ?? d.restart_time ?? 0) || 0
      return {
        ...base,
        name: d.name || 'process',
        kindLabel: 'Node · PM2',
        badge: 'pm2',
        hasBars: true,
        cpu: Math.round(m.cpu || 0),
        mem: 0,
        memBytes: Number(m.memory) || 0,
        restarts,
        metrics: [
          metric('STATUS', String(d.status || '—').toUpperCase(), lvl),
          metric('MEM', fmtBytes(m.memory), 'ok'),
          metric('RESTARTS', String(restarts), restarts > 5 ? 'warn' : 'ok'),
        ],
      }
    }
    case 'docker':
      return { ...base, ...mapContainerGroup(d, 'docker') }
    case 'lxc':
      return { ...base, ...mapContainerGroup(d, 'lxc') }
    case 'lxc-container': {
      // One LXC container as its own service (split from the per-host lxc payload).
      const c = d.container || {}
      const running = !!c.running
      const state = running ? String(c.health || c.state || 'running') : String(c.state || 'stopped')
      return {
        ...base,
        name: c.name || 'container',
        kindLabel: d.host ? `LXC · ${d.host}` : 'LXC',
        badge: 'lxc',
        hasBars: true,
        cpu: Math.round(Number(c.cpu) || 0),
        mem: 0, // container mem is bytes, not a %, so surface it as a metric
        // Same rx/tx shape as the os plugin; absent on the agent's first poll.
        ...(() => {
          const nw = c.network
          if (!nw || typeof nw.rxRate !== 'number') return {}
          const netIn = Number(nw.rxRate) || 0, netOut = Number(nw.txRate) || 0
          return { net: netIn + netOut, netIn, netOut }
        })(),
        processes: normProcesses(c.processes),
        metrics: [
          metric('STATE', state.toUpperCase(), containerLevel(c)),
          metric('MEM', fmtBytes(c.mem), 'ok'),
          ...(c.network && typeof c.network.rxRate === 'number'
            ? [metric('NET', fmtRate((Number(c.network.rxRate) || 0) + (Number(c.network.txRate) || 0)), 'ok')]
            : []),
          metric('RESTARTS', String(c.restarts ?? 0), (Number(c.restarts) || 0) > 5 ? 'warn' : 'ok'),
        ],
      }
    }
    case 'website':
    case 'web': {
      const ok = d.ok || (d.status >= 200 && d.status < 400)
      const httpLevel: Level = ok ? 'ok' : webThrottled(d.status) ? 'warn' : 'crit'
      // Optional direct-to-origin check (bypassing Cloudflare/CDN) — catches an
      // origin outage a CDN is masking with cached content. Shown as its own
      // metric pair so it reads distinctly from the public-facing check above.
      const origin = d.origin
      const originOk = !!origin?.ok
      const metrics: Metric[] = [
        metric('STATUS', String(d.status ?? '—'), httpLevel),
        metric('LATENCY', d.duration ? `${Math.round(d.duration)}ms` : '—', 'ok'),
      ]
      if (origin) {
        metrics.push(
          metric('ORIGIN', origin.error ? 'DOWN' : String(origin.status ?? '—'), originOk ? 'ok' : 'crit'),
          metric('ORIGIN MS', origin.duration ? `${Math.round(origin.duration)}ms` : '—', 'ok'),
        )
      }
      // A web check ran real checks — an HTTP request, sometimes a second one
      // straight to the origin behind the CDN, and a scan of the body for copy
      // that should or shouldn't be there. None of it was expressed as units, so
      // the health panel read "0/0 healthy" for a service that is nothing BUT
      // health checks.
      //
      // Only assert what actually ran. The payload records failures
      // (missingExpected, matchedUnexpected) but never the configured
      // expectations, so an empty missingExpected cannot distinguish "every
      // string was found" from "no strings were ever configured" — and a green
      // CONTENT row for a check nobody set up is a lie the panel would tell on
      // every site. The content rows appear when there is a finding.
      const units: Unit[] = [{
        name: 'HTTP',
        state: d.redirected ? `${d.status ?? '—'} redirected` : String(d.status ?? '—'),
        value: String(d.status ?? '—'),
        level: httpLevel,
      }]
      if (origin) {
        units.push({
          name: 'ORIGIN',
          state: origin.error ? String(origin.error) : String(origin.status ?? '—'),
          value: origin.error ? 'DOWN' : String(origin.status ?? '—'),
          level: originOk ? 'ok' : 'crit',
        })
      }
      const missing: string[] = Array.isArray(d.missingExpected) ? d.missingExpected : []
      const unexpected: string[] = Array.isArray(d.matchedUnexpected) ? d.matchedUnexpected : []
      if (missing.length || d.hasAllExpectedStrings === false) {
        units.push({
          name: 'CONTENT',
          state: missing.length ? `missing: ${missing.slice(0, 3).join(', ')}` : 'expected text missing',
          value: missing.length ? `−${missing.length}` : 'missing',
          level: 'crit',
        })
      }
      if (unexpected.length) {
        units.push({
          name: 'UNEXPECTED',
          state: `found: ${unexpected.slice(0, 3).join(', ')}`,
          value: `+${unexpected.length}`,
          level: 'crit',
        })
      }
      return {
        ...base,
        name: d.name || d.url || 'web check',
        kindLabel: origin ? 'Web check · origin' : 'Web check',
        badge: 'http',
        ping: Math.round(d.duration || 0),
        metrics,
        unitLabel: 'CHECKS',
        units,
      }
    }
    case 'mongodb': {
      return {
        ...base,
        name: d.name || 'mongodb',
        kindLabel: 'MongoDB',
        badge: 'mongo',
        metrics: [
          metric('CONNS', String(d.conn ?? '—'), 'ok'),
          metric('NET IN', fmtBytes(d.net_in), 'ok'),
          metric('NET OUT', fmtBytes(d.net_out), 'ok'),
        ],
      }
    }
    case 'ewelink': {
      const sw = d.params?.switches?.[0]?.switch
      return {
        ...base,
        name: d.name || 'device',
        kindLabel: 'eWeLink',
        badge: sw === 'on' ? 'on' : 'off',
        metrics: [
          metric('POWER', d.params?.power != null ? `${d.params.power}W` : '—', 'ok'),
          metric('VOLTAGE', d.params?.voltage != null ? `${d.params.voltage}V` : '—', 'ok'),
        ],
      }
    }
    case 'wordpress': {
      // WordPress security posture: version, admins (service-account ones flagged),
      // mu-plugins (unknown flagged), a web-user crontab (persistence), and trashed
      // critical pages. The dangerous signals drive crit; the rest are informational.
      const admins: any[] = Array.isArray(d.admins) ? d.admins : []
      const susp: any[] = Array.isArray(d.suspiciousAdmins) ? d.suspiciousAdmins : []
      const mu: string[] = Array.isArray(d.muPlugins) ? d.muPlugins : []
      const unknownMu: string[] = Array.isArray(d.unknownMuPlugins) ? d.unknownMuPlugins : []
      const trashedCrit: any[] = Array.isArray(d.trashedCriticalPages) ? d.trashedCriticalPages : []
      const suspKeys = new Set(susp.map((a) => String(a.login || a.email || a.id).toLowerCase()))
      const cronBad = d.hasWebUserCrontab === true
      // Waiting updates (core, plugins, themes) and the plugin count, from
      // plugin 1.1.38 on; older agents leave them out.
      const plugins = d.plugins && typeof d.plugins === 'object' ? d.plugins : null
      const themeUps: string[] = Array.isArray(d.themeUpdates) ? d.themeUpdates : []
      const updates = plugins || d.coreUpdate !== undefined
        ? (d.coreUpdate ? 1 : 0) + (Array.isArray(plugins?.updates) ? plugins.updates.length : 0) + themeUps.length
        : null
      const inactive = Array.isArray(plugins?.inactive) ? plugins.inactive.length : 0
      return {
        ...base,
        name: d.name || d.site || 'wordpress',
        kindLabel: `WordPress${d.wpVersion ? ` ${d.wpVersion}` : ''}`,
        badge: 'wp',
        metrics: [
          metric('WP', d.wpVersion ? String(d.wpVersion) : '—', 'ok'),
          metric('ADMINS', String(admins.length), susp.length ? 'crit' : 'ok'),
          metric('MU-PLUGINS', String(mu.length), unknownMu.length ? 'crit' : 'ok'),
          metric('CRON', cronBad ? 'CRONTAB!' : 'clean', cronBad ? 'crit' : 'ok'),
          ...(trashedCrit.length ? [metric('TRASHED PAGES', String(trashedCrit.length), 'crit')] : []),
          ...(updates != null ? [metric('UPDATES', String(updates), updates ? 'warn' : 'ok')] : []),
          // Active of all: as a ring, the inactive ones are its unlit part.
          ...(plugins ? [metric('PLUGINS', `${Number(plugins.active) || 0}/${(Number(plugins.active) || 0) + inactive}`, 'ok')] : []),
          ...(d.phpVersion ? [metric('PHP', String(d.phpVersion), 'ok')] : []),
        ],
        unitLabel: 'ADMINISTRATORS',
        units: admins.map((a: any) => {
          const key = String(a.login || a.email || a.id).toLowerCase()
          const bad = suspKeys.has(key)
          return {
            name: String(a.login || a.email || a.id || 'admin'),
            state: a.email && a.email !== a.login ? String(a.email) : (a.role || 'administrator'),
            value: bad ? 'SERVICE-ACCT' : (a.role || 'admin'),
            level: (bad ? 'crit' : 'ok') as Level,
            kind: 'admin',
          }
        }),
      }
    }

    case 'appactivity': {
      // Windows are counted fresh by the agent. `recent` belongs to the activity views.
      const n = (v: any) => (v == null ? '—' : Number(v).toLocaleString())
      return {
        ...base,
        name: d.name || 'app activity',
        kindLabel: 'app activity',
        badge: 'activity',
        metrics: d.reachable === false
          ? [metric('ERROR', String(d.error || 'unavailable'), 'warn')]
          : [
              metric('USERS', n(d.users), 'ok'),
              metric('SIGNUPS · 30D', n(d.signups?.d30), 'ok'),
              metric(d.loginsArePeople ? 'SIGNED IN · 30D' : 'LOGINS · 30D', n(d.logins?.d30), 'ok'),
            ],
      }
    }

    case 'logwatch': {
      // Counts over the last refresh window (~60s) of one access log. The
      // findings themselves arrive as alerts; this is the traffic behind them.
      const c = d.counts || {}
      const n = (v: any) => (v == null ? '—' : Number(v).toLocaleString())
      return {
        ...base,
        name: d.name || 'access log',
        kindLabel: 'logwatch',
        badge: 'log',
        metrics: d.error
          ? [metric('ERROR', String(d.error), 'crit')]
          : [
              metric(`LINES · ${d.window || 60}s`, n(c.total), 'ok'),
              metric('BATCH/V1', n(c.batchV1), c.batchV1 ? 'warn' : 'ok'),
              metric('XMLRPC POSTS', n(c.xmlrpcPosts), 'ok'),
              metric('WEBSHELL HITS', n(c.webshellHits), c.webshellHits ? 'crit' : 'ok'),
              // Only where it can be counted: on a site that hides wp-login.php
              // every request to it redirects, so a login can't be told from a
              // miss, and the row read "hidden", which said nothing.
              ...(c.loginRedirectsAlways ? [] : [metric('ADMIN LOGINS', n(c.loginSuccess), 'ok')]),
            ],
      }
    }

    case 'nagios':
      return { ...base, ...nagiosFields(d) }

    case 'tplink':
      return { ...base, ...tplinkFields(d) }

    case 'ga4': {
      // Totals across every property, then one unit per property. No figures
      // while the plugin reports an error, same as adsense.
      const ok = !d.error
      const accounts: Ga4Detail['accounts'] = Array.isArray(d.accounts) ? d.accounts : []
      const props = accounts.flatMap((a) => a.properties || [])
      const sum = (f: (p: any) => number) => props.reduce((n, p) => n + (f(p) || 0), 0)
      const show = (n: number) => (ok ? compact(n) : '—')
      return {
        ...base,
        name: d.name || 'Google Analytics',
        kindLabel: 'Google Analytics',
        badge: 'ga4',
        metrics: [
          metric('PROPERTIES', ok ? String(props.length) : '—', 'ok'),
          metric('ACTIVE NOW', show(sum((p) => p.activeNow)), 'ok'),
          metric('USERS TODAY', show(sum((p) => p.today?.users)), 'ok'),
          metric('SESSIONS 7D', show(sum((p) => p.last7?.sessions)), 'ok'),
        ],
        unitLabel: props.length ? 'PROPERTIES' : '',
        units: props.map((p) => ({
          name: p.name,
          state: p.error ? 'error' : 'ok',
          value: p.error ? 'error' : `${compact(p.today?.users || 0)} today`,
          level: (p.error ? 'warn' : 'ok') as Level,
          kind: 'GA4 property',
        })),
        ga4: ok ? { accounts } : undefined,
      }
    }

    case 'indexing': {
      // Google indexing of a URL list. Units are the URLs, worst first; the
      // per-URL alerts carry the detail and the GSC inspect link.
      const urls: any[] = Array.isArray(d.urls) ? d.urls : []
      const staleMs = (Number(d.staleHours) || 72) * 3600_000
      const late = (u: any) => u.stuck && Date.now() - (Date.parse(u.since) || Date.now()) > staleMs
      const lvl = (u: any): Level => (u.error || late(u) ? 'warn' : 'ok')
      return {
        ...base,
        name: d.name || `Indexing · ${d.site || ''}`,
        kindLabel: 'Google indexing',
        badge: 'index',
        metrics: d.error
          ? [metric('ERROR', String(d.error), 'crit')]
          : [
              metric('CHECKED', String(d.checked ?? urls.length), 'ok'),
              metric('INDEXED', String(d.indexed ?? 0), 'ok'),
              metric('NOT INDEXED', String(d.stuck ?? 0), urls.some(late) ? 'warn' : 'ok'),
            ],
        unitLabel: urls.length ? 'URLS' : '',
        units: urls
          .map((u) => ({
            name: String(u.url || '').replace(/^https?:\/\/[^/]+/, '') || String(u.url),
            state: u.error ? 'error' : u.verdict === 'PASS' ? 'indexed' : 'not indexed',
            value: u.error ? String(u.error).slice(0, 60) : String(u.coverageState || ''),
            level: lvl(u),
            kind: 'URL',
          }))
          .sort((a, b) => (a.level === b.level ? 0 : a.level === 'warn' ? -1 : 1)),
        indexing: d.error ? undefined : { site: String(d.site || ''), staleHours: Number(d.staleHours) || 72, urls },
      }
    }

    case 'adsense': {
      // No figures while the plugin is reporting an error: the last good
      // numbers are gone from the row, and zeroes would read as "earned nothing".
      const ok = !d.error
      const daily: AdsenseDetail['daily'] = Array.isArray(d.daily) ? d.daily : []
      return {
        ...base,
        name: d.name || 'AdSense',
        kindLabel: 'Google AdSense',
        badge: 'adsense',
        metrics: adsenseMetrics(d, ok, d.currency),
        sparkline: daily.map((x) => Number(x.earnings) || 0),
        adsense: ok
          ? {
              currency: d.currency || 'USD', asOf: d.asOf,
              today: Number(d.today) || 0, yesterday: Number(d.yesterday) || 0,
              last7: Number(d.last7) || 0, monthToDate: Number(d.monthToDate) || 0,
              pageViews7: Number(d.pageViews7) || 0, clicks7: d.clicks7 == null ? undefined : Number(d.clicks7) || 0,
              rpm: Number(d.rpm) || 0, daily,
              accountId: d.accountId,
              sites: Array.isArray(d.sites) ? d.sites : undefined,
            }
          : undefined,
      }
    }

    case 'cost': {
      // Spend for one provider. Same rule as adsense: no figures while the
      // plugin reports an error, because $0 would read as "spent nothing".
      const ok = !d.error
      const cur = d.currency || 'USD'
      const money = (n: any) => ok ? fmtMoney(Number(n) || 0, cur) : '—'
      const budget = Number(d.budget) || undefined
      const daily: CostDetail['daily'] = Array.isArray(d.daily) ? d.daily : []
      const mtd = Number(d.monthToDate) || 0
      const projected = Number(d.projected) || 0
      return {
        ...base,
        name: d.name || d.provider || 'Cost',
        kindLabel: `Spend · ${COST_PROVIDER_LABEL[d.provider] || d.provider || 'cost'}`,
        badge: 'cost',
        metrics: [
          metric('MONTH', money(mtd), 'ok'),
          metric('PROJECTED', money(projected), ok && budget && projected > budget ? 'warn' : 'ok'),
          ...(budget ? [metric('BUDGET', money(budget), ok && mtd > budget ? 'crit' : 'ok')] : []),
          ...(daily.length ? [metric('YESTERDAY', money(d.yesterday), 'ok'), metric('TODAY', money(d.today), 'ok')] : []),
        ],
        sparkline: daily.map((x) => Number(x.amount) || 0),
        cost: ok
          ? {
              provider: String(d.provider || ''), currency: cur, asOf: d.asOf,
              monthToDate: mtd, projected, budget,
              today: d.today == null ? undefined : Number(d.today) || 0,
              yesterday: d.yesterday == null ? undefined : Number(d.yesterday) || 0,
              daily,
              breakdown: Array.isArray(d.breakdown) ? d.breakdown : undefined,
            }
          : undefined,
      }
    }

    case 'cloudflare-worker-script': {
      // One Cloudflare Worker as its own service (24h requests/errors).
      const sc = d.script || {}
      // A Worker only appears in the per-script analytics while it is serving
      // traffic. Once the record stops updating, the numbers it holds are the
      // last busy window, not now — show it idle with zeroes instead.
      // Two ways to have no traffic. The record may have stopped updating (an
      // older reporter that only knew about workers which ran), or it may be
      // current and simply report zero — a deployed worker nobody is calling.
      // Both read IDLE; the second is the honest one and is now the common case.
      const stale = secondsSince(cs.updated_at) > CF_WORKER_IDLE_AFTER
      const errors = stale ? 0 : Number(sc.errors) || 0
      const requests = stale ? 0 : Number(sc.requests) || 0
      const idle = stale || requests === 0
      const rate = requests > 0 ? (errors / requests) * 100 : 0
      // The ERRORS tile counts the 24h window but is coloured by the RECENT one,
      // to match how the server judges health. Otherwise a worker the server
      // calls online would still show a red ERRORS tile for the rest of the day
      // over a fault that's already fixed.
      const recentErrors = idle ? 0 : Number(sc.recentErrors) || 0
      const erroringNow = sc.recentErrors !== undefined ? recentErrors > 0 : errors > 0
      return {
        ...base,
        name: sc.name || sc.id || 'worker',
        kindLabel: 'Cloudflare · Worker',
        badge: 'worker',
        idleWord: idle ? 'IDLE · no traffic 24h' : undefined,
        metrics: [
          metric('REQUESTS', compact(requests), 'ok'),
          metric('ERRORS', String(errors), erroringNow ? 'crit' : 'ok'),
          ...(requests > 0 ? [metric('ERROR RATE', `${rate < 0.1 && rate > 0 ? rate.toFixed(2) : rate.toFixed(1)}%`, erroringNow && rate >= 5 ? 'crit' : erroringNow && rate >= 1 ? 'warn' : 'ok')] : []),
        ],
      }
    }

    case 'snmp':
      return { ...base, ...snmpFields(d) }

    case '3cx': {
      // 3CX PBX — service health + SIP/console liveness. Reachable but with an
      // incomplete read (couldn't reach systemd) shows the error; a down service
      // or dead SIP port is critical, console-only down is a warning.
      const isSbc = d.role === 'sbc'
      const reachable = d.reachable !== false && !d.error
      const services = Array.isArray(d.services) ? d.services : []
      const down = Array.isArray(d.down) ? d.down : []
      const total = d.servicesTotal ?? services.length
      const okCount = d.servicesOk ?? (total - down.length)
      const metrics: Metric[] = [
        metric('SERVICES', reachable ? `${okCount}/${total}` : '—', !reachable ? 'crit' : down.length ? 'crit' : 'ok'),
      ]
      if (isSbc) {
        // SBC: the outbound tunnel to the PBX is the make-or-break signal.
        const tunUp = d.tunnelUp !== false
        metrics.push(metric('TUNNEL', !reachable ? '—' : tunUp ? 'UP' : 'DOWN', !reachable ? 'standby' : tunUp ? 'ok' : 'crit'))
      } else {
        const sip = Array.isArray(d.sip) ? d.sip : []
        const sipUp = d.sipOk !== false && sip.some((p: any) => p.listening)
        const consoleUp = d.console ? d.console.listening !== false : undefined
        metrics.push(metric('SIP', !reachable ? '—' : sipUp ? 'UP' : 'DOWN', !reachable ? 'standby' : sipUp ? 'ok' : 'crit'))
        if (consoleUp != null) metrics.push(metric('CONSOLE', consoleUp ? 'UP' : 'DOWN', consoleUp ? 'ok' : 'warn'))
        // Branch SBCs watched from the PBX side (inbound tunnels).
        if (Array.isArray(d.sbcs) && d.sbcs.length) {
          const connected = d.sbcs.filter((s: any) => s.connected).length
          metrics.push(metric('SBC', `${connected}/${d.sbcs.length}`, connected < d.sbcs.length ? 'warn' : 'ok'))
        }
      }
      metrics.push(metric('VER', d.version ? String(d.version) : '—', 'ok'))
      return {
        ...base,
        name: d.name || (isSbc ? 'SBC' : 'PBX'),
        kindLabel: `3CX · ${isSbc ? 'SBC' : 'PBX'}${d.version ? ` v${String(d.version).split('.').slice(0, 2).join('.')}` : ''}`,
        badge: '3cx',
        metrics,
        unitLabel: 'SERVICES',
        units: services.map((s: any) => ({
          name: tcxUnitName(String(s.unit || '')),
          // Running, or done for a one-shot that ran and exited (the firewall
          // sets its rules and stops); the sub-state stays under it.
          state: s.ok && s.sub === 'running' ? 'running' : s.ok && s.sub === 'exited' ? 'done' : String(s.active || ''),
          value: String(s.sub || ''),
          level: (s.ok ? 'ok' : 'crit') as Level,
          kind: 'service',
        })),
      }
    }

    case 'device': {
      // Merged device — one entity carrying every plugin's datapoints from
      // data.sources.<plugin>: snmp metrics (printer/switch/qnap), tplink
      // extender health, and a netscan reachability/ping datapoint. Status is
      // the combined worst (set by ingest).
      // A TP-Link Easy Managed switch has no SNMP; its plugin reports the same
      // switch shape from the web API, so it renders through snmpFields too.
      const snmp = d.sources && (d.sources.snmp || d.sources.tplinkswitch)
      const tp = d.sources && d.sources.tplink
      const net = d.sources && d.sources.netscan
      // Only one of snmp/tplink ever applies to a given box (they're different
      // device classes), so whichever reported wins the card's identity.
      const f = snmp ? snmpFields(snmp) : tp ? tplinkFields(tp) : {}
      const metrics = [...(f.metrics || [])]
      if (net) {
        const down = net.up === false
        const slow = typeof net.latency === 'number' && net.latency > (Number(net.warnMs) || 200)
        metrics.unshift(metric('PING', down ? 'DOWN' : typeof net.latency === 'number' ? `${net.latency}ms` : 'up', down ? 'crit' : slow ? 'warn' : 'ok'))
      }
      return {
        ...base,
        name: d.name || f.name || d.ip || 'device',
        kindLabel: f.kindLabel || (d.ip ? `Device · ${d.ip}` : 'Device'),
        badge: f.badge || 'device',
        metrics,
        disks: f.disks || [],
        ports: f.ports,
        units: f.units || [],
        unitLabel: f.unitLabel || '',
      }
    }

    case 'supabase': {
      // One card per cloud project. Either source may be missing (health needs
      // an access token, the figures need the service key), so every metric is
      // shown only when it was measured.
      if (d.error || d.reachable === false) {
        return {
          ...base,
          name: d.name || d.ref || 'supabase',
          kindLabel: 'Supabase',
          badge: 'supabase',
          metrics: [metric('API', 'UNREACHABLE', 'crit')],
        }
      }
      const m = d.metrics || {}
      const over = (v: number, warn: unknown, crit: unknown): Level =>
        v >= (Number(crit) || Infinity) ? 'crit' : v >= (Number(warn) || Infinity) ? 'warn' : 'ok'
      const project = d.projectStatus ? String(d.projectStatus) : ''
      const connPct = typeof m.connections === 'number' && m.maxConnections ? (m.connections / m.maxConnections) * 100 : null
      const services: any[] = Array.isArray(d.services) ? d.services : []
      return {
        ...base,
        name: d.name || d.ref || 'supabase',
        kindLabel: `Supabase${d.region ? ` · ${d.region}` : ''}`,
        badge: 'supabase',
        metrics: [
          ...(project ? [metric('PROJECT', project === 'ACTIVE_HEALTHY' ? 'ACTIVE' : project === 'INACTIVE' ? 'PAUSED' : project.replace(/_/g, ' '), project === 'ACTIVE_HEALTHY' ? 'ok' : project === 'INACTIVE' ? 'crit' : 'warn')] : []),
          ...(typeof m.diskPct === 'number' ? [metric('DISK', `${m.diskPct}%`, over(m.diskPct, d.diskWarnPct, d.diskCritPct))] : []),
          ...(typeof m.connections === 'number' ? [metric('CONNS', m.maxConnections ? `${m.connections}/${m.maxConnections}` : String(m.connections), connPct == null ? 'ok' : over(connPct, d.connWarnPct, null))] : []),
          ...(typeof m.dbSizeBytes === 'number' ? [metric('DB SIZE', fmtBytes(m.dbSizeBytes), 'ok')] : []),
          ...(typeof m.memPct === 'number' ? [metric('MEM', `${m.memPct}%`, 'ok')] : []),
          ...(d.pgVersion ? [metric('POSTGRES', String(d.pgVersion).split('.').slice(0, 2).join('.'), 'ok')] : []),
        ],
        unitLabel: services.length ? 'SERVICES' : '',
        units: services.map((s) => ({
          name: String(s.name),
          state: String(s.status || ''),
          value: s.healthy ? 'healthy' : String(s.status || 'unhealthy').toLowerCase().replace(/_/g, ' '),
          level: (s.healthy ? 'ok' : s.status === 'COMING_UP' ? 'warn' : 'crit') as Level,
          kind: 'service',
        })),
      }
    }
    case 'patroni': {
      // One card per NODE, not per cluster: each Patroni agent reports its own
      // role plus the whole member list as it sees it. The member list is what
      // makes a follower's card useful during a failover, since the leader's own
      // agent is exactly the one that has stopped reporting.
      if (d.reachable === false) {
        return {
          ...base,
          name: d.member || 'patroni',
          kindLabel: 'Patroni',
          badge: 'patroni',
          metrics: [metric('API', 'UNREACHABLE', 'crit')],
        }
      }
      const isLeader = !!d.isLeader
      const members: any[] = Array.isArray(d.members) ? d.members : []
      const lag = typeof d.lagBytes === 'number' ? d.lagBytes : null
      const lagLevel: Level =
        lag == null ? 'standby'
          : lag >= (Number(d.lagCritBytes) || Infinity) ? 'crit'
          : lag >= (Number(d.lagWarnBytes) || Infinity) ? 'warn'
          : 'ok'
      const memberLevel = (m: any): Level => {
        const st = String(m.state || '').toLowerCase()
        if (st !== 'running' && st !== 'streaming') return 'crit'
        return 'ok'
      }
      return {
        ...base,
        name: d.scope || d.name || 'patroni',
        kindLabel: `Patroni · ${d.member || 'node'}`,
        // The role is the single most useful word on the card: it is what says
        // where a leader-pinned service is supposed to be right now.
        badge: isLeader ? 'leader' : String(d.role || 'replica'),
        hasBars: false,
        metrics: [
          metric('ROLE', String(d.role || 'unknown').toUpperCase(), isLeader ? 'ok' : 'standby'),
          // A cluster with no leader is the fault that matters; naming who holds
          // it is the answer to the only question anyone asks during a failover.
          metric('LEADER', d.hasLeader ? String(d.leader) : 'NONE', d.hasLeader ? 'ok' : 'crit'),
          metric('LAG', lag == null ? '—' : fmtBytes(lag), lagLevel),
          metric('MEMBERS', `${d.runningCount ?? members.length}/${d.memberCount ?? members.length}`,
            (d.runningCount ?? 0) < (d.memberCount ?? 0) ? 'warn' : 'ok'),
          // Paused means automatic failover is switched off. Everything looks
          // fine until the leader dies and nothing promotes a replica, so it
          // earns a slot of its own rather than a footnote.
          ...(d.paused ? [metric('FAILOVER', 'PAUSED', 'warn')] : []),
          ...(d.pendingRestart ? [metric('RESTART', 'PENDING', 'warn')] : []),
        ],
        unitLabel: 'MEMBERS',
        units: members.map((m) => ({
          name: String(m.name || 'member'),
          state: String(m.role || '').replace('standby_leader', 'standby-leader'),
          value: typeof m.lagBytes === 'number' && m.lagBytes > 0 ? fmtBytes(m.lagBytes) : String(m.state || ''),
          level: memberLevel(m),
        })),
        events: members
          .filter((m) => memberLevel(m) !== 'ok')
          .slice(0, 5)
          .map((m) => ({ time: String(m.name || '').slice(0, 12), severity: 'crit' as Level, message: `${m.name}: ${m.state}` })),
      }
    }

    default:
      return { ...base, name: d?.name || cs.type, kindLabel: cs.type, badge: cs.type }
  }
}

// ---- outbound deep links ------------------------------------------------

const CF_DASH = 'https://dash.cloudflare.com'

/** Prefix a bare host with https:// if it isn't already a full URL. */
function ensureHttp(u?: string | null): string {
  const s = String(u || '').trim()
  if (!s) return ''
  return /^https?:\/\//i.test(s) ? s : `https://${s}`
}

/** Best public URL for a Pages project: first real custom domain, else the pages.dev subdomain. */
function pagesLiveUrl(p: any): string {
  const domains: string[] = Array.isArray(p.domains) ? p.domains : []
  const custom = domains.find((d) => d && !/\.pages\.dev$/i.test(String(d)))
  return ensureHttp(custom || p.production_url || p.subdomain || '')
}

/**
 * External deep links for a service: the live site it represents plus the
 * relevant admin consoles (Cloudflare zone/security/analytics, Pages project, …).
 * Returns [] for services with no meaningful outbound target (os/pm2/docker/lxc).
 */
export function serviceLinks(cs: CS): ServiceLink[] {
  const d = cs.data || {}
  const acct = d.account
  const out: ServiceLink[] = []
  const admin = (label: string, href: string, icon: string) => href && out.push({ label, href, kind: 'admin', icon })
  const site = (label: string, href: string) => href && out.push({ label, href, kind: 'site', icon: 'i-heroicons-globe-alt-20-solid' })

  switch (cs.type) {
    case 'cloudflare-domain': {
      const zone = d.domain?.name
      if (zone) {
        site('Visit site', ensureHttp(zone))
        if (acct) {
          admin('Cloudflare', `${CF_DASH}/${acct}/${zone}`, 'i-heroicons-cloud-20-solid')
          admin('Security events', `${CF_DASH}/${acct}/${zone}/security/events`, 'i-heroicons-shield-exclamation-20-solid')
          admin('Traffic analytics', `${CF_DASH}/${acct}/${zone}/analytics/traffic`, 'i-heroicons-chart-bar-20-solid')
        }
      }
      break
    }
    case 'cloudflare-project': {
      const p = d.project || {}
      site('Visit site', pagesLiveUrl(p))
      if (acct && p.name) admin('Pages project', `${CF_DASH}/${acct}/pages/view/${p.name}`, 'i-heroicons-document-text-20-solid')
      break
    }
    case 'cloudflare-workers':
      if (acct) admin('Workers & Pages', `${CF_DASH}/${acct}/workers-and-pages`, 'i-heroicons-cloud-20-solid')
      break
    case 'cloudflare-worker-script': {
      const sc = d.script || {}
      const nm = sc.name || sc.id
      if (acct && nm) {
        admin('Worker', `${CF_DASH}/${acct}/workers/services/view/${nm}/production`, 'i-heroicons-bolt-20-solid')
        admin('Logs', `${CF_DASH}/${acct}/workers/services/view/${nm}/production/observability/logs`, 'i-heroicons-document-magnifying-glass-20-solid')
      }
      break
    }
    case 'cloudflare-account':
    case 'cloudflare':
      if (acct) admin('Cloudflare', `${CF_DASH}/${acct}`, 'i-heroicons-cloud-20-solid')
      break
    case 'website':
    case 'web':
      site('Visit site', ensureHttp(d.url))
      break
    case 'adsense':
      admin('AdSense', 'https://adsense.google.com/', 'i-heroicons-banknotes-20-solid')
      break
    case 'cost': {
      const href = COST_BILLING_URL[d.provider]
      if (href) admin(`${COST_PROVIDER_LABEL[d.provider] || d.provider} billing`, href, 'i-heroicons-banknotes-20-solid')
      break
    }
    case 'indexing':
      if (d.site) admin('Search Console', `https://search.google.com/search-console?resource_id=${encodeURIComponent(d.site)}`, 'i-heroicons-magnifying-glass-20-solid')
      break
    case 'ga4':
      admin('Google Analytics', 'https://analytics.google.com/', 'i-heroicons-chart-bar-20-solid')
      break
    case 'supabase':
      if (d.ref) admin('Supabase', `https://supabase.com/dashboard/project/${d.ref}`, 'i-heroicons-circle-stack-20-solid')
      break
  }
  return out
}

// ---- public builders ----------------------------------------------------

export function stackEnv(group?: string | null): 'production' | 'staging' | 'shared' {
  const g = (group || '').toLowerCase()
  if (g.includes('stag')) return 'staging'
  if (g.includes('shared') || g.includes('infra')) return 'shared'
  return 'production'
}

// AWS assigns auto-hostnames like "ip-172-31-64-11" — noise as a service label.
const AWS_HOSTNAME = /^ip-\d{1,3}-\d{1,3}-\d{1,3}-\d{1,3}$/
const AWS_HOST_SUFFIX = /\s·\sip-\d{1,3}-\d{1,3}-\d{1,3}-\d{1,3}\s*$/

const LRANK: Record<Level, number> = { standby: 0, ok: 1, warn: 2, crit: 3 }

// Resource pressure that should elevate a service's DISPLAY level, so a busy
// service is flagged on its tile — not merely ranked in the pressure panel.
// Visual only: it doesn't change stored status or fire notifications.
function resourcePressure(type: string, m: Mapped): { level: Level; word: string } | null {
  const worst = (cands: { l: Level; w: string }[]) => {
    let best: { l: Level; w: string } | null = null
    for (const c of cands) if ((c.l === 'warn' || c.l === 'crit') && (!best || LRANK[c.l] > LRANK[best.l])) best = c
    return best ? { level: best.l, word: best.w } : null
  }
  if (type === 'os') {
    const c = [{ l: cpuLevel(m.cpu), w: `CPU ${m.cpu}%` }, { l: memLevel(m.mem), w: `MEM ${m.mem}%` }]
    if (m.disk != null) c.push({ l: diskLevel(m.disk), w: `DISK ${m.disk}%` })
    return worst(c)
  }
  // docker/lxc cpu is aggregate across containers, so thresholds are in cores.
  if (type === 'docker' || type === 'lxc') {
    const l: Level = containerCpuLevel(m.cpu)
    return l === 'ok' ? null : { level: l, word: `CPU ${fmtCores(m.cpu)}` }
  }
  if (type === 'lxc-container' || type === 'pm2') {
    const l = cpuLevel(m.cpu)
    return l === 'ok' ? null : { level: l, word: `CPU ${m.cpu}%` }
  }
  return null
}

/** Build a Service from one client_state row + its owning system. */
// Human-readable byte rate ("1.2 MB/s"). Used by the OS NETWORK tile/metric.
function rateParts(bytesPerSec: number): { num: string; unit: string } {
  if (!isFinite(bytesPerSec) || bytesPerSec < 0) return { num: '—', unit: '' }
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = bytesPerSec, i = 0
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
  return { num: v >= 10 || i === 0 ? String(Math.round(v)) : v.toFixed(1), unit: `${u[i]}/s` }
}

export function fmtRate(bytesPerSec: number): string {
  const p = rateParts(bytesPerSec)
  return p.unit ? `${p.num} ${p.unit}` : '—'
}

// Compact IN/OUT throughput, e.g. "↓11 ↑105 KB/s" (shared unit) or, when the two
// magnitudes differ, "↓11 KB/s ↑2 MB/s". Fits the NETWORK tile on one line.
export function fmtRatePair(inBytes: number, outBytes: number): string {
  const a = rateParts(inBytes), b = rateParts(outBytes)
  if (a.unit && a.unit === b.unit) return `↓${a.num} ↑${b.num} ${a.unit}`
  return `↓${fmtRate(inBytes)} ↑${fmtRate(outBytes)}`
}

/**
 * What a cluster says about this particular row, when the row belongs to a
 * clustered service. Supplied by the caller (the fleet store / fleetCompute),
 * which is the layer that knows about clusters; the adapter itself stays a pure
 * per-row mapping.
 */
export interface ClusterMemberHint {
  /** The cluster that speaks for this service. */
  clusterName: string
  /** Is the workload actually placed on this host right now? */
  placed: boolean
}

// 3CX's systemd units by what they do, for its services list. Anything not
// listed loses its 3CX prefix and instance number and splits into words.
const TCX_UNITS: Record<string, string> = {
  '3CXAudioProvider01': 'Audio provider', '3CXCallFlow01': 'Call flow', '3CXCfgServ01': 'Config service',
  '3CXEventNotificationManager': 'Event notifications', '3CXFirewall': 'Firewall', '3CXGatewayService': 'Gateway',
  '3CXIVR01': 'IVR', '3CXMediaServer': 'Media server', '3CXPhoneSystem01': 'Phone system',
  '3CXPhoneSystemMC01': 'Management console', '3CXQueueManager01': 'Call queues', '3CXSystemService01': 'System service',
  '3CXTunnel01': 'Tunnel', '3CXSBC': 'SBC',
}
export function tcxUnitName(unit: string): string {
  const u = unit.replace(/\.service$/, '')
  const known = TCX_UNITS[u]
  if (known) return known
  const words = u.replace(/^3CX/, '').replace(/\d+$/, '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').split(' ').filter(Boolean)
  if (!words.length) return u
  // Sentence case, but an acronym (SIP, IVR) keeps its capitals.
  return words.map((w, i) => (/^[A-Z0-9]+$/.test(w) ? w : i ? w.toLowerCase() : w[0]!.toUpperCase() + w.slice(1).toLowerCase())).join(' ')
}

export function clientStateToService(cs: CS, sys: Sys, cluster?: ClusterMemberHint): Service {
  const m = mapByType(cs)
  // Host services (os/lxc) report the machine hostname as their name; when that's
  // an AWS auto-hostname, use the system's chosen name instead, and drop the
  // "· ip-x-x-x-x" host tag that trails the kind label / status.
  if ((cs.type === 'os' || cs.type === 'lxc') && AWS_HOSTNAME.test(m.name)) {
    m.name = sys.name
  }
  m.kindLabel = m.kindLabel.replace(AWS_HOST_SUFFIX, '')
  let level = cs.type.startsWith('cloudflare') || ['website', 'web', 'mongodb', 'ewelink'].includes(cs.type)
    ? toLevel(cs.status)
    : toLevel(cs.status || 'online')
  // Elevate the level for resource pressure (high cpu/mem/disk) so it's visible
  // on the service itself, not just the dashboard pressure panel.
  const pressure = resourcePressure(cs.type, m)
  let pressureWord = ''
  if (pressure && LRANK[pressure.level] > LRANK[level]) {
    level = pressure.level
    pressureWord = pressure.word
  }
  const age = secondsSince(cs.updated_at)
  // Staleness: a service that has stopped reporting must not keep showing its
  // last-known status. Cloudflare pushes every ~5min (worker cron); other agents
  // report every 10-60s — so anything silent past these windows is offline.
  // wordpress is a slow posture poller (~5 min), like the cloudflare cron — give
  // it the wider window so it doesn't flap to OFFLINE just before each poll.
  // adsense polls every 10 min for the same reason.
  // adsense and ga4 poll every 15 minutes: allow two polls of silence.
  const staleAfter = cs.type === 'adsense' || cs.type === 'ga4' ? 1800
    : cs.type.startsWith('cloudflare') || cs.type === 'wordpress' ? 900
    // A nagios check runs on its own interval: three missed runs, never under 5 min.
    : cs.type === 'nagios' ? Math.max(300, (3 * (Number(cs.data?.intervalMs) || 60000)) / 1000)
    // cost polls hourly by default: three missed polls.
    : cs.type === 'cost' ? Math.max(1800, (3 * (Number(cs.data?.intervalMs) || 3600000)) / 1000)
    // indexing polls every 6 hours by default: two missed polls.
    : cs.type === 'indexing' ? Math.max(3600, (2 * (Number(cs.data?.intervalMs) || 21600000)) / 1000)
    : 300
  let statusWord = cs.status_reason
    ? String(cs.status_reason).slice(0, 80).replace(AWS_HOST_SUFFIX, '')
    : (pressureWord || WORD[level])
  // Cloudflare inventory records (a Pages project, a Worker script) are not
  // heartbeats — there is no agent on the other end to go quiet. A record stops
  // updating because the resource left this push (Pages/zones are modulo-sharded)
  // or because a Worker served no traffic in the analytics window. Neither means
  // "down", so these never take the OFFLINE word; mapByType marks a traffic-less
  // Worker IDLE, and resources deleted at Cloudflare are archived at ingest.
  // A member of a cluster that isn't holding the service is not offline, and
  // this is where saying so used to go wrong: `summarized-renderer` is pinned to
  // the current Patroni leader, so on the other two Pis the project is stopped
  // or gone, and both of them read OFFLINE · 3d. The row is telling the truth —
  // nothing is running here — but the conclusion is the cluster's to draw, and
  // the cluster's answer is that one member holding it is correct. Standby, and
  // the rollup card carries the real verdict.
  if (cluster && !cluster.placed) {
    level = 'standby'
    statusWord = `STANDBY · ${cluster.clusterName}`
  } else if (age > staleAfter && !CF_INVENTORY.has(cs.type)) {
    level = 'crit'
    statusWord = `OFFLINE · ${fmtAge(age)}`
  } else if (m.idleWord) {
    level = 'standby'
    statusWord = m.idleWord
  }
  return {
    id: cs.id,
    name: m.name,
    stack: sys.id,
    ownerId: sys.user_id ?? undefined,
    env: stackEnv(sys.group_name),
    kindLabel: m.kindLabel,
    badge: m.badge,
    level,
    hasBars: m.hasBars,
    cpu: m.cpu,
    mem: m.mem,
    disk: m.disk,
    disks: m.disks,
    net: m.net,
    netIn: (m as any).netIn,
    netOut: (m as any).netOut,
    processes: m.processes,
    memBytes: m.memBytes,
    memory: m.memory,
    restarts: m.restarts,
    ping: m.ping,
    ports: m.ports,
    age,
    statusWord,
    // Uncut reason, only while it is the status being shown (not OFFLINE/STANDBY/idle).
    statusReason: cs.status_reason && statusWord === String(cs.status_reason).slice(0, 80).replace(AWS_HOST_SUFFIX, '')
      ? String(cs.status_reason).replace(AWS_HOST_SUFFIX, '')
      : undefined,
    unitLabel: m.unitLabel,
    units: m.units,
    metrics: m.metrics,
    sparkline: m.sparkline ?? [],
    load: [],
    events: m.events ?? [],
    // netscan/snmp monitor OTHER devices, so the reported data.ip is the device's
    // LAN address — not client_ip (the WAN source of the agent's report).
    ip: (cs.type === 'netscan' || cs.type === 'netdevice' || cs.type === 'snmp' || cs.type === 'device')
      ? ((cs.data as any)?.ip || cs.client_ip || undefined)
      : (cs.client_ip || sys.ip_address || undefined),
    // A merged device is fed by several plugins (netscan · tplinkswitch); name
    // those rather than the row's own "device" type.
    plugins: cs.type === 'device' && (cs.data as any)?.sources ? Object.keys((cs.data as any).sources) : [cs.type],
    lastReport: fmtAge(age),
    links: serviceLinks(cs),
    cf: m.cf,
    adsense: m.adsense,
    cost: m.cost,
    ga4: m.ga4,
    // An account-level summary stands for its whole stack (zones, Pages projects,
    // workers), so clicking it should open the stack — its own service page shows
    // only the account totals.
    ...(cs.type === 'cloudflare-account' || cs.type === 'cloudflare'
      ? { href: `/stacks/${sys.id}` }
      : {}),
  }
}

/** A placeholder Service for a system that has not reported any client_states yet. */
export function systemPlaceholderService(sys: Sys): Service {
  const level = toLevel(sys.status)
  const age = secondsSince(sys.last_seen)
  return {
    id: sys.id,
    name: sys.name,
    stack: sys.id,
    ownerId: sys.user_id ?? undefined,
    env: stackEnv(sys.group_name),
    kindLabel: sys.type ? String(sys.type) : 'system',
    badge: String(sys.type || 'system'),
    level,
    hasBars: false,
    cpu: 0, mem: 0, ping: 0, age,
    statusWord: sys.status_reason ? String(sys.status_reason).slice(0, 80) : (sys.last_seen ? WORD[level] : 'NO DATA'),
    statusReason: sys.status_reason ? String(sys.status_reason) : undefined,
    unitLabel: '',
    units: [],
    metrics: [],
    sparkline: [], load: [], events: [],
    ip: sys.ip_address || undefined,
    plugins: [],
    lastReport: sys.last_seen ? fmtAge(age) : 'never',
  }
}

/**
 * A group's own figures, summed from its members rather than borrowed from the
 * hosts they run on: CPU in cores across its containers and processes, their
 * memory, and their network. Host (os) members are left out of the sums: a
 * host's cpu% doesn't add to a container's cores, and counting the host would
 * hand every group on it the same number. Labels only appear when at least one
 * member contributed.
 */
export function groupOwnMetrics(members: Service[]): Metric[] {
  const WORKLOAD = ['docker', 'lxc', 'lxc-container', 'pm2']
  const work = members.filter((s) => s.plugins?.some((p) => WORKLOAD.includes(p)))
  if (!work.length) return []
  const metricOf = (s: Service, label: string) => s.metrics?.find((m) => m.label === label)?.value
  const sum = (label: string, bytes: boolean) => {
    let total = 0, n = 0
    for (const s of work) {
      const v = metricOf(s, label)
      // MEM on a pm2 app or a % elsewhere isn't bytes; only add like with like.
      if (!v || (bytes && !/B/.test(v)) || /%/.test(v)) continue
      const q = parseQuantity(v)
      if (q != null) { total += q; n++ }
    }
    return n ? total : null
  }
  const cpu = work.reduce((t, s) => t + (Number(s.cpu) || 0), 0)
  const mem = sum('MEM', true)
  const net = sum('NET', true)
  return [
    metric('CPU', fmtCores(cpu), 'ok'),
    ...(mem != null ? [metric('MEM', fmtBytes(mem), 'ok')] : []),
    ...(net != null ? [metric('NET', fmtRate(net), 'ok')] : []),
  ]
}
