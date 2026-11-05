// Shared TypeScript types for the observatory fleet dashboard.
// These match the data-backbone contract — other agents depend on these field names.
//
// Canonical home is @daemonitor/common so external consumers (e.g. the HERETIC
// portal) can import the exact same Service contract the daemonitor frontend
// renders. The frontend re-exports this from ~/types/fleet.

export type Level = 'ok' | 'warn' | 'crit' | 'standby'

export interface Unit {
  name: string
  state: string
  value: string
  level: Level
  // Optional type label (e.g. "Cloudflare · Pages", "Node · PM2", "Web check")
  // — used to disambiguate members in a group's health popover.
  kind?: string
}

export interface Metric {
  label: string
  value: string
  level: Level
}

// One real (physical/attached) drive on a host.
export interface DiskInfo {
  mount: string
  fstype: string
  pct: number
  used: number
  total: number
}

// A named service process group (nginx, php-fpm, mysql, …) on a host or in a
// container — aggregated across all its workers.
export interface ProcessInfo {
  name: string
  count: number
  cpu: number
  mem: number
}

export interface EventLine {
  time: string
  severity: Level
  message: string
}

// An outbound deep link for a service: the live thing it monitors (`site`) or
// an external admin/console surface (`admin`, e.g. the Cloudflare dashboard).
export interface ServiceLink {
  label: string
  href: string
  kind: 'site' | 'admin'
  icon?: string
}

export interface Service {
  id: string
  /** client_states.unique_id: what notify stamps as metadata.service on the alerts this service raised. */
  uniqueId?: string
  name: string
  stack: string // stack id
  env: 'production' | 'staging' | 'shared'
  kindLabel: string
  badge: string
  level: Level
  hasBars: boolean
  cpu: number
  mem: number
  ping: number
  age: number
  statusWord: string
  /**
   * The full reason behind a non-ok status. `statusWord` is cut to 80
   * characters for the compact rows; this is the whole sentence, for views with
   * room to wrap it. Absent when the status needs no explanation.
   */
  statusReason?: string
  unitLabel: string
  units: Unit[]
  metrics?: Metric[]
  sparkline: number[]
  load: number[]
  // Rolling disk% history for host (os) services — powers the card's DISK
  // sparkline. Populated client-side by the fleet store (seeded from the DB),
  // like sparkline (cpu) and load (mem).
  diskSpark?: number[]
  events: EventLine[]
  ip?: string
  region?: string
  agent?: string
  // Storage: fullest real-drive usage % (for the bar), plus the per-drive list.
  disk?: number
  disks?: DiskInfo[]
  // Named service processes (nginx/php-fpm/db/…) on the host or in the container.
  processes?: ProcessInfo[]
  // For container services (docker/lxc): the host's disk %, inherited from the
  // sibling OS service on the same system (containers share the host disk).
  hostDisk?: number
  plugins: string[]
  lastReport: string
  // Outbound deep links (live site, Cloudflare dashboard, etc.). May be empty.
  links?: ServiceLink[]
  // Optional override for the card's click target. Regular services link to
  // /systems/<id>; a group item links to /groups.
  href?: string
  // Marks a synthetic item that stands in for a whole group (not a real service).
  isGroup?: boolean
  // Marks a synthetic item that stands in for one service across a cluster's
  // members. Its `units` are the member hosts, not containers, and its level is
  // the cluster verdict rather than any one host's status.
  isCluster?: boolean
  // Owning account (system.user_id, or the group's owner for group items). Used
  // by the "group by account" view mode. Undefined for orphan/pseudo services.
  ownerId?: string
  // Detailed Cloudflare zone security/caching breakdown (cloudflare-domain
  // services only), surfaced on the detail page. Optional/best-effort.
  cf?: CloudflareDetail
  // Raw AdSense earnings (adsense services only), for consumers that draw
  // their own revenue view instead of the preformatted `metrics`.
  adsense?: AdsenseDetail
  // Raw Google Analytics figures (ga4 services only).
  ga4?: Ga4Detail
  // Spend figures (cost services, and groups made only of them).
  cost?: CostDetail
  // Google indexing of a URL list (indexing services only).
  indexing?: IndexingDetail
  // User has hidden this entity from the fleet views (local preference). Hidden
  // items are filtered out unless the global "show hidden" toggle is on, in
  // which case they render dimmed.
  hidden?: boolean
}

