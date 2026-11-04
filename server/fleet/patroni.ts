/**
 * Turning a Patroni report into a leader identity daemonitor can act on.
 *
 * Placement 'leader' needs to know which SYSTEM currently holds the primary, and
 * Patroni only ever speaks in member names. Bridging the two is the whole job of
 * this file, and there are two ways to do it that are not equally good:
 *
 *   1. The reporting node says `isLeader`. That is first-hand and exact: the
 *      agent that sent this report runs on that host, so the system id is the
 *      one that authenticated the request. No name matching, nothing to get
 *      wrong. Always preferred.
 *
 *   2. A follower names the leader (`leader: "pi5b"`). Second-hand, and needs a
 *      member-name-to-system mapping. That mapping is LEARNED from case 1: every
 *      node reports its own Patroni member name, so after one round of reports
 *      the cluster knows which system answers to which name. Falls back to
 *      matching systems.name, which is right on these hosts and a guess in
 *      general.
 *
 * Case 2 matters because it is the failover case. When the leader dies its agent
 * dies with it, so the only reports still arriving are from followers, and the
 * new leader may not have reported yet.
 */
import type { ClusterContext } from "./clusters"

/**
 * How stale a leader identity may get before it stops being trusted. Two report
 * intervals plus slack: the patroni plugin runs every 30s, so anything past this
 * means no node has confirmed a leader in a long time, and 'leader' placement is
 * better off degrading to 'exactly one member' than enforcing a stale answer.
 */
export const LEADER_STALE_AFTER_MS = 180_000

/** Only refresh the timestamp this often, so a steady cluster isn't rewriting a row every 30s. */
const LEADER_TOUCH_INTERVAL_MS = 120_000

/**
 * Which system corresponds to a Patroni member name, learned from what each
 * member reported about itself.
 */
async function systemForMemberName(
    client: any,
    memberIds: string[],
    memberName: string,
): Promise<string | null> {
    const wanted = memberName.toLowerCase()

    const { data: states } = await client
        .from("client_states")
        .select("system_id, data")
        .in("system_id", memberIds)
        .eq("type", "patroni")
    for (const row of states || []) {
        if (String(row?.data?.member || "").toLowerCase() === wanted) return row.system_id
    }

    // Nothing has self-reported that name yet. Patroni's member name defaults to
    // the hostname, so the system name is a good guess, but it is a guess: say so
    // in the log rather than letting a silent mismatch look like a real answer.
    const { data: systems } = await client.from("systems").select("id, name").in("id", memberIds)
    for (const s of systems || []) {
        if (String(s?.name || "").toLowerCase() === wanted) {
            console.log(`patroni: matched leader "${memberName}" to system ${s.name} by name, no self-report yet`)
            return s.id
        }
    }
    return null
}

/**
 * Record who holds the leader, for every patroni-kind cluster this host is in.
 *
 * Never throws: this runs inside ingest, and a cluster that cannot be updated
 * must not fail the metrics push that carried the news.
 */
export async function applyPatroniLeader(
    client: any,
    contexts: ClusterContext[],
    reportingSystemId: string,
    body: any,
): Promise<void> {
    const patroniClusters = contexts.filter((c) => c.cluster.kind === "patroni")
    if (!patroniClusters.length) return
    if (body?.reachable === false) return

    for (const ctx of patroniClusters) {
        try {
            let leaderId: string | null | undefined

            if (body?.isLeader === true) {
                leaderId = reportingSystemId
            } else if (body?.leader) {
                leaderId = await systemForMemberName(client, ctx.memberIds, String(body.leader))
            } else if (body?.hasLeader === false && !body?.partial && Number(body?.memberCount) > 0) {
                // A complete report from a node that can see the whole cluster and
                // finds no leader in it. Clearing is the honest answer, and it is
                // also the safe one: 'leader' placement degrades to "exactly one
                // member", which still catches a service running nowhere or twice
                // without pinning it to a host that no longer holds the primary.
                leaderId = null
            } else {
                continue
            }

            const current = ctx.cluster.leader_system_id ?? null
            const changed = current !== (leaderId ?? null)
            if (!changed) {
                // Same answer as before. Refresh the timestamp occasionally so the
                // staleness check can tell "still true" from "nobody has said
                // anything in an hour", but not on every single report.
                const seen = (ctx.cluster as any).leader_seen_at
                const age = seen ? Date.now() - new Date(seen).getTime() : Infinity
                if (age < LEADER_TOUCH_INTERVAL_MS) continue
            }

            const { error } = await client
                .from("clusters")
                .update({
                    leader_system_id: leaderId ?? null,
                    leader_seen_at: leaderId ? new Date().toISOString() : null,
                })
                .eq("id", ctx.cluster.id)
            if (error) {
                console.error(`patroni: could not record leader for ${ctx.cluster.name}:`, error.message)
                continue
            }

            // Keep the in-memory context in step: the cluster evaluation that runs
            // later in this same request reads it, and a failover should be
            // reflected in the very report that announced it.
            ctx.cluster.leader_system_id = leaderId ?? null
            ;(ctx.cluster as any).leader_seen_at = leaderId ? new Date().toISOString() : null

            if (changed) {
                console.log(
                    `patroni: ${ctx.cluster.name} leader is now ` +
                    `${leaderId ? body?.leader || reportingSystemId : "unknown (no leader in the cluster)"}`,
                )
            }
        } catch (e: any) {
            console.error("patroni: leader update failed:", e?.message || e)
        }
    }
}

