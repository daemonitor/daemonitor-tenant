// Cluster placement evaluation.
//
// Pure, and deliberately so: this is called from BOTH the ingest path (which
// raises the Slack alert) and the browser (which draws the card). The two must
// never disagree about whether a cluster is healthy, and the cheapest way to
// guarantee that is one function with no I/O in it. `now` is a parameter for the
// same reason: a Date.now() buried in here would make the browser's computed
// value depend on something Vue cannot track, and would make this untestable.
//
// The whole idea is that some services are placed ACROSS a set of hosts rather
// than run on all of them. Judged per host, a follow-the-leader singleton looks
// like an outage on every host that isn't currently the leader. Judged across
// the set it looks like what it is, and the case per-host monitoring can never
// see — the same singleton running on two hosts at once — finally shows up.

import type {
  Cluster,
  ClusterMemberStatus,
  ClusterService,
  ClusterVerdict,
  Level,
} from '~/types/fleet'

/**
 * How long a service row may go unmentioned before we stop believing it.
 * Matches the fleet adapter's own window for agent-backed types, so a member row
 * and the cluster verdict flip on the same schedule.
 */
export const SERVICE_STALE_AFTER = 300

/**
 * How long a SYSTEM may go quiet before its members' placement is unknowable.
 * Wider than the service window on purpose, and the same figure
 * reap_stale_services uses for "the agent is alive": a system reports every
 * 30-60s, so 15 minutes of silence is the machine, not a slow poll.
 */
export const SYSTEM_ALIVE_WITHIN = 900

/**
 * How long a recorded leader stays believable without reconfirmation.
 *
 * The patroni plugin reports every 30s, so three minutes of silence means no
 * member has confirmed a primary in a long time. Past that the answer is
 * "unknown", not "still whoever it was".
 */
export const LEADER_STALE_AFTER = 180

/** One member: its system row, and the client_states row matching the rule. */
export interface ClusterMemberInput {
  system: { id: string; name?: string | null; last_seen?: string | null }
  state?: {
    status?: string | null
    status_reason?: string | null
    updated_at?: string | null
    data?: any
  } | null
}

function secondsSince(ts: string | null | undefined, now: number): number {
  if (!ts) return Number.POSITIVE_INFINITY
  const t = new Date(ts).getTime()
  if (!Number.isFinite(t)) return Number.POSITIVE_INFINITY
  return Math.max(0, (now - t) / 1000)
}

/** Find one container inside a container-group payload, by compose service or name. */
function findContainer(data: any, container: string): any | undefined {
  const list: any[] = Array.isArray(data?.containers) ? data.containers : []
  return list.find((c) => c?.service === container || c?.name === container)
}

/** The container's own health word, for the member detail line. */
function containerDetail(c: any): string {
  if (!c.running) return String(c.state || 'stopped')
  const health = String(c.health || '').toLowerCase()
  return health && health !== 'healthy' ? health : 'running'
}

/**
 * Classify one member against one rule.
 *
 * The distinction that matters here is `absent` vs `unknown`. A member that is
 * checking in and simply isn't running the service is a follower: that is the
 * normal state of two thirds of a three-node cluster, and it must be silent. A
 * member whose agent has gone dark tells us nothing at all, and counting its
 * silence as "not running here" is how a cluster with two dead hosts would
 * report itself perfectly healthy on the strength of one surviving replica.
 *
 * `container` narrows the question to one container inside a compose project.
 * Omitted, the whole row answers.
 */
