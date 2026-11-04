import { runOp } from "../../../../utils/op"

export default defineEventHandler(async (event) => runOp(event, "external.history", { systemId: getRouterParam(event, "systemId"), state: getQuery(event).state, limit: Number(getQuery(event).limit) || undefined }, "key"))
