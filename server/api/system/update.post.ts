import { runOp } from "../../utils/op"

export default defineEventHandler(async (event) => runOp(event, "updateSystem", await readBody(event), "session"))
