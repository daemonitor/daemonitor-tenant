// MCP over HTTP for Claude and the CLI. The tools ask for /api/external/* paths;
// they're answered by the same operations those routes run, with the caller's
// own key, so MCP can never see more than the key can. (Not over HTTP: Nitro's
// internal fetch doesn't carry the Worker's bindings.)
import { handleMessage, type Call } from "~/server/utils/mcp"
import { apiKeyOf, runOp } from "../utils/op"
import { google } from "../utils/google"

export default defineEventHandler(async (event) => {
  if (event.method !== "POST") {
    setResponseHeader(event, "Allow", "POST")
    throw createError({ statusCode: 405, statusMessage: "Method Not Allowed" })
  }
  const key = apiKeyOf(event)
  if (!key) {
    setResponseHeader(event, "WWW-Authenticate", 'Bearer realm="daemonitor"')
    throw createError({ statusCode: 401, statusMessage: "API key required" })
  }
  // Refuse a bad key here rather than inside the first tool call.
  await runOp(event, "listKeys", {}, "key")
  const call: Call = (path, query = {}) => {
    const g = path.match(/^\/api\/google\/(inspect|publish|metadata)$/)
    if (g) return google(event, g[1], query)
    const [, kind, id, sub] = path.match(/^\/api\/external\/(fleet|systems|incidents|groups)(?:\/([^/]+))?(?:\/(history|events))?$/) || []
    const q = Object.fromEntries(Object.entries(query).filter(([, v]) => v !== undefined))
    const name =
      kind === "fleet" ? (id ? "external.fleetSystem" : "external.fleet")
      : kind === "systems" && id && sub === "history" ? "external.history"
      : kind === "systems" && id && sub === "events" ? "external.events"
      : kind === "incidents" ? "external.incidents"
      : kind === "groups" ? "external.groups"
      : null
    if (!name) throw createError({ statusCode: 404, message: `MCP asked for an unknown path: ${path}` })
    return runOp(event, name, { systemId: id, ...q, open: !!q.open }, "key")
  }
  const body = await readBody(event)
  if (Array.isArray(body)) {
    const replies = (await Promise.all(body.map((m) => handleMessage(m, call)))).filter(Boolean)
    if (!replies.length) { setResponseStatus(event, 202); return null }
    return replies
  }
  const reply = await handleMessage(body, call)
  if (!reply) { setResponseStatus(event, 202); return null }
  return reply
})
