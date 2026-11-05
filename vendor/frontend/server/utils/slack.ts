/**
 * Slack Web API calls for the notification channel.
 *
 * Deliberately dependency-free (plain fetch, no @slack/web-api) and fully
 * env-gated, the same shape as server/utils/push.ts: with no SLACK_CLIENT_ID /
 * SLACK_CLIENT_SECRET configured, `isSlackConfigured()` is false and the UI
 * hides the connect button, so the app runs identically without credentials.
 *
 * Setup, once, at https://api.slack.com/apps:
 *   1. Create an app "from scratch" in the workspace you own.
 *   2. OAuth & Permissions → Redirect URLs → add
 *        https://daemonitor.com/api/slack/callback
 *      (and http://localhost:3000/api/slack/callback for dev).
 *   3. OAuth & Permissions → Bot Token Scopes → chat:write, chat:write.public,
 *      channels:read, groups:read. chat:write.public is what lets the bot post to
 *      a public channel it has not been invited to; groups:read lets it see
 *      private channels, which it can only ever see or post to once someone
 *      invites it (/invite @daemonitor in the channel).
 *   4. Basic Information → App Credentials → set these on the server:
 *        SLACK_CLIENT_ID
 *        SLACK_CLIENT_SECRET
 *   5. To offer it to other workspaces, Manage Distribution → activate public
 *      distribution. Until then only your own workspace can install it.
 */

const SLACK_API = "https://slack.com/api"

export const SLACK_SCOPES = ["chat:write", "chat:write.public", "channels:read", "groups:read"].join(",")

export interface SlackInstall {
    teamId: string
    teamName: string
    botToken: string
    scope: string
    authedUser?: string
}

export interface SlackConversation {
    id: string
    name: string
    isPrivate: boolean
}

export function isSlackConfigured(): boolean {
    return Boolean(process.env.SLACK_CLIENT_ID && process.env.SLACK_CLIENT_SECRET)
}

export function slackClientId(): string {
    return process.env.SLACK_CLIENT_ID || ""
}

/**
 * Slack always answers 200 and signals failure in the body's `ok` field, so a
 * plain `response.ok` check would let every error through silently.
 *
 * Encoding is not a style choice. Write methods like chat.postMessage take JSON,
 * which is what lets `blocks` be a real array. The cursor-paginated read methods
 * do NOT: send them JSON and Slack ignores the body entirely and answers with
 * defaults — no error, just quietly wrong results. That is what hid every
 * private channel from the picker, since `types` fell back to public_channel,
 * and it silently broke pagination the same way. Read methods use form encoding.
 */
async function slackCall(
    method: string,
    token: string,
    body?: Record<string, unknown>,
    encoding: "json" | "form" = "json",
): Promise<any> {
    const isForm = encoding === "form"
    const res = await fetch(`${SLACK_API}/${method}`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": isForm
                ? "application/x-www-form-urlencoded; charset=utf-8"
                : "application/json; charset=utf-8",
        },
        body: isForm ? formEncode(body ?? {}) : JSON.stringify(body ?? {}),
    })
    const data = await res.json().catch(() => null)
    if (!data?.ok) {
        throw new Error(`slack ${method} failed: ${data?.error || res.status}`)
    }
    return data
}

function formEncode(body: Record<string, unknown>): string {
    const params = new URLSearchParams()
    for (const [k, v] of Object.entries(body)) {
        if (v === undefined || v === null) continue
        params.set(k, typeof v === "object" ? JSON.stringify(v) : String(v))
    }
    return params.toString()
}

/** Exchange the OAuth code for a bot token. Uses form encoding, as oauth.v2.access requires. */
export async function exchangeSlackCode(code: string, redirectUri: string): Promise<SlackInstall> {
    const params = new URLSearchParams({
        code,
        client_id: process.env.SLACK_CLIENT_ID || "",
        client_secret: process.env.SLACK_CLIENT_SECRET || "",
        redirect_uri: redirectUri,
    })
    const res = await fetch(`${SLACK_API}/oauth.v2.access`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
    })
    const data = await res.json().catch(() => null)
    if (!data?.ok) {
        throw new Error(`slack oauth.v2.access failed: ${data?.error || res.status}`)
    }
    if (!data.access_token) {
        throw new Error("slack oauth.v2.access returned no bot token")
    }
    return {
        teamId: String(data.team?.id || ""),
        teamName: String(data.team?.name || "Slack"),
        botToken: String(data.access_token),
        scope: String(data.scope || ""),
        authedUser: data.authed_user?.id ? String(data.authed_user.id) : undefined,
    }
}

/**
 * Channels available to the bot, for the channel picker.
 *
 * Public channels are all listed — chat:write.public means the bot can post to
 * any of them uninvited. Private channels are listed too, but Slack only returns
 * the ones the bot already belongs to, because a private channel is invisible to
 * non-members. So a private channel appears here only after someone runs
 * /invite @daemonitor in it — which is the same thing posting to it requires.
 *
 * Paginated: a workspace of any size returns a cursor, and stopping at the
 * first page would quietly hide most channels from the picker. Capped at 10
 * pages so a huge workspace can't stall the request.
 */
