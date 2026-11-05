// Agent enrollment.
//
// A token is a single-use bearer credential that an agent trades for its
// system key. Only its sha256 is stored, so a database leak yields nothing
// usable, and it is burned on first successful claim.

export const TOKEN_PREFIX = "dmk_enroll_"

/** An hour. Long enough to walk away and come back, short enough to matter. */
export const DEFAULT_TTL_MS = 60 * 60 * 1000

/**
 * Web Crypto, not node:crypto.
 *
 * These routes run on Cloudflare Workers in production, where node:crypto is
 * absent unless the compat flag is set. It resolves fine on the Node dev
 * server, so the failure only ever shows up after a deploy. push.ts already
 * reaches for crypto.subtle for the same reason.
 */
const bytesToHex = (bytes: Uint8Array): string =>
    [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")

const randomBase64Url = (length: number): string => {
    const bytes = crypto.getRandomValues(new Uint8Array(length))
    return btoa(String.fromCharCode(...bytes))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "")
}

export const randomHex = (length: number): string =>
    bytesToHex(crypto.getRandomValues(new Uint8Array(length)))

export const hashToken = async (token: string): Promise<string> => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))
    return bytesToHex(new Uint8Array(digest))
}

/**
 * Cryptographically random, URL-safe, and prefixed so it is obvious in a log
 * or a paste what kind of secret it is (and greppable when one leaks).
 */
export const generateEnrollmentToken = (): string => TOKEN_PREFIX + randomBase64Url(24)

/**
 * The durable per-system ingest credential.
 *
 * Was Math.random() over a 62-character alphabet, which is predictable: V8's
 * PRNG state is recoverable from a handful of outputs, and this key is the only
 * thing standing between a stranger and writing to someone's fleet.
 */
export const generateSystemKey = (): string => randomBase64Url(24)

/** Plugins an agent can run with no credentials of its own. */
const ZERO_CONFIG_PLUGINS = new Set(["os", "pm2", "docker", "lxc", "web"])

interface PluginConfigContext {
    apiBaseUrl: string;
}

/**
 * A starting config block per plugin, mirroring client.config.json.example.
 *
 * Plugins that need an operator secret (ewelink, cloudflare) get a scaffold
 * with the field blank rather than being silently dropped: the agent should
 * show the operator what is missing instead of pretending the plugin is off.
 */
function pluginConfig(id: string, ctx: PluginConfigContext): Record<string, any> | null {
    const base = { name: id, uniqueId: id }

    switch (id) {
        case "os":
            return { ...base, refreshInterval: 30000 }
        case "pm2":
            return { ...base, refreshInterval: 10000, processes: [] }
        case "docker":
            return { ...base, refreshInterval: 60000, dockerBin: "docker", projects: [], exclude: [] }
        case "lxc":
            return { ...base, refreshInterval: 60000, lxcBin: "lxc", instances: [], exclude: [] }
        case "web":
            // Server-managed monitors: the agent fills in systemKey from its own
            // credentials, so the key never has to be written into this file.
            return {
                ...base,
                refreshInterval: 60000,
                configUrl: `${ctx.apiBaseUrl}/monitors/for-client`,
                endpoints: [],
            }
        case "mongodb":
            return { ...base, refreshInterval: 30000, uri: "mongodb://localhost:27017", databases: [] }
        case "cloudflare":
            return { ...base, refreshInterval: 60000, reportingKey: "", maxDataAge: 300000 }
        case "ewelink":
            return { ...base, refreshInterval: 10000, email: "", password: "", region: "us", devices: [] }
        default:
            return null
    }
}

/**
 * Resolve the plugin list for a claim.
 *
 * An operator's explicit choice wins. When they made no choice, fall back to
 * what the agent actually found on the box, filtered to plugins that can run
 * without further setup, so the first run produces data instead of a row of
 * half-configured integrations.
 */
export function resolvePlugins(chosen: string[], detected: string[]): string[] {
    const list = chosen?.length
        ? chosen
        : (detected || []).filter((id) => ZERO_CONFIG_PLUGINS.has(id))

    // "os" is the baseline: without it a system reports no CPU, memory or disk
    // and shows up in the fleet as an empty card.
    const unique = [...new Set(["os", ...list])]
    return unique
}

/** The full client.config.json an enrolled agent should start with. */
export function buildClientConfig(plugins: string[], ctx: PluginConfigContext): Record<string, any> {
    const config: Record<string, any> = {
        connectors: ["rest-api"],
        plugins,
    }

    for (const id of plugins) {
        const block = pluginConfig(id, ctx)
        if (block) config[id] = block
    }

    return config
}

/**
 * Mint an enrollment token for a user, creating the system unless one of
 * theirs is named: what the "Add a system" dialog does, and `daemonitor agent
 * install` through /api/external/enroll. Returns the command to run on the host.
 */
export async function mintEnrollment(
    svc: any,
    userId: string,
    opts: { systemId?: string; name?: string; plugins?: string[] },
    origin: string,
): Promise<{ systemId: string; token: string; expiresAt: string; command: string }> {
    const plugins = (opts.plugins || []).map(String).filter(Boolean)
    let systemId = opts.systemId
    // A blank name means the agent's hostname wins at claim time.
    const requestedName = (opts.name || "").trim()
    let autoname = !requestedName

    if (systemId) {
        // Regenerating for an existing system. Only its owner may do that:
        // a viewer with a share grant can see the system but must not be able
        // to mint credentials that write to it.
        const { data: existing } = await svc.from("systems").select("id, user_id").eq("id", systemId).maybeSingle()
        if (!existing) throw createError({ statusCode: 404, message: "System not found" })
        if (existing.user_id !== userId) throw createError({ statusCode: 403, message: "Not your system" })
        // The system already has whatever name it has.
        autoname = false
    } else {
        const name = requestedName || "Awaiting agent"
        // The random suffix only earns its place on the placeholder name, where
        // several unclaimed systems would otherwise collide on "awaiting-agent".
        // A name the operator actually typed keeps the slug they expect.
        const base = name.toLowerCase().replace(/[^\w-]+/g, "-")
        const slug = autoname ? `${base}-${randomHex(3)}` : base
        const { data: created, error } = await svc
            .from("systems")
            .insert({ user_id: userId, name, slug, key_hash: await hashToken(generateSystemKey()), status: "pending", status_reason: "Waiting for the agent to enroll" })
            .select("id")
            .single()
        if (error) throw createError({ statusCode: 500, message: error.message })
        systemId = created.id
    }

    const token = generateEnrollmentToken()
    const expiresAt = new Date(Date.now() + DEFAULT_TTL_MS).toISOString()
    const { error: tokenError } = await svc.from("enrollment_tokens").insert({
        user_id: userId,
        system_id: systemId,
        token_hash: await hashToken(token),
        plugins,
        autoname,
        expires_at: expiresAt,
    })
    if (tokenError) throw createError({ statusCode: 500, message: tokenError.message })

    const apiBaseUrl = origin + "/api"
    // The default endpoint is compiled into the agent, so it is only worth
    // spelling out when this deployment is somewhere else.
    const endpointFlag = apiBaseUrl === "https://daemonitor.com/api" ? "" : ` --endpoint ${apiBaseUrl}`
    return { systemId: systemId!, token, expiresAt, command: `npx @daemonitor/client --token ${token}${endpointFlag}` }
}
