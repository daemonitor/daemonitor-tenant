// The tenant Worker: Nitro routes in front, one Durable Object holding the fleet.
// Nitro's output only exports a fetch handler, so the DO class is exported here,
// and the live socket is answered here too: an h3 handler can't return a 101.
import app from "../.output/server/index.mjs"
import { upgradeLive } from "../server/fleet/live.ts"
export { FleetDO } from "../server/fleet/FleetDO.ts"

export default {
  fetch(request, env, ctx) {
    if (new URL(request.url).pathname === "/api/live") {
      return upgradeLive(request, env, env.FLEET.get(env.FLEET.idFromName("fleet")))
    }
    return app.fetch(request, env, ctx)
  },
}
