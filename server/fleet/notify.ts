/**
 * The one place a notification is raised.
 *
 * Before this, the sequence "check for an unread duplicate → insert a
 * notifications row → mirror to push devices" was copy-pasted at eight sites
 * across the two ingest endpoints, with small differences at each one. Adding a
 * third delivery channel that way means editing eight call sites and getting one
 * of them subtly wrong, so the sequence lives here and the channels fan out from
 * a single list.
 *
 * Delivery is best-effort and never blocks ingest: a channel that errors is
 * logged and skipped, because a Slack outage must not fail a metrics push.
 */
import { postSlackMessage, resolveSlackMessage } from "~/server/utils/slack"
import { deliverWebhook } from "~/server/utils/webhook"
import type { FleetCtx } from "./ctx"

export type NotifyType = "error" | "warning" | "info" | "success"

/** Severity ordering, shared by notification types and a channel's min_level. */
const RANK: Record<string, number> = { info: 1, success: 1, warning: 2, error: 3 }

/** How long after an alert resolves its recurrence is recorded but not delivered. */
const REALERT_COOLDOWN_MS = 30 * 60 * 1000

export interface NotifySystem {
    id: string
    name: string
    user_id: string
}

export interface NotifyInput {
    /** Service-role client; the call sites already hold one. */
    client: any
    system: NotifySystem
    title: string
    message: string
    type: NotifyType
    /** Plugin/source that raised it ("cloudflare", "logwatch", …). */
    source: string
    /**
     * Stable identity for this specific finding, stored on the row. Also the
     * dedupe key unless `dedupeOn` says otherwise.
     */
    sourceDetail: string
    /**
     * How to decide "already reported": by the exact finding (default), or by
     * severity alone, which collapses a whole source into one open alert. The
     * rollup sites use 'type'; per-finding sites use 'detail'.
     */
    dedupeOn?: "detail" | "type"
    /**
     * unique_id of the service a discrete finding came from, stored in
     * metadata.service. resolveClearedFindings() needs it: finding keys are
     * not scoped to a service, and one system runs several log watchers.
     */
    service?: string
    /**
     * What specifically changed, as label → value(s), stored in metadata.detail
     * and shown on the event's page. The message is one line for Slack; this
     * is where the full before/after goes, uncut.
     */
    detail?: Record<string, string | string[]>
    /**
     * client_states.id of the specific service, when known. The deep link then
     * lands on that service instead of the whole system (/systems/:id resolves
     * a service id first, then falls back to a system id).
     */
    serviceId?: string
}

/**
 * Raise a notification unless an unread one already covers it.
 *
 * @returns true if a row was written, false if it was deduped.
 */
