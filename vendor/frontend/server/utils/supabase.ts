/**
 * Verdict for one Supabase project report (plugins/.../SupabasePlugin.ts).
 * Pure, so test/supabase.check.ts can run it without a server.
 */
export interface SupabaseVerdict { status: "online" | "warning" | "error"; reason?: string }

/** Project states that are a step on the way to healthy, not a fault yet. */
const TRANSIENT = new Set(["COMING_UP", "RESTORING", "UPGRADING", "RESTARTING", "RESIZING", "PAUSING", "GOING_DOWN", "UNKNOWN"])

export function supabaseStatus(body: any): SupabaseVerdict {
    const label = String(body?.name || body?.ref || "Supabase")

    if (body?.error || body?.reachable === false) {
        return { status: "error", reason: `${label}: ${String(body?.error || "unreachable").slice(0, 160)}` }
    }

    // A paused project reports INACTIVE. Everything behind it is down, and it
    // stays down until someone restores it by hand.
    const project = body?.projectStatus ? String(body.projectStatus) : null
    if (project && project !== "ACTIVE_HEALTHY") {
        if (project === "INACTIVE") return { status: "error", reason: `${label}: project is paused` }
        return {
            status: TRANSIENT.has(project) ? "warning" : "error",
            reason: `${label}: project ${project.toLowerCase().replace(/_/g, " ")}`,
        }
    }

    const services: any[] = Array.isArray(body?.services) ? body.services : []
    const down = services.filter((s) => !s?.healthy)
    // The database being down takes every other service with it. Anything else
    // unhealthy leaves the project partly working.
    const dbDown = down.find((s) => s.name === "db" && s.status !== "COMING_UP")
    if (dbDown) return { status: "error", reason: `${label}: database unhealthy${dbDown.error ? `, ${dbDown.error}` : ""}`.slice(0, 200) }

    const m = body?.metrics || {}
    const disk = typeof m.diskPct === "number" ? m.diskPct : null
    if (disk != null && disk >= (Number(body.diskCritPct) || Infinity)) {
        return { status: "error", reason: `${label}: disk ${disk}% full` }
    }
    if (down.length) {
        return { status: "warning", reason: `${label}: ${down.map((s) => s.name).join(", ")} unhealthy`.slice(0, 200) }
    }
    if (disk != null && disk >= (Number(body.diskWarnPct) || Infinity)) {
        return { status: "warning", reason: `${label}: disk ${disk}% full` }
    }
    if (typeof m.connections === "number" && m.maxConnections) {
        const pct = Math.round((m.connections / m.maxConnections) * 100)
        if (pct >= (Number(body.connWarnPct) || Infinity)) {
            return { status: "warning", reason: `${label}: ${m.connections} of ${m.maxConnections} connections in use` }
        }
    }
    // A configured source failed while another answered: half a report.
    const errors: string[] = Array.isArray(body?.errors) ? body.errors : []
    if (errors.length) return { status: "warning", reason: `${label}: ${errors[0]}`.slice(0, 200) }

    return { status: "online" }
}
