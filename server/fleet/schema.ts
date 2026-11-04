/**
 * The fleet's tables, ported from the Postgres schema (information_schema dump
 * of 2026-11-04).
 *
 * Each table is written once, as "column kind [!] [=default]", and both the
 * CREATE TABLE statements and the query builder's type conversions come from it.
 * Kinds: uuid, text, int, real, bool, json, ts. "!" is NOT NULL.
 *
 * SQLite has no jsonb, boolean, array or timestamptz, so:
 * - json (and Postgres arrays) are stored as JSON text and parsed on read.
 * - bool is 0/1, returned as true/false.
 * - ts is ISO text in the exact shape Date.toISOString() writes, so string
 *   comparison orders correctly. Defaults use the same shape.
 * - uuid is text. A missing id is filled in by the query builder on insert.
 */

const TABLES: Record<string, string> = {
  systems: `
    id uuid !, user_id uuid !, name text !, slug text !, description text,
    group_name text ='Default', tags json ='[]', type text ='other',
    os json ='{"arch":"","name":"","type":"other","version":""}',
    status text ='pending', status_reason text, last_seen ts, last_updated ts,
    ip_address text, metrics json ='{}', created_at ts =now, updated_at ts =now,
    archived bool ! =0, org_id uuid, key_hash text !, previous_key_hash text,
    previous_key_used_at ts`,
  client_states: `
    id uuid !, unique_id text !, system_id uuid !, type text !, data json !,
    status text ='online', status_reason text, client_ip text, updated_at ts =now,
    archived bool ! =0, archived_module text`,
  client_state_history: `
    id uuid !, unique_id text !, system_id uuid !, type text !, data json !,
    status text ='online', created_at ts =now`,
  cf_zone_daily: `
    system_id uuid !, unique_id text !, day text !, zone text,
    requests int ! =0, bandwidth int ! =0, threats int ! =0, uniques int ! =0,
    updated_at ts ! =now, probes int, probes_cms int, probes_served int, probe_paths json`,
  notifications: `
    id uuid !, user_id uuid !, system_id uuid, title text !, message text !,
    type text ! ='info', source text ='system', source_detail text,
    read bool =0, read_at ts, action_required bool =0, action_taken bool =0,
    metadata json ='{}', created_at ts =now, resolved_at ts`,
  events: `
    id uuid !, user_id uuid !, system_id uuid, service_uid text, severity text !,
    title text !, body text, created_at ts =now`,
  groups: `
    id uuid !, user_id uuid !, name text !, description text, cf_zone text,
    color text, sort int =0, created_at ts =now, updated_at ts =now, kind text`,
  group_members: `
    id uuid !, group_id uuid !, service_id text !, label text, created_at ts =now, part text`,
  clusters: `
    id uuid !, user_id uuid !, name text !, description text, kind text ! ='generic',
    leader_system_id uuid, leader_seen_at ts, grace_seconds int ! =120,
    created_at ts =now, updated_at ts =now`,
  cluster_members: `
    id uuid !, cluster_id uuid !, system_id uuid !, created_at ts =now`,
  cluster_services: `
    id uuid !, cluster_id uuid !, name text !, match_type text !, match_unique_id text !,
    match_container text, placement text ! ='singleton', min_running int ! =1,
    max_running int, enabled bool ! =1, last_level text, last_reason text,
    degraded_since ts, evaluated_at ts, created_at ts =now, updated_at ts =now`,
  cluster_service_history: `
    id uuid !, cluster_service_id uuid !, level text !, reason text,
    running_count int !, member_count int !, unknown_count int ! =0, created_at ts =now`,
  incidents: `
    id uuid !, user_id uuid !, title text !, severity text ! ='warn',
    status text ! ='investigating', started_at ts !, ended_at ts, summary text,
    solution text, client_visible bool ! =0, created_at ts ! =now, updated_at ts ! =now`,
  incident_targets: `
    id uuid !, incident_id uuid !, target_type text !, target_id text !, label text,
    system_id uuid, created_at ts ! =now`,
  incident_entries: `
    id uuid !, incident_id uuid !, author_id uuid, kind text ! ='note', body text,
    url text, status text, occurred_at ts ! =now, client_visible bool ! =0,
    created_at ts ! =now`,
  web_monitors: `
    id uuid !, user_id uuid !, system_id uuid, name text !, url text !,
    config json ! ='{}', interval_ms int ! =120000, enabled bool ! =1, sort int ! =0,
    created_at ts ! =now, updated_at ts ! =now`,
  views: `
    id uuid !, user_id uuid !, name text !, template json ! ='{}', sort int ! =0,
    created_at ts ! =now, updated_at ts ! =now`,
  enrollment_tokens: `
    id uuid !, user_id uuid !, system_id uuid !, token_hash text !, plugins json ! ='[]',
    autoname bool ! =0, expires_at ts !, claimed_at ts, claimed_ip text,
    claimed_hostname text, claimed_machine_id text, created_at ts ! =now`,
  api_keys: `
    id uuid !, user_id uuid !, name text !, permissions json ='["read"]',
    created_at ts =now, expires_at ts, last_used_at ts, key_hash text !`,
  notification_channels: `
    id uuid !, user_id uuid !, kind text !, enabled bool ! =1, min_level text ! ='warning',
    label text, config json ! ='{}', created_at ts ! =now, updated_at ts ! =now`,
  // Who may use this tenant. Replaces organization_members and account-level
  // share_grants: a tenant is one account.
  members: `
    user_id uuid, email text, role text ! ='viewer', created_at ts ! =now`,
  // System and group shares, unchanged in meaning from share_grants.
  grants: `
    id uuid !, resource_type text !, resource_id text !, grantee_email text !,
    grantee_id uuid, role text ! ='viewer', created_at ts ! =now`,
}