export async function notify(ctx: FleetCtx, input: NotifyInput): Promise<boolean> {
    const { client, system } = input
    const title = input.title.slice(0, 200)
    const message = input.message.slice(0, 500)
    const dedupeOn = input.dedupeOn ?? "detail"

    // Keyed on resolved_at, NOT on `read`. Those are different questions:
    // `read` means the operator has seen it (the inbox marks it on click-through),
    // while resolved_at means the condition actually cleared. Deduping on `read`
    // meant opening an alert to investigate re-armed it, and the next agent report
    // raised a fresh CRIT for a fault nobody had touched.
    let q = client
        .from("notifications")
        .select("id")
        .eq("system_id", system.id)
        .eq("source", input.source)
        .is("resolved_at", null)
        .limit(1)
    q = dedupeOn === "type" ? q.eq("type", input.type) : q.eq("source_detail", input.sourceDetail)

    const { data: dupe, error: dupeError } = await q
    // FAIL CLOSED. This check used to ignore its error, and a null `data` reads
    // exactly like "no duplicate found" — so any failed read sent the alert
    // again. A Patroni failover kills in-flight queries, which is precisely when
    // this fired: same device, unchanged state, a fresh CRIT in Slack every time
    // the leader moved. Three unread rows with an identical
    // (system_id, source, source_detail) is the fingerprint.
    //
    // Suppressing a real alert is the better failure than crying wolf: the
    // condition is still true, so the next report raises it again a minute later.
    if (dupeError) {
        console.error("notify: dedupe check failed, suppressing to avoid a duplicate:", dupeError.message)
        return false
    }
    if (dupe && dupe.length) return false

    // Cooldown: the same alert resolved moments ago and is back. The event is
    // still recorded, so the history shows every recurrence, but nobody gets
    // paged again. Without this an IP hovering around the xmlrpc threshold
    // trips, clears and trips again, and each trip is a Slack message.
    // A failed read delivers: one extra message beats a silent recurrence.
    let cool = client
        .from("notifications")
        .select("id")
        .eq("system_id", system.id)
        .eq("source", input.source)
        .gte("resolved_at", new Date(Date.now() - REALERT_COOLDOWN_MS).toISOString())
        .limit(1)
    cool = dedupeOn === "type" ? cool.eq("type", input.type) : cool.eq("source_detail", input.sourceDetail)
    const { data: recent } = await cool
    const quiet = !!recent?.length

    const { data: row, error } = await client.from("notifications").insert({
        user_id: system.user_id,
        system_id: system.id,
        title,
        message,
        type: input.type,
        source: input.source,
        source_detail: input.sourceDetail,
        ...(input.service || input.detail
            ? { metadata: { ...(input.service ? { service: input.service } : {}), ...(input.detail ? { detail: input.detail } : {}) } }
            : {}),
        read: false,
        created_at: new Date().toISOString(),
    }).select("id").single()
    if (error) {
        // 23505 = unique_violation against notifications_open_alert_uniq (partial
        // on resolved_at is null). Another request won the race and already has
        // this alert open, which is the same outcome as the dedupe check above
        // hitting. Not an error worth logging.
        if ((error as any)?.code === "23505") return false
        console.error("notify: failed to insert notification:", error.message)
        return false
    }

    if (quiet) {
        console.log(`notify: ${input.source} ${input.sourceDetail} recurred inside the cooldown, recorded without paging`)
        return true
    }

    // Mirror to registered push devices (no-op if push is unconfigured).
    try {
        await ctx.push(system.user_id, {
            title,
            body: message,
            data: { system_id: system.id, type: input.type, source: input.source },
        })
    } catch (e: any) {
        console.error("notify: push delivery failed:", e?.message || e)
    }

    await fanOutToChannels(input, title, message, row?.id)
    return true
}

/**
 * Close the open alerts for a source that has recovered.
 *
 * An UNRESOLVED notification means "this is still wrong", and that is what
 * notify() dedupes against. Nothing used to clear them, so a container that went
 * unhealthy for ninety seconds left a CRIT sitting in the inbox indefinitely,
 * carrying no information beyond "something was once wrong".
 *
 * Stamping resolved_at rather than deleting keeps the history: the event still
 * happened and is still in the inbox, it just stops claiming to be current. It
 * also re-arms the dedupe, so a genuine recurrence alerts again instead of being
 * swallowed by the stale row.
 *
 * This is the ONLY thing that re-arms alerting. It used to be `read`, which the
 * inbox also sets when you click an alert to go and look at the system, so
 * investigating a fault made it page again on the next report. See
 * 20260902140000_notifications_resolved_at.sql.
 *
 * @returns how many were closed.
 */
