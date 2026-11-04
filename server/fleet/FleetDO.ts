/**
 * The tenant's whole fleet: one Durable Object, one SQLite database.
 *
 * Requests run one at a time inside it, which is what makes notify()'s
 * check-then-insert safe without a database round trip in between. The unique
 * index on open alerts is still there as a backstop.
 */
import { DurableObject } from "cloudflare:workers"
import { migrate } from "./schema"
import { sqlClient, type ChangeOp, type Db } from "./db"
import { ingest, type IngestRequest } from "./ingest"
import { cloudflarePush, type CloudflarePushRequest } from "./cloudflare"
import { claimEnrollment, claimTenant, mintEnrollment } from "./enroll"
import type { Identity } from "./jwt"
import { atLeast, roleOf, scopeOf, type Scope } from "./access"
import { listClientStates, listNotifications, listSystems, type NotificationQuery } from "./reads"
import { insert, list, makeCtx, remove, update, type ListQuery } from "./data"
import * as ops from "./ops"
import * as external from "./external"
import { ageOut, exportMonths, purgeClusterHistory, reapStaleServices, thinHistory } from "./maintenance"
import { cfHistory, historyBatch, overviewHistory, probes, serviceHistory, suspects, systemEvents, type EventsQuery, type HistoryQuery } from "./history"
import { fromAttachment, liveMessage, LIVE_PROTOCOL, toAttachment, type LiveAttachment } from "./live"
import { HttpError, type FleetCtx } from "./ctx"

const JOBS = ["reap", "thin", "clusterPurge", "archive"] as const
type Job = (typeof JOBS)[number]

/** The next :07 past the hour. */
function nextTick(now: number): number {
  const d = new Date(now)
  d.setUTCMinutes(7, 0, 0)
  if (d.getTime() <= now) d.setUTCHours(d.getUTCHours() + 1)
  return d.getTime()
}

export type OpAuth =
  | { kind: "session"; who: Identity }
  | { kind: "key"; key: string; want: "read" | "manage" }
  | { kind: "none" }

const scoped = (fn: (db: Db, scope: Scope, c: ops.OpCtx, a: any) => unknown) => (c: ops.OpCtx, a: any) => {
  if (!c.scope) throw new HttpError(401, "Sign in or use an API key")
  return fn(c.db, c.scope, c, a)
}

/** Every operation op() can run. The Worker's routes each name one. */
const OPS: Record<string, (c: ops.OpCtx, a: any) => unknown> = {
  monitorsForClient: ops.monitorsForClient,
  markRead: ops.markRead,
  createSystem: ops.createSystem,
  updateSystem: ops.updateSystem,
  archiveSystem: ops.archiveSystem,
  archiveService: ops.archiveService,
  archivable: ops.archivable,
  clusterSuggest: ops.clusterSuggest,
  listChannels: ops.listChannels,
  updateChannel: ops.updateChannel,
  deleteChannel: ops.deleteChannel,
  testChannel: ops.testChannel,
  addWebhook: ops.addWebhook,
  connectSlack: ops.connectSlack,
  slackChannels: ops.slackChannels,
  listKeys: ops.listKeys,
  createKey: ops.createKey,
  deleteKey: ops.deleteKey,
  // The archive's months are the tenant's; reading them is for members.
  archiveAccess: (c) => {
    if (!c.scope?.all) throw new HttpError(404, "Not found")
    return true
  },
  "external.fleet": scoped((db, scope) => external.fleet(db, scope)),
  "external.fleetSystem": scoped((db, scope, _c, a) => external.fleetSystem(db, scope, String(a.systemId))),
  "external.systems": scoped((db, scope) => external.systems(db, scope)),
  "external.system": scoped((db, scope, _c, a) => external.system(db, scope, String(a.systemId))),
  "external.events": scoped((db, scope, _c, a) => external.events(db, scope, String(a.systemId), a)),
  "external.history": scoped((db, scope, _c, a) => external.history(db, scope, String(a.systemId), String(a.state || ""), a.limit)),
  "external.groups": scoped(async (db, scope, c) => {
    const { data } = await db.from("grants").select("resource_id").eq("grantee_id", c.who!.sub).eq("resource_type", "group")
    return external.groups(db, scope, new Set((data || []).map((g: any) => g.resource_id)))
  }),
  "external.incidents": scoped((db, scope, _c, a) => external.incidents(db, scope, a)),
  "external.enroll": (c, a) => mintEnrollment(c.db, c.who!, a, String(a.origin)),
}

