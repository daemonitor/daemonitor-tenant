// MCP server for daemonitor: a read-only view of the fleet for AI agents.
//
// Speaks the Streamable HTTP transport in its plain-JSON form: every request
// is one POST carrying a JSON-RPC message, answered with one JSON body. That
// is all a request/response server needs, and it runs on Workers, where the
// SDK's Node-stream transport doesn't.
//
// Every tool goes through the /api/external endpoints with the caller's API
// key (`call` below), so key checks, org scope and visibility live in one
// place and MCP can't see more than the external API does.
//
// Pure on purpose: no Nuxt imports, so test/mcp.check.ts can drive it.

import { scopeToDomain } from "../../utils/fleetAdapter"

export type Call = (path: string, query?: Record<string, string | number | undefined>) => Promise<any>

const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]
export const SERVER_INFO = { name: "daemonitor", version: "1.0.0" }

const INSTRUCTIONS = `daemonitor monitors hosts, containers, websites, office networks and cloud services.
Start with fleet_status: it lists every problem across the fleet with its reason.
Levels: ok, warn, crit, standby (correctly idle, e.g. a cluster follower). A service that stopped reporting is crit with an OFFLINE status.
Use get_system for one host's services, get_service_history for a trend, list_events for a system's past alerts, list_incidents for the operator's own write-ups.
Where the tenant holds a Google service account: inspect_url asks Search Console whether Google indexed a page, submit_url sends an Indexing API notification, indexing_history reads what Google recorded of past submits. A 200 from submit_url does not mean Google will crawl; inspect_url later is the check.
Through daemonitor.com this covers every account you can open: \`account\` names the one a row came from, and \`unreachable\` lists accounts that didn't answer.`

// ---- shaping ---------------------------------------------------------------

const RANK: Record<string, number> = { crit: 3, warn: 2, ok: 1, standby: 0 }
const worst = (levels: string[]) => levels.reduce((w, l) => ((RANK[l] ?? 0) > (RANK[w] ?? 0) ? l : w), "standby")

/** A Service cut down to what an agent needs to decide what to do. */
function service(s: any, systemName: string, detail = false) {
  const out: Record<string, unknown> = {
    id: s.id,
    name: s.name,
    system: systemName,
    kind: s.kindLabel,
    level: s.level,
    status: s.statusWord,
  }
  if (s.statusReason) out.reason = s.statusReason
  if (s.hasBars) { out.cpu = s.cpu; out.mem = s.mem }
  if (s.ping > 0) out.pingMs = s.ping
  if (typeof s.age === "number") out.ageSeconds = Math.round(s.age)
  const units: any[] = Array.isArray(s.units) ? s.units : []
  // Problems inside a service (one bad container in a compose project) are the
  // actionable part; the healthy rest only matters when asked for detail.
  const shown = detail ? units : units.filter((u) => u.level === "warn" || u.level === "crit")
  if (shown.length) out.units = shown.map((u) => ({ name: u.name, state: u.state, value: u.value, level: u.level }))
  if (detail && Array.isArray(s.metrics) && s.metrics.length) {
    out.metrics = s.metrics.map((m: any) => ({ label: m.label, value: m.value, level: m.level }))
  }
  return out
}

/** Find a system by id or by name (case-insensitive) in a /fleet response. */
function findSystem(fleet: any, ref: string) {
  const want = String(ref || "").trim().toLowerCase()
  const systems: any[] = fleet?.systems || []
  return systems.find((s) => s.id === ref) || systems.find((s) => String(s.name).toLowerCase() === want)
}

class ToolError extends Error {}

// ---- tools -----------------------------------------------------------------

const readOnly = { readOnlyHint: true, openWorldHint: false }

