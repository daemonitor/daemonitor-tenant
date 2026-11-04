import { runOp } from "../../utils/op"

export default defineEventHandler(async (event) => runOp(event, "archivable", { archived: getQuery(event).archived !== "false" }, "session"))