export function classifyMember(
  m: ClusterMemberInput,
  now: number,
  container?: string | null,
): ClusterMemberStatus {
  const base = { systemId: m.system.id, systemName: m.system.name || 'unknown' }
  const systemAlive = secondsSince(m.system.last_seen, now) <= SYSTEM_ALIVE_WITHIN
  const state = m.state
  const fresh = !!state && secondsSince(state.updated_at, now) <= SERVICE_STALE_AFTER

  // No row, or a row nobody has touched in a while.
  if (!state || !fresh) {
    // The agent is alive and has stopped mentioning this service, so it is gone
    // from this host. That is a follower, not a fault.
    if (systemAlive) return { ...base, state: 'absent' }
    return { ...base, state: 'unknown', detail: 'agent offline' }
  }

  // A rule scoped to one container answers from that container alone. A named
  // container missing from the payload reads as absent, which is exactly right:
  // `docker compose down renderer` removes it and leaves the project's other
  // containers reporting happily.
  if (container) {
    const list: any[] = Array.isArray(state.data?.containers) ? state.data.containers : []
    if (!list.length) return { ...base, state: 'unknown', detail: 'no container list' }
    const c = findContainer(state.data, container)
    if (!c) return { ...base, state: 'absent', detail: 'not present' }
    if (!c.running) return { ...base, state: 'absent', detail: containerDetail(c) }
    const detail = containerDetail(c)
    return { ...base, state: detail === 'running' ? 'running' : 'degraded', detail }
  }

  // Whole-row rule. For a container group, "placed here" means at least one of
  // its containers is up: a project scaled to zero is not running here.
  const data = state.data
  if (Array.isArray(data?.containers)) {
    const running = typeof data.running === 'number'
      ? data.running
      : data.containers.filter((c: any) => c?.running).length
    if (!running) return { ...base, state: 'absent', detail: 'stopped' }
    return {
      ...base,
      state: state.status === 'error' ? 'degraded' : 'running',
      detail: state.status_reason ? String(state.status_reason).slice(0, 80) : `${running} running`,
    }
  }

  // Everything else: the row's own status is the answer.
  const status = String(state.status || 'online').toLowerCase()
  if (status === 'error') return { ...base, state: 'degraded', detail: state.status_reason?.slice(0, 80) || 'error' }
  if (status === 'warning') return { ...base, state: 'degraded', detail: state.status_reason?.slice(0, 80) || 'degraded' }
  return { ...base, state: 'running', detail: 'online' }
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const names = (list: ClusterMemberStatus[]) => list.map((m) => m.systemName).join(', ')

type LeaderAware = Pick<Cluster, 'id' | 'kind' | 'leader_system_id' | 'leader_seen_at'>

/**
 * Judge one clustered service across its members.
 *
 * Returns a level and a line naming what is wrong. This does NOT apply the grace
 * window: that is the caller's job, because only the caller knows how long the
 * current verdict has been standing. Keeping the two apart is what lets the
 * browser render the true instantaneous state (a card that goes amber the moment
 * a failover starts) while the alerting path stays quiet until the fault has
 * actually persisted.
 */
export function evaluateClusterService(
  svc: ClusterService,
  cluster: LeaderAware,
  members: ClusterMemberInput[],
  now: number,
): ClusterVerdict {
  const statuses = members.map((m) => classifyMember(m, now, svc.match_container))

  // A leader identity nobody has confirmed in a while is not a leader identity.
  // It is whoever held the primary when the last patroni agent was still alive,
  // and enforcing a service onto that host is worse than admitting we don't
  // know: 'leader' degrades to 'singleton', which still catches the service
  // running nowhere and the service running twice.
  const leaderKnown = !!cluster.leader_system_id &&
    secondsSince(cluster.leader_seen_at, now) <= LEADER_STALE_AFTER
  for (const s of statuses) {
    if (leaderKnown && s.systemId === cluster.leader_system_id) s.leader = true
  }

  const running = statuses.filter((s) => s.state === 'running')
  const degraded = statuses.filter((s) => s.state === 'degraded')
  const unknown = statuses.filter((s) => s.state === 'unknown')
  // A degraded member IS placed here. It is running the service badly, which for
  // a singleton still occupies the slot. Counting it as absent would report
  // "running nowhere" for a service that is running, and would hide a genuine
  // second copy behind the first one's ill health.
  const placed = [...running, ...degraded]

  // The oldest member report behind this verdict. A cluster has no report time of
  // its own, so the weakest evidence is the honest thing to show as its age:
  // "computed from something at least this stale".
  const ages = members
    .map((m) => (m.state?.updated_at ? secondsSince(m.state.updated_at, now) : null))
    .filter((a): a is number => a != null && Number.isFinite(a))
  const oldestReportAge = ages.length ? Math.max(...ages) : undefined
  // The newest report, so consumers can show the evidence window rather than a
  // latency the verdict does not have.
  const freshestReportAge = ages.length ? Math.min(...ages) : undefined

  const verdict = (level: Level, reason: string): ClusterVerdict => ({
    serviceId: svc.id,
    clusterId: svc.cluster_id,
    name: svc.name,
    placement: svc.placement,
    level,
    reason,
    members: statuses,
    runningCount: placed.length,
    unknownCount: unknown.length,
    runningOn: placed.map((s) => s.systemName),
    oldestReportAge,
    freshestReportAge,
  })

  if (!statuses.length) return verdict('standby', 'no members')

  // 'leader' without a known leader is 'singleton' with a better name. Patroni
  // is the only thing that can name one; until it reports, "exactly one member
  // runs it" is the strongest true statement available.
  const placement = svc.placement === 'leader' && !leaderKnown ? 'singleton' : svc.placement

  switch (placement) {
    case 'leader': {
      const leader = statuses.find((s) => s.leader)
      const strays = placed.filter((s) => !s.leader)
      const onLeader = placed.some((s) => s.leader)
      if (strays.length) {
        return verdict('crit', onLeader
          ? `running on the leader AND on ${names(strays)}`
          : `running on ${names(strays)}, but the leader is ${leader?.systemName || 'unknown'}`)
      }
      if (!onLeader) {
        return unknown.length
          ? verdict('warn', `not running on any reporting member, ${plural(unknown.length, 'member')} offline`)
          : verdict('crit', `not running on the leader (${leader?.systemName || 'unknown'})`)
      }
      if (degraded[0]) return verdict('warn', `degraded on the leader: ${degraded[0].detail || 'unhealthy'}`)
      return verdict('ok', `running on the leader (${leader?.systemName})`)
    }

    case 'singleton': {
      if (placed.length > 1) {
        // The expensive one. Two copies of a singleton is invisible from inside
        // any single host and is what duplicated the Bluesky posts, so it names
        // the hosts rather than reporting a count and leaving you to go looking.
        return verdict('crit', `running on ${plural(placed.length, 'member')} at once (${names(placed)}), should be exactly one`)
      }
      if (!placed.length) {
        return unknown.length
          ? verdict('warn', `not running on any reporting member, ${plural(unknown.length, 'member')} offline`)
          : verdict('crit', `not running on any of ${plural(statuses.length, 'member')}`)
      }
      if (degraded[0]) return verdict('warn', `degraded on ${degraded[0].systemName}: ${degraded[0].detail || 'unhealthy'}`)
      return verdict('ok', `running on ${placed[0]?.systemName}`)
    }

    case 'all': {
      const missing = statuses.filter((s) => s.state === 'absent')
      if (missing.length) return verdict('crit', `missing on ${names(missing)}`)
      if (degraded.length) return verdict('warn', `degraded on ${names(degraded)}`)
      if (unknown.length) return verdict('warn', `${plural(unknown.length, 'member')} offline, cannot confirm`)
      return verdict('ok', `running on all ${statuses.length}`)
    }

    case 'quorum': {
      const need = Math.max(1, svc.min_running)
      if (placed.length < need) {
        return verdict('crit', `${placed.length}/${need} required members running` +
          (unknown.length ? `, ${plural(unknown.length, 'member')} offline` : ''))
      }
      // Above the floor but below full strength is the state a cluster survives
      // and should not stay in: losing one more member takes it down. etcd on two
      // voters is exactly this.
      if (placed.length < statuses.length) {
        return verdict('warn', `${placed.length}/${statuses.length} running, quorum is ${need} so there is no margin left`)
      }
      if (degraded.length) return verdict('warn', `degraded on ${names(degraded)}`)
      return verdict('ok', `${placed.length}/${statuses.length} running`)
    }
  }

  return verdict('standby', 'no placement rule')
}
