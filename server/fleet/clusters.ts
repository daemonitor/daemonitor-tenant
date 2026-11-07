/**
 * Cluster evaluation on the ingest path.
 *
 * The judgement itself lives in ~/utils/clusterEval (pure, and shared with the
 * browser, so the Slack message and the card can never disagree). This file is
 * the plumbing around it: find the clusters a reporting system belongs to,
 * gather every member's view of the service, apply the grace window, and raise
 * or clear exactly one alert for the set.
 *
 * Two things here are load-bearing and easy to get wrong.
 *
 * 1. ANY report from ANY member re-judges the cluster, not just a report that
 *    matches the rule. A follow-the-leader singleton exists only on the leader:
 *    the other hosts have no such compose project and never mention it. So if
 *    the leader dies, no report matching the rule will ever arrive again, and a
 *    match-triggered evaluator would sit silent through the exact outage it was
 *    built for. The followers' unrelated os/docker reports are the only evidence
 *    left, so those drive the sweep (throttled, see SWEEP_INTERVAL_MS).
 *
 * 2. The alert anchors to a FIXED member, never the reporting one. notify()
 *    dedupes on (system_id, source, source_detail); anchoring to whoever
 *    reported would open one alert per host for a single cluster-wide fault, and
 *    resolve only one of them on recovery.
 */
import { notify, resolveNotifications, type NotifySystem } from "./notify"
import type { FleetCtx } from "./ctx"
import { evaluateClusterService, type ClusterMemberInput } from "~/utils/clusterEval"
import type { ClusterService, ClusterVerdict, Level } from "~/types/fleet"

/**
 * How stale a rule's verdict may get before an unrelated report from a member
 * re-judges it. The floor on how long a dead leader can go unnoticed, and the
 * ceiling on how much work every unrelated os report does.
 */
const SWEEP_INTERVAL_MS = 30_000

/** notify() takes info/warning/error; the evaluator speaks in fleet levels. */
const LEVEL_TO_NOTIFY: Record<string, "error" | "warning" | "info"> = {
    crit: "error",
    warn: "warning",
    ok: "info",
    standby: "info",
}

export interface ClusterContext {
    cluster: {
        id: string
        user_id: string
        name: string
        kind: "generic" | "patroni"
        leader_system_id: string | null
        leader_seen_at: string | null
        grace_seconds: number
    }
    /** Member system ids, ordered so the first is the stable alert anchor. */
    memberIds: string[]
    rules: ClusterService[]
}

/** One rule, carrying the cluster it belongs to. */
export interface ClusterRuleMatch {
    svc: ClusterService
    ctx: ClusterContext
}

/**
 * Every cluster this system is a member of, with that cluster's members and
 * enabled rules. Empty for a system in no cluster, which is the common case.
 *
 * Membership is cached; the rules are not. They carry `degraded_since` and
 * `last_level`, which are the running state of the grace window and change
 * between one report and the next, so a cached copy would re-open alerts that
 * were already resolved and restart windows that had already elapsed.
 */
export async function getClusterContexts(client: any, systemId: string): Promise<ClusterContext[]> {
    // Membership used to be cached for a minute, because every report asked
    // Postgres over the network. It's a local SQLite read now, so it isn't.
    const { data: memberOf } = await client.from("cluster_members").select("cluster_id").eq("system_id", systemId)
    const ids = (memberOf || []).map((r: any) => r.cluster_id)
    if (!ids.length) return []

    const [clustersRes, membersRes, rulesRes] = await Promise.all([
        client.from("clusters")
            .select("id, user_id, name, kind, leader_system_id, leader_seen_at, grace_seconds")
            .in("id", ids),
        // created_at ordering makes the anchor deterministic and stable: the
        // first system added to a cluster stays first for its lifetime, so an
        // alert opened weeks ago still resolves against the same row.
        client.from("cluster_members")
            .select("cluster_id, system_id, created_at")
            .in("cluster_id", ids)
            .order("created_at", { ascending: true })
            .order("system_id", { ascending: true }),
        client.from("cluster_services").select("*").in("cluster_id", ids).eq("enabled", true),
    ])
    if (clustersRes.error) {
        console.error("clusters: load failed:", clustersRes.error.message)
        return []
    }

    const membersByCluster = new Map<string, string[]>()
    for (const m of membersRes.data || []) {
        const arr = membersByCluster.get(m.cluster_id) || []
        arr.push(m.system_id)
        membersByCluster.set(m.cluster_id, arr)
    }
    const rulesByCluster = new Map<string, ClusterService[]>()
    for (const r of (rulesRes.data || []) as ClusterService[]) {
        const arr = rulesByCluster.get(r.cluster_id) || []
        arr.push(r)
        rulesByCluster.set(r.cluster_id, arr)
    }

    return (clustersRes.data || []).map((cluster: any) => ({
        cluster,
        memberIds: membersByCluster.get(cluster.id) || [],
        rules: rulesByCluster.get(cluster.id) || [],
    }))
}

