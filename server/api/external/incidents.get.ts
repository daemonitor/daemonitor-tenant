import { runOp } from "../../utils/op"

export default defineEventHandler(async (event) => runOp(event, "external.incidents", { since: getQuery(event).since ? String(getQuery(event).since) : undefined, open: !!getQuery(event).open }, "key"))