export interface AdsenseDetail {
  /** ISO 4217 code every amount below is in. */
  currency: string
  /** The account's "today" (YYYY-MM-DD, account time zone) these figures were read on. */
  asOf?: string
  today: number
  yesterday: number
  /** Seven days including today, matching AdSense's own "Last 7 days". */
  last7: number
  monthToDate: number
  pageViews7: number
  /** Ad clicks over the same seven days. Absent from older agents. */
  clicks7?: number
  /** Earnings per thousand page views over the same seven days. */
  rpm: number
  /** One entry per day, oldest first, gap-filled with zeroes. */
  daily: { date: string; earnings: number; pageViews: number; clicks?: number }[]
  /** AdSense's own id for the account, "accounts/pub-…". */
  accountId?: string
  /** The same figures per site, biggest earner first. Absent from older agents. */
  sites?: AdsenseSite[]
}

/** One URL in an indexing report: Search Console's inspection plus when it entered the list. */
export interface IndexingUrl {
  url: string
  verdict: string
  coverageState: string
  /** Earlier of the sitemap lastmod and the first poll that listed it. */
  since: string
  stuck: boolean
  lastCrawlTime?: string
  pageFetchState?: string
  googleCanonical?: string
  userCanonical?: string
  /** GSC inspection page (carries an opaque id). */
  link?: string
  /** Indexing API history: null = Google has none on record. */
  notify?: { updated?: string; deleted?: string } | null
  error?: string
}

export interface IndexingDetail {
  site: string
  staleHours: number
  urls: IndexingUrl[]
}

/** What one provider (or a group of them) is billing. Amounts in `currency`. */
export interface CostDetail {
  /** openai, anthropic, aws, ... A group of several reads "mixed". */
  provider: string
  /** ISO 4217. */
  currency: string
  /** The UTC day these figures were read on. */
  asOf?: string
  monthToDate: number
  /** Month-end estimate from complete days so far. */
  projected: number
  budget?: number
  today?: number
  yesterday?: number
  /** One entry per day, oldest first, gap-filled. Empty when the API only gives a month-to-date figure. */
  daily: { date: string; amount: number }[]
  /** Month-to-date by line item (model, service, campaign), biggest first. */
  breakdown?: { name: string; amount: number }[]
  /** Member rows behind a group's total. */
  parts?: { name: string; provider: string; monthToDate: number; projected: number; budget?: number }[]
}

/** Google Analytics overview: every account and GA4 property the login can see. */
export interface Ga4Detail {
  accounts: {
    id: string
    name: string
    properties: Ga4Property[]
  }[]
}

export interface Ga4Totals { users: number; sessions: number; views: number }

export interface Ga4Property {
  id: string
  name: string
  /** Set instead of the figures when this property's reports failed. */
  error?: string
  /** Users active in the last 30 minutes; null when the realtime call failed. */
  activeNow?: number | null
  /** The property's own "today" (its time zone), YYYY-MM-DD. */
  asOf?: string
  today?: Ga4Totals
  yesterday?: Ga4Totals
  /** GA's own 7-day count (users are not summed across days). */
  last7?: Ga4Totals
  /** Per-day figures, oldest first, gap-filled, starting at `start`. */
  daily?: { start: string; users: number[]; sessions: number[]; views: number[] }
}

/** One hostname's share of an AdSense account. Hostnames do not overlap. */
export interface AdsenseSite {
  domain: string
  today: number
  yesterday: number
  last7: number
  monthToDate: number
  pageViews7: number
  clicks7?: number
  rpm: number
  /** Earnings per day, oldest first, same days as the account's `daily`. */
  daily: number[]
}