export const TOOLS = [
  {
    name: "fleet_status",
    title: "Fleet status",
    description: "What is wrong right now. Totals by level, one line per system, and every service that is not ok with the server's reason. Pass include_ok to list healthy services too.",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: "Only this system, by name or id." },
        include_ok: { type: "boolean", description: "Also list services that are ok or standby." },
      },
    },
    annotations: readOnly,
  },
  {
    name: "get_system",
    title: "One system",
    description: "Every service on one system with its level, status, units (containers, devices, checks) and metrics.",
    inputSchema: {
      type: "object",
      properties: { system: { type: "string", description: "System name or id." } },
      required: ["system"],
    },
    annotations: readOnly,
  },
  {
    name: "get_service_history",
    title: "Service history",
    description: "Recent samples for one service, oldest first: CPU and memory for hosts, response time for web checks, requests for Cloudflare. Use it to tell a spike from a trend.",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: "System name or id." },
        service: { type: "string", description: "Service name or id, as fleet_status or get_system returned it, or a plugin type such as os or docker when only one service on the system has it." },
        limit: { type: "number", description: "Number of samples, default 60, maximum 240." },
      },
      required: ["system", "service"],
    },
    annotations: readOnly,
  },
  {
    name: "list_incidents",
    title: "Incidents",
    description: "Incidents the operator wrote up and marked client-visible, newest first, with their timeline. Machine-raised alerts are not here; use list_events for those.",
    inputSchema: {
      type: "object",
      properties: {
        open: { type: "boolean", description: "Only incidents that have not ended." },
        since: { type: "string", description: "ISO timestamp. Only incidents updated since then." },
      },
    },
    annotations: readOnly,
  },
  {
    name: "list_events",
    title: "Alert history",
    description: "Machine-raised alerts for one system, newest first, open and resolved: severity, title, message, source, when it was raised and when it cleared.",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: "System name or id." },
        limit: { type: "number", description: "Number of alerts, default 50, maximum 200." },
        offset: { type: "number", description: "Skip this many of the newest, to page further back." },
        open: { type: "boolean", description: "Only alerts that have not resolved." },
      },
      required: ["system"],
    },
    annotations: readOnly,
  },
  {
    name: "inspect_url",
    title: "Inspect a URL in Search Console",
    description: "Google's view of one page: verdict, coverage state (e.g. \"Discovered - currently not indexed\"), last crawl time, fetch state, Google's chosen canonical, and the Search Console link for this inspection.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Full page URL." },
        site: { type: "string", description: "Search Console property, e.g. sc-domain:example.com. Defaults to the tenant's configured property." },
      },
      required: ["url"],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "submit_url",
    title: "Submit a URL to the Google Indexing API",
    description: "Send URL_UPDATED (new or changed page) or URL_DELETED for one URL inside the configured property. Needs a manage key. Counts against the 200 a day quota. Google accepts calls it then ignores, so check with inspect_url later.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Full page URL." },
        type: { type: "string", enum: ["URL_UPDATED", "URL_DELETED"], description: "Default URL_UPDATED." },
      },
      required: ["url"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "indexing_history",
    title: "Indexing API history for a URL",
    description: "The last URL_UPDATED and URL_DELETED notifications Google has on record for one URL. recorded: false means Google holds none, even if submits returned 200.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "Full page URL." } },
      required: ["url"],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "list_groups",
    title: "Groups",
    description: "The operator's groups (an app, a site, a cluster) with each member service's level, so you can see which app a problem belongs to.",
    inputSchema: { type: "object", properties: {} },
    annotations: readOnly,
  },
]

