// Google Indexing API and Search Console calls for the MCP tools, on the
// tenant's own service account: secret GOOGLE_SERVICE_ACCOUNT_JSON (the key
// file's JSON) and var GSC_SITE (the default property). Without the secret the
// tools answer "not configured" and nothing else changes.
import type { H3Event } from "h3"
import {
  SCOPES, accessToken, inProperty, inspectUrl, parseKey, publishUrl, urlMetadata, type NotifyType,
} from "../../vendor/plugins/plugins/monitoring/googleIndexing"
import { runOp } from "./op"

const fail = (statusCode: number, message: string) => createError({ statusCode, message })

export async function google(event: H3Event, op: string, q: Record<string, any>) {
  const env = event.context.cloudflare.env as any
  if (!env.GOOGLE_SERVICE_ACCOUNT_JSON) throw fail(501, "Google is not configured on this tenant: set the GOOGLE_SERVICE_ACCOUNT_JSON secret")
  const key = parseKey(env.GOOGLE_SERVICE_ACCOUNT_JSON)
  const url = String(q.url || "")
  if (!/^https?:\/\//.test(url)) throw fail(400, "url must be a full http(s) URL")
  const site = String(q.site || env.GSC_SITE || "")
  try {
    switch (op) {
      case "inspect":
        if (!site) throw fail(400, "No Search Console property: pass site, or set the GSC_SITE var")
        return await inspectUrl(await accessToken(key, [SCOPES.inspect]), url, site)
      case "publish": {
        // The only tool that writes outside daemonitor, so it takes a manage key
        // and stays inside the configured property.
        await runOp(event, "listKeys", {}, "manage-key")
        if (!env.GSC_SITE || !inProperty(url, env.GSC_SITE)) throw fail(400, `submit_url only takes URLs inside ${env.GSC_SITE || "the GSC_SITE property, which is not set"}`)
        const type: NotifyType = q.type === "URL_DELETED" ? "URL_DELETED" : "URL_UPDATED"
        return { type, ...(await publishUrl(await accessToken(key, [SCOPES.indexing]), url, type)) }
      }
      case "metadata": {
        const m = await urlMetadata(await accessToken(key, [SCOPES.indexing]), url)
        return m ? { ...m, recorded: true } : { url, recorded: false }
      }
    }
  } catch (e: any) {
    if (e?.statusCode) throw e
    // Google's own status goes in the text: a 403 here is Google refusing the
    // service account, not daemonitor refusing the caller's key.
    throw fail(502, `Google ${e?.status || ""} ${e?.message || e}`.trim())
  }
  throw fail(404, `Unknown Google operation: ${op}`)
}
