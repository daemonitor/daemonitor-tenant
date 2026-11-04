import { runOp } from "../../../../utils/op"

export default defineEventHandler(async (event) => runOp(event, "external.events", { systemId: getRouterParam(event, "systemId"), ...getQuery(event), open: !!getQuery(event).open }, "key"))