/**
 * How long lag must stay over the threshold before it means anything.
 *
 * Replication lag is spiky by nature: a WAL burst puts a replica a few hundred
 * MB behind and it catches up within a minute. Measured over 333 samples per
 * node on this cluster, lag is 0 at the median AND at p90, and crosses 32MB in
 * 1.5% of samples, every one of which recovered on its own. Paging on the
 * instantaneous value alerted on all of them.
 *
 * The question worth answering is not "is this replica behind" but "is this
 * replica failing to catch up", and the only difference between those is time.
 */
export const LAG_SUSTAINED_SEC = 300
/** Below this many samples in the window there is not enough evidence to judge. */
const LAG_MIN_SAMPLES = 3

/**
 * Has this node's lag been continuously over `threshold` for the whole window?
 *
 * Reads the node's own recent patroni reports. Server-side on purpose: the
 * plugin could keep this state itself, but that means publishing it and
 * redeploying every agent, and the history is already in the database.
 *
 * Fails CLOSED (returns false, so no alert) on any error or thin evidence.
 * A missed page for a genuinely stuck replica is recoverable, since the next
 * report re-asks; crying wolf every time a WAL burst lands is what made this a
 * problem in the first place.
 */
export async function lagSustained(
    client: any,
    systemId: string,
    uniqueId: string,
    threshold: number,
    windowSec: number = LAG_SUSTAINED_SEC,
): Promise<boolean> {
    if (!threshold) return false
    try {
        const since = new Date(Date.now() - windowSec * 1000).toISOString()
        const { data, error } = await client
            .from("client_state_history")
            .select("data, created_at")
            .eq("system_id", systemId)
            .eq("unique_id", uniqueId)
            .gte("created_at", since)
            .order("created_at", { ascending: false })
            .limit(40)
        if (error) throw new Error(error.message)
        const lags = (data || [])
            .map((r: any) => r?.data?.lagBytes)
            .filter((n: any) => typeof n === "number" && Number.isFinite(n))
        if (lags.length < LAG_MIN_SAMPLES) return false
        if (!lags.every((n: number) => n >= threshold)) return false
        // Over the line the whole window is not enough: a replica draining a
        // 960MB burst sits above 32MB for five minutes while shrinking every
        // sample. "Not catching up" means no net progress, newest >= oldest.
        return lags[0] >= lags[lags.length - 1]
    } catch (e: any) {
        console.error("patroni: lag persistence check failed:", e?.message || e)
        return false
    }
}

export interface PatroniStatus {
    status: "online" | "warning" | "error"
    reason: string | null
}

/**
 * Read a Patroni report as a status for this host's own row.
 *
 * Deliberately separate from the cluster verdict. This says whether THIS node is
 * a healthy cluster member; whether the CLUSTER has a leader and where the
 * singletons are placed is the cluster evaluator's business, and mixing the two
 * would page every follower for one leaderless moment.
 */
export function patroniStatus(body: any, lagIsSustained = false): PatroniStatus {
    const member = String(body?.member || "node")

    if (body?.reachable === false) {
        return { status: "error", reason: `${member}: Patroni API unreachable — ${String(body?.error || "no response").slice(0, 140)}` }
    }

    const state = String(body?.state || "unknown").toLowerCase()
    const role = String(body?.role || "unknown").toLowerCase()

    // A node that is not running is not a member in any useful sense, whatever
    // the DCS still says about its role.
    if (state && !["running", "streaming"].includes(state)) {
        return { status: "error", reason: `${member}: Patroni state "${state}" (role ${role})` }
    }

    // No leader anywhere. Reported by every member at once, which is correct:
    // each of them is genuinely in a leaderless cluster. The per-host debounce
    // and the cluster grace window are what keep an election from paging.
    if (body?.hasLeader === false && !body?.partial && Number(body?.memberCount) > 0) {
        return {
            status: "error",
            reason: body?.paused
                ? `${member}: no leader and Patroni is PAUSED — nothing will promote a replica`
                : `${member}: cluster has no leader (${body?.memberCount} members, none primary)`,
        }
    }

    // Paused means failover is switched off. Everything looks fine until the
    // leader dies and nothing replaces it, so it is worth saying out loud.
    if (body?.paused) {
        return { status: "warning", reason: `${member}: Patroni is PAUSED — automatic failover is disabled` }
    }

    // Only sustained lag counts. A replica that is behind and catching up is a
    // replica doing its job; see LAG_SUSTAINED_SEC.
    const lag = body?.lagBytes
    if (lagIsSustained && typeof lag === "number" && Number.isFinite(lag)) {
        const crit = Number(body?.lagCritBytes) || 0
        const warn = Number(body?.lagWarnBytes) || 0
        const held = `for over ${Math.round(LAG_SUSTAINED_SEC / 60)}m`
        if (crit && lag >= crit) return { status: "error", reason: `${member}: replication lag ${fmtBytes(lag)} behind the leader ${held}, not catching up` }
        if (warn && lag >= warn) return { status: "warning", reason: `${member}: replication lag ${fmtBytes(lag)} behind the leader ${held}, not catching up` }
    }

    // A member the DCS cannot see is not the same as one that is caught up. It is
    // in the member list and reporting no position at all.
    const unreachable = (Array.isArray(body?.members) ? body.members : [])
        .filter((m: any) => m?.state && !["running", "streaming"].includes(String(m.state).toLowerCase()))
        .map((m: any) => `${m.name} (${m.state})`)
    if (unreachable.length) {
        return { status: "warning", reason: `${member}: ${unreachable.slice(0, 3).join(", ")}` }
    }

    if (body?.pendingRestart) {
        return { status: "warning", reason: `${member}: pending restart — a config change is not in effect yet` }
    }

    return { status: "online", reason: null }
}

function fmtBytes(n: number): string {
    const u = ["B", "KB", "MB", "GB", "TB"]
    let v = n, i = 0
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
    return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)}${u[i]}`
}
