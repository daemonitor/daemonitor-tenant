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
import { scopeOf, type Scope } from "./access"
import { listClientStates, listNotifications, listSystems, type NotificationQuery } from "./reads"
import { cfHistory, historyBatch, overviewHistory, probes, serviceHistory, suspects, systemEvents, type EventsQuery, type HistoryQuery } from "./history"
import { fromAttachment, liveMessage, LIVE_PROTOCOL, toAttachment, type LiveAttachment } from "./live"
import { HttpError, type FleetCtx } from "./ctx"

export type RpcResult<T> = { ok: true; value: T } | { ok: false; statusCode: number; message: string }

export class FleetDO extends DurableObject {
  private db: Db
  private fleetCtx: FleetCtx = {
    // ponytail: no push yet; it goes through daemonitor.com's relay once that exists.
    push: async () => {},
  }

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as any)
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.transactionSync(() => migrate(ctx.storage.sql))
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
