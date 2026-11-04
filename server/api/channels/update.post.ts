import { runOp } from "../../utils/op"

export default defineEventHandler(async (event) => runOp(event, "updateChannel", await readBody(event), "session"))