export interface CloudflareDetail {
  cacheHitRatio?: number
  bandwidthSaved?: number
  encryptedShare?: number
  errorRate?: number
  serverErrorRate?: number
  statusClasses?: Record<string, number>
  topCountries?: { country: string; requests: number; threats: number }[]
  // Last 24h: requests that arrived vs. served 2xx (excluding /cdn-cgi/)
  countries24h?: { country: string; requests: number; served: number }[]
  security?: {
    window?: string
    totalEvents?: number
    mitigated?: number
    byAction?: Record<string, number>
    // Which Cloudflare security product handled the event (waf, firewallrules,
    // ratelimit, botFight, …) — the "what stopped it" view alongside byAction.
    bySource?: Record<string, number>
    topCountries?: { country: string; count: number }[]
    topSources?: { source: string; count: number }[]
    // Top individual WAF/firewall rules that fired (ruleId + its source). The
    // grouped dataset carries no human rule name, so ruleId is shown as-is.
    topRules?: { ruleId: string; source: string; count: number }[]
    error?: string
    /**
     * Set instead of querying when the reporter knows the answer in advance:
     * firewall events need Pro or above, so on a Free zone there is nothing to
     * ask for. Distinct from `error`, which means we asked and it failed.
     */
    unavailable?: 'plan' | 'disabled'
    /** What would make it available, e.g. "Pro". */
    requires?: string
  }
  // Bot Management score distribution (Enterprise-only; undefined otherwise).
  bot?: { window?: string; total?: number; bySource?: Record<string, number>; error?: string }
  // Real Web-Analytics (RUM) figures, when the zone has Web Analytics enabled.
  pageviews?: number
  visits?: number
  // Per-bucket traffic history (from detailedAnalytics.timeseries) for the zone
  // detail traffic chart. Newest last.
  timeseries?: { timestamp?: string; requests?: number; bandwidth?: number; threats?: number; uniques?: number }[]
  cache?: {
    window?: string
    total?: number
    byStatus?: Record<string, number>
    error?: string
  }
  // Turnstile challenge stats for this zone. Only present when the reporter runs
  // with INCLUDE_TURNSTILE and the zone has widgets.
  //
  // The zone rollup is TurnstileStats across every widget on the zone; `widgets`
  // carries the same shape per widget.
  //
  // The per-widget breakdown matters because a zone can host several widgets on
  // different hostnames (jobs.x.com, shop.x.com) with wildly different solve
  // rates, and consumers group by hostname — showing them the zone rollup would be
  // silently wrong. Narrowing by widget (rather than by the `hostnames` map) is
  // also the only way to keep verified/failed, since siteverify events are raised
  // server-side and carry no hostname.
  turnstile?: TurnstileStats & {
    window?: string
    widgets?: TurnstileStats[]
    error?: string
  }
}

/**
 * Turnstile challenge stats — used both for a single widget and for a zone-wide
 * rollup across widgets.
 */
export interface TurnstileStats {
  // Identity — set on per-widget entries, absent on a zone rollup.
  sitekey?: string
  name?: string
  mode?: string
  domains?: string[]

  // Challenges served to visitors.
  issued?: number
  // Solved in-browser. Excludes siteverify (see `verified`) — those are separate
  // events for the same challenge, so adding them would push solveRate over 100%.
  solved?: number
  // Solves the site's server confirmed via /siteverify.
  verified?: number
  // siteverify rejections (e.g. invalid token).
  failed?: number
  // Solves that required a visitor interaction vs ones that passed silently —
  // the bot-vs-human signal.
  interactive?: number
  nonInteractive?: number
  // solved/issued and interactive/(interactive+nonInteractive), as percentages.
  solveRate?: number | null
  interactiveRate?: number | null
  // Per-hostname challenge counts. Server-side siteverify events carry no
  // hostname, so these cover browser-side events only.
  hostnames?: Record<string, number>
  byHour?: { t: string; issued: number; solved: number; failed: number }[]
}

export interface StackGroup {
  id: string
  name: string
  // Owning account (auth user id). Used to show an account chip in All-accounts mode.
  ownerId?: string
  env: 'production' | 'staging' | 'shared'
  level: Level
  services: Service[]
  counts: { ok: number; warn: number; crit: number }
  serviceCount: number
  instanceCount: number
  rollup: { ok: number; warn: number; crit: number }
  topIssue: { level: Level; text: string } | null
  // Group/stack tile hidden by the user (group items only, keyed by group id).
  hidden?: boolean
}

export interface Group {
  id: string
  user_id?: string
  name: string
  description?: string | null
  cf_zone?: string | null
  color?: string | null
  sort?: number
  /** What the group is: 'website', 'application', or null for an ordinary group. Free text. */
  kind?: string | null
}

export interface GroupMember {
  id: string
  group_id: string
  service_id: string
  label?: string | null
}

