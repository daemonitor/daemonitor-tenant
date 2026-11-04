import { runOp } from "../../utils/op"

export default defineEventHandler(async (event) => runOp(event, "monitorsForClient", { key: getRequestHeader(event, "x-system-key") || String(getQuery(event).key || "") }, "none"))
