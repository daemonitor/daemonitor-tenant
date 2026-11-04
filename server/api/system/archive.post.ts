import { runOp } from "../../utils/op"

export default defineEventHandler(async (event) => runOp(event, "archiveSystem", await readBody(event), "session"))
