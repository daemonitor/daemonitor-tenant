// node:sqlite standing in for a Durable Object's storage.sql, with the schema applied.
import { DatabaseSync } from "node:sqlite"
import { migrate } from "../server/fleet/schema"
import { sqlClient } from "../server/fleet/db"

export function freshSql(): SqlStorage {
  const raw = new DatabaseSync(":memory:")
  const sql = {
    exec(q: string, ...args: any[]) {
      const rows = raw.prepare(q).all(...args) as any[]
      const rowsWritten = /^\s*(insert|update|delete)/i.test(q) ? Number((raw.prepare("select changes() as n").get() as any).n) : 0
      return { toArray: () => rows, one: () => rows[0], rowsWritten }
    },
  } as unknown as SqlStorage
  migrate(sql)
  return sql
}

export const freshDb = () => sqlClient(freshSql())
