// The app at daemonitor.com calls the tenant from the browser, so the tenant
// answers CORS for that origin only (plus any in APP_ORIGINS, comma-separated,
// for a local app in dev). No cookies are involved: requests carry a bearer
// token, so credentials stay off.
//
// Agents, the Cloudflare reporter and API keys don't send an Origin and are
// unaffected.

const DEFAULT_ORIGINS = ["https://daemonitor.com"]

export function allowedOrigin(request, env) {
  const origin = request.headers.get("origin")
  if (!origin) return null
  const extra = String(env?.APP_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean)
  return [...DEFAULT_ORIGINS, ...extra].includes(origin) ? origin : null
}

function corsHeaders(origin) {
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, PUT, OPTIONS",
    "access-control-allow-headers": "authorization, content-type, x-api-key",
    "access-control-max-age": "86400",
    vary: "Origin",
  }
}

/** A preflight's answer, or null if this isn't one. */
export function preflight(request, env) {
  if (request.method !== "OPTIONS") return null
  const origin = allowedOrigin(request, env)
  return origin ? new Response(null, { status: 204, headers: corsHeaders(origin) }) : new Response(null, { status: 403 })
}

/** The response with CORS headers added, when the request came from an allowed origin. */
export function withCors(request, env, response) {
  const origin = allowedOrigin(request, env)
  if (!origin || response.status === 101) return response
  const headers = new Headers(response.headers)
  for (const [k, v] of Object.entries(corsHeaders(origin))) headers.set(k, v)
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}