// Primary keys, and the indexes the code relies on (unique ones are upsert
// targets or dedupe guards). The rest mirror the Postgres indexes reads use.
const KEYS: Record<string, string> = {
  cf_zone_daily: "primary key (system_id, unique_id, day)",
  members: "unique (user_id), unique (email)",
}

const INDEXES = [
  "create unique index systems_key_hash on systems (key_hash)",
  "create index systems_previous_key_hash on systems (previous_key_hash) where previous_key_hash is not null",
  "create unique index client_states_uid_sys on client_states (unique_id, system_id)",
  "create index client_states_system on client_states (system_id)",
  "create index client_states_type on client_states (type)",
  "create index csh_uid_sys_created on client_state_history (unique_id, system_id, created_at desc)",
  "create index csh_created on client_state_history (created_at)",
  // A second open alert for the same finding is refused, as in Postgres.
  "create unique index notifications_open_alert_uniq on notifications (system_id, source, source_detail) where resolved_at is null and source_detail is not null",
  "create index notifications_unresolved on notifications (system_id, source, resolved_at) where resolved_at is null",
  "create index notifications_created on notifications (created_at)",
  "create index events_system_created on events (system_id, created_at desc)",
  "create unique index group_members_group_service on group_members (group_id, service_id)",
  "create unique index cluster_members_cluster_system on cluster_members (cluster_id, system_id)",
  "create index cluster_members_system on cluster_members (system_id)",
  // Postgres declared this NULLS NOT DISTINCT; SQLite needs the coalesce.
  "create unique index cluster_services_match on cluster_services (cluster_id, match_type, match_unique_id, coalesce(match_container, ''))",
  "create index cluster_service_history_svc_time on cluster_service_history (cluster_service_id, created_at desc)",
  "create unique index enrollment_tokens_hash on enrollment_tokens (token_hash)",
  "create unique index api_keys_hash on api_keys (key_hash)",
  "create unique index incident_targets_uniq on incident_targets (incident_id, target_type, target_id)",
  "create index incident_entries_incident on incident_entries (incident_id, occurred_at desc)",
  "create unique index channels_slack_team on notification_channels (user_id, kind, json_extract(config, '$.team_id')) where kind = 'slack'",
  "create unique index grants_uniq on grants (resource_type, resource_id, grantee_email)",
]

export type Kind = "uuid" | "text" | "int" | "real" | "bool" | "json" | "ts"
export type Columns = Record<string, Kind>

const NOW = "(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))"
const SQL_TYPE: Record<Kind, string> = { uuid: "text", text: "text", int: "integer", real: "real", bool: "integer", json: "text", ts: "text" }

function parseTable(spec: string) {
  return spec.split(",").map((s) => s.trim()).filter(Boolean).map((col) => {
    const m = col.match(/^(\w+)\s+(\w+)(\s+!)?(?:\s+=(.+))?$/)
    if (!m) throw new Error(`schema: can't read column "${col}"`)
    return { name: m[1], kind: m[2] as Kind, notNull: !!m[3], def: m[4] }
  })
}

// Commas inside a json default would split the spec, so those defaults avoid them
// (the os default is the one exception, rejoined here).
function columnsOf(spec: string) {
  return parseTable(spec.replace(/'\{[^']*\}'/g, (s) => s.replace(/,/g, "\u0000")))
    .map((c) => ({ ...c, def: c.def?.replace(/\u0000/g, ",") }))
}

/** Column kinds per table, for the query builder. */
export const COLUMNS: Record<string, Columns> = Object.fromEntries(
  Object.entries(TABLES).map(([t, spec]) => [t, Object.fromEntries(columnsOf(spec).map((c) => [c.name, c.kind]))]),
)

/** Tables that have an `id` the builder should fill in. */
export const HAS_ID = new Set(Object.entries(COLUMNS).filter(([, c]) => c.id === "uuid").map(([t]) => t))

function createTable(table: string, spec: string): string {
  const cols = columnsOf(spec).map((c) => {
    let s = `${c.name} ${SQL_TYPE[c.kind]}`
    if (c.name === "id" && c.kind === "uuid") s += " primary key"
    if (c.notNull) s += " not null"
    if (c.def === "now") s += ` default ${NOW}`
    else if (c.def !== undefined) s += ` default ${c.def}`
    return s
  })
  if (KEYS[table]) cols.push(KEYS[table])
  return `create table ${table} (${cols.join(", ")})`
}

/**
 * Schema versions, applied in order inside the DO's constructor. Append, never
 * edit: a tenant that already ran version N only runs what comes after it.
 */
export const MIGRATIONS: string[][] = [
  [...Object.entries(TABLES).map(([t, spec]) => createTable(t, spec)), ...INDEXES],
]

export function migrate(sql: SqlStorage): void {
  sql.exec("create table if not exists _schema (version integer not null)")
  const row = sql.exec<{ version: number }>("select version from _schema").toArray()[0]
  let version = row?.version ?? 0
  if (!row) sql.exec("insert into _schema (version) values (0)")
  for (; version < MIGRATIONS.length; version++) {
    for (const stmt of MIGRATIONS[version]) sql.exec(stmt)
    sql.exec("update _schema set version = ?", version + 1)
  }
}
