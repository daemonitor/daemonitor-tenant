import { runOp } from "../../../utils/op"

export default defineEventHandler(async (event) => runOp(event, "createKey", await readBody(event), "session"))
