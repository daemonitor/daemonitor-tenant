/**
 * A Cloudflare reporter's push, judged and stored. Moved from the frontend's
 * server/api/clientstate/cloudflare.post.ts with its logic unchanged: only the
 * database client, the request plumbing and the module check differ.
 */
import { SENTINEL_SCRIPTS, workersIssue } from "~/server/utils/cloudflareWorkers"
import { findSystemByKey } from "./keys"
import { notify, resolveNotifications } from "./notify"
import { HttpError, type FleetCtx } from "./ctx"
import type { Db } from "./db"

export interface CloudflarePushRequest {
    /** Request headers, lower-cased. */
    headers: Record<string, string | undefined>
    /** The ?alias= query parameter, if any. */
    alias: string | null
    body: any
    clientIp: string | null
}

// A zone's `threats` count is requests Cloudflare IDENTIFIED AND ACTED ON —
// blocked, challenged, or filtered. It is the "threats stopped" figure, so a
// high or rising number means the edge did its job, not that the site is
// unhealthy. It is shown on the card and drives the sparkline; it deliberately
// does NOT affect status.
//
// A median-relative spike heuristic used to warn here and got it backwards in
// practice. Being relative to each zone's own baseline, it stayed silent on the
// zone taking 233k threats a day (that is its normal) while firing on quiet
// personal domains going from 5 to 762, which is ordinary background radiation.
// Four of twenty zones sat amber for having been successfully defended.
//
// The signal that means something is events getting THROUGH the edge, which is
// what wafPressure below measures. That needs firewallEventsAdaptiveGroups, so
// it only works on Pro+ zones — on a Free zone there is no way to distinguish
// mitigated from unmitigated, and the honest answer is to report no security
// signal rather than the wrong one.

// WAF pressure: the worker's fetchZoneSecurity aggregate reports firewall events
// and how many were mitigated. Events getting THROUGH the edge (total - mitigated)
// mean an active attack the WAF isn't stopping — the CF-side complement to the
// host log-watcher. Floor avoids alarming on normal low-volume noise.
const WAF_THROUGH_FLOOR = 500   // unmitigated events in the window before alerting
const WAF_THROUGH_RATIO = 0.5   // ...and at least half of all events got through
// Aggregated firewall events can't see per-path (batch/v1, xmlrpc) — that
// resolution comes from the host LogWatchPlugin. This is a volume/bypass signal.
function wafPressure(domain: any): { through: number; total: number; topRule: string | null } | null {
    const sec = domain?.security
    if (!sec) return null
    const total = Number(sec.totalEvents) || 0
    const mitigated = Number(sec.mitigated) || 0
    const through = Math.max(0, total - mitigated)
    if (through < WAF_THROUGH_FLOOR) return null
    if (total > 0 && through / total < WAF_THROUGH_RATIO) return null
    const tr = Array.isArray(sec.topRules) && sec.topRules[0] ? sec.topRules[0] : null
    return { through, total, topRule: tr ? String(tr.ruleId || tr.source || "") : null }
}

// Traffic quality: composition, not volume. Ad revenue degrades with no outage
// and no traffic drop — automated traffic dilutes the inventory and RPM halves
// while every uptime signal stays green. The worker computes the shares; this
// only decides whether a human should look. Two shapes caught every 2026
// incident on a customer site: one foreign geography taking over the mix
// (Singapore 0.5% -> 70% of pageviews), or one network doing the same
// (AS45102 was 98% of Singapore). Volume was flat through both.
function trafficQualityFinding(domain: any): { level: 'warning' | 'error'; reason: string } | null {
    const tq = domain?.trafficQuality
    if (!tq || tq.unavailable || tq.error) return null
    // The worker already applied the thresholds; trust its verdict so the
    // numbers in the alert match the numbers on the tile.
    const a = tq.alert
    if (!a || !a.reason) return null
    return { level: a.level === 'error' ? 'error' : 'warning', reason: String(a.reason) }
}

// Cloudflare Pages deployment states. "active"/"building"/etc. mean a build is
// IN PROGRESS (transient, normal) — not a failure. Only genuine failed/canceled
// stages or statuses should raise a warning.
const DEPLOY_FAILED = ["failure", "error", "canceled", "cancelled"]
const DEPLOY_INPROGRESS = ["active", "building", "deploying", "initializing", "queued", "running"]