export type RpcResult<T> = { ok: true; value: T } | { ok: false; statusCode: number; message: string }

export class FleetDO extends DurableObject {
  private db: Db
  /**
   * Phone push goes through daemonitor.com, which holds the push credentials
   * and the devices. Sent in the background: a push must never hold up the
   * report that raised the alert.
   */
  private fleetCtx: FleetCtx = {
    push: async (userId, payload) => {
      const relay = (await this.ctx.storage.get("relay")) as { secret: string; origin: string } | undefined
      const issuer = String((this.env as any).DAEMONITOR_ISSUER || "https://daemonitor.com").replace(/\/$/, "")
      if (!relay) return
      this.ctx.waitUntil(
        fetch(`${issuer}/api/push/relay`, {
          method: "POST",
          headers: { authorization: `Bearer ${relay.secret}`, "x-daemonitor-tenant": relay.origin, "content-type": "application/json" },
          body: JSON.stringify({ userId, ...payload }),
        }).then((r) => { if (!r.ok) console.warn(`push relay: HTTP ${r.status}`) }, (e) => console.warn("push relay:", e?.message || e)),
      )
    },
  }

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as any)
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.transactionSync(() => migrate(ctx.storage.sql))
      if ((await ctx.storage.getAlarm()) == null) await ctx.storage.setAlarm(nextTick(Date.now()))
    })
    this.db = sqlClient(ctx.storage.sql, (table, op, rows) => this.broadcast(table, op, rows))
    // Answered by the runtime without waking the DO, so an idle tab's keepalive costs nothing.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"))
  }

  /**
   * A browser opening a live socket. Only reached through upgradeLive() in the
   * Worker, which has already checked the token and put the identity in a
   * header; nothing outside the Worker can address this DO.
   */
  async fetch(request: Request): Promise<Response> {
    const raw = request.headers.get("x-daemonitor-identity")
    if (!raw) return new Response("Not found", { status: 404 })
    const who = JSON.parse(raw) as Identity
    const scope = await scopeOf(this.db, who)
    if (!scope) return new Response("You don't have access to this tenant", { status: 403 })
    const [client, server] = Object.values(new WebSocketPair())
    this.ctx.acceptWebSocket(server)
    server.serializeAttachment(toAttachment(scope, who.exp ?? 0))
    return new Response(null, { status: 101, webSocket: client, headers: { "sec-websocket-protocol": LIVE_PROTOCOL } })
  }

  /** Every write to a watched table, out to every socket allowed to see it. */
  private broadcast(table: string, op: ChangeOp, rows: Record<string, any>[]) {
    const sockets = this.ctx.getWebSockets()
    if (!sockets.length) return
    const now = Math.floor(Date.now() / 1000)
    for (const ws of sockets) {
      const att = ws.deserializeAttachment() as LiveAttachment | null
      if (!att) continue
      if (att.exp && att.exp < now) {
        // The browser reconnects with a fresh token, which also picks up any
        // change in what this person may see.
        ws.close(4001, "token expired")
        continue
      }
      const scope = fromAttachment(att)
      for (const row of rows) {
        const msg = liveMessage(scope, table, op, row)
        if (msg) {
          try { ws.send(JSON.stringify(msg)) } catch { /* closing; the next broadcast skips it */ }
        }
      }
    }
  }

  async webSocketMessage() {
    // Browsers only ever send "ping", which the auto-response answers.
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string) {
    try { ws.close(code, reason) } catch { /* already closed */ }
  }

  /**
   * Housekeeping, once an hour at :07. Each job records when it last ran, so a
   * missed hour (a deploy, an outage) is caught up on the next one rather than
   * skipped until tomorrow. One failing job doesn't stop the others, and the
   * next alarm is always set.
   */
  async alarm() {
    try {
      await this.runJobs(Date.now())
    } finally {
      await this.ctx.storage.setAlarm(nextTick(Date.now()))
    }
  }

  private async runJobs(now: number, only?: Job) {
    const sql = this.ctx.storage.sql
    const d = new Date(now)
    const today = d.toISOString().slice(0, 10)
    const month = today.slice(0, 7)
    const state = ((await this.ctx.storage.get("jobs")) as Record<string, string>) || {}
    const out: Record<string, unknown> = {}
    const run = async (job: Job, due: boolean, fn: () => Promise<unknown> | unknown, stamp: string) => {
      if (only ? only !== job : !due) return
      try {
        out[job] = await fn()
        state[job] = stamp
      } catch (e: any) {
        out[job] = { error: e?.message || String(e) }
        console.error(`maintenance: ${job} failed:`, e)
      }
    }
    await run("reap", true, () => reapStaleServices(this.db, sql, now), d.toISOString())
    await run("thin", d.getUTCHours() >= 4 && state.thin !== today, () => thinHistory(sql, now), today)
    await run("clusterPurge", d.getUTCHours() >= 4 && state.clusterPurge !== today, () => purgeClusterHistory(sql, now), today)
    // A failed export leaves the month unstamped, so it's retried next hour, and
    // the age-out doesn't run: rows are never deleted before they're in R2.
    await run("archive", d.getUTCHours() >= 2 && state.archive !== month, async () => {
      const bucket = (this.env as any).ARCHIVE as R2Bucket | undefined
      if (!bucket) throw new Error("no ARCHIVE bucket bound")
      const r = await exportMonths(sql, bucket, now)
      if (!r.ok) throw new Error(`export incomplete: ${r.done.length} written, see the log`)
      return { ...r, agedOut: ageOut(sql, now) }
    }, month)
    await this.ctx.storage.put("jobs", state)
    if (Object.keys(out).length) console.log("maintenance:", JSON.stringify(out))
    return out
  }

  /** Run one job now, for an owner: catching up after an import, or checking the archive. */
  async runJob(who: Identity, job: Job) {
    return this.rpc("maintenance", async () => {
      if (!atLeast(await roleOf(this.db, who), "owner")) throw new HttpError(403, "Only the owner can run maintenance")
      if (!JOBS.includes(job)) throw new HttpError(400, `Unknown job, expected one of ${JOBS.join(", ")}`)
      return this.runJobs(Date.now(), job)
    })
  }

  /** The app's own records: list, insert, update by id, delete by id or match. */
  async data(who: Identity, op: "list" | "insert" | "update" | "delete", table: string, args: { id?: string; body?: any; query?: ListQuery }) {
    return this.rpc(`data ${op} ${table}`, () => this.scoped(who, async (scope) => {
      const c = await makeCtx(this.db, who, scope, scope.all ? scope.role : null)
      if (op === "list") return list(c, table, args.query)
      if (op === "insert") return insert(c, table, args.body)
      if (op === "update") return update(c, table, String(args.id || ""), args.body)
      return remove(c, table, args.body)
    }))
  }

  /**
   * Everything else the routes ask for, by name. Three kinds of caller:
   * a session the Worker already verified, an API key checked here against
   * this tenant's api_keys, or an agent that brings its own system key.
   */
  async op(auth: OpAuth, name: string, args: any = {}) {
    return this.rpc(name, async () => {
      const handler = OPS[name]
      if (!handler) throw new HttpError(404, `No such operation: ${name}`)
      let who: Identity | null = null
      if (auth.kind === "session") who = auth.who
      else if (auth.kind === "key") who = await ops.identifyKey(this.db, auth.key, auth.want)
      const scope = who ? await scopeOf(this.db, who) : null
      if (who && !scope) throw new HttpError(403, "You don't have access to this tenant")
      const c: ops.OpCtx = { db: this.db, sql: this.ctx.storage.sql, env: this.env, who, scope, role: scope?.all ? scope.role : null }
      return handler(c, args)
    })
  }

  private async scoped<T>(who: Identity, fn: (scope: Scope) => Promise<T>): Promise<T> {
    const scope = await scopeOf(this.db, who)
    if (!scope) throw new HttpError(403, "You don't have access to this tenant")
    return fn(scope)
  }

  async listSystems(who: Identity) {
    return this.rpc("system list", () => this.scoped(who, (s) => listSystems(this.db, s)))
  }

  async listClientStates(who: Identity) {
    return this.rpc("client state list", () => this.scoped(who, (s) => listClientStates(this.db, s)))
  }

  async listNotifications(who: Identity, q: NotificationQuery) {
    return this.rpc("notification list", () => this.scoped(who, (s) => listNotifications(this.db, s, q)))
  }

  async historyBatch(who: Identity, range: string) {
    return this.rpc("history batch", () => this.scoped(who, (s) => historyBatch(this.db, this.ctx.storage.sql, s, range)))
  }

  async overviewHistory(who: Identity, range: string) {
    return this.rpc("overview history", () => this.scoped(who, (s) => overviewHistory(this.db, this.ctx.storage.sql, s, range)))
  }

  async serviceHistory(who: Identity, q: HistoryQuery) {
    return this.rpc("service history", () => this.scoped(who, (s) => serviceHistory(this.db, s, q)))
  }

  async cfHistory(who: Identity, id: string, range: string) {
    return this.rpc("cf history", () => this.scoped(who, (s) => cfHistory(this.db, s, id, range)))
  }

  async suspects(who: Identity, id: string, range: string) {
    return this.rpc("suspects", () => this.scoped(who, (s) => suspects(this.db, s, id, range)))
  }

  async probes(who: Identity) {
    return this.rpc("probes", () => this.scoped(who, (s) => probes(this.db, s)))
  }

  async systemEvents(who: Identity, q: EventsQuery) {
    return this.rpc("system events", () => this.scoped(who, (s) => systemEvents(this.db, s, q)))
  }

  /**
   * An agent report. Errors come back as values: an exception crossing the RPC
   * boundary loses its status code, and a 404 for an unknown key is not a 500.
   */
  async ingest(req: IngestRequest): Promise<RpcResult<unknown>> {
    return this.rpc("ingest", () => ingest(this.db, this.fleetCtx, req))
  }

  /** A Cloudflare reporter's push. */
  async cloudflarePush(req: CloudflarePushRequest): Promise<RpcResult<unknown>> {
    return this.rpc("cloudflare push", () => cloudflarePush(this.db, this.fleetCtx, req))
  }

  /** The relay secret daemonitor.com handed over, and this tenant's origin to name itself with. Owner only. */
  async setRelaySecret(who: Identity, secret: string, origin: string) {
    return this.rpc("relay secret", async () => {
      if (!atLeast(await roleOf(this.db, who), "owner")) throw new HttpError(403, "Only the owner can set the relay secret")
      if (!/^rly_[0-9a-f]{64}$/.test(secret)) throw new HttpError(400, "That isn't a relay secret")
      await this.ctx.storage.put("relay", { secret, origin })
      return { success: true }
    })
  }

  /** The first owner, with the CLAIM_CODE set at deploy. */
  async claimTenant(who: Identity, code: string): Promise<RpcResult<unknown>> {
    return this.rpc("claim", () => claimTenant(this.db, who, code, (this.env as any).CLAIM_CODE))
  }

  async mintEnrollment(who: Identity, opts: { systemId?: string; name?: string; plugins?: string[] }, origin: string): Promise<RpcResult<unknown>> {
    return this.rpc("enroll", () => mintEnrollment(this.db, who, opts, origin))
  }

  async claimEnrollment(body: unknown, clientIp: string | null, origin: string): Promise<RpcResult<unknown>> {
    return this.rpc("enroll claim", () => claimEnrollment(this.db, body, clientIp, origin))
  }

  private async rpc<T>(what: string, fn: () => Promise<T>): Promise<RpcResult<T>> {
    try {
      return { ok: true, value: await fn() }
    } catch (e: any) {
      if (e instanceof HttpError) return { ok: false, statusCode: e.statusCode, message: e.message }
      console.error(`${what} failed:`, e)
      return { ok: false, statusCode: 500, message: e?.message || "Internal server error" }
    }
  }
}