async function runTool(name: string, args: any, call: Call): Promise<unknown> {
  switch (name) {
    case "fleet_status": {
      const fleet = await call("/api/external/fleet")
      let systems: any[] = fleet.systems || []
      if (args.system) {
        const one = findSystem(fleet, args.system)
        if (!one) throw new ToolError(`No system named "${args.system}". Systems: ${systems.map((s) => s.name).join(", ")}`)
        systems = [one]
      }
      const all = systems.flatMap((sys) => (sys.services || []).map((s: any) => ({ ...service(s, sys.name), ...(sys.account ? { account: sys.account } : {}) })))
      const totals: Record<string, number> = { systems: systems.length, services: all.length, ok: 0, warn: 0, crit: 0, standby: 0 }
      for (const s of all) totals[s.level as string] = (totals[s.level as string] || 0) + 1
      const order = (s: any) => -(RANK[s.level] ?? 0)
      return {
        generatedAt: fleet.generatedAt,
        totals,
        systems: systems.map((sys) => ({
          id: sys.id,
          name: sys.name,
          account: sys.account,
          level: worst((sys.services || []).map((s: any) => s.level)),
          services: (sys.services || []).length,
          lastSeen: sys.last_seen,
        })),
        problems: all.filter((s) => s.level === "warn" || s.level === "crit").sort((a, b) => order(a) - order(b)),
        ...(fleet.unreachable?.length ? { unreachable: fleet.unreachable } : {}),
        ...(args.include_ok ? { healthy: all.filter((s) => s.level === "ok" || s.level === "standby") } : {}),
      }
    }

    case "get_system": {
      const fleet = await call("/api/external/fleet")
      const sys = findSystem(fleet, args.system)
      if (!sys) throw new ToolError(`No system named "${args.system}". Systems: ${(fleet.systems || []).map((s: any) => s.name).join(", ")}`)
      const one = await call(`/api/external/fleet/${sys.id}`)
      return {
        id: one.system.id,
        name: one.system.name,
        description: one.system.description || undefined,
        os: one.system.os || undefined,
        lastSeen: one.system.last_seen,
        services: (one.services || []).map((s: any) => service(s, one.system.name, true)),
      }
    }

    case "get_service_history": {
      const fleet = await call("/api/external/fleet")
      const sys = findSystem(fleet, args.system)
      if (!sys) throw new ToolError(`No system named "${args.system}".`)
      const want = String(args.service || "").trim().toLowerCase()
      const services: any[] = sys.services || []
      // Agents reach for the plugin type ("os", "docker") as often as the
      // name, so accept it when it picks out exactly one service.
      // A name or type matching several services is ambiguous (a web check and
      // a compose project can both be "shop"), so say so instead of guessing.
      const describe = (list: any[]) => list.map((s) => `${s.name} (${(s.plugins || [])[0]}, id ${s.id})`).join(", ")
      const byName = services.filter((s) => String(s.name).toLowerCase() === want)
      if (byName.length > 1) throw new ToolError(`${byName.length} services on ${sys.name} are named "${args.service}": ${describe(byName)}. Pass the id.`)
      const byType = services.filter((s) => (s.plugins || []).includes(want))
      const svc = services.find((s) => s.id === args.service)
        || byName[0]
        || (byType.length === 1 ? byType[0] : undefined)
      if (!svc && byType.length > 1) throw new ToolError(`${byType.length} services on ${sys.name} are "${want}": ${describe(byType)}. Pass one of those names or ids.`)
      if (!svc) throw new ToolError(`No service "${args.service}" on ${sys.name}. Services: ${services.map((s) => `${s.name} (${(s.plugins || [])[0]})`).join(", ")}`)
      const limit = Math.min(Math.max(Number(args.limit) || 60, 1), 240)
      const h = await call(`/api/external/systems/${sys.id}/history`, { state: svc.id, limit })
      return { system: sys.name, service: svc.name, label: h.label, unit: h.unit, points: h.points, ...(h.cpu?.length ? { cpu: h.cpu, mem: h.mem } : {}) }
    }

    case "list_incidents": {
      const r = await call("/api/external/incidents", { open: args.open ? 1 : undefined, since: args.since })
      return { incidents: r.incidents }
    }

    case "list_events": {
      const fleet = await call("/api/external/fleet")
      const sys = findSystem(fleet, args.system)
      if (!sys) throw new ToolError(`No system named "${args.system}". Systems: ${(fleet.systems || []).map((s: any) => s.name).join(", ")}`)
      const limit = Math.min(Math.max(Number(args.limit) || 50, 1), 200)
      const offset = Math.max(Number(args.offset) || 0, 0)
      const r = await call(`/api/external/systems/${sys.id}/events`, { limit, offset: offset || undefined, open: args.open ? 1 : undefined })
      return {
        system: sys.name,
        total: r.total,
        events: (r.events || []).map((e: any) => ({
          level: e.type, title: e.title, message: e.message, source: e.source, detail: e.source_detail || undefined,
          raisedAt: e.created_at, resolvedAt: e.resolved_at || undefined,
        })),
      }
    }

    case "inspect_url":
      return call("/api/google/inspect", { url: args.url, site: args.site })

    case "submit_url":
      return call("/api/google/publish", { url: args.url, type: args.type })

    case "indexing_history":
      return call("/api/google/metadata", { url: args.url })

    case "list_groups": {
      const [groups, fleet] = await Promise.all([call("/api/external/groups"), call("/api/external/fleet")])
      const byId = new Map<string, any>()
      for (const sys of fleet.systems || []) for (const s of sys.services || []) byId.set(s.id, { ...s, systemName: sys.name })
      return (groups || []).map((g: any) => {
        const members = (g.members || []).map((id: string) => byId.get(id)).filter(Boolean).map((s: any) => scopeToDomain(s, g.cf_zone))
        return {
          name: g.name,
          account: g.account,
          kind: g.kind || undefined,
          level: members.length ? worst(members.map((m: any) => m.level)) : undefined,
          members: members.map((m: any) => ({ name: m.name, system: m.systemName, kind: m.kindLabel, level: m.level, status: m.statusWord })),
        }
      })
    }
  }
  throw new ToolError(`Unknown tool: ${name}`)
}