export async function listSlackConversations(token: string): Promise<SlackConversation[]> {
    const out: SlackConversation[] = []
    const seen = new Set<string>()
    let cursor: string | undefined
    for (let page = 0; page < 10; page++) {
        const data = await slackCall("conversations.list", token, {
            exclude_archived: true,
            types: "public_channel,private_channel",
            limit: 200,
            ...(cursor ? { cursor } : {}),
        }, "form")
        let fresh = 0
        for (const c of data.channels || []) {
            const id = String(c.id)
            if (seen.has(id)) continue
            seen.add(id)
            fresh++
            out.push({ id, name: String(c.name), isPrivate: Boolean(c.is_private) })
        }
        const next = data.response_metadata?.next_cursor || undefined
        // A cursor that doesn't advance means the page repeated — the symptom of
        // the parameters not landing. Stop rather than spin out the page budget
        // collecting the same channels.
        if (!next || next === cursor || fresh === 0) break
        cursor = next
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
}

const LEVEL_EMOJI: Record<string, string> = {
    error: ":red_circle:",
    warning: ":large_orange_diamond:",
    info: ":large_blue_circle:",
}

interface SlackAlert {
    token: string
    channel: string
    title: string
    message: string
    level: string
    url?: string
}

function alertBlocks(opts: Omit<SlackAlert, "token" | "channel">, emoji: string, title: string, footer?: string): any[] {
    const blocks: any[] = [
        {
            type: "section",
            text: { type: "mrkdwn", text: `${emoji} *${escapeSlack(title)}*\n${escapeSlack(opts.message)}` },
        },
    ]
    if (footer) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: footer }] })
    if (opts.url) {
        blocks.push({
            type: "actions",
            elements: [
                {
                    type: "button",
                    text: { type: "plain_text", text: "Open in daemonitor" },
                    url: opts.url,
                },
            ],
        })
    }
    return blocks
}

/**
 * Post one notification to a channel. Returns where it landed, so the message
 * can be edited when the alert resolves.
 *
 * `text` is set alongside the blocks because Slack uses it for the notification
 * preview and for clients that can't render blocks — blocks alone show up blank
 * in a phone banner.
 */
export async function postSlackMessage(opts: SlackAlert): Promise<{ channel: string; ts: string }> {
    const emoji = LEVEL_EMOJI[opts.level] || LEVEL_EMOJI.info
    const data = await slackCall("chat.postMessage", opts.token, {
        channel: opts.channel,
        text: `${opts.title} — ${opts.message}`,
        blocks: alertBlocks(opts, emoji, opts.title),
        unfurl_links: false,
        unfurl_media: false,
    })
    return { channel: String(data?.channel || opts.channel), ts: String(data?.ts || "") }
}

/** "45s", "12m", "2h 14m", "3d 4h". */
export function fmtDuration(ms: number): string {
    const s = Math.max(0, Math.round(ms / 1000))
    if (s < 60) return `${s}s`
    const m = Math.floor(s / 60)
    if (m < 60) return `${m}m`
    const h = Math.floor(m / 60)
    if (h < 48) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`
    const d = Math.floor(h / 24)
    return h % 24 ? `${d}d ${h % 24}h` : `${d}d`
}

/** Slack renders <!date^…> in each reader's own time zone; the text after | is the fallback. */
const slackDate = (iso: string) => {
    const t = Math.floor(Date.parse(iso) / 1000)
    return `<!date^${t}^{date_short_pretty} {time}|${new Date(t * 1000).toISOString().replace("T", " ").slice(0, 16)} UTC>`
}

/** The footer a resolved alert's message gets: when it started, how long it lasted, when it cleared. */
export function resolvedFooter(startedAt: string, resolvedAt: string): string {
    return `:white_check_mark: Resolved ${slackDate(resolvedAt)} · started ${slackDate(startedAt)} · lasted *${fmtDuration(Date.parse(resolvedAt) - Date.parse(startedAt))}*`
}

/** Rewrite a posted alert as resolved: same text, a check mark, and the outage's start and length. */
export async function resolveSlackMessage(opts: SlackAlert & { ts: string; startedAt: string; resolvedAt: string }): Promise<void> {
    const lasted = fmtDuration(Date.parse(opts.resolvedAt) - Date.parse(opts.startedAt))
    await slackCall("chat.update", opts.token, {
        channel: opts.channel,
        ts: opts.ts,
        text: `Resolved after ${lasted}: ${opts.title} — ${opts.message}`,
        blocks: alertBlocks(opts, ":white_check_mark:", `Resolved: ${opts.title}`, resolvedFooter(opts.startedAt, opts.resolvedAt)),
    })
}

/** Slack mrkdwn treats these three as markup; escape so hostnames and rules render literally. */
function escapeSlack(s: string): string {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}