// A resolved group rollup. Extends StackGroup so existing stack cards/sections
// render it unchanged, plus the group's own metadata.
export interface GroupView extends StackGroup {
  description?: string | null
  cf_zone?: string | null
}

export interface Incident {
  id: string
  level: Level
  title: string
  stack: string
  detail: string
  time: string
  ack: boolean
}

export interface Notification {
  id: string
  level: Level
  title: string
  source: string
  message: string
  time: string
  day: 'TODAY' | 'YESTERDAY'
  read: boolean
}

export interface ApiKey {
  id: string
  name: string
  masked: string
  scopes: string[]
  lastUsed: string
}

export interface Channel {
  id: string
  kind: 'email' | 'slack' | 'webhook'
  value: string
  enabled: boolean
}

// ---------------------------------------------------------------------------
// Clusters
//
// A cluster is a set of systems judged as one. It exists because some services
// are placed across the set rather than run on every member: a follow-the-leader
// singleton is running correctly when exactly one host has it, and that host
// changes on every failover. Read per host, the other members look broken; read
// across the set, they look like what they are.
// ---------------------------------------------------------------------------

/** What a shared service expects of the set. */
export type Placement = 'singleton' | 'leader' | 'all' | 'quorum'

export interface Cluster {
  id: string
  user_id?: string
  name: string
  description?: string | null
  kind: 'generic' | 'patroni'
  /** Set only when something authoritative named a leader (the patroni plugin). */
  leader_system_id?: string | null
  leader_seen_at?: string | null
  /** Seconds a fault must persist before it pages. Covers a failover window. */
  grace_seconds: number
}

export interface ClusterMember {
  id: string
  cluster_id: string
  system_id: string
}

export interface ClusterService {
  id: string
  cluster_id: string
  name: string
  /** client_states.type, e.g. 'docker'. */
  match_type: string
  /** client_states.unique_id, e.g. 'docker-summarized-apps'. */
  match_unique_id: string
  /**
   * Optional compose service name inside that row, e.g. 'renderer'. Needed
   * whenever one compose project mixes placements — `summarized-apps` holds a
   * renderer that must run once and an admin that must run everywhere.
   */
  match_container?: string | null
  placement: Placement
  min_running: number
  max_running?: number | null
  enabled: boolean
  last_level?: Level | null
  last_reason?: string | null
  degraded_since?: string | null
  evaluated_at?: string | null
}

/**
 * Where one member stands on one clustered service.
 *
 * `absent` and `unknown` are kept apart on purpose. A member that is checking in
 * and simply isn't running the service is a follower, and silence about it is
 * correct. A member whose whole agent has gone dark tells us nothing about the
 * service at all — counting that as "not running here" is how a cluster with two
 * dead hosts reports itself healthy.
 */
export type MemberPlacementState = 'running' | 'degraded' | 'absent' | 'unknown'

export interface ClusterMemberStatus {
  systemId: string
  systemName: string
  state: MemberPlacementState
  /** Status word from the member's own row, when it has one. */
  detail?: string
  /** True when this member is the cluster leader (patroni clusters only). */
  leader?: boolean
}

export interface ClusterVerdict {
  serviceId: string
  clusterId: string
  name: string
  placement: Placement
  level: Level
  /** One line naming what is wrong, or what is right. Used as the alert text. */
  reason: string
  members: ClusterMemberStatus[]
  runningCount: number
  /** Members whose agent is dark, so their placement is genuinely unknown. */
  unknownCount: number
  /** Member names currently running it — "ACTIVE ON pi5b" in the UI. */
  runningOn: string[]
  /**
   * Seconds since the OLDEST member report this verdict was computed from.
   *
   * A cluster verdict has no report time of its own — it is derived from several
   * members that each reported at a different moment — so the honest figure is
   * the staleness of the weakest evidence. Infinity when no member has reported
   * at all; undefined when the caller supplied no timestamps.
   */
  oldestReportAge?: number
  /**
   * Seconds since the NEWEST member report behind this verdict.
   *
   * Paired with `oldestReportAge` it brackets how current the evidence is:
   * "computed from reports between 8s and 47s old". That pair is the honest
   * substitute for a latency figure, which a verdict across members does not
   * have.
   */
  freshestReportAge?: number
}