export async function resolveNotifications(
    client: any,
    system: NotifySystem,
    source: string,
    // Several at once (a push's zones) in one query; an empty list closes nothing.
    sourceDetail?: string | string[],
): Promise<number> {
    if (Array.isArray(sourceDetail) && !sourceDetail.length) return 0
    try {
        const now = new Date().toISOString()
        // resolved_at is the recovery signal and the only thing that re-arms
        // alerting. read/read_at are still set so a cleared alert stops showing
        // as unread, but the inbox setting those alone no longer re-opens it.
        let q = client
            .from("notifications")
            .update({ read: true, read_at: now, resolved_at: now })
            .eq("system_id", system.id)
            .eq("source", source)
            .is("resolved_at", null)
        // Scope to the specific thing that recovered when we know it. One host
        // can run several docker projects; project A coming back must not clear
        // an alert that project B is still raising.
        if (Array.isArray(sourceDetail)) q = q.in("source_detail", sourceDetail)
        else if (sourceDetail) q = q.eq("source_detail", sourceDetail)

        const { data, error } = await q.select(RESOLVED_FIELDS)
        if (error) throw new Error(error.message)
        const n = data?.length || 0
        if (n) console.log(`notify: resolved ${n} open ${source} alert(s) for ${system.name}`)
        if (n) await fanOutResolved(client, system, data)
        return n
    } catch (e: any) {
        console.error("notify: could not resolve alerts:", e?.message || e)
        return 0
    }
}

/**
 * Close the findings a service has stopped reporting.
 *
 * Finding alerts (web/wordpress/logwatch) are keyed per finding, and
 * resolveNotifications() is called with the service's unique_id, which never
 * matches a finding key. So nothing closed them: 646 logwatch rows sat open,
 * "active" meant nothing, and an IP that came back was deduped against its own
 * months-old row and never alerted again.
 *
 * Only rows stamped with metadata.service are touched, so one log watcher's
 * quiet report cannot close another's findings.
 */
export async function resolveClearedFindings(
    client: any,
    system: NotifySystem,
    source: string,
    service: string,
    stillOpen: string[],
): Promise<number> {
    try {
        const { data: open, error } = await client
            .from("notifications")
            .select("id, source_detail")
            .eq("system_id", system.id)
            .eq("source", source)
            .eq("metadata->>service", service)
            .is("resolved_at", null)
        if (error) throw new Error(error.message)
        const ids = (open || []).filter((r: any) => !stillOpen.includes(r.source_detail)).map((r: any) => r.id)
        if (!ids.length) return 0
        const now = new Date().toISOString()
        const { data: closed, error: updateError } = await client
            .from("notifications")
            .update({ read: true, read_at: now, resolved_at: now })
            .in("id", ids)
            .select(RESOLVED_FIELDS)
        if (updateError) throw new Error(updateError.message)
        if (closed?.length) await fanOutResolved(client, system, closed)
        return ids.length
    } catch (e: any) {
        console.error("notify: could not resolve cleared findings:", e?.message || e)
        return 0
    }
}

/**
 * Close open alerts by their finding key alone, ignoring which system they were
 * filed against.
 *
 * Cluster alerts need this. A clustered service's alert is attributed to a
 * member host so it has somewhere to link, and the host that best represents the
 * fault moves — "running on pi5b" becomes "running nowhere" becomes "running on
 * pi5a". Scoping the resolve by system_id, the way the per-service path does,
 * would leave the first alert open forever once the fault moved on. The
 * source_detail carries the cluster service id, which is unique on its own.
 */
export async function resolveBySourceDetail(
    client: any,
    userId: string,
    source: string,
    sourceDetail: string,
): Promise<number> {
    try {
        const { data, error } = await client
            .from("notifications")
            .update({ read: true, read_at: new Date().toISOString() })
            .eq("user_id", userId)
            .eq("source", source)
            .eq("source_detail", sourceDetail)
            .eq("read", false)
            .select("id")
        if (error) throw new Error(error.message)
        return data?.length || 0
    } catch (e: any) {
        console.error("notify: could not resolve alerts by detail:", e?.message || e)
        return 0
    }
}

