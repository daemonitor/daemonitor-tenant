// Fleet helpers — auto-imported by Nuxt (no explicit import needed elsewhere).
import type { Level, Metric, Service } from '~/types/fleet'

const LEVEL_HEX: Record<Level, string> = {
  ok: '#3fb950',
  warn: '#d29922',
  crit: '#f85149',
  standby: '#6e7681',
}

const CARD_WORD: Record<Level, 'OK' | 'WARN' | 'CRIT'> = {
  ok: 'OK',
  warn: 'WARN',
  crit: 'CRIT',
  standby: 'OK',
}

/**
 * Per-metric hues, independent of status colour: a metric keeps its identity
 * whether the host is healthy or on fire. Board meters, hover popovers, system
 * detail and group member cards all read from here, so CPU is the same blue in
 * every chart in the product.
 */
export const METRIC_HEX = {
  cpu: '#4aa3ff',
  mem: '#2bd84a',
  disk: '#ffc01e',
  net: '#954e9f',
} as const

/** Hex color for a level. */
export function levelColor(level: Level): string {
  return LEVEL_HEX[level] ?? LEVEL_HEX.standby
}

/** Compact card status word for a level. */
export function cardWord(level: Level): 'OK' | 'WARN' | 'CRIT' {
  return CARD_WORD[level] ?? 'OK'
}

/**
 * A web check answered 429: the site is up and refusing the checker, not
 * failing visitors. Shopify throttles a long-running checker process while
 * fresh clients on the same IP get 200, and reading that as DOWN paged ~50
 * times a day for a healthy shop. Shared by ingest and the card so the alert
 * and the LED agree.
 */
export function webThrottled(status: unknown): boolean {
  return status === 429
}

/** CPU threshold level: warn > 70, crit > 85. */
/**
 * A unit's status without the echo of its own name. The text almost always
 * opens by repeating it, often with the address: "NETGEAR (172.16.36.113)
 * unreachable" in a row already headed NETGEAR. One word of that is new.
 */
export function ownStatus(u: { name?: string; state?: string }): string {
  let t = String(u.state || '').trim()
  const name = String(u.name || '').trim()
  if (name && t.toLowerCase().startsWith(name.toLowerCase())) {
    t = t
      .slice(name.length)
      .replace(/^\s*\([^)]*\)\s*/, '') // a trailing "(10.0.0.1)" belongs to the name
      .replace(/^[\s:·|-]+/, '')
  }
  return t
}

export function cpuLevel(v: number): Level {
  if (v > 85) return 'crit'
  if (v > 70) return 'warn'
  return 'ok'
}

/**
 * Container-group CPU is a SUM of per-container `docker stats` percentages,
 * where 100% means one full core, so a stack using 1.75 cores reads as 175%.
 * That looks like an overloaded host but is 17.5% of a 10-core box. Render it
 * in cores so the unit is unambiguous.
 */
export function fmtCores(pct: number): string {
  const cores = (Number(pct) || 0) / 100
  return `${cores >= 10 ? Math.round(cores) : cores.toFixed(2)} cores`
}

/** Level for container-group CPU. Thresholds are in cores, not percent. */
export function containerCpuLevel(pct: number): Level {
  const cores = (Number(pct) || 0) / 100
  if (cores > 3) return 'crit'
  if (cores > 2) return 'warn'
  return 'ok'
}

// Memory is MemAvailable-based, so cache is already free. A small box that
// lives near full with swap behind it (the 1 GB 3CX PBX) still read red at 85.
export const MEM_WARN = 90
export const MEM_CRIT = 95

/** Memory threshold level: warn > MEM_WARN, crit > MEM_CRIT. */
export function memLevel(v: number): Level {
  if (v > MEM_CRIT) return 'crit'
  if (v > MEM_WARN) return 'warn'
  return 'ok'
}

/**
 * Rows listed under a heading that carries their own name ("AN 3CX PBX" in the
 * group "AN 3CX PBX") say what they are instead. Display only, and an exact
 * match: a name that differs at all is kept.
 */
export function underHeading<T extends { name: string; kindLabel?: string }>(list: T[], heading?: string | null): T[] {
  if (!heading) return list
  return list.map((s) => (s.name === heading && s.kindLabel ? { ...s, name: s.kindLabel } : s))
}

/** Disk usage threshold level: warn >= 80, crit >= 90. */
export function diskLevel(v: number): Level {
  if (v >= 90) return 'crit'
  if (v >= 80) return 'warn'
  return 'ok'
}

