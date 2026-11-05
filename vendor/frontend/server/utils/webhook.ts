/**
 * Webhook delivery channel: a signed JSON POST per alert raised and resolved.
 *
 * Signature: HMAC-SHA256 over `${timestamp}.${body}` with the channel's secret,
 * sent as `X-Daemonitor-Signature: t=<unix seconds>,v1=<hex>`. Signing the
 * timestamp with the body lets a receiver reject replays of an old delivery.
 *
 * Pure (Web Crypto and fetch only, no Nuxt imports) so it runs on Workers and
 * test/webhook.check.ts can drive it.
 */

export type WebhookEvent = "alert.raised" | "alert.resolved" | "test"

export interface WebhookPayload {
    event: WebhookEvent
    /** notifications.id; the same id on an alert's raised and resolved events. */
    id?: string
    level: string
    title: string
    message: string
    source?: string
    /** Stable identity of the finding, e.g. a service's unique_id or a finding key. */
    sourceDetail?: string
    system?: { id: string; name: string }
    /** unique_id of the service the alert came from, when known. */
    service?: string
    detail?: Record<string, string | string[]>
    url?: string
    at: string
}

const TIMEOUT_MS = 5000
const enc = new TextEncoder()
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("")

/** A new signing secret, shown to the user once. */
export function newWebhookSecret(): string {
    return `whsec_${hex(crypto.getRandomValues(new Uint8Array(24)).buffer)}`
}

export async function signWebhook(secret: string, timestamp: number, body: string): Promise<string> {
    const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
    return hex(await crypto.subtle.sign("HMAC", key, enc.encode(`${timestamp}.${body}`)))
}

/**
 * Why a URL can't be a webhook target, or null if it can. The server fetches
 * it, so anything that points back inside a network is refused: plain http,
 * localhost and internal names, and literal private, loopback or link-local IPs.
 */
export function webhookUrlProblem(raw: string): string | null {
    let u: URL
    try { u = new URL(raw) } catch { return "Not a valid URL" }
    if (u.protocol !== "https:") return "Webhook URLs must use https"
    if (u.username || u.password) return "Webhook URLs can't carry a username or password"
    const host = u.hostname.toLowerCase().replace(/\.+$/, "")
    // Every IPv6 literal, rather than a list of ranges to keep up with. A webhook on a
    // bare IPv6 address isn't a real use, and mapped forms can wrap any private address.
    if (host.startsWith("[")) return "Webhook URLs must point at a public host"
    if (host === "localhost" || !host.includes(".") || /\.(localhost|local|internal|intranet|lan|home|corp|arpa|test|invalid)$/.test(host)) {
        return "Webhook URLs must point at a public host"
    }
    // Public names that exist to resolve to whatever address is in them.
    if (/(^|\.)(nip\.io|sslip\.io|xip\.io|localtest\.me|lvh\.me)$/.test(host)) {
        return "Webhook URLs must point at a public host"
    }
    const v4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
    if (v4) {
        const [a, b, c] = [Number(v4[1]), Number(v4[2]), Number(v4[3])]
        if (
            a === 0 || a === 10 || a === 127 || a >= 224
            || (a === 100 && b >= 64 && b <= 127)
            || (a === 169 && b === 254)
            || (a === 172 && b >= 16 && b <= 31)
            || (a === 192 && b === 168)
            || (a === 192 && b === 0 && (c === 0 || c === 2))
            || (a === 198 && (b === 18 || b === 19))
            || (a === 198 && b === 51 && c === 100)
            || (a === 203 && b === 0 && c === 113)
        ) {
            return "Webhook URLs must point at a public address"
        }
    }
    return null
}

/** POST one signed payload. Throws with the reason on any non-2xx or timeout. */
export async function deliverWebhook(config: { url?: string; secret?: string }, payload: WebhookPayload): Promise<void> {
    if (!config?.url) throw new Error("No webhook URL stored")
    const problem = webhookUrlProblem(config.url)
    if (problem) throw new Error(problem)
    const body = JSON.stringify(payload)
    const timestamp = Math.floor(Date.now() / 1000)
    const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "User-Agent": "daemonitor-webhook/1",
        "X-Daemonitor-Event": payload.event,
    }
    // Rows created before signing existed have no secret; they still deliver.
    if (config.secret) headers["X-Daemonitor-Signature"] = `t=${timestamp},v1=${await signWebhook(config.secret, timestamp, body)}`
    const res = await fetch(config.url, { method: "POST", headers, body, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!res.ok) throw new Error(`Webhook returned ${res.status}`)
}
