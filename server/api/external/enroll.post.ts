import { runOp } from "../../utils/op"

export default defineEventHandler(async (event) => runOp(event, "external.enroll", { ...(await readBody(event).catch(() => ({}))), origin: getRequestURL(event).origin }, "manage-key"))
