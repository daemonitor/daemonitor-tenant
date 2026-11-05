// How a Cloudflare Workers push turns into a status, shared by the account
// record and the workers record so the two can't disagree.

// Not real Workers: the per-script analytics use these as catch-all buckets for
// invocations that can't be attributed to a named script.
export const SENTINEL_SCRIPTS = new Set(["__unknown__", "unknown", "(unknown)"])

/**
 * Scripts currently erroring, worst first.
 *
 * Prefers the reporter's recent window over the 24h totals: an error stays in a
 * 24h sum for a full day, so judging health on it keeps an account degraded long
 * after the worker was fixed. Reporters that predate the recent window still
 * send only 24h totals, so fall back rather than call everything healthy.
 */
export function failingScripts(byScript: any): { script: string; errors: number; requests: number; recent: boolean }[] {
    const rows = Array.isArray(byScript) ? byScript : []
    const hasRecent = rows.some((r: any) => r?.recentErrors !== undefined)
    return rows
        .map((r: any) => ({
            script: String(r?.script || ""),
            errors: hasRecent ? Number(r?.recentErrors) || 0 : Number(r?.errors) || 0,
            requests: hasRecent ? Number(r?.recentRequests) || 0 : Number(r?.requests) || 0,
            recent: hasRecent,
        }))
        .filter((r) => r.script && !SENTINEL_SCRIPTS.has(r.script.toLowerCase()) && r.errors > 0)
        .sort((a, b) => b.errors - a.errors)
}

/**
 * The Workers issue to report, or null when there is nothing actionable.
 *
 * Driven entirely by the per-script breakdown, because that is the only part of
 * the push that can name a worker — and an alert that cannot name one is not
 * worth sending.
 *
 * It deliberately ignores `analytics.summary.totalErrors`, which used to be the
 * trigger and produced "Workers errors detected: 1". That number does not come
 * from Workers at all: the reporter builds it from
 * `pagesFunctionsInvocationsAdaptiveGroups` (Pages Functions), while `byScript`
 * comes from `workersInvocationsAdaptive` (Workers). A Pages Function error can
 * therefore never be attributed to a script, so the count sat at 1 for hours
 * while all three workers on the account reported zero, and any push whose
 * per-script query hiccuped (it returns [] on failure, silently) turned that
 * stale number into a page naming nothing.
 */
export function workersIssue(workers: any): string | null {
    if (!workers) return null
    if (workers.error) return `Workers error: ${workers.error}`
    const failing = failingScripts(workers.byScript)
    if (!failing.length) return null
    return `Worker errors: ${failing
        .slice(0, 3)
        .map((s) => `${s.script} (${s.errors}${s.requests ? `/${s.requests}` : ""})`)
        .join(", ")}${failing.length > 3 ? ` +${failing.length - 3} more` : ""}`.slice(0, 200)
}
