import { runOp } from "../../utils/op"

export default defineEventHandler(async (event) => runOp(event, "deleteChannel", await readBody(event), "session"))