// ---- JSON-RPC --------------------------------------------------------------

type Message = { jsonrpc: "2.0"; id?: string | number | null; method?: string; params?: any }

const result = (id: Message["id"], value: unknown) => ({ jsonrpc: "2.0" as const, id, result: value })
const failure = (id: Message["id"], code: number, message: string) => ({ jsonrpc: "2.0" as const, id: id ?? null, error: { code, message } })

/**
 * Handle one JSON-RPC message. Returns the response, or null for a
 * notification (no id), which the transport answers with 202 and no body.
 */
export async function handleMessage(msg: Message, call: Call) {
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return failure(msg?.id, -32600, "Invalid request")
  }
  const isNotification = msg.id === undefined || msg.id === null
  if (isNotification) return null

  switch (msg.method) {
    case "initialize": {
      const asked = msg.params?.protocolVersion
      return result(msg.id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      })
    }
    case "ping":
      return result(msg.id, {})
    case "tools/list":
      return result(msg.id, { tools: TOOLS })
    case "tools/call": {
      const name = msg.params?.name
      if (!TOOLS.some((t) => t.name === name)) return failure(msg.id, -32602, `Unknown tool: ${name}`)
      try {
        const value = await runTool(name, msg.params?.arguments || {}, call)
        return result(msg.id, { content: [{ type: "text", text: JSON.stringify(value) }] })
      } catch (e: any) {
        // Tool failures go back to the model as a result it can read and act on,
        // not as a protocol error it can't.
        const status = e?.statusCode || e?.response?.status
        const text = e instanceof ToolError ? e.message
          : status === 404 ? "Not found, or not visible to this API key."
          : status === 401 || status === 403 ? "The API key was rejected."
          : `daemonitor API error${status ? ` (${status})` : ""}: ${e?.message || e}`
        return result(msg.id, { content: [{ type: "text", text }], isError: true })
      }
    }
  }
  return failure(msg.id, -32601, `Method not found: ${msg.method}`)
}
