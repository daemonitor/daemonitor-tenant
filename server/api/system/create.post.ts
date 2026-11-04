import { runOp } from "../../utils/op"

export default defineEventHandler(async (event) => runOp(event, "createSystem", await readBody(event), "session"))
