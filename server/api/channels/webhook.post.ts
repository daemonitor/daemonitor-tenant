import { runOp } from "../../utils/op"

export default defineEventHandler(async (event) => runOp(event, "addWebhook", await readBody(event), "session"))
