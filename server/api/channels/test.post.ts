import { runOp } from "../../utils/op"

export default defineEventHandler(async (event) => runOp(event, "testChannel", await readBody(event), "session"))
