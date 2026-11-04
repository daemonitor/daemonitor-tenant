/**
 * The tenant's whole fleet: one Durable Object, one SQLite database.
 *
 * Requests run one at a time inside it, which is what makes notify()'s
 * check-then-insert safe without a database round trip in between. The unique
 * index on open alerts is still there as a backstop.
 */
import { DurableObject } from "cloudflare:workers"
import { migrate } from "./schema"
import { sqlClient, type Db } from "./db"
import { ingest, type IngestRequest } from "./ingest"
import { cloudflarePush, type CloudflarePushRequest } from "./cloudflare"
import { claimEnrollment, claimTenant, mintEnrollment } from "./enroll"
import type { Identity } from "./jwt"
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
    this.db = sqlClient(ctx.storage.sql)
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
