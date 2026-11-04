import { runOp } from "../../../../utils/op"

export default defineEventHandler(async (event) => runOp(event, "external.system", { systemId: getRouterParam(event, "systemId") }, "key"))
