import { runOp } from "../../../utils/op"

export default defineEventHandler(async (event) => runOp(event, "external.fleetSystem", { systemId: getRouterParam(event, "systemId") }, "key"))
