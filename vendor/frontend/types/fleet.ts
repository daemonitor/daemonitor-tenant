// Fleet types now live in @daemonitor/common so external consumers (e.g. the
// HERETIC portal) can import the exact same Service contract. Re-exported here
// via the sibling checkout so all `~/types/fleet` importers keep working in dev
// and build (the frontend consumes common as a Nuxt layer at ../common).
export * from '../../common/types/fleet'
import type { Level } from '../../common/types/fleet'

// Frontend-only presentation extension (kept out of the shared @daemonitor/common
// contract since it's pure rendering): a stat card may carry compact stacked-bar
// segments — e.g. HTTP 2xx/3xx/4xx/5xx — rendered as a mini bar instead of a plain
// number. Augmenting the source interface merges the field into Service.metrics too.
declare module '../../common/types/fleet' {
  interface Metric {
    segments?: { key: string; count: number; pct: number; color: string }[]
  }
  // The originating system id, so the notifications list can deep-link to the
  // system's detail page. Frontend-only routing hint, not part of the contract.
  interface Notification {
    systemId?: string
    /** Raw ISO timestamp, so views can window by age (`time` is pre-formatted). */
    at?: string
  }
  // OS network throughput (bytes/sec, rx+tx) derived from the os plugin's
  // /proc/net/dev delta — powers the NETWORK tile/metric. Frontend-only.
  // netSpark is its rolling history, rendered as a normalised line in the combo
  // sparkline (bytes/sec, not a %).
  interface Service {
    /** Preformatted CPU for display, when a raw `%` would be the wrong unit
     *  (container groups aggregate to cores). Falls back to `cpu` + '%'. */
    cpuDisplay?: string
    /** Level matching cpuDisplay's unit, so views don't re-threshold in %. */
    cpuLevelHint?: Level
    /**
     * Cluster items only: seconds since the FRESHEST member report behind the
     * verdict. Shown where an ordinary service shows its ping, because a verdict
     * computed across members has no latency of its own — but it does have an
     * evidence window, and `clusterFreshest`..`age` is that window.
     */
    clusterFreshest?: number
    net?: number      // combined rx+tx bytes/sec
    netIn?: number    // rx bytes/sec
    netOut?: number   // tx bytes/sec
    netSpark?: number[]
    // pm2 only: raw figures behind the MEM/RESTARTS metrics, so mergePm2 can
    // total a cluster's instances without parsing "41.3 MB" back to bytes.
    memBytes?: number
    restarts?: number
    // os only: the bytes behind `mem`. Swap and cache arrive from plugins 1.1.51.
    memory?: { used: number; total: number; cached?: number; swapUsed?: number; swapTotal?: number }
    // switch only: every port's state in order, for the board's port instrument.
    ports?: Level[]
  }
  // A unit row may deep-link to where you'd actually act on it — e.g. a failing
  // Cloudflare Worker links to its dashboard (logs/errors). Presentation-only.
  interface Unit {
    href?: string
    /** More to read when it's pointed at, on the XR view: a count's names. */
    hover?: string
    /** Where a click on it goes, in a new tab, on the XR view: an article in a list of pages. */
    opens?: string
  }
}