/**
 * Rules covering one client_states row, across every cluster the host is in.
 * Ingest uses this to decide whether the row gets to raise its own per-host
 * alert, and which of its containers still count towards the host's status.
 */
export function findClusterRules(
    contexts: ClusterContext[],
    type: string,
    uniqueId: string,
): ClusterRuleMatch[] {
    const out: ClusterRuleMatch[] = []
    for (const ctx of contexts) {
        for (const svc of ctx.rules) {
            if (svc.match_type === type && svc.match_unique_id === uniqueId) out.push({ svc, ctx })
        }
    }
    return out
}

/**
 * The single rule that speaks for a WHOLE row, if there is one.
 *
 * Only a rule with no `match_container` qualifies, and that is the point. A rule
 * naming one container inside a compose project claims that container and leaves
 * the rest of the project to the host, so the row still has its own status to
 * report; treating the row as cluster-owned there would hide the `admin`
 * container behind a verdict about `renderer`.
 */
export function findClusterService(
    contexts: ClusterContext[],
    type: string,
    uniqueId: string,
): ClusterRuleMatch | undefined {
    return findClusterRules(contexts, type, uniqueId).find((m) => !m.svc.match_container)
}

/** Everything the evaluator needs about the members, read fresh. */
async function gatherMembers(
    client: any,
    memberIds: string[],
    matchType: string,
    matchUniqueId: string,
): Promise<ClusterMemberInput[]> {
    const [sysRes, stateRes] = await Promise.all([
        client.from("systems").select("id, name, last_seen").in("id", memberIds),
        client.from("client_states")
            .select("system_id, status, status_reason, updated_at, data")
            .in("system_id", memberIds)
            .eq("type", matchType)
            .eq("unique_id", matchUniqueId),
    ])
    if (sysRes.error) throw new Error(`member systems: ${sysRes.error.message}`)
    if (stateRes.error) throw new Error(`member states: ${stateRes.error.message}`)

    const stateBySystem = new Map<string, any>()
    for (const row of stateRes.data || []) stateBySystem.set(row.system_id, row)

    // Iterate memberIds, not the query result, so a member that returned no row
    // at all still appears. Its absence IS the datapoint.
    const byId = new Map<string, any>((sysRes.data || []).map((s: any) => [s.id, s]))
    return memberIds.map((id) => ({
        system: byId.get(id) ?? { id, name: "unknown", last_seen: null },
        state: stateBySystem.get(id) ?? null,
    }))
}

/**
 * Persist the verdict and decide whether it pages.
 *
 * The grace window is measured from `degraded_since`, which has to survive
 * across requests because no single request sees the whole stretch: members
 * report independently, and the one that notices a fault first is rarely the
 * one still watching when the window closes.
 */
