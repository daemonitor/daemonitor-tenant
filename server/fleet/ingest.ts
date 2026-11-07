/**
 * An agent's report, judged and stored. Moved from the frontend's
 * server/api/clientstate/update.put.ts with its logic unchanged: only the
 * database client, the request plumbing and the module check differ.
 */
import { supabaseStatus } from "~/server/utils/supabase"
import { webThrottled } from "~/utils/fleet"
import { deviceFaultHeld } from "~/utils/deviceAlert"
import { findSystemByKey } from "./keys"
import { notify, resolveNotifications, resolveClearedFindings } from "./notify"
import { getClusterContexts, findClusterRules, runClusterEvaluations } from "./clusters"
import { applyPatroniLeader, patroniStatus, lagSustained } from "./patroni"
import { HttpError, type FleetCtx } from "./ctx"
import type { Db } from "./db"

export interface IngestRequest {
    /** Request headers, lower-cased. */
    headers: Record<string, string | undefined>
    body: any
    clientIp: string | null
}

/** Types that are not written to client_state_history (see the insert below). */
const SELF_HISTORIED = new Set(["adsense", "ga4", "cost"])

export async function ingest(client: Db, ctx: FleetCtx, req: IngestRequest) {
        const body = req.body
        // Stored as jsonb on every push, in the state row and in history.
        if (JSON.stringify(body ?? null).length > 1_048_576) {
            throw new HttpError(413, "Too large for a report")
        }
        const headers = req.headers
        const systemKey = headers["x-system-key"]
        const uniqueId = headers["x-unique-id"]
        // Normalize type to lowercase so it matches the frontend adapter's
        // switch (pm2, docker, lxc, ...) regardless of the client's casing.
        const dataType = headers["x-type"] ? String(headers["x-type"]).toLowerCase() : headers["x-type"]
        const clientIp = req.clientIp

        // Validate required headers
        if (!systemKey) {
            throw new HttpError(400, "Missing system key")
        }

        if (!uniqueId) {
            throw new HttpError(400, "Missing unique id")
        }

        if (!dataType) {
            throw new HttpError(400, "Missing data type")
        }

        // Find system by key. `name` is needed for notification titles and the
        // lxc fan-out host fallback; without it those render "undefined".
        const { system: found, error: systemError } = await findSystemByKey(client, systemKey, 'id, user_id, name')
        const systems = found ? [found] : []

        if (systemError) {
            throw new HttpError(500, systemError.message)
        }

        if (!systems || systems.length === 0) {
            throw new HttpError(404, "System not found")
        }

        const system = systems[0]

        // ponytail: no module check yet. It comes back as a signed entitlement
        // fetched from daemonitor.com (see the migration plan, "Modules").

        // Cluster membership, if this host has any. Read before the status switch
        // because it changes how this row is judged, not just what happens to the
        // verdict afterwards.
        const clusterContexts = await getClusterContexts(client, system.id)
        const clusterRules = clusterContexts.length
            ? findClusterRules(clusterContexts, dataType, uniqueId)
            : []
        // A rule with no container names the whole row, so the cluster speaks for
        // all of it. Rules that name containers claim only those.
        const wholeRowClustered = clusterRules.some((r) => !r.svc.match_container)
        const clusteredContainers = new Set(
            clusterRules.map((r) => r.svc.match_container).filter(Boolean) as string[],
        )

        // Determine system status based on data
        let systemStatus = "online"
        let statusReason = null

        // Security detection produces DISCRETE findings (one WP has several
        // independent problems; one access-log window trips several rules). The
        // legacy path collapses all of a (system, type, source) into a single
        // notification, so a second distinct problem is silently suppressed by
        // the dedup guard. Cases push individual findings here; each becomes its
        // own notification keyed by a stable fingerprint (`key`) so distinct
        // issues coexist and re-alert only after the previous one has resolved.
        type Finding = { key: string; type: "info" | "warning" | "error"; title: string; message: string; detail?: Record<string, string | string[]> }
        const findings: Finding[] = []
        const addFinding = (f: Finding) => {
            if (findings.length < 50 && !findings.some((x) => x.key === f.key)) findings.push(f)
        }

        // Process different monitoring data types
        switch (dataType) {
            case "os":
                // Check if CPU or memory exceeds thresholds
                if (body.cpu && body.cpu > 90) {
                    systemStatus = "warning"
                    statusReason = "CPU usage is high"
                }

                if (body.memory && body.memory.usedPercent > 90) {
                    systemStatus = "warning"
                    statusReason = "Memory usage is high"
                }

                // Update system OS info
                await client
                    .from('systems')
                    .update({
                        os: {
                            type: body.platform || body.type,
                            name: body.platform || body.type,
                            version: body.release || body.version,
                            arch: body.arch
                        },
                        ip_address: clientIp,
                        last_seen: new Date().toISOString(),
                        status: systemStatus,
                        status_reason: statusReason,
                        metrics: {
                            cpu: body.cpu,
                            memory: body.memory,
                            disk: body.disk
                        },
                        updated_at: new Date().toISOString()
                    })
                    .eq('id', system.id)
                break;

            case "pm2": {
                // The PM2 plugin sends one process per push (body.status), not a
                // processes[] array — reflect that single process's actual status.
                const st = String(body.status || "").toLowerCase()
                if (st && st !== "online") {
                    systemStatus = st === "errored" ? "error" : "warning"
                    statusReason = `${body.name || "process"} is ${st}`
                }
                break;
            }

            case "mongodb":
                // Check MongoDB connection status
                if (body.status !== "connected") {
                    systemStatus = "error"
                    statusReason = "MongoDB connection failed"
                }
                break;

            case "web":
            case "website": {
                // WebsitePlugin sends `ok` (already combining the public check
                // and, if configured, a direct origin check) plus per-tier
                // detail. Older producers may only send legacy error/responseTime
                // fields — support both without regressing either.
                //
                // NOTE: the "web" case didn't exist before this — client_states
                // for web checks always got systemStatus "online" regardless of
                // the check's actual result, since the switch fell through with
                // no match. STATUS/LATENCY still showed correctly (read straight
                // from cs.data by the frontend), but the service's health LED
                // and notifications never reflected a down site.
                const label = body.name || body.url || "site"
                // Security-relevant content checks come FIRST, because they are a
                // different (and higher-signal) failure mode than an outage: a
                // reachable page carrying a forbidden string is a likely
                // compromise (injected-script IOC, webshell marker), and a
                // reachable page MISSING an expected canary is likely defacement.
                // `evaluate()` already folds both into `ok`, so without this they
                // would surface as an opaque "check failed (HTTP 200)". Older
                // clients send only the boolean; newer ones send the matched list.
                const iocMatches: string[] = Array.isArray(body.matchedUnexpected) ? body.matchedUnexpected : []
                const missingCanaries: string[] = Array.isArray(body.missingExpected) ? body.missingExpected : []
                const originMatches: string[] = Array.isArray(body.origin?.matchedUnexpected) ? body.origin.matchedUnexpected : []
                if (body.error) {
                    systemStatus = "error"
                    statusReason = String(body.error).slice(0, 120)
                    addFinding({ key: `web:down:${label}`, type: "error", title: `${system.name}: ${label} unreachable`, message: statusReason })
                } else if (body.hasAnyUnexpectedStrings === true) {
                    systemStatus = "error"
                    statusReason = iocMatches.length
                        ? `Possible compromise on ${label}: forbidden content matched (${iocMatches.join(", ")})`.slice(0, 200)
                        : `Possible compromise on ${label}: forbidden content matched`
                    // Key on the matched IOCs so a NEW IOC appearing re-alerts even
                    // if an earlier compromise alert is still unread.
                    addFinding({ key: `web:ioc:${label}:${[...iocMatches].sort().join(",")}`, type: "error", title: `${system.name}: possible compromise · ${label}`, message: statusReason })
                } else if (body.hasAllExpectedStrings === false) {
                    systemStatus = "error"
                    statusReason = missingCanaries.length
                        ? `Possible defacement on ${label}: expected content missing (${missingCanaries.join(", ")})`.slice(0, 200)
                        : `Possible defacement on ${label}: expected content missing`
                    addFinding({ key: `web:deface:${label}:${[...missingCanaries].sort().join(",")}`, type: "error", title: `${system.name}: possible defacement · ${label}`, message: statusReason })
                } else if (body.ok === false && webThrottled(body.status)) {
                    systemStatus = "warning"
                    statusReason = `${label} is rate-limiting the checker (HTTP 429)`
                    addFinding({ key: `web:throttled:${label}`, type: "warning", title: `${system.name}: ${label} rate-limiting the checker`, message: statusReason })
                } else if (body.ok === false) {
                    systemStatus = "error"
                    statusReason = `${label} check failed (HTTP ${body.status ?? "—"})`
                    addFinding({ key: `web:fail:${label}`, type: "error", title: `${system.name}: ${label} check failed`, message: statusReason })
                } else if (body.origin && body.origin.hasAnyUnexpectedStrings === true) {
                    systemStatus = "error"
                    statusReason = originMatches.length
                        ? `Possible compromise at origin of ${label}: forbidden content matched (${originMatches.join(", ")})`.slice(0, 200)
                        : `Possible compromise at origin of ${label}: forbidden content matched`
                    addFinding({ key: `web:ioc-origin:${label}:${[...originMatches].sort().join(",")}`, type: "error", title: `${system.name}: possible origin compromise · ${label}`, message: statusReason })
                } else if (body.origin && body.origin.ok === false) {
                    // Public tier is fine (possibly served from CDN cache) but
                    // the origin itself is unreachable/failing — warn, since
                    // visitors aren't affected yet but the origin needs attention.
                    systemStatus = "warning"
                    statusReason = body.origin.error
                        ? `Origin unreachable: ${String(body.origin.error).slice(0, 100)}`
                        : `Origin check failed (HTTP ${body.origin.status ?? "—"})`
                    addFinding({ key: `web:origin-down:${label}`, type: "warning", title: `${system.name}: origin issue · ${label}`, message: statusReason })
                } else {
                    // Name the site and the number: "Website response time is
                    // high" on a client that watches twenty sites says nothing.
                    const ms = typeof body.responseTime === "number" ? body.responseTime
                        : typeof body.duration === "number" ? body.duration : null
                    if (ms !== null && ms > 5000) {
                        systemStatus = "warning"
                        statusReason = `${label} slow: ${Math.round(ms)}ms response`
                    }
                }
                break;
            }

            case "wordpress": {
                // Security-posture rules for the WordpressPlugin. The plugin only
                // reports current state; the new-admin / admin-demotion DIFFS are
                // computed HERE against the previously stored snapshot, so a
                // restarted agent can't reset the baseline and hide a change.
                const label = body.name || body.site || "WordPress"

                // Pull the prior snapshot BEFORE the generic upsert below
                // overwrites it. No prior row (or no admins recorded yet) = first
                // sighting: establish a baseline WITHOUT flagging every existing
                // admin as "new".
                const { data: priorRows } = await client
                    .from("client_states")
                    .select("data")
                    .eq("unique_id", uniqueId)
                    .eq("system_id", system.id)
                    .limit(1)
                const prior = priorRows?.[0]?.data as any | undefined
                // Only diff against a prior SUCCESSFUL, non-empty admin snapshot.
                // A prior poll that errored or saw zero admins (collection was
                // failing, or the site just came online) is NOT a baseline —
                // otherwise the empty→populated transition reports every existing
                // admin as "new". Every real WP has ≥1 admin, so an empty list
                // means "not collected", not "no admins".
                const priorOk = !!prior && !prior.adminsError && Array.isArray(prior.admins) && prior.admins.length > 0
                const prevAdmins: any[] | null = priorOk ? prior.admins : null

                const currAdmins: any[] = Array.isArray(body.admins) ? body.admins : []
                // Same rule for THIS poll, which is where it was missing: an
                // errored or empty list means "not collected", not "every admin
                // was deleted". Without it one failed collection reported the
                // whole admin table as removed/demoted — anjobs named all six of
                // its admins while all six were still there.
                const currOk = !body.adminsError && currAdmins.length > 0
                const loginOf = (a: any) => String(a?.login ?? "").toLowerCase()
                const prevLogins = new Set((prevAdmins || []).map(loginOf))
                const currLogins = new Set(currAdmins.map(loginOf))
                // Only meaningful once a baseline exists.
                const newAdmins = prevAdmins ? currAdmins.filter((a) => !prevLogins.has(loginOf(a))) : []
                const removedAdmins = prevAdmins && currOk ? [...prevLogins].filter((l) => l && !currLogins.has(l)) : []

                // The before/after an admin finding carries to its event page.
                // Removing every admin at once is the signature of a failed
                // collection rather than a real change, and the counts show it.
                const adminCounts = {
                    "Administrators before": String(prevAdmins?.length ?? 0),
                    "Administrators after": String(currAdmins.length),
                }

                const susp: any[] = Array.isArray(body.suspiciousAdmins) ? body.suspiciousAdmins : []
                const trashedCrit: any[] = Array.isArray(body.trashedCriticalPages) ? body.trashedCriticalPages : []
                const unknownMu: string[] = Array.isArray(body.unknownMuPlugins) ? body.unknownMuPlugins : []

                // Each detected problem is an INDEPENDENT finding (a WP host can
                // have a rogue admin AND a trashed login page AND a web-user
                // crontab at once) → one notification apiece, not just the top
                // one. The client_states row keeps the worst as its headline.
                const reasons: string[] = []
                if (body.error) {
                    addFinding({ key: `wp:error:${label}`, type: "error", title: `${system.name}: ${label} check error`, message: `${label}: ${String(body.error).slice(0, 120)}` })
                    reasons.push(String(body.error).slice(0, 80))
                }
                if (body.hasWebUserCrontab === true) {
                    const r = `${body.cronUser || "web user"} has a crontab (persistence)`
                    addFinding({ key: `wp:crontab:${label}:${body.cronUser || "web"}`, type: "error", title: `${system.name}: ${label} — web-user crontab`, message: `${label}: ${r}` })
                    reasons.push(r)
                }
                if (newAdmins.length) {
                    const logins = newAdmins.map((a) => a.login).join(", ")
                    // Key includes the logins so a further new admin re-alerts.
                    addFinding({
                        key: `wp:newadmin:${label}:${newAdmins.map((a) => loginOf(a)).sort().join(",")}`, type: "error",
                        title: `${system.name}: ${label} — new administrator`, message: `${label}: new administrator ${logins}`,
                        detail: {
                            "New administrators": newAdmins.map((a) => `${a.login} (user id ${a.id ?? "?"}, registered ${a.registered || "unknown"})`),
                            ...adminCounts,
                        },
                    })
                    reasons.push(`new admin ${logins}`)
                }
                for (const a of susp) {
                    addFinding({ key: `wp:svcadmin:${label}:${String(a.login).toLowerCase()}`, type: "error", title: `${system.name}: ${label} — service-account admin`, message: `${label}: service-account admin ${a.login} (${a.reason || "pattern"})`.slice(0, 200) })
                }
                if (susp.length) reasons.push(`service-account admin ${susp.map((a) => a.login).join(", ")}`)
                if (removedAdmins.length) {
                    addFinding({
                        key: `wp:demote:${label}:${[...removedAdmins].sort().join(",")}`, type: "error",
                        title: `${system.name}: ${label} — admin removed/demoted`, message: `${label}: administrator removed/demoted ${removedAdmins.join(", ")}`,
                        detail: {
                            "Removed or demoted": removedAdmins,
                            "Still administrators": currAdmins.map((a) => String(a.login)),
                            ...adminCounts,
                        },
                    })
                    reasons.push(`admin removed/demoted ${removedAdmins.join(", ")}`)
                }
                for (const p of trashedCrit) {
                    addFinding({ key: `wp:trashed:${label}:${p.slug || p.id || p.title}`, type: "error", title: `${system.name}: ${label} — critical page trashed`, message: `${label}: critical page trashed ${p.slug || p.title}`.slice(0, 200) })
                }
                if (trashedCrit.length) reasons.push(`critical page trashed ${trashedCrit.map((p) => p.slug || p.title).join(", ")}`)
                for (const f of unknownMu) {
                    addFinding({ key: `wp:muplugin:${label}:${f}`, type: "error", title: `${system.name}: ${label} — unknown mu-plugin`, message: `${label}: unknown mu-plugin ${f}`.slice(0, 200) })
                }
                if (unknownMu.length) reasons.push(`unknown mu-plugin ${unknownMu.join(", ")}`)

                if (findings.length) {
                    systemStatus = "error"
                    statusReason = `${label}: ${reasons.join("; ")}`.slice(0, 200)
                } else if (body.adminsError || body.cronError) {
                    // Every collector that could surface a security event failed —
                    // warn rather than report a false "clean".
                    systemStatus = "warning"
                    statusReason = `${label}: posture collection incomplete`
                }
                break
            }

            case "logwatch": {
                // Access-log watcher (LogWatchPlugin, host-side). The plugin tails
                // nginx/apache logs, applies the WordPress/xmlrpc/webshell rules,
                // and pushes a `findings[]` array of already-classified events —
                // the rule logic lives in the agent (it needs the raw lines), the
                // server just turns each finding into an alert. Each finding is
                // pre-keyed by the plugin for stable dedup.
                const src = body.name || body.source || "access log"
                const list: any[] = Array.isArray(body.findings) ? body.findings : []
                let worst: "warning" | "error" | null = null
                for (const f of list) {
                    const sev: "warning" | "error" = f?.severity === "warning" ? "warning" : "error"
                    if (sev === "error") worst = "error"
                    else if (!worst) worst = "warning"
                    const detail = String(f?.detail || f?.rule || "suspicious request").slice(0, 200)
                    addFinding({
                        key: `log:${f?.key || `${f?.rule}:${f?.ip || ""}:${f?.path || ""}`}`.slice(0, 180),
                        type: sev,
                        title: `${system.name}: ${f?.title || f?.rule || "log alert"} · ${src}`.slice(0, 160),
                        message: detail,
                        detail: Object.fromEntries(
                            [["Rule", f?.rule], ["IP", f?.ip], ["Path", f?.path], ["Log", src]]
                                .filter(([, v]) => v).map(([k, v]) => [k, String(v)]),
                        ),
                    })
                }
                if (worst) {
                    systemStatus = worst
                    statusReason = `${src}: ${list.length} finding${list.length === 1 ? "" : "s"} — ${String(list[0]?.detail || list[0]?.rule || "").slice(0, 140)}`.slice(0, 200)
                }
                break
            }

            case "appactivity": {
                // Sign-ups and logins (AppActivityPlugin). Only a sign-up from the
                // last 15 minutes alerts, so the first report isn't a month of them.
                // Once it ages out it stops being a finding and resolves.
                const label = body.name || "app"
                if (body.reachable === false) {
                    systemStatus = "warning"
                    statusReason = `${label}: activity unavailable: ${String(body.error || "no reason given").slice(0, 140)}`
                    break
                }
                const recent: any[] = Array.isArray(body.recent) ? body.recent : []
                for (const e of recent) {
                    if (e?.action !== "signup" || !(Date.now() - Date.parse(e.at) < 15 * 60 * 1000)) continue
                    addFinding({
                        key: `signup:${e.at}:${e.who}`.slice(0, 180),
                        type: "info",
                        title: `${label}: new signup`,
                        message: `${e.who}${e.provider ? ` via ${e.provider}` : ""}`.slice(0, 200),
                    })
                }
                break
            }

            case "netscan":
            case "netdevice": {
                // LAN device reachability from the netscan plugin (type is the
                // plugin name, "netscan"). Down = error; reachable-but-slow = warning.
                const label = body.name || body.ip || "device"
                if (body.up === false) {
                    systemStatus = "error"
                    statusReason = `${label} (${body.ip}) unreachable`
                } else if (typeof body.latency === "number" && body.latency > (Number(body.warnMs) || 200)) {
                    systemStatus = "warning"
                    statusReason = `${label}: high latency ${body.latency}ms`
                }
                break
            }

            case "snmp": {
                // SNMP monitor (printers). Unreachable/error → error; a supply
                // at/under its warn threshold, or a non-idle printer status →
                // warning.
                const label = body.name || body.ip || "device"
                const low: any[] = Array.isArray(body.lowSupplies) ? body.lowSupplies : []
                if (body.error) {
                    systemStatus = "error"
                    statusReason = `${label}: ${String(body.error).slice(0, 120)}`
                } else if (body.reachable === false) {
                    systemStatus = "error"
                    statusReason = `${label} (${body.ip}) SNMP unreachable`
                } else if (Array.isArray(body.badDisks) && body.badDisks.length) {
                    // QNAP: a failing/hot disk is a real problem.
                    systemStatus = "error"
                    statusReason = `${label}: disk ${body.badDisks.map((d: any) => `${d.descr || `slot ${d.slot}`}${d.smart ? ` ${d.smart}` : ""}${d.tempC ? ` ${d.tempC}C` : ""}`).join(", ")}`.slice(0, 200)
                } else if (Array.isArray(body.fullVolumes) && body.fullVolumes.length) {
                    systemStatus = "warning"
                    statusReason = `${label}: volume ${body.fullVolumes.map((v: any) => `${String(v.mount).split("/").pop()} ${v.pct}%`).join(", ")} full`.slice(0, 200)
                } else if (typeof body.cpuTempC === "number" && typeof body.tempWarnC === "number" && body.cpuTempC >= body.tempWarnC) {
                    systemStatus = "warning"
                    statusReason = `${label}: CPU ${body.cpuTempC}C`
                } else if (typeof body.memPct === "number" && body.memPct >= 90) {
                    systemStatus = "warning"
                    statusReason = `${label}: RAM ${body.memPct}%`
                } else if (low.length) {
                    systemStatus = "warning"
                    statusReason = `${label}: low ${low.map((s) => `${String(s.name).replace(/\s*(Cartridge|HP)\s*/gi, " ").trim()} ${s.pct}%`).join(", ")}`.slice(0, 200)
                } else if (body.status && !["idle", "printing", "warmup"].includes(String(body.status))) {
                    systemStatus = "warning"
                    statusReason = `${label}: ${body.status}`
                }
                break
            }

            case "ewelink":
                // Check EWeLink devices
                const hasOfflineDevice = body.devices?.some(device => device.status === "offline")

                if (hasOfflineDevice) {
                    systemStatus = "warning"
                    statusReason = "One or more EWeLink devices are offline"
                }
                break;

            case "docker":
            case "lxc": {
                // Container-group health: unhealthy or crashed (non-zero exit) => error;
                // any merely-stopped container => warning.
                const reported = Array.isArray(body.containers) ? body.containers : []
                // Containers a cluster rule claims are judged across the members,
                // not here — a follower's stopped renderer is correct. Only those
                // drop out: the rest of the project is still this host's problem,
                // so declaring the renderer a singleton doesn't quietly stop
                // anyone hearing about the admin container next to it.
                const containers = clusteredContainers.size
                    ? reported.filter((c: any) => !clusteredContainers.has(String(c.service || c.name || "")))
                    : reported
                const total = containers.length
                const project = body.project || body.name || "group"
                const bad = containers.filter((c: any) =>
                    String(c.health || "").toLowerCase() === "unhealthy" ||
                    (!c.running && (Number(c.exitCode) || 0) !== 0)
                )
                const stopped = containers.filter((c: any) => !c.running && !bad.includes(c))

                // Name the container and say what is wrong with it. "1/13
                // containers unhealthy" counts the problem and discards every
                // field that would let someone act on it — which one, how long
                // it has been up, whether it is crash-looping. All of that is
                // already in the payload.
                const describe = (c: any): string => {
                    const name = String(c.service || c.name || "container")
                    const restarts = Number(c.restarts) || 0
                    const loop = restarts > 2 ? `, ${restarts} restarts` : ""
                    if (String(c.health || "").toLowerCase() === "unhealthy") {
                        // The healthcheck's own output when there is one. Plenty of
                        // checks print nothing at all (supabase-meta among them), and
                        // for those there is genuinely no "why" to report — so say
                        // the short true thing rather than padding it out. The old
                        // fallback appended docker's status string and produced
                        // "meta unhealthy (Up 5 weeks (unhealthy))": uptime dressed
                        // up as a diagnosis, with the word repeated inside its own
                        // brackets. Worse than saying nothing.
                        const why = String(c.healthOutput || "").trim()
                        const streak = Number(c.healthFailingStreak) || 0
                        const checks = streak > 1 ? ` after ${streak} failed checks` : ""
                        if (why) return `${name} unhealthy${checks}: ${why}`
                        // No output means docker killed the check for exceeding
                        // its timeout — it never got to print anything. That is
                        // the difference between "the service answered wrong" and
                        // "the box was too busy to answer in time", and on a
                        // loaded host it is nearly always the latter.
                        const code = Number(c.healthExitCode)
                        if (code === -1) return `${name} unhealthy${checks}: healthcheck timed out`
                        if (code) return `${name} unhealthy${checks}: healthcheck exit ${code}`
                        return `${name} unhealthy${checks}${loop}`
                    }
                    if (!c.running) {
                        const code = Number(c.exitCode) || 0
                        return code !== 0 ? `${name} exited (code ${code})${loop}` : `${name} stopped${loop}`
                    }
                    return name
                }
                const summarise = (list: any[]) => {
                    const named = list.slice(0, 2).map(describe).join(", ")
                    return list.length > 2 ? `${named} +${list.length - 2} more` : named
                }

                if (bad.length) {
                    systemStatus = "error"
                    statusReason = `${project}: ${summarise(bad)}`.slice(0, 400)
                } else if (stopped.length) {
                    systemStatus = "warning"
                    statusReason = `${project}: ${summarise(stopped)}`.slice(0, 160)
                }
                break;
            }
                
            case "patroni": {
                // Patroni is the authority on which host holds the primary, so
                // this report does two separate jobs. First it records the leader
                // against every patroni-kind cluster this host belongs to, which
                // is what makes placement 'leader' enforceable at all. Then it
                // reports on THIS node as a cluster member.
                //
                // Kept apart deliberately: whether the cluster has a leader is a
                // property of the set and belongs to the cluster verdict, while
                // "my replica is 400MB behind" is this host's own problem.
                await applyPatroniLeader(client, clusterContexts, system.id, body)
                // Lag only counts if it has held. Checked here rather than in
                // patroniStatus so that stays pure; the history it reads is this
                // node's own recent patroni reports.
                const lagFloor = Number(body?.lagWarnBytes) || 0
                const heldLag = typeof body?.lagBytes === "number" && body.lagBytes >= lagFloor
                    ? await lagSustained(client, system.id, uniqueId, lagFloor)
                    : false
                const patroniVerdict = patroniStatus(body, heldLag)
                if (patroniVerdict.status !== "online") {
                    systemStatus = patroniVerdict.status
                    statusReason = (patroniVerdict.reason || "Patroni issue").slice(0, 300)
                }
                break;
            }

            case "cloudflare":
                // Check Cloudflare services
                
                // Check Pages projects status
                if (body.pages?.projects) {
                    const hasFailedDeployments = body.pages.projects.some(project => {
                        const deployment = project.latest_deployment
                        return deployment && deployment.status !== "success" && deployment.status !== "queued"
                    })
                    
                    if (hasFailedDeployments) {
                        systemStatus = "warning"
                        statusReason = "One or more Pages deployments have failed"
                    }
                }
                
                // Check Zones status if available
                if (body.zones) {
                    // Name the zones — an unnamed "one or more" gives nothing to act on.
                    const inactiveZones = Object.values(body.zones)
                        .filter((zone: any) => typeof zone === 'object' && zone !== null && 'info' in zone)
                        .map((zone: any) => zone.info)
                        .filter((info: any) => info && info.status !== "active")
                        .map((info: any) => `${info.name || info.id} (${info.status})`)

                    if (inactiveZones.length > 0) {
                        systemStatus = "error"
                        statusReason = `Zones not active: ${inactiveZones.slice(0, 3).join(', ')}${inactiveZones.length > 3 ? ` +${inactiveZones.length - 3} more` : ''}`.slice(0, 200)
                    }
                }
                
                // Update system type to cloudflare if it's not already set
                // Also ensure the os field is a proper JSON object, not a string
                await client
                    .from('systems')
                    .update({
                        type: 'cloudflare',
                        last_seen: new Date().toISOString(),
                        updated_at: new Date().toISOString(),
                        os: { type: "other", name: "Cloudflare" } // Always use proper JSON format
                    })
                    .eq('id', system.id)
                
                break;

            case "adsense": {
                // AdSense earnings. A dead refresh token is an error: nothing
                // will be collected until someone mints a new one. A full day
                // with no earnings on an account that was earning is the
                // signal worth a warning (broken ad tags, ads.txt, a policy
                // stop). Yesterday is judged, not today, because today's
                // figure starts at zero and fills in hours late.
                const label = body.name || "AdSense"
                const earlier = (Number(body.last7) || 0) - (Number(body.today) || 0) - (Number(body.yesterday) || 0)
                if (body.authExpired) {
                    systemStatus = "error"
                    statusReason = `${label}: authorization expired, mint a new refresh token`
                } else if (body.error) {
                    systemStatus = "error"
                    statusReason = `${label}: ${String(body.error).slice(0, 140)}`
                } else if (Number(body.yesterday) === 0 && earlier > 0) {
                    // ponytail: zero-day check only. A partial drop (say 80% down)
                    // passes. Compare against a trailing average if that matters.
                    systemStatus = "warning"
                    statusReason = `${label}: no earnings yesterday`
                }
                break;
            }

            case "cost": {
                // Spend per provider. Over budget already is an error; on course
                // to go over is a warning, and so is a day far above the week
                // before it, which is what a leaked key or a runaway job looks
                // like long before the month closes.
                const label = body.name || body.provider || "Cost"
                const cur = String(body.currency || "USD")
                const money = (n: any) => new Intl.NumberFormat("en-US", { style: "currency", currency: cur }).format(Number(n) || 0)
                const budget = Number(body.budget) || 0
                const mtd = Number(body.monthToDate) || 0
                const projected = Number(body.projected) || 0
                const yesterday = Number(body.yesterday) || 0
                const avg7 = Number(body.avg7) || 0
                const spikeFactor = Number(body.spikeFactor) || 3
                if (body.authExpired) {
                    systemStatus = "error"
                    statusReason = `${label}: billing API rejected the key`
                } else if (body.error) {
                    systemStatus = "error"
                    statusReason = `${label}: ${String(body.error).slice(0, 140)}`
                } else if (budget && mtd > budget) {
                    systemStatus = "error"
                    statusReason = `${label}: ${money(mtd)} spent, over the ${money(budget)} budget`
                } else if (budget && projected > budget) {
                    systemStatus = "warning"
                    statusReason = `${label}: on course for ${money(projected)}, budget ${money(budget)}`
                } else if (avg7 > 0 && yesterday > avg7 * spikeFactor && yesterday - avg7 >= 5) {
                    // ponytail: a $5 floor keeps a $0.10 -> $0.40 day quiet; make it configurable if small accounts need it.
                    systemStatus = "warning"
                    statusReason = `${label}: ${money(yesterday)} yesterday, ${(yesterday / avg7).toFixed(1)}x the 7-day average`
                }
                break;
            }

            case "ga4": {
                // Google Analytics overview. Auth and API failures are errors,
                // like adsense. Some properties failing while others report is a
                // warning naming how many, since the rest of the view is still good.
                const accounts: any[] = Array.isArray(body.accounts) ? body.accounts : []
                const failed = accounts.flatMap((a) => (a.properties || []).filter((p: any) => p.error))
                if (body.authExpired) {
                    systemStatus = "error"
                    statusReason = "Google Analytics: authorization expired, mint a new refresh token"
                } else if (body.error) {
                    systemStatus = "error"
                    statusReason = `Google Analytics: ${String(body.error).slice(0, 140)}`
                } else if (failed.length) {
                    systemStatus = "warning"
                    statusReason = `Google Analytics: ${failed.length} propert${failed.length === 1 ? "y" : "ies"} failed to report (${failed[0].name}: ${String(failed[0].error).slice(0, 80)})`
                }
                break;
            }

            case "workspace": {
                // Google Workspace pooled storage. Over critPct is an error,
                // over warnPct a warning. No pooled cap reported means no verdict.
                const pct = Number(body.usedPct)
                const tb = (b: any) => `${(Number(b) / 1024 ** 4).toFixed(2)} TB`
                if (body.authExpired) {
                    systemStatus = "error"
                    statusReason = "Workspace storage: authorization expired, mint a new refresh token"
                } else if (body.error) {
                    systemStatus = "error"
                    statusReason = `Workspace storage: ${String(body.error).slice(0, 140)}`
                } else if (body.usedPct != null && pct >= (Number(body.critPct) || 95)) {
                    systemStatus = "error"
                    statusReason = `Workspace storage ${pct}% full (${tb(body.usedBytes)} of ${tb(body.totalBytes)})`
                } else if (body.usedPct != null && pct >= (Number(body.warnPct) || 85)) {
                    systemStatus = "warning"
                    statusReason = `Workspace storage ${pct}% full (${tb(body.usedBytes)} of ${tb(body.totalBytes)})`
                }
                break;
            }

            case "indexing": {
                // Google indexing of a URL list (IndexingPlugin). One warning per
                // URL Google still hasn't indexed `staleHours` after it appeared,
                // keyed by URL so it closes on its own once the page is indexed.
                // Auth and API failures are errors, like ga4.
                const site = body.site || "Search Console"
                const staleMs = (Number(body.staleHours) || 72) * 3600_000
                const list: any[] = Array.isArray(body.urls) ? body.urls : []
                const late = list.filter((u) => u?.stuck && Date.now() - (Date.parse(u.since) || Date.now()) > staleMs)
                const failed = list.filter((u) => u?.error)
                for (const u of late) {
                    const days = Math.floor((Date.now() - Date.parse(u.since)) / 86400_000)
                    const sent = u.notify?.updated ? `last submitted ${u.notify.updated}` : u.notify === null ? "Indexing API has no submit on record" : ""
                    addFinding({
                        key: `idx:${u.url}`.slice(0, 180),
                        type: "warning",
                        title: `Not indexed after ${days}d: ${String(u.url).replace(/^https?:\/\//, "")}`.slice(0, 160),
                        message: [u.coverageState, u.lastCrawlTime ? `last crawl ${u.lastCrawlTime}` : "never crawled", sent].filter(Boolean).join("; ").slice(0, 200),
                        detail: Object.fromEntries(
                            [["URL", u.url], ["Coverage", u.coverageState], ["Last crawl", u.lastCrawlTime], ["Fetch", u.pageFetchState], ["Inspect", u.link]]
                                .filter(([, v]) => v).map(([k, v]) => [k, String(v)]),
                        ),
                    })
                }
                // A URL that was not indexed last report and is indexed now: one
                // info alert. It isn't "newly indexed" on the next report, so it
                // closes itself then and stays in the event history.
                if (!body.error && list.length) {
                    // The last report that carried URLs: a failed poll in between
                    // has none, and must not hide the change.
                    const { data: prevRows } = await client.from("client_state_history").select("data")
                        .eq("unique_id", uniqueId).eq("system_id", system.id)
                        .order("created_at", { ascending: false }).limit(5)
                    const prevUrls: any[] = (prevRows || []).map((r: any) => r?.data?.urls).find((x: any) => Array.isArray(x) && x.length) || []
                    const before = new Map<string, any>(prevUrls.map((u: any) => [u?.url, u]))
                    for (const u of list) {
                        const was = before.get(u?.url)
                        if (u?.verdict !== "PASS" || !was || was.verdict === "PASS" || was.error) continue
                        const days = Math.max(0, Math.floor((Date.now() - (Date.parse(u.since) || Date.now())) / 86400_000))
                        addFinding({
                            key: `indexed:${u.url}`.slice(0, 180),
                            type: "info",
                            title: `Indexed after ${days}d: ${String(u.url).replace(/^https?:\/\//, "")}`.slice(0, 160),
                            message: [`was ${was.coverageState || "not indexed"}`, u.lastCrawlTime ? `crawled ${u.lastCrawlTime}` : ""].filter(Boolean).join("; ").slice(0, 200),
                            detail: Object.fromEntries(
                                [["URL", u.url], ["Coverage", u.coverageState], ["Was", was.coverageState], ["Last crawl", u.lastCrawlTime], ["Inspect", u.link]]
                                    .filter(([, v]) => v).map(([k, v]) => [k, String(v)]),
                            ),
                        })
                    }
                }
                if (body.authExpired) {
                    systemStatus = "error"
                    statusReason = `Indexing ${site}: Google rejected the service account (${String(body.error || "").slice(0, 100)})`
                } else if (body.error) {
                    systemStatus = "error"
                    statusReason = `Indexing ${site}: ${String(body.error).slice(0, 140)}`
                } else if (late.length) {
                    systemStatus = "warning"
                    statusReason = `${late.length} of ${list.length} URL${list.length === 1 ? "" : "s"} not indexed after ${Math.round(staleMs / 3600_000)}h`
                } else if (failed.length) {
                    systemStatus = "warning"
                    statusReason = `${failed.length} URL${failed.length === 1 ? "" : "s"} failed inspection (${String(failed[0].error).slice(0, 80)})`
                }
                break
            }

            case "nagios": {
                // A Nagios-compatible check. The check itself decided the state
                // with its own thresholds, so the server only maps it. UNKNOWN
                // means it couldn't tell (timed out, couldn't run, bad arguments):
                // a warning, because it says nothing about the thing checked.
                const label = body.name || "check"
                const output = String(body.output || "").slice(0, 160)
                if (body.state === "critical") {
                    systemStatus = "error"
                    statusReason = `${label}: ${output}`
                } else if (body.state === "warning") {
                    systemStatus = "warning"
                    statusReason = `${label}: ${output}`
                } else if (body.state !== "ok") {
                    systemStatus = "warning"
                    statusReason = `${label}: UNKNOWN, ${output}`
                }
                break
            }

            case "tplinkswitch": {
                // TP-Link Easy Managed switch read through its web API. A loop is
                // the fault that takes a network down, so it's an error; a port
                // that loop prevention blocked has already contained it.
                const label = body.name || body.ip || "switch"
                const loops: string[] = Array.isArray(body.loops) ? body.loops : []
                const uplinks: string[] = Array.isArray(body.downUplinks) ? body.downUplinks : []
                const blocked: string[] = Array.isArray(body.blocked) ? body.blocked : []
                if (body.error) {
                    systemStatus = "error"
                    statusReason = body.reachable === false
                        ? `${label} unreachable: ${String(body.error).slice(0, 120)}`
                        : `${label}: ${String(body.error).slice(0, 160)}`
                } else if (loops.length) {
                    systemStatus = "error"
                    statusReason = `${label}: loop detected on ${loops.join(", ")}`
                } else if (uplinks.length) {
                    systemStatus = "error"
                    statusReason = `${label}: uplink down on ${uplinks.join(", ")}`
                } else if (blocked.length) {
                    systemStatus = "warning"
                    statusReason = `${label}: loop prevention blocked ${blocked.join(", ")}`
                }
                break
            }

            case "supabase": {
                // Supabase cloud project. Paused, database down or a full disk
                // is an outage; another service unhealthy, a disk filling up or
                // a half-answered report is a warning.
                const supabaseVerdict = supabaseStatus(body)
                if (supabaseVerdict.status !== "online") {
                    systemStatus = supabaseVerdict.status
                    statusReason = (supabaseVerdict.reason || "Supabase issue").slice(0, 300)
                }
                break
            }

            case "tplink": {
                // TP-Link extender/AP. The uplink is the signal that matters:
                // an extender whose backhaul dropped still answers ping while
                // serving nobody, so that's an error, not a warning. A radio
                // switched off is degraded coverage → warning.
                const label = body.name || body.ip || "extender"
                if (body.error) {
                    systemStatus = "error"
                    statusReason = `${label}: ${String(body.error).slice(0, 140)}`
                } else if (body.reachable === false) {
                    systemStatus = "error"
                    statusReason = `${label} unreachable`
                } else if (body.uplinkUp === false) {
                    systemStatus = "error"
                    statusReason = `${label}: uplink ${body.internetStatus || "disconnected"} — extender is not serving traffic`
                } else if (body.radio2g === false && body.radio5g === false) {
                    systemStatus = "error"
                    statusReason = `${label}: both radios off`
                } else if (body.radio2g === false || body.radio5g === false) {
                    systemStatus = "warning"
                    statusReason = `${label}: ${body.radio2g === false ? "2.4GHz" : "5GHz"} radio off`
                }
                break;
            }

            case "3cx": {
                // 3CX PBX. A crashed 3CX service or a dead SIP port is an
                // outage → error. The management console being down (SIP still
                // up) degrades admin access only → warning. An incomplete read
                // (couldn't reach systemd) is reported as error, never green.
                const label = body.name || body.host || "3CX"
                const down: any[] = Array.isArray(body.down) ? body.down : []
                if (body.error) {
                    systemStatus = "error"
                    statusReason = `${label}: ${String(body.error).slice(0, 140)}`
                } else if (body.reachable === false) {
                    systemStatus = "error"
                    statusReason = `${label} unreachable`
                } else if (down.length) {
                    systemStatus = "error"
                    statusReason = `${label}: ${down.length} service(s) down — ${down.map((d: any) => String(d.unit || "").replace(/\.service$/, "")).join(", ")}`.slice(0, 200)
                } else if (body.role === "sbc" && body.tunnelUp === false) {
                    // SBC cut off from the PBX — no calls can traverse it.
                    systemStatus = "error"
                    statusReason = `${label}: tunnel to PBX down (port ${body.tunnelPort ?? 5090})`
                } else if (body.sipOk === false) {
                    systemStatus = "error"
                    const dead = (Array.isArray(body.sip) ? body.sip : []).filter((p: any) => !p.listening).map((p: any) => p.port)
                    statusReason = `${label}: SIP not listening (port ${dead.join(", ")})`
                } else if (Array.isArray(body.sbcs) && body.sbcs.some((s: any) => !s.connected)) {
                    // A branch SBC dropped its tunnel — the PBX core is fine, but
                    // phones behind that SBC can't reach it. Surface as a warning.
                    systemStatus = "warning"
                    const dropped = body.sbcs.filter((s: any) => !s.connected).map((s: any) => s.name)
                    statusReason = `${label}: SBC tunnel down — ${dropped.join(", ")}`.slice(0, 200)
                } else if (body.console && body.console.listening === false) {
                    systemStatus = "warning"
                    statusReason = `${label}: management console (port ${body.console.port}) down`
                }
                break;
            }
        }

        // Device datapoint merge: netscan (reachability) and snmp (metrics) that
        // watch the SAME physical device fold into ONE `device` client_state keyed
        // by its IP, each plugin's report under data.sources.<plugin>. So a device
        // (QNAP, switch, printer) is a single entity carrying every plugin's
        // datapoints — not a separate row per plugin. Combined status = worst
        // across datapoints. The switch above already computed THIS source's
        // status into systemStatus/statusReason.
        const DEVICE_SOURCES: Record<string, string> = { netscan: "netscan", netdevice: "netscan", snmp: "snmp", tplink: "tplink", tplinkswitch: "tplinkswitch" }
        if (DEVICE_SOURCES[dataType] && body.ip) {
            const source = DEVICE_SOURCES[dataType]
            const deviceKey = `dev-${String(body.ip).replace(/[^0-9a-zA-Z]+/g, "-")}`
            const { data: exRows } = await client
                .from("client_states").select("data, status")
                .eq("unique_id", deviceKey).eq("system_id", system.id).limit(1)
            const ex = (exRows?.[0]?.data as any) || {}
            const sources = { ...(ex.sources || {}), [source]: body }
            const statuses = { ...(ex.statuses || {}), [source]: { status: systemStatus, reason: statusReason } }
            const RANK: Record<string, number> = { online: 0, warning: 1, error: 2 }
            let combined = "online"
            let combinedReason: string | null = null
            for (const st of Object.values(statuses) as any[]) {
                if ((RANK[st.status] ?? 0) > (RANK[combined] ?? 0)) { combined = st.status; combinedReason = st.reason }
            }
            const mergedData = {
                // snmp/tplink/tplinkswitch report the device's own identity, so
                // their name wins over netscan's config label when both are present.
                name: (source !== "netscan" ? body.name : undefined) || ex.name || body.name || String(body.ip),
                ip: body.ip,
                mac: body.mac || ex.mac,
                sources,
                statuses,
            }
            const nowIso = new Date().toISOString()
            await client.from("client_states").upsert({
                unique_id: deviceKey, system_id: system.id, type: "device",
                data: mergedData, status: combined, status_reason: combinedReason,
                client_ip: clientIp, updated_at: nowIso,
            }, { onConflict: "unique_id, system_id" })
            await client.from("client_state_history").insert({
                unique_id: deviceKey, system_id: system.id, type: "device",
                data: mergedData, status: combined, created_at: nowIso,
            })
            // Same rules as every other service: page only once a fault has
            // survived a second report, and close the alert when it clears.
            // This path returns early, so it used to page on the first bad
            // report and never resolve, leaving a device silent after one alert.
            if (combined === "online") {
                await resolveNotifications(ctx, client, system, "device", deviceKey)
            } else if (deviceFaultHeld(ex.statuses?.[source]?.status, systemStatus)) {
                await notify(ctx, {
                    client,
                    system,
                    title: `${system.name}: ${statusReason || mergedData.name}`,
                    // statusReason already opens with the device name (every
                    // branch of the snmp/netscan switch builds `${label}: ...`),
                    // so prefixing it again produced "QNAP: QNAP: disk HDD2 ...".
                    message: statusReason || `${mergedData.name}: issue detected`,
                    type: systemStatus === "warning" ? "warning" : "error",
                    source: "device",
                    sourceDetail: deviceKey,
                })
            }
            return { success: true, message: "device datapoint merged", device: deviceKey, status: combined }
        }

        // LXC → one client_state per container. Each container is a distinct
        // property (aninterior, cestrong, …), so split the per-host payload into
        // individual "lxc-container" services that can be seen and grouped on
        // their own. Bypasses the single-aggregate upsert below.
        if (dataType === "lxc" && Array.isArray(body.containers)) {
            const host = body.host || system.name
            const nowIso = new Date().toISOString()
            const rows = body.containers.map((c: any) => {
                const running = !!c.running
                const badExit = !running && (Number(c.exitCode) || 0) !== 0
                const unhealthy = String(c.health || "").toLowerCase() === "unhealthy"
                const st = unhealthy || badExit ? "error" : !running ? "warning" : "online"
                const reason = unhealthy ? "unhealthy" : !running ? (c.state || "stopped") : null
                return {
                    unique_id: `lxc-${host}-${c.id || c.name}`,
                    system_id: system.id,
                    type: "lxc-container",
                    data: { container: c, host, engine: "lxc" },
                    status: st,
                    status_reason: reason,
                    client_ip: clientIp,
                    updated_at: nowIso,
                }
            })
            if (rows.length) {
                const { error: e } = await client
                    .from("client_states")
                    .upsert(rows, { onConflict: "unique_id, system_id" })
                if (e) throw new HttpError(500, e.message)
                // Record history per container so cpu/mem charts have a series.
                await client.from("client_state_history").insert(
                    rows.map((r) => ({
                        unique_id: r.unique_id, system_id: r.system_id, type: r.type,
                        data: r.data, status: r.status, created_at: nowIso,
                    })),
                )
            }
            return { success: true, message: "LXC containers updated", count: rows.length }
        }

        // Each pair below goes to the database together: neither half needs the
        // other, and every report paid for each round trip from the edge to the
        // cluster in turn.
        //
        // The host's status if this report changes it, and what this service
        // reported LAST time, read before the upsert overwrites it (it debounces
        // alerts: see the notify block below).
        const [, { data: prevRows }] = await Promise.all([
            systemStatus !== "online"
                ? client
                    .from('systems')
                    .update({
                        status: systemStatus,
                        status_reason: statusReason,
                        last_updated: new Date().toISOString()
                    })
                    .eq('id', system.id)
                : null,
            client
                .from('client_states')
                .select('status')
                .eq('unique_id', uniqueId)
                .eq('system_id', system.id)
                .limit(1),
        ])
        const prevStatus = prevRows?.[0]?.status ?? null

        // The client state record, and its history row. History is skipped for
        // types whose report already IS a history: an adsense report carries 30
        // days of daily figures, so a row per report would save the same month
        // over again every ten minutes.
        const [{ data: clientState, error: clientStateError }] = await Promise.all([
            client
                .from('client_states')
                .upsert({
                    unique_id: uniqueId,
                    system_id: system.id,
                    type: dataType,
                    data: body,
                    status: systemStatus,
                    status_reason: statusReason,
                    client_ip: clientIp,
                    updated_at: new Date().toISOString()
                }, {
                    onConflict: 'unique_id, system_id',
                })
                .select('id'),
            SELF_HISTORIED.has(dataType)
                ? null
                : client
                    .from('client_state_history')
                    .insert({
                        unique_id: uniqueId,
                        system_id: system.id,
                        type: dataType,
                        data: body,
                        status: systemStatus,
                        created_at: new Date().toISOString()
                    }),
        ])

        if (clientStateError) {
            throw new HttpError(500, clientStateError.message)
        }

        // Security types (web/wordpress/logwatch) collect DISCRETE findings →
        // one notification per finding, deduped on a stable per-finding key
        // (source_detail) so distinct problems coexist instead of collapsing.
        //
        // A finding the service has stopped reporting is over: close it, so the
        // event reads as history and the same finding alerts again if it returns.
        // A failed indexing poll carries no URLs, which must not read as "all indexed".
        if (["web", "wordpress", "logwatch", "appactivity", "indexing"].includes(dataType) && !(dataType === "indexing" && body.error)) {
            await resolveClearedFindings(ctx, client, system, dataType, uniqueId, findings.map((f) => f.key))
        }
        if (findings.length) {
            for (const f of findings) {
                await notify(ctx, {
                    client,
                    system,
                    title: f.title,
                    message: f.message,
                    type: f.type,
                    source: dataType,
                    sourceDetail: f.key,
                    service: uniqueId,
                    detail: f.detail,
                })
            }
        // A clustered service is judged across its members, never on one host.
        // Both halves of the per-host path are wrong for it: the alert, because a
        // follower with the container stopped is doing exactly what it was told
        // to, and the recovery, because "online here" says nothing about whether
        // the service is placed anywhere at all. The cluster verdict below covers
        // both, and covers the two cases a host can't see — running nowhere, and
        // running in two places.
        } else if (wholeRowClustered) {
            console.log(`update: ${uniqueId} is cluster-managed by ${clusterRules[0].ctx.cluster.name}, deferring to the cluster verdict`)

        // Otherwise the legacy single-notification path (all non-security types).
        } else if (systemStatus !== "online") {
            // Debounced: alert only once the problem has survived a second
            // consecutive report.
            //
            // Containers flap. Every supabase-meta on this fleet goes unhealthy
            // for well under a minute and heals itself, and each blip was paging
            // as CRIT. Docker already applies its own retries before declaring a
            // container unhealthy, so this is not about being slow to believe it
            // — it is that a fault which fixes itself before anyone can read the
            // alert was never worth sending.
            //
            // The dashboard still turns amber immediately; this delays the
            // NOTIFICATION only. A real outage alerts one report later, which for
            // a minute-interval agent costs a minute.
            const wasBad = prevStatus != null && prevStatus !== "online"
            if (!wasBad) {
                console.log(`update: ${uniqueId} became ${systemStatus}, holding the alert for one report`)
            } else await notify(ctx, {
                client,
                system,
                title: `${system.name}: ${statusReason || 'Issue detected'}`,
                message: `${dataType.toUpperCase()}: ${statusReason || 'An issue was detected'}`,
                type: systemStatus === "warning" ? "warning" : "error",
                source: dataType,
                sourceDetail: uniqueId,
                // Link the Slack button to this service row, not just the host.
                serviceId: clientState?.[0]?.id,
            })
        } else if (prevStatus !== "online") {
            // Recovered: close whatever this service had open. Without this an
            // alert outlives the problem, and an inbox full of things that are
            // no longer true is one nobody reads.
            //
            // Only on the way back from a bad report (or the first report). This
            // path opens an alert only after two bad reports in a row, and the
            // first good one after closes it, so a good report after a good one
            // has nothing to close; it was an UPDATE on most of the fleet's
            // reports, every one of them finding nothing.
            await resolveNotifications(ctx, client, system, dataType, uniqueId)
        }

        // Re-judge this host's clusters. Runs on every report from a member, not
        // just on reports of a clustered service, because the failure that
        // matters most is silent: a dead leader reports nothing at all, so the
        // only evidence left is the followers still saying "not here".
        if (clusterContexts.length) {
            await runClusterEvaluations(ctx, client, clusterContexts, { type: dataType, uniqueId })
        }

        return {
            success: true,
            message: "Client state updated",
            status: systemStatus,
            clientState: clientState
        }
}