function deploymentFailure(deployment: any): string | null {
    if (!deployment) return null
    const stages = Array.isArray(deployment.stages) ? deployment.stages : []
    const failed = stages.find((s: any) => DEPLOY_FAILED.includes(String(s.status).toLowerCase()))
    if (failed) return `Build failed at ${failed.name} stage`
    const st = String(deployment.status || deployment.latest_stage?.status || "").toLowerCase()
    if (DEPLOY_FAILED.includes(st)) return `Deployment ${st}`
    return null
}

function deploymentInProgress(deployment: any): boolean {
    if (!deployment) return false
    const st = String(deployment.status || deployment.latest_stage?.status || "").toLowerCase()
    if (DEPLOY_INPROGRESS.includes(st)) return true
    const stages = Array.isArray(deployment.stages) ? deployment.stages : []
    return stages.some((s: any) => DEPLOY_INPROGRESS.includes(String(s.status).toLowerCase()))
}

// Marker for records this endpoint retired on its own, so a resource that comes
// back can be un-retired without disturbing anything the user archived by hand.
const RETIRED = "retired"

/**
 * Retire per-resource records whose resource no longer exists at Cloudflare.
 *
 * Detailed data arrives in modulo shards, so "absent from this push" on its own
 * proves nothing — which is why deleted Pages projects and Workers used to sit
 * on the dashboard until the staleness rule painted them OFFLINE. The reporter's
 * `inventory` block carries the full, unsharded list, and only that list is
 * trusted here: `complete: false` (a failed list call) means do nothing rather
 * than wipe out every record for the account.
 *
 * Runs before the push is written so a resource that reappears is un-retired
 * first and then refreshed by the usual upsert.
 */
async function reconcileInventory(
    client: any,
    systemId: string,
    type: string,
    prefix: string,
    entry: any,
    account: string,
    alias: string,
): Promise<void> {
    if (!entry || entry.complete !== true) return
    const present = Array.isArray(entry.ids) ? entry.ids : Array.isArray(entry.scripts) ? entry.scripts : null
    if (!present) return
    const keep = new Set(present.map((v: any) => `${prefix}${v}`))

    // Scoped to the reporter that owns these records: several workers can push
    // to one system (different accounts, or PROJECT_NAMES-limited groups under
    // the same alias), and each one's inventory only describes its own slice.
    const { data: rows, error } = await client
        .from("client_states")
        .select("id, unique_id, archived, status")
        .eq("system_id", systemId)
        .eq("type", type)
        .eq("data->>account", account)
        .eq("data->>alias", alias)
    if (error || !rows) return

    const gone = rows.filter((r: any) => !keep.has(r.unique_id) && !r.archived).map((r: any) => r.id)
    if (gone.length) {
        console.log(`Retiring ${gone.length} ${type} record(s) no longer present at Cloudflare`)
        await client
            .from("client_states")
            .update({ archived: true, status: RETIRED, status_reason: "No longer present at Cloudflare" })
            .in("id", gone)
    }

    // Recreated at Cloudflare — bring back only what this endpoint retired.
    const returned = rows.filter((r: any) => keep.has(r.unique_id) && r.archived && r.status === RETIRED).map((r: any) => r.id)
    if (returned.length) {
        await client.from("client_states").update({ archived: false, status_reason: null }).in("id", returned)
    }
}

