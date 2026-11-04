import { runOp } from "../../utils/op"

export default defineEventHandler(async (event) => runOp(event, "clusterSuggest", { clusterId: String(getQuery(event).cluster_id || "") }, "session"))