async function applyVerdict(
    ctx0: FleetCtx,
    client: any,
    ctx: ClusterContext,
    rule: ClusterService,
    verdict: ClusterVerdict,
): Promise<void> {
    const now = new Date()
    const nowIso = now.toISOString()
    const anchorId = ctx.memberIds[0]
    if (!anchorId) return
    const healthy = verdict.level === "ok" || verdict.level === "standby"

    const prevLevel = (rule.last_level || null) as Level | null
    const wasBad = !!prevLevel && prevLevel !== "ok" && prevLevel !== "standby"
    const degradedSince = healthy ? null : (wasBad && rule.degraded_since ? rule.degraded_since : nowIso)

    const { error: updErr } = await client
        .from("cluster_services")
        .update({
            last_level: verdict.level,
            last_reason: verdict.reason,
            degraded_since: degradedSince,
            evaluated_at: nowIso,
        })
        .eq("id", rule.id)
    if (updErr) console.error("clusters: could not persist verdict:", updErr.message)

    // Verdict history, for the placed-count trend.
    //
    // One row per wall-clock minute per rule, plus every level change.
    //
    // Throttling on "time since the last evaluation" does NOT work here, and got
    // this wrong first time round: evaluated_at is refreshed by every evaluation,
    // and with three members reporting plus the 30s sweep those land every ~20s.
    // The gap never reached the threshold, so a healthy cluster recorded nothing
    // at all — precisely the flat line the trend is for.
    //
    // Comparing minute buckets instead makes the first evaluation in each new
    // minute write, whatever the evaluation cadence happens to be. A level CHANGE
    // always records regardless: the moment a singleton goes from one member to
    // three is the one sample that must never be throttled away.
    const prevMinute = rule.evaluated_at ? Math.floor(new Date(rule.evaluated_at).getTime() / 60_000) : -1
    if (Math.floor(now.getTime() / 60_000) !== prevMinute || prevLevel !== verdict.level) {
        const { error: histErr } = await client.from("cluster_service_history").insert({
            cluster_service_id: rule.id,
            level: verdict.level,
            reason: verdict.reason,
            running_count: verdict.runningCount,
            member_count: verdict.members.length,
            unknown_count: verdict.unknownCount,
            created_at: nowIso,
        })
        // Best effort: losing a trend sample must never fail an ingest.
        if (histErr) console.error("clusters: could not record verdict history:", histErr.message)
    }

    // The anchor stands in for the whole cluster. Its identity only supplies the
    // owner and the deep link; the alert text names the cluster and the members.
    const { data: anchor } = await client
        .from("systems").select("id, name, user_id").eq("id", anchorId).maybeSingle()
    if (!anchor) return
    const anchorSystem: NotifySystem = { id: anchor.id, name: anchor.name, user_id: anchor.user_id }
    const sourceDetail = `cluster:${rule.id}`

    if (healthy) {
        if (wasBad) {
            await resolveNotifications(ctx0, client, anchorSystem, "cluster", sourceDetail)
            console.log(`clusters: ${ctx.cluster.name}/${rule.name} recovered, ${verdict.reason}`)
        }
        return
    }

    const heldFor = (now.getTime() - new Date(degradedSince as string).getTime()) / 1000
    if (heldFor < ctx.cluster.grace_seconds) {
        console.log(
            `clusters: ${ctx.cluster.name}/${rule.name} ${verdict.level} for ${Math.round(heldFor)}s ` +
            `(grace ${ctx.cluster.grace_seconds}s), holding: ${verdict.reason}`,
        )
        return
    }

    // An escalation is news. notify() dedupes against the open row, so a warn
    // that becomes a crit would otherwise be swallowed by its own earlier alert.
    // Close that one first and let the worse one through.
    if (prevLevel && prevLevel !== verdict.level) {
        await resolveNotifications(ctx0, client, anchorSystem, "cluster", sourceDetail)
    }

    await notify(ctx0, {
        client,
        system: anchorSystem,
        title: `${ctx.cluster.name}: ${rule.name} ${verdict.reason}`,
        message:
            `${rule.placement.toUpperCase()} ${rule.name}: ${verdict.reason}. ` +
            `Members: ${verdict.members.map((m) => `${m.systemName}=${m.state}`).join(", ")}.`,
        type: LEVEL_TO_NOTIFY[verdict.level] || "warning",
        source: "cluster",
        sourceDetail,
    })
}

/**
 * Re-judge every cluster the reporting host belongs to. Called once per ingest,
 * AFTER the row has been written: the evaluator reads member states back out of
 * the database, so the report being handled has to be in there first.
 *
 * Never throws. A cluster misconfiguration must not fail a metrics push.
 */
export async function runClusterEvaluations(
    fleet: FleetCtx,
    client: any,
    contexts: ClusterContext[],
    reported: { type: string; uniqueId: string },
): Promise<void> {
    const now = Date.now()
    for (const ctx of contexts) {
        if (!ctx.rules.length || !ctx.memberIds.length) continue

        // Group by the row identity the rules match, so a compose project
        // carrying a rule for `renderer` and another for `admin` costs one
        // member query, not two.
        // Keyed on the JSON pair rather than a joined string: a unique_id is
        // agent-supplied and a web monitor's can contain anything, so a
        // separator character is a bug waiting for the right service name.
        const byRow = new Map<string, { type: string; uniqueId: string; rules: ClusterService[] }>()
        for (const rule of ctx.rules) {
            const direct = rule.match_type === reported.type && rule.match_unique_id === reported.uniqueId
            const age = rule.evaluated_at ? now - new Date(rule.evaluated_at).getTime() : Infinity
            // A report that names the rule always re-judges it. Anything else
            // only does so on the sweep interval, which is what stops a dead
            // leader going unnoticed without making every os report re-read the
            // fleet.
            if (!direct && age < SWEEP_INTERVAL_MS) continue
            const key = JSON.stringify([rule.match_type, rule.match_unique_id])
            const entry = byRow.get(key)
            if (entry) entry.rules.push(rule)
            else byRow.set(key, { type: rule.match_type, uniqueId: rule.match_unique_id, rules: [rule] })
        }
        if (!byRow.size) continue

        for (const { type: matchType, uniqueId: matchUniqueId, rules } of byRow.values()) {
            try {
                const members = await gatherMembers(client, ctx.memberIds, matchType, matchUniqueId)
                const now = Date.now()
                for (const rule of rules) {
                    const verdict = evaluateClusterService(rule, ctx.cluster, members, now)
                    await applyVerdict(fleet, client, ctx, rule, verdict)
                }
            } catch (e: any) {
                console.error(`clusters: evaluation failed for ${matchUniqueId}:`, e?.message || e)
            }
        }
    }
}