export async function cloudflarePush(client: Db, ctx: FleetCtx, req: CloudflarePushRequest) {
        const body = req.body
        // Stored as jsonb on every push, in the state row and in history.
        if (JSON.stringify(body ?? null).length > 8_388_608) {
            throw new HttpError(413, "Too large for a Cloudflare push")
        }
        const headers = req.headers
        // The reporter sends the key both ways; Bearer is what this route always read.
        const reportingKey = headers["authorization"]?.replace("Bearer ", "") || headers["x-system-key"] || ""
        const deploymentAlias = headers["x-deployment-alias"] || body.alias || "cloudflare"
        const clientIp = req.clientIp
        const aliasQuery = req.alias || deploymentAlias

        // Validate reporting key
        if (!reportingKey) {
            throw new HttpError(401, "Missing or invalid reporting key")
        }

        // Validate body has required fields
        if (!body.timestamp || !body.account) {
            throw new HttpError(400, "Invalid request body, missing required fields")
        }

        // Find system by key (reporting key)
        const { system: found, error: systemError } = await findSystemByKey(client, reportingKey, 'id, name, user_id')
        const systems = found ? [found] : []

        if (systemError) {
            throw new HttpError(500, systemError.message)
        }

        if (!systems || systems.length === 0) {
            throw new HttpError(404, "System not found with provided reporting key")
        }

        const system = systems[0]
        // ponytail: no module check yet; see the note in ingest.ts.
        const uniqueId = `cf-${body.account}-${aliasQuery}`

        // Reconcile against the reporter's full inventory before writing this
        // push, so anything deleted at Cloudflare stops being shown and anything
        // recreated is brought back and then refreshed below. Reporters older
        // than the inventory block send no `inventory` and are left alone.
        if (body.inventory) {
            const invAlias = body.alias || "cloudflare"
            // Three kinds of record, none touching another's: together.
            await Promise.all([
                reconcileInventory(client, system.id, "cloudflare-project", "cf-project-", body.inventory.pages, body.account, invAlias),
                reconcileInventory(client, system.id, "cloudflare-worker-script", "cf-worker-script-", body.inventory.workers, body.account, invAlias),
                reconcileInventory(client, system.id, "cloudflare-domain", "cf-domain-", body.inventory.zones, body.account, invAlias),
            ])
        }

        // Determine system status based on data
        let systemStatus = "online"
        let statusReason = null

        // The account rollup judges only what every push carries in full. Pages
        // projects and zones arrive in modulo shards, so judging them here meant
        // "not active" whenever a push held the zone and "fine" whenever it
        // didn't: one pending zone raised and resolved this alert 239 times a
        // day. Zones and projects are judged on their own rows below, only when
        // they are in the push. Workers come from byScript, which is complete.
        // Check Workers status if available
        const workersReason = workersIssue(body.workers)
        if (workersReason && systemStatus !== "error") {
            systemStatus = "warning";
            statusReason = statusReason || workersReason;
        }

        // Every project, worker and zone in the push is written at the end, in
        // one write per table: one at a time, an account of 26 zones and 22
        // workers was over 150 round trips from the edge to the cluster, every
        // five minutes. Alerts are sent once the rows are in, and closed in one
        // query per kind.
        const stateRows = new Map<string, Record<string, unknown>>()
        const historyRows: Record<string, unknown>[] = []
        const dailyRows = new Map<string, Record<string, unknown>>()
        const probeRows: Record<string, unknown>[] = []
        const alerts: Parameters<typeof notify>[1][] = []
        const toResolve: Record<string, string[]> = {}
        const resolve = (source: string, detail: string) => { (toResolve[source] ||= []).push(detail) }
        /** A service's row and its history row, for the writes at the end. */
        const put = (unique_id: string, type: string, data: unknown, status: string, status_reason: string | null) => {
            const at = new Date().toISOString()
            stateRows.set(unique_id, { unique_id, system_id: system.id, type, data, status, status_reason, client_ip: clientIp, updated_at: at })
            historyRows.push({ unique_id, system_id: system.id, type, data, status, created_at: at })
        }

        // Store a summary record for the account with minimal data (no projects array)
        const summaryData = {
            account: body.account,
            alias: body.alias || 'cloudflare',
            timestamp: body.timestamp,
            pages: {
                summary: body.pages?.summary || {},
                // The Functions scripts Cloudflare reported for the account (or why
                // it couldn't), to check a project that matched none against them.
                ...(Array.isArray(body.pages?.functionScripts) ? { functionScripts: body.pages.functionScripts.slice(0, 50) } : {}),
                ...(body.pages?.functionsError ? { functionsError: String(body.pages.functionsError).slice(0, 300) } : {}),
            },
            zones: body.zones,
            workers: body.workers ? {
                summary: body.workers.summary || {},
                analytics: body.workers.analytics?.summary || null,
                // Per-script requests/errors, so the account card can show WHICH
                // worker is erroring rather than just a total.
                byScript: Array.isArray(body.workers.byScript) ? body.workers.byScript : undefined
            } : undefined
        };
        
        // Store client state record for the account summary 
        const { data: clientState, error: clientStateError } = await client
            .from('client_states')
            .upsert({
                unique_id: uniqueId,
                system_id: system.id,
                type: "cloudflare-account", // Changed to differentiate from projects
                data: summaryData,
                status: systemStatus,
                status_reason: statusReason,
                client_ip: clientIp,
                updated_at: new Date().toISOString()
            }, {
                onConflict: 'unique_id, system_id',
                returning: 'representation'
            })

        if (clientStateError) {
            throw new HttpError(500, clientStateError.message)
        }

        // Store historic data for the account (summary only), with the rest
        historyRows.push({
            unique_id: uniqueId,
            system_id: system.id,
            type: "cloudflare-account", // Changed to differentiate from projects
            data: summaryData,
            status: systemStatus,
            created_at: new Date().toISOString()
        })
            
        // Now create per-project records if we have pages projects
        if (body.pages?.projects) {
            // Sort projects alphabetically by name
            const sortedProjects = [...body.pages.projects].sort((a, b) => {
                const nameA = a.name?.toLowerCase() || '';
                const nameB = b.name?.toLowerCase() || '';
                return nameA.localeCompare(nameB);
            });
            
            for (const project of sortedProjects) {
                const projectUniqueId = `cf-project-${project.id}`;
                const deployment = project.latest_deployment;
                
                let projectStatus = 'online';
                let projectStatusReason = null;

                // Warn only on a genuine build failure; an in-progress build is
                // normal (shown as "Deployment in progress", not a warning).
                if (deployment) {
                    const failReason = deploymentFailure(deployment);
                    if (failReason) {
                        projectStatus = 'warning';
                        projectStatusReason = failReason;
                    } else if (deploymentInProgress(deployment)) {
                        projectStatusReason = 'Deployment in progress';
                    }
                }
                
                // Alert per project, judged only when the project is in this push.
                const failed = deployment ? deploymentFailure(deployment) : null
                if (failed) {
                    alerts.push({
                        client, system,
                        title: `${system.name}: ${project.name} deployment failed`,
                        message: `${project.name}: ${failed}`,
                        type: 'warning',
                        source: 'cloudflare-project',
                        sourceDetail: `cf-pages:${project.id}`,
                    })
                } else {
                    resolve('cloudflare-project', `cf-pages:${project.id}`)
                }

                // Create project-specific data structure
                const projectData = {
                    account: body.account,
                    alias: body.alias || 'cloudflare',
                    timestamp: body.timestamp,
                    project: project
                };
                
                put(projectUniqueId, "cloudflare-project", projectData, projectStatus, projectStatusReason)
            }
        }
        
        // Process Workers data if available
        if (body.workers && body.workers.scripts) {
            // Create Workers record for the aggregate view
            const workersUniqueId = `cf-workers-${body.account}`;
            
            // Determine Workers status
            let workersStatus = 'online';
            let workersStatusReason = null;
            
            // Check for errors — same rule as the account status above.
            if (workersReason) {
                workersStatus = 'warning';
                workersStatusReason = workersReason;
            }
            
            // Create Workers data structure
            const workersData = {
                account: body.account,
                alias: body.alias || 'cloudflare',
                timestamp: body.timestamp,
                workers: body.workers
            };
            
            put(workersUniqueId, "cloudflare-workers", workersData, workersStatus, workersStatusReason)
                
            // Individual Worker scripts as first-class services.
            //
            // Driven by `byScript` (the GraphQL per-script analytics), NOT
            // `scripts`: the collector shards `scripts` by modulo, so it only
            // carries ~1/N of the workers per push — records built from it would
            // rotate in and out and flap OFFLINE on the staleness rule. byScript
            // covers every script on every push. `scripts` still supplies
            // metadata when that worker happens to be in this run's shard.
            const byScript: any[] = Array.isArray(body.workers.byScript) ? body.workers.byScript : []
            const scriptMeta = new Map<string, any>(
                (Array.isArray(body.workers.scripts) ? body.workers.scripts : [])
                    .map((s: any) => [String(s.id || s.name), s]),
            )
            // A push details only its shard's scripts but counts every one, so
            // a script outside the shard lost its deployments and usage every
            // other push, and its tower forgot when it was last deployed. Those
            // carry over from the script's last record until its shard comes round.
            const carried = new Map<string, any>()
            const names = [
                ...(Array.isArray(body.workers.byScript) ? body.workers.byScript.map((r: any) => r?.script) : []),
                ...(Array.isArray(body.inventory?.workers?.scripts) ? body.inventory.workers.scripts : []),
            ]
            const unsharded = [...new Set(names.map((n: any) => String(n || '').trim()))].filter((n) => n && !scriptMeta.has(n))
            if (unsharded.length) {
                const { data: prev } = await client
                    .from("client_states")
                    .select("unique_id, deps:data->script->recent_deployments, usage:data->script->usage")
                    .eq("system_id", system.id)
                    .in("unique_id", unsharded.map((n: string) => `cf-worker-script-${n}`))
                for (const r of (prev || []) as any[]) {
                    if (r.deps || r.usage) carried.set(String(r.unique_id).slice("cf-worker-script-".length), { ...(r.deps ? { recent_deployments: r.deps } : {}), ...(r.usage ? { usage: r.usage } : {}) })
                }
            }

            // byScript only lists workers that RAN. A worker with no traffic is
            // absent from it entirely, so its record simply stops updating and
            // freezes at whatever it last did — one sat untouched for 17 days
            // still showing its final reading. Workers that have never had
            // traffic in a window never got a record at all: 13 deployed, 9 on
            // the dashboard.
            //
            // The inventory carries every deployed worker, so fill the gap with
            // explicit zeroes. A deployed worker serving nothing is a fact worth
            // showing, and it is very different from a worker we stopped hearing
            // about. Gated on `complete` for the same reason as reconciliation:
            // a failed list call must not invent records.
            const inv = body.inventory?.workers
            const inventoryScripts: string[] = inv?.complete === true && Array.isArray(inv.scripts) ? inv.scripts : []
            const reported = new Set(byScript.map((r: any) => String(r?.script || '').trim()).filter(Boolean))
            const idleRows = inventoryScripts
                .map((n: any) => String(n || '').trim())
                .filter((n) => n && !reported.has(n) && !SENTINEL_SCRIPTS.has(n.toLowerCase()))
                .map((script) => ({ script, requests: 0, errors: 0, recentRequests: 0, recentErrors: 0 }))
            if (idleRows.length) {
                console.log(`Seeding ${idleRows.length} deployed worker(s) with no traffic in the window`)
            }

            for (const row of [...byScript, ...idleRows]) {
                const name = String(row?.script || '').trim()
                if (!name) continue
                // Cloudflare buckets invocations it can't attribute to a script
                // under the sentinel "__unknown__" (deleted workers, preview
                // deployments). It counts toward the account totals but it isn't
                // a Worker, so it must not become a service.
                if (SENTINEL_SCRIPTS.has(name.toLowerCase())) continue
                const errors = Number(row.errors) || 0
                const requests = Number(row.requests) || 0

                // Health is judged on the RECENT window, not the 24h totals. A
                // single error sits inside a 24h sum for a full day, so a worker
                // that has just been fixed keeps reading degraded with no way to
                // say otherwise — the status should answer "is it erroring now".
                // The 24h numbers stay on the record for the card to display.
                //
                // Reporters older than this send no recent window; for them, fall
                // back to the 24h behaviour rather than silently calling every
                // worker healthy.
                const hasRecent = row.recentErrors !== undefined
                const recentErrors = Number(row.recentErrors) || 0
                const recentRequests = Number(row.recentRequests) || 0
                const mins = Number(row.recentWindowMinutes) || 60

                let scriptStatus = 'online'
                let scriptStatusReason: string | null = null
                if (hasRecent ? recentErrors > 0 : errors > 0) {
                    scriptStatus = 'warning'
                    scriptStatusReason = hasRecent
                        ? `Worker errors: ${recentErrors}${recentRequests ? ` of ${recentRequests} requests` : ''} in the last ${mins}m`
                        : `Worker errors: ${errors}${requests ? ` of ${requests} requests` : ''}`
                }

                const scriptData = {
                    account: body.account,
                    alias: body.alias || 'cloudflare',
                    timestamp: body.timestamp,
                    script: {
                        id: name,
                        name,
                        ...(scriptMeta.get(name) || carried.get(name) || {}),
                        requests,
                        errors,
                        // Present only from reporters that send the recent window.
                        ...(hasRecent ? { recentRequests, recentErrors, recentWindowMinutes: mins } : {}),
                        // CPU time per request (ms) and failures by kind, from reporters that send them.
                        ...(row.cpuP50 != null ? { cpuP50: row.cpuP50, cpuP99: row.cpuP99 } : {}),
                        ...(row.outcomes ? { outcomes: row.outcomes } : {}),
                    },
                }

                put(`cf-worker-script-${name}`, "cloudflare-worker-script", scriptData, scriptStatus, scriptStatusReason)
            }
        }
        
        // Process domain data if available
        if (body.domains && Array.isArray(body.domains)) {
            for (const domain of body.domains) {
                if (!domain.id) continue
                // The reporter couldn't read this zone ("Network connection
                // lost.", a 400 from its auth fallback): `{ id, error }` and no
                // name. That says nothing about the zone. Judging it paged CRIT
                // under a bare zone id and overwrote the zone's last good record.
                // Leave the record alone; if reads keep failing, the staleness
                // rule paints it OFFLINE.
                if (domain.error) {
                    console.warn(`cloudflare: skipping zone ${domain.id}, reporter could not read it: ${domain.error}`)
                    continue
                }

                const domainUniqueId = `cf-domain-${domain.id}`;
                
                // Determine domain status
                // Pending means Cloudflare is waiting for the nameservers to move:
                // nothing is broken yet. Moved or deactivated means traffic is
                // no longer going through Cloudflare at all.
                const zoneActive = domain.status === 'active'
                const zoneWaiting = ['pending', 'initializing'].includes(String(domain.status))
                let domainStatus = zoneActive ? 'online' : zoneWaiting ? 'warning' : 'error';
                let domainStatusReason = zoneActive ? null
                    : zoneWaiting ? `Zone ${domain.status}: waiting for its nameservers to point at Cloudflare`
                    : `Zone ${domain.status}`;
                
                // Threat COUNT is not a health signal (see the note at the top of
                // this file) — only events getting through the edge are.
                let wafFinding: { through: number; total: number; topRule: string | null } | null = null
                if (domainStatus === 'online') {
                    wafFinding = wafPressure(domain)
                    if (wafFinding) {
                        domainStatus = 'warning'
                        domainStatusReason = `WAF: ${wafFinding.through} unmitigated firewall events${wafFinding.topRule ? ` · top rule ${wafFinding.topRule}` : ''}`
                    }
                    // Traffic quality outranks WAF pressure in the status line:
                    // a zone can be fully mitigated and still be monetising junk.
                    // It is never more than a warning on the zone, whatever level
                    // the worker gave it: the site is up and serving, and a red
                    // zone should mean it isn't. This branch only runs for an
                    // online zone, so there is no error to preserve.
                    const tqFinding = trafficQualityFinding(domain)
                    if (tqFinding) {
                        domainStatus = 'warning'
                        domainStatusReason = `Traffic quality: ${tqFinding.reason}`
                    }
                }
                
                // Create domain-specific data structure with proper nesting
                const domainData = {
                    account: body.account,
                    alias: body.alias || 'cloudflare',
                    timestamp: body.timestamp,
                    domain: domain
                };
                
                put(domainUniqueId, "cloudflare-domain", domainData, domainStatus, domainStatusReason)

                // Accumulate the zone's daily traffic. The worker only ever sends
                // a rolling 30 days (that's Cloudflare's own window for
                // httpRequests1dGroups), so the only way to see a longer span is
                // to keep each day as it goes past. Upserting the whole window
                // every push also repairs days we missed while the worker was
                // down, and re-settles today's still-growing counts.
                // Probes come hourly and only for today. They get their own upsert:
                // in one batch with the traffic rows, every past day would be
                // written back with these columns null.
                if (typeof domain.probes?.total === 'number') {
                    probeRows.push({
                        system_id: system.id,
                        unique_id: domainUniqueId,
                        day: new Date().toISOString().slice(0, 10),
                        zone: domain.name || null,
                        probes: domain.probes.total,
                        probes_cms: Number(domain.probes.cms) || 0,
                        probes_served: Number(domain.probes.served) || 0,
                        probe_paths: Array.isArray(domain.probes.paths) ? domain.probes.paths : [],
                    })
                }
                const daily = Array.isArray(domain.detailedAnalytics?.timeseries)
                    ? domain.detailedAnalytics.timeseries
                    : []
                for (const t of daily) {
                    if (!t?.timestamp) continue
                    const day = String(t.timestamp).slice(0, 10)
                    // Keyed as the table is, so a day twice in one push is one row.
                    dailyRows.set(`${domainUniqueId}|${day}`, {
                        system_id: system.id,
                        unique_id: domainUniqueId,
                        day,
                        zone: domain.name || null,
                        requests: Number(t.requests) || 0,
                        bandwidth: Number(t.bandwidth) || 0,
                        threats: Number(t.threats) || 0,
                        uniques: Number(t.uniques) || 0,
                        updated_at: new Date().toISOString(),
                    })
                }

                // Per-domain WAF-pressure notification, deduped on a stable
                // per-domain key so each affected zone alerts independently of the
                // rollup Cloudflare notification below.
                // Zone state, judged only when the zone is in this push. Its own
                // source, so an open zone alert can't swallow the account rollup's
                // alert, which dedupes on source and severity.
                const zoneLabel = domain.name || domain.id
                if (!zoneActive) {
                    alerts.push({
                        client, system,
                        title: `${system.name}: ${zoneLabel} zone ${domain.status}`,
                        message: `${zoneLabel}: ${domainStatusReason}`,
                        type: zoneWaiting ? 'warning' : 'error',
                        source: 'cloudflare-domain',
                        sourceDetail: `cf-zone:${domain.id}`,
                    })
                } else {
                    resolve('cloudflare-domain', `cf-zone:${domain.id}`)
                }

                if (wafFinding) {
                    alerts.push({
                        client,
                        system,
                        title: `${system.name}: WAF bypass · ${zoneLabel}`,
                        message: `${zoneLabel}: ${wafFinding.through} of ${wafFinding.total} firewall events reached the origin${wafFinding.topRule ? ` (top rule ${wafFinding.topRule})` : ''}`,
                        type: 'warning',
                        source: 'cloudflare-domain',
                        sourceDetail: `cf-waf:${domain.id}`,
                    })
                } else {
                    // WAF alerts used to be filed under "cloudflare" and nothing
                    // ever closed them. Close both kinds once the zone is clean.
                    resolve('cloudflare-domain', `cf-waf:${domain.id}`)
                    resolve('cloudflare', `cf-waf:${domain.id}`)
                }
            }
        }

        // The writes, one per table, together, and the system's own row: its
        // status when the account has a problem, else that it was just seen.
        const now = new Date().toISOString()
        const [states, history, daily, probes] = await Promise.all([
            stateRows.size ? client.from('client_states').upsert([...stateRows.values()], { onConflict: 'unique_id, system_id' }) : null,
            historyRows.length ? client.from('client_state_history').insert(historyRows) : null,
            dailyRows.size ? client.from('cf_zone_daily').upsert([...dailyRows.values()], { onConflict: 'system_id, unique_id, day' }) : null,
            probeRows.length ? client.from('cf_zone_daily').upsert(probeRows, { onConflict: 'system_id, unique_id, day' }) : null,
            client
                .from('systems')
                // os: a JSON object for Cloudflare systems.
                .update(systemStatus !== "online"
                    ? { status: systemStatus, status_reason: statusReason, last_seen: now, last_updated: now, os: { type: "other", name: "Cloudflare" } }
                    : { last_seen: now, os: { type: "other", name: "Cloudflare" } })
                .eq('id', system.id),
        ])
        if (states?.error) console.error("cloudflare: client_states upsert failed:", states.error.message)
        if (history?.error) console.error("cloudflare: history insert failed:", history.error.message)
        if (daily?.error) console.error("cloudflare: cf_zone_daily upsert failed:", daily.error.message)
        if (probes?.error) console.error("cloudflare: probe upsert failed:", probes.error.message)
        if (systemStatus !== "online") {
            // One open alert per severity for the account as a whole: the reason
            // text changes from push to push, so deduping on it would nag.
            alerts.push({
                client,
                system,
                title: `${system.name}: ${statusReason || 'Cloudflare issue detected'}`,
                message: `Cloudflare: ${statusReason || 'An issue was detected with your Cloudflare services'}`,
                type: systemStatus === "warning" ? "warning" : "error",
                source: "cloudflare",
                sourceDetail: uniqueId,
                dedupeOn: "type",
            })
        } else {
            // Recovered: close any open Cloudflare alert for this account, so a
            // resolved issue stops reading as current.
            resolve("cloudflare", uniqueId)
        }
        // Alerts once the rows they describe are in; a new one is rare, so in
        // turn. Then everything that's clear closed, one query per kind.
        for (const a of alerts) await notify(ctx, a)
        await Promise.all(Object.entries(toResolve).map(([source, details]) => resolveNotifications(ctx, client, system, source, details)))

        return {
            success: true,
            message: "Cloudflare data received and processed",
            status: systemStatus,
            clientState: clientState
        }
}
