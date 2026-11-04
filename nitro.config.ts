import { fileURLToPath } from "node:url"
import { defineNitroConfig } from "nitropack/config"

export default defineNitroConfig({
  srcDir: "server",
  preset: "cloudflare-module",
  compatibilityDate: "2025-10-01",
  cloudflare: { deployConfig: false, nodeCompat: true },
  alias: {
    // Pure modules (judgment, cluster evaluation, Slack, webhooks) still live in
    // the frontend checkout next door.
    // ponytail: cross-repo import; move them into common/ once the frontend is
    // on this stack and nothing else imports them from there.
    "~": fileURLToPath(new URL("../frontend", import.meta.url)),
  },
})
