import { runOp } from "../../utils/op"

export default defineEventHandler(async (event) => runOp(event, "archiveService", await readBody(event), "session"))
