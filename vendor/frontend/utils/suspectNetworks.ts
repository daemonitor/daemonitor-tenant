// A zone's suspect networks over time, from live history and archived months.

export type SuspectNetwork = {
  asn: number | string
  name?: string
  pages?: number
  share?: number
  articleShare?: number
  isNew?: boolean
}
export type SuspectSample = { at: number; share: number; suspects: SuspectNetwork[] }

export type NetworkHistory = {
  asn: string
  name: string
  // One value per timeline bucket: the network's highest share in it, or null
  // when it was not flagged then. A null is not a zero: the network may still be
  // sending traffic, it just stopped looking suspect.
  buckets: (number | null)[]
  firstSeen: number
  lastSeen: number
  days: number
  peak: number
  lastShare: number
  lastPages: number
  lastArticleShare: number
  active: boolean
  isNew: boolean
}

export type SuspectTimeline = {
  times: number[]
  total: (number | null)[]
  // Each bucket's worst report. A bad few hours shouldn't average away over a day.
  peaks: number[]
  networks: NetworkHistory[]
  from: number
  to: number
  reports: number
}

// Format 2 archives intern any sub-object over ~200 chars into `blobs` and leave
// a {"__b": id} marker behind (daemonitor-archive-export in scripts/ops).
export function resolveArchived(node: any, blobs?: Record<string, any>): any {
  if (!blobs) return node
  if (Array.isArray(node)) return node.map((v) => resolveArchived(v, blobs))
  if (node && typeof node === 'object') {
    const keys = Object.keys(node)
    if (keys.length === 1 && keys[0] === '__b') return resolveArchived(blobs[node.__b], blobs)
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, resolveArchived(v, blobs)]))
  }
  return node
}

// R2 holds these gzipped and the route passes them through with Content-Encoding:
// gzip, but by default a Worker gzips such a body again. The browser only undoes
// one layer, so inflate whatever is left instead of depending on which happened.
export async function parseArchive(bytes: ArrayBuffer): Promise<any> {
  const head = new Uint8Array(bytes, 0, 2)
  if (head[0] === 0x1f && head[1] === 0x8b) {
    const inflated = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))
    return parseArchive(await new Response(inflated).arrayBuffer())
  }
  return JSON.parse(new TextDecoder().decode(bytes))
}

export const SUSPECT_THREE_MONTHS_DAYS = 92

// The archived months a window of `days` reaches back into. Live history holds 30
// to 60 days, so the 3 month view is live plus these.
export function monthsReaching(months: string[], days: number, now = Date.now()): string[] {
  const first = new Date(now - days * 86_400_000).toISOString().slice(0, 7)
  return months.filter((m) => m >= first)
}

export async function fetchArchiveMonth(account: string, month: string): Promise<any> {
  return parseArchive(await $fetch<ArrayBuffer>(`/api/archive/${account}/${month}`, { responseType: 'arrayBuffer' }))
}

// Only this zone's rows get resolved. A month holds every service in the account.
export function suspectSamplesFromArchive(
  archive: { rows: any[]; blobs?: Record<string, any> },
  systemId: string,
  uniqueId: string,
): SuspectSample[] {
  const out: SuspectSample[] = []
  for (const r of archive.rows) {
    if (r.system_id !== systemId || r.unique_id !== uniqueId) continue
    const sn = resolveArchived(r.data, archive.blobs)?.domain?.trafficQuality?.suspectNetworks
    if (typeof sn?.suspectShare !== 'number') continue
    out.push({ at: Date.parse(r.created_at), share: sn.suspectShare, suspects: Array.isArray(sn.suspects) ? sn.suspects : [] })
  }
  return out
}

// Fixed-width time buckets, because history is uneven: every report for the last
// day and at most 24 a day before that. Plotted per sample, the last day would
// take up a quarter of a 30-day chart. Empty buckets stay null so a gap reads as
// a gap.
export function buildSuspectTimeline(samples: SuspectSample[], maxBuckets = 120): SuspectTimeline | null {
  const byTime = new Map(samples.map((s) => [s.at, s]))
  const sorted = [...byTime.values()].sort((a, b) => a.at - b.at)
  const first = sorted[0]
  const last = sorted[sorted.length - 1]
  if (!first || !last) return null

  const width = Math.max(3_600_000, (last.at - first.at + 1) / maxBuckets)
  const count = Math.max(1, Math.ceil((last.at - first.at + 1) / width))
  const bucketOf = (t: number) => Math.min(count - 1, Math.floor((t - first.at) / width))

  const sums = new Array(count).fill(0)
  const ns = new Array(count).fill(0)
  const peaks = new Array(count).fill(0)
  const nets = new Map<string, NetworkHistory & { dayKeys: Set<string> }>()

  for (const s of sorted) {
    const b = bucketOf(s.at)
    sums[b] += s.share
    ns[b]++
    peaks[b] = Math.max(peaks[b], s.share)
    for (const x of s.suspects) {
      const asn = String(x.asn)
      let n = nets.get(asn)
      if (!n) {
        n = {
          asn, name: x.name || 'unknown', buckets: new Array(count).fill(null),
          firstSeen: s.at, lastSeen: s.at, days: 0, peak: 0,
          lastShare: 0, lastPages: 0, lastArticleShare: 0,
          active: false, isNew: false, dayKeys: new Set(),
        }
        nets.set(asn, n)
      }
      const share = Number(x.share) || 0
      n.buckets[b] = Math.max(n.buckets[b] ?? 0, share)
      n.lastSeen = s.at
      n.peak = Math.max(n.peak, share)
      n.lastShare = share
      n.lastPages = Number(x.pages) || 0
      n.lastArticleShare = Number(x.articleShare) || 0
      if (x.name) n.name = x.name
      n.isNew = !!x.isNew
      n.active = s === last
      n.dayKeys.add(new Date(s.at).toISOString().slice(0, 10))
    }
  }

  const networks = [...nets.values()]
    .map(({ dayKeys, ...n }) => ({ ...n, days: dayKeys.size }))
    .sort((a, b) => Number(b.active) - Number(a.active) || b.peak - a.peak)

  return {
    times: Array.from({ length: count }, (_, i) => first.at + i * width),
    total: sums.map((v, i) => (ns[i] ? v / ns[i] : null)),
    peaks,
    networks,
    from: first.at,
    to: last.at,
    reports: sorted.length,
  }
}