/**
 * Everyone who should hear about this system: its owner, plus anyone the owner
 * delegated MANAGER access to, whether that's a share of this one system or of
 * the whole account.
 *
 * Manager and not viewer, deliberately. Delegation has two roles, and the line
 * that makes sense for a push is whether you can do anything about it: a manager
 * was trusted to act, a viewer was given a window. Sending an alert into
 * someone's Slack is a claim on their attention, so it follows the first. One
 * line to widen if that turns out to be the wrong call.
 *
 * Group grants are excluded on purpose. A group share hands over specific
 * services, not the system, so a system-level alert — whose text can name any
 * service on the box — would tell a group grantee about things the rest of the
 * app correctly hides from them.
 */
async function recipientsFor(client: any, system: NotifySystem): Promise<string[]> {
    const ids = new Set<string>([system.user_id])
    try {
        // Tenant members with a manager or owner role cover the whole account,
        // which is what an account-level manager grant was. Then managers of
        // this one system. A member or grant without a user id is an invite
        // nobody has accepted yet, so there is no one to tell.
        const [account, direct] = await Promise.all([
            client
                .from("members")
                .select("user_id")
                .in("role", ["owner", "manager"])
                .not("user_id", "is", null),
            client
                .from("grants")
                .select("grantee_id")
                .eq("resource_type", "system")
                .eq("resource_id", system.id)
                .eq("role", "manager")
                .not("grantee_id", "is", null),
        ])
        for (const row of account.data || []) if (row?.user_id) ids.add(row.user_id)
        for (const row of direct.data || []) if (row?.grantee_id) ids.add(row.grantee_id)
    } catch (e: any) {
        // Fall back to the owner alone rather than dropping the alert entirely.
        console.error("notify: could not resolve delegated recipients:", e?.message || e)
    }
    return [...ids]
}

/** Enabled delivery channels of everyone entitled to hear about this system. */
async function channelsFor(client: any, system: NotifySystem, kind?: string): Promise<any[]> {
    try {
        const recipients = await recipientsFor(client, system)
        let q = client
            .from("notification_channels")
            .select("id, kind, enabled, min_level, config, user_id")
            .in("user_id", recipients)
            .eq("enabled", true)
        if (kind) q = q.eq("kind", kind)
        const { data, error } = await q
        if (error) throw new Error(error.message)
        return data || []
    } catch (e: any) {
        console.error("notify: could not load delivery channels:", e?.message || e)
        return []
    }
}

const RESOLVED_FIELDS = "id, title, message, type, source, source_detail, metadata, created_at, resolved_at"

/**
 * Tell webhooks an alert cleared, with the same id as its alert.raised event,
 * so whatever acted on the alert can close it. Slack gets no new message for a
 * recovery (a channel that also posts every recovery is twice as loud to read):
 * the alert's own message is edited instead, to say it resolved, when it
 * started and how long it lasted.
 */
async function fanOutResolved(client: any, system: NotifySystem, rows: any[]): Promise<void> {
    const all = await channelsFor(client, system)
    await editSlackResolved(system, rows, all.filter((c) => c.kind === "slack"))
    const hooks = all.filter((c) => c.kind === "webhook")
    if (!hooks.length) return
    const base = process.env.APP_URL?.replace(/\/$/, "")
    const delivered = new Set<string>()
    for (const row of rows) {
        for (const ch of hooks) {
            if ((RANK[row.type] ?? 1) < (RANK[ch.min_level] ?? 2)) continue
            const key = `${row.id}:${ch.config?.url}`
            if (delivered.has(key)) continue
            delivered.add(key)
            try {
                await deliverWebhook(ch.config, {
                    event: "alert.resolved",
                    id: row.id,
                    level: row.type,
                    title: row.title,
                    message: row.message,
                    source: row.source,
                    sourceDetail: row.source_detail,
                    system: { id: system.id, name: system.name },
                    service: row.metadata?.service,
                    url: base ? `${base}/systems/${system.id}/events/${row.id}` : undefined,
                    at: new Date().toISOString(),
                })
            } catch (e: any) {
                console.error(`notify: webhook ${ch.id} resolve delivery failed:`, e?.message || e)
            }
        }
    }
}

