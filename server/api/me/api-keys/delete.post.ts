import { runOp } from "../../../utils/op"

export default defineEventHandler(async (event) => runOp(event, "deleteKey", await readBody(event), "session"))
