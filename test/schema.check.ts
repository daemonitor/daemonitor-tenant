// Run: pnpm exec tsx test/schema.check.ts
// The migrations, applied in order, give the schema TABLES describes. Fails when
// TABLES changes without a new version appended to MIGRATIONS (or the reverse).
import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"
import { CURRENT_DDL, MIGRATIONS } from "../server/fleet/schema"

function shape(stmts: string[]) {
  const db = new DatabaseSync(":memory:")
  for (const s of stmts) db.exec(s)
  const tables = db.prepare("select name from sqlite_master where type in ('table','index') and name not like 'sqlite_%' order by name").all() as any[]
  return Object.fromEntries(tables.map((t) => [t.name, [
    db.prepare(`select name, type, "notnull", dflt_value, pk from pragma_table_info(?) order by name`).all(t.name),
    db.prepare(`select name, "unique", partial from pragma_index_list(?) order by name`).all(t.name),
  ]]))
}

assert.deepEqual(shape(MIGRATIONS.flat()), shape(CURRENT_DDL()))
console.log("schema check: ok")