/**
 * Ping threshold level: green < 90ms, slate < 150, amber >= 150,
 * red (crit) when down (ping <= 0).
 */
export function pingLevel(ms: number): Level {
  if (ms <= 0) return 'crit'
  if (ms < 90) return 'ok'
  if (ms < 150) return 'standby'
  return 'warn'
}

/** Hex color for a ping value, following pingLevel thresholds. */
export function pingColor(ms: number): string {
  return levelColor(pingLevel(ms))
}

/** Format an age in seconds as '4s' / '2m' / '1h'. */
export function fmtAge(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  return `${Math.floor(s / 3600)}h`
}

// An event's message, or '' when it only repeats the title. The rollup alert
// paths build both from one reason string ("<system>: <reason>" and
// "<TYPE>: <reason>"), and printing the pair reads as a rendering bug.
export function distinctMessage(title: string, message: string): string {
  const t = (title || '').trim().toLowerCase()
  const m = (message || '').trim().toLowerCase()
  return !m || t === m || t.endsWith(m.replace(/^[^:]{1,40}:\s*/, '')) ? '' : message
}

// Sources whose source_detail names one finding. Everywhere else it names the
// service or device that raised the alert, which covers many unrelated faults.
export const FINDING_SOURCES = ['web', 'wordpress', 'logwatch', 'appactivity']

/**
 * The number in a formatted reading, in base units: "104 MB" → 109051904,
 * "21 KB/s" → 21504, "0.06 cores" → 0.06, "132.4K" → 132400. Byte units are
 * 1024-based to match fmtBytes/fmtRate; a bare K/M/G is 1000-based.
 */
export function parseQuantity(v: string): number | null {
  const m = String(v).match(/(-?\d+(?:\.\d+)?)\s*([KMGT]?)(i?B)?/)
  if (!m) return null
  const step = m[3] ? 1024 : 1000
  return Number(m[1]) * step ** ' KMGT'.indexOf(m[2] || ' ')
}

/** Uptime text ("696d 10h", "743h", "3h 12m", "40m") in hours; null if none. */
export function parseUptimeHours(v: string): number | null {
  const parts = [...String(v).matchAll(/(\d+(?:\.\d+)?)\s*([ydhm])\b/g)]
  if (!parts.length) return null
  const per: Record<string, number> = { y: 8760, d: 24, h: 1, m: 1 / 60 }
  return parts.reduce((s, [, n, u]) => s + Number(n) * per[u], 0)
}

/**
 * A metric's value as one number to chart: a quantity ("1.0ms", "133 KB/s",
 * "42%"), a count of a whole ("3/8" is 3), a load triple's first, or an
 * uptime in hours. Null for anything that isn't one number ("1.0.12", "DOWN").
 */
export function chartValue(v: string): number | null {
  const t = String(v).trim()
  if (/^(\d+(\.\d+)?\s*[ydhm]\s*)+$/.test(t)) return parseUptimeHours(t)
  const one = /^-?\d+(\.\d+)?(\s*([KMGT]i?B(\/s)?|B(\/s)?|ms|%|°C|rpm))?$/i.test(t)
  return one || /^\d+\/\d+$/.test(t) || /^(\d+(\.\d+)?\s+)+\d+(\.\d+)?$/.test(t) ? parseQuantity(t) : null
}

/**
 * What a card's gauges and status bar draw from. A host's own CPU and MEM
 * live on the service (they drive its chart), not in `metrics`, so they're
 * added here: they're the two numbers that matter most on a host. A group's
 * figures are already its own metrics, so groups are left as they are. A
 * STATUS that only says ONLINE is dropped: the LED says it.
 */
export function gaugeMetrics(s: Service): Metric[] {
  const own = (s.metrics || []).filter((m) => !(m.label === 'STATUS' && /^online$/i.test(String(m.value)) && m.level === 'ok'))
  if (!s.hasBars || s.isGroup) return own
  const has = (l: string) => own.some((m) => m.label === l)
  const extra: Metric[] = []
  if (!has('CPU')) extra.push({ label: 'CPU', value: `${Math.round(s.cpu)}%`, level: cpuLevel(s.cpu) })
  if (s.mem && !has('MEM') && !has('RAM')) extra.push({ label: 'MEM', value: `${Math.round(s.mem)}%`, level: memLevel(s.mem) })
  return [...extra, ...own]
}