/** Rewrite each resolved alert's Slack messages (metadata.slack, recorded when it was raised). */
async function editSlackResolved(system: NotifySystem, rows: any[], slack: any[]): Promise<void> {
    const byId = new Map(slack.map((c) => [c.id, c]))
    for (const row of rows) {
        const posted: any[] = Array.isArray(row.metadata?.slack) ? row.metadata.slack : []
        for (const p of posted) {
            const token = byId.get(p.ch)?.config?.bot_token
            if (!token || !p.ts) continue
            const base = systemUrl(row.metadata?.serviceId || system.id)
            try {
                await resolveSlackMessage({
                    token, channel: p.channel, ts: p.ts,
                    title: row.title, message: row.message, level: row.type,
                    url: base ? `${base}/events/${row.id}` : undefined,
                    startedAt: row.created_at, resolvedAt: row.resolved_at || new Date().toISOString(),
                })
            } catch (e: any) {
                console.error(`notify: slack resolve edit on channel ${p.ch} failed:`, e?.message || e)
            }
        }
    }
}

/** Delivery channels for everyone entitled to hear about this system, filtered by severity. */
async function fanOutToChannels(input: NotifyInput, title: string, message: string, eventId?: string): Promise<void> {
    const { client, system } = input
    const channels = await channelsFor(client, system)
    if (!channels.length) return

    const rank = RANK[input.type] ?? 1
    // Straight to this event's own page, which names the finding and lists its
    // recurrences. The system page alone left the reader hunting for it.
    const base = systemUrl(input.serviceId || system.id)
    const url = base && eventId ? `${base}/events/${eventId}` : base
    // Two people can point their own connection at the same Slack channel — an
    // owner and the manager they delegated to, both alerting #notifications.
    // Deliver once per destination. Deduped after the severity filter, so a
    // channel that passes still wins over one that doesn't.
    const delivered = new Set<string>()
    // Where each Slack copy landed, so resolving can edit it in place.
    const posted: { ch: string; channel: string; ts: string }[] = []

    for (const ch of channels) {
        if (rank < (RANK[ch.min_level] ?? 2)) continue
        const destination = ch.kind === "slack"
            ? `slack:${ch.config?.team_id}:${ch.config?.channel_id}`
            : `webhook:${ch.config?.url}`
        if (delivered.has(destination)) continue
        delivered.add(destination)
        try {
            if (ch.kind === "slack") {
                const token = ch.config?.bot_token
                const channel = ch.config?.channel_id
                if (!token || !channel) continue
                const at = await postSlackMessage({ token, channel, title, message, level: input.type, url })
                if (at.ts) posted.push({ ch: ch.id, ...at })
            } else if (ch.kind === "webhook") {
                await deliverWebhook(ch.config, {
                    event: "alert.raised",
                    id: eventId,
                    level: input.type,
                    title,
                    message,
                    source: input.source,
                    sourceDetail: input.sourceDetail,
                    system: { id: system.id, name: system.name },
                    service: input.service,
                    detail: input.detail,
                    url,
                    at: new Date().toISOString(),
                })
            }
        } catch (e: any) {
            // One bad channel must not stop the others, or the ingest request.
            console.error(`notify: ${ch.kind} channel ${ch.id} failed:`, e?.message || e)
        }
    }
    if (posted.length && eventId) {
        const metadata = {
            ...(input.service ? { service: input.service } : {}),
            ...(input.detail ? { detail: input.detail } : {}),
            ...(input.serviceId ? { serviceId: input.serviceId } : {}),
            slack: posted,
        }
        const { error } = await client.from("notifications").update({ metadata }).eq("id", eventId)
        if (error) console.error("notify: could not record slack message ids:", error.message)
    }
}

/** Deep link back to the system, for the Slack button and the webhook payload. */
function systemUrl(systemId: string): string | undefined {
    const base = process.env.APP_URL?.replace(/\/$/, "")
    return base ? `${base}/systems/${systemId}` : undefined
}
