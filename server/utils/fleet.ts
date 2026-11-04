import type { H3Event } from "h3"
import type { FleetDO } from "../fleet/FleetDO"

/** The tenant's one fleet DO. A tenant is one account, so there is only ever one. */
export function fleet(event: H3Event): DurableObjectStub<FleetDO> {
  const ns = (event.context.cloudflare.env as any).FLEET as DurableObjectNamespace<FleetDO>
  return ns.get(ns.idFromName("fleet"))
}
