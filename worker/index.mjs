// The tenant Worker: Nitro routes in front, one Durable Object holding the fleet.
// Nitro's output only exports a fetch handler, so the DO class is exported here.
import app from "../.output/server/index.mjs"
export { FleetDO } from "../server/fleet/FleetDO.ts"

export default app
