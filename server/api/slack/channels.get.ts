import { runOp } from "../../utils/op"

export default defineEventHandler(async (event) => runOp(event, "slackChannels", { id: String(getQuery(event).id || "") }, "session"))
