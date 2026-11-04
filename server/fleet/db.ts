/**
 * A Supabase-shaped query builder over the Durable Object's SQLite.
 *
 * The alerting code (ingest, notify, clusters, patroni) was written against
 * supabase-js and is subtle in ways that took production incidents to get right.
 * Rewriting each query by hand would risk changing that behaviour, so this
 * supports exactly the builder calls the server uses, and the code moves over
 * with its queries unchanged:
 *
 *   select(cols, { count, head }), insert, upsert({ onConflict, ignoreDuplicates }),
 *   update, delete, eq, neq, in, is, not(col, "is", null), gt, gte, lt, lte, like,
 *   or("a.eq.x,b.in.(y,z)"), filter(col, op, value), order, limit, range,
 *   single, maybeSingle
 *
 * Columns may be JSON paths: "data->machineId", "metadata->>service".
 * Results come back as { data, error, count }, never thrown. A unique-constraint
 * failure reports error.code "23505", which notify() treats as "already open".
 *
 * Anything else throws "unsupported" so a missed case fails loudly in tests,
 * not silently in production.
 */
import { COLUMNS, HAS_ID, type Columns } from "./schema"

type Row = Record<string, any>
type Result = { data: any; error: { message: string; code?: string } | null; count?: number | null }

export type ChangeOp = "INSERT" | "UPDATE" | "DELETE"
export type OnChange = (table: string, op: ChangeOp, rows: Row[]) => void

export interface Db {
  from(table: string): Query
}

const OPS: Record<string, string> = { eq: "=", neq: "!=", gt: ">", gte: ">=", lt: "<", lte: "<=", like: "like" }

/**
 * A column reference, possibly a JSON path ("data->script->usage"), as SQL.
 *
 * In a filter a path is always its scalar value (json_extract), which is what
 * the server compares against. In a select list, a path ending in `->` returns
 * JSON (parsed on read, as PostgREST returns jsonb) and one ending in `->>`
 * returns text.
 */
function colSql(table: string, col: string, inSelect = false): string {
  const m = col.match(/^(\w+)((?:->>?\w+)+)$/)
  if (m) {
    if (!COLUMNS[table]?.[m[1]]) throw new Error(`db: no column ${table}.${m[1]}`)
    const path = `$.${[...m[2].matchAll(/->>?(\w+)/g)].map((k) => k[1]).join(".")}`
    return inSelect && !m[2].match(/->>\w+$/) ? `(${m[1]} -> '${path}')` : `json_extract(${m[1]}, '${path}')`
  }
  if (!/^\w+$/.test(col) || !COLUMNS[table]?.[col]) throw new Error(`db: no column ${table}.${col}`)
  return col
}

function encode(kind: string | undefined, v: any): any {
  if (v === undefined) return null
  if (v === null) return null
  if (kind === "json") return JSON.stringify(v)
  if (kind === "bool") return v ? 1 : 0
  if (v instanceof Date) return v.toISOString()
  return v
}

function decode(cols: Columns, row: Row): Row {
  for (const k in row) {
    const kind = cols[k]
    const v = row[k]
    if (v == null) continue
    if (kind === "json") row[k] = JSON.parse(v)
    else if (kind === "bool") row[k] = !!v
  }
  return row
}

/** A comparison value: JSON paths compare against SQLite's extracted value. */
function filterValue(kind: string | undefined, isPath: boolean, v: any): any {
  if (isPath) return typeof v === "boolean" ? (v ? 1 : 0) : v
  if (kind === "bool") return v ? 1 : 0
  return v
}

class Query implements PromiseLike<Result> {
  private where: { sql: string; args: any[] }[] = []
  private orders: string[] = []
  private lim: number | null = null
  private off = 0
  private cols = "*"
  private returning: string | null = null
  private countMode: "exact" | null = null
  private headOnly = false
  private one: "single" | "maybe" | null = null
  private action: "select" | "insert" | "upsert" | "update" | "delete" = "select"
  private payload: Row[] = []
  private patch: Row = {}
  private conflict: string[] = []
  private ignoreDupes = false

  constructor(private sql: SqlStorage, private table: string, private onChange?: OnChange) {
    if (!COLUMNS[table]) throw new Error(`db: no table ${table}`)
  }

  private get kinds(): Columns {
    return COLUMNS[this.table]
  }

  select(cols = "*", opts?: { count?: "exact"; head?: boolean }) {
    if (this.action === "select") {
      this.cols = cols
      this.countMode = opts?.count ?? null
      this.headOnly = !!opts?.head
    } else this.returning = cols
    return this
  }

  insert(rows: Row | Row[]) {
    this.action = "insert"
    this.payload = Array.isArray(rows) ? rows : [rows]
    return this
  }

  upsert(rows: Row | Row[], opts?: { onConflict?: string; ignoreDuplicates?: boolean }) {
    this.action = "upsert"
    this.payload = Array.isArray(rows) ? rows : [rows]
    this.conflict = (opts?.onConflict || "id").split(",").map((s) => s.trim())
    this.ignoreDupes = !!opts?.ignoreDuplicates
    return this
  }

  update(patch: Row) {
    this.action = "update"
    this.patch = patch
    return this
  }

  delete() {
    this.action = "delete"
    return this
  }

  private add(col: string, op: string, v: any) {
    const isPath = col.includes("->")
    const kind = this.kinds[col]
    this.where.push({ sql: `${colSql(this.table, col)} ${OPS[op]} ?`, args: [filterValue(kind, isPath, v)] })
    return this
  }

  eq(col: string, v: any) { return this.add(col, "eq", v) }
  neq(col: string, v: any) { return this.add(col, "neq", v) }
  gt(col: string, v: any) { return this.add(col, "gt", v) }
  gte(col: string, v: any) { return this.add(col, "gte", v) }
  lt(col: string, v: any) { return this.add(col, "lt", v) }
  lte(col: string, v: any) { return this.add(col, "lte", v) }
  like(col: string, v: string) { return this.add(col, "like", v) }

  in(col: string, values: any[]) {
    if (!values.length) {
      this.where.push({ sql: "0", args: [] })
      return this
    }
    const kind = this.kinds[col]
    this.where.push({
      sql: `${colSql(this.table, col)} in (${values.map(() => "?").join(", ")})`,
      args: values.map((v) => filterValue(kind, col.includes("->"), v)),
    })
    return this
  }

  is(col: string, v: null | boolean) {
    if (v === null) this.where.push({ sql: `${colSql(this.table, col)} is null`, args: [] })
    else this.add(col, "eq", v)
    return this
  }

  not(col: string, op: string, v: any) {
    if (op === "is" && v === null) {
      this.where.push({ sql: `${colSql(this.table, col)} is not null`, args: [] })
      return this
    }
    throw new Error(`db: unsupported not(${op})`)
  }

  filter(col: string, op: string, v: any) {
    if (!OPS[op]) throw new Error(`db: unsupported filter op ${op}`)
    return this.add(col, op, v)
  }

  /** PostgREST's or() syntax, for the forms the server uses: col.op.value and col.in.(a,b). */
  or(expr: string) {
    const parts: string[] = []
    const args: any[] = []
    for (const term of expr.split(/,(?![^(]*\))/)) {
      const m = term.match(/^([\w>-]+)\.(\w+)\.(.*)$/)
      if (!m) throw new Error(`db: unsupported or() term ${term}`)
      const [, col, op, raw] = m
      if (op === "in") {
        const list = raw.replace(/^\(|\)$/g, "").split(",").filter(Boolean)
        parts.push(list.length ? `${colSql(this.table, col)} in (${list.map(() => "?").join(", ")})` : "0")
        args.push(...list)
      } else if (op === "is" && raw === "null") {
        parts.push(`${colSql(this.table, col)} is null`)
      } else if (OPS[op]) {
        parts.push(`${colSql(this.table, col)} ${OPS[op]} ?`)
        args.push(raw)
      } else throw new Error(`db: unsupported or() op ${op}`)
    }
    this.where.push({ sql: `(${parts.join(" or ")})`, args })
    return this
  }

  order(col: string, opts?: { ascending?: boolean; nullsFirst?: boolean }) {
    this.orders.push(`${colSql(this.table, col)} ${opts?.ascending === false ? "desc" : "asc"}`)
    return this
  }

  limit(n: number) {
    this.lim = n
    return this
  }

  range(from: number, to: number) {
    this.off = from
    this.lim = to - from + 1
    return this
  }

  single() {
    this.one = "single"
    return this
  }

  maybeSingle() {
    this.one = "maybe"
    return this
  }

  /** Select-list names whose value is JSON text from a `->` path, parsed on read. */
  private jsonPaths = new Set<string>()

  /** "a, b, alias:c, data->>x, deps:data->script->deployments" as a select list. */
  private selectList(cols: string): string {
    if (cols.trim() === "*") return "*"
    return cols.split(",").map((s) => s.trim()).filter(Boolean).map((c) => {
      const [alias, col] = c.includes(":") ? c.split(":").map((x) => x.trim()) : [null, c]
      const expr = colSql(this.table, col, true)
      const name = alias || (col.includes("->") ? col.split(/->>?/).pop()! : col)
      if (expr.endsWith("')") && expr.startsWith("(")) this.jsonPaths.add(name)
      return expr === name ? expr : `${expr} as ${name}`
    }).join(", ")
  }

  private whereSql(): { sql: string; args: any[] } {
    if (!this.where.length) return { sql: "", args: [] }
    return { sql: ` where ${this.where.map((w) => w.sql).join(" and ")}`, args: this.where.flatMap((w) => w.args) }
  }

  private tail(): string {
    let s = ""
    if (this.orders.length) s += ` order by ${this.orders.join(", ")}`
    if (this.lim != null) s += ` limit ${Math.max(0, this.lim | 0)}`
    else if (this.off) s += " limit -1"
    if (this.off) s += ` offset ${this.off | 0}`
    return s
  }

  private rows(query: string, args: any[]): Row[] {
    return this.sql.exec(query, ...args).toArray().map((r) => {
      const row = decode(this.kinds, { ...r })
      for (const k of this.jsonPaths) if (typeof row[k] === "string") row[k] = JSON.parse(row[k])
      return row
    })
  }

  private finish(data: Row[], count?: number | null): Result {
    if (this.one) {
      if (data.length > 1 || (this.one === "single" && data.length === 0)) {
        return { data: null, error: { message: `expected one row, got ${data.length}`, code: "PGRST116" }, count }
      }
      return { data: data[0] ?? null, error: null, count }
    }
    return { data, error: null, count }
  }

  private fill(row: Row): Row {
    const out: Row = {}
    for (const [k, v] of Object.entries(row)) {
      if (v === undefined) continue
      if (!this.kinds[k]) throw new Error(`db: no column ${this.table}.${k}`)
      out[k] = v
    }
    if (HAS_ID.has(this.table) && out.id == null) out.id = crypto.randomUUID()
    return out
  }

  private run(): Result {
    const w = this.whereSql()
    switch (this.action) {
      case "select": {
        let count: number | null = null
        if (this.countMode) {
          count = Number(this.sql.exec(`select count(*) as n from ${this.table}${w.sql}`, ...w.args).one().n)
        }
        if (this.headOnly) return { data: null, error: null, count }
        return this.finish(this.rows(`select ${this.selectList(this.cols)} from ${this.table}${w.sql}${this.tail()}`, w.args), count)
      }
      case "insert":
      case "upsert": {
        const out: Row[] = []
        for (const raw of this.payload) {
          const row = this.fill(raw)
          const keys = Object.keys(row)
          let q = `insert into ${this.table} (${keys.join(", ")}) values (${keys.map(() => "?").join(", ")})`
          if (this.action === "upsert") {
            const target = this.conflict.map((c) => colSql(this.table, c)).join(", ")
            const sets = keys.filter((k) => !this.conflict.includes(k) && k !== "id").map((k) => `${k} = excluded.${k}`)
            q += this.ignoreDupes || !sets.length
              ? ` on conflict (${target}) do nothing`
              : ` on conflict (${target}) do update set ${sets.join(", ")}`
          }
          out.push(...this.rows(`${q} returning *`, keys.map((k) => encode(this.kinds[k], row[k]))))
        }
        // An upsert can't tell which rows were new. The stores treat INSERT
        // as insert-or-replace by id, so that's what every write here says.
        this.emit("INSERT", out)
        return this.finish(this.returning ? this.project(out) : (this.one ? out : null) as any)
      }
      case "update": {
        const keys = Object.keys(this.patch).filter((k) => this.patch[k] !== undefined)
        for (const k of keys) if (!this.kinds[k]) throw new Error(`db: no column ${this.table}.${k}`)
        if (!keys.length) return { data: [], error: null }
        const q = `update ${this.table} set ${keys.map((k) => `${k} = ?`).join(", ")}${w.sql} returning *`
        const data = this.rows(q, [...keys.map((k) => encode(this.kinds[k], this.patch[k])), ...w.args])
        this.emit("UPDATE", data)
        return this.finish(this.returning ? this.project(data) : (null as any))
      }
      case "delete": {
        const data = this.rows(`delete from ${this.table}${w.sql} returning *`, w.args)
        this.emit("DELETE", data)
        return this.finish(this.returning ? this.project(data) : (null as any))
      }
    }
  }

  private emit(op: ChangeOp, rows: Row[]) {
    if (rows.length && this.onChange) this.onChange(this.table, op, rows)
  }

  /** A write's full returned rows cut down to what .select() asked for: plain columns, maybe aliased. */
  private project(rows: Row[]): Row[] {
    const cols = (this.returning || "*").trim()
    if (cols === "*") return rows
    const pick = cols.split(",").map((s) => s.trim()).filter(Boolean).map((c) => {
      const [alias, col] = c.includes(":") ? c.split(":").map((x) => x.trim()) : [c, c]
      if (!this.kinds[col]) throw new Error(`db: a write can only return plain columns, not ${c}`)
      return [alias, col] as const
    })
    return rows.map((r) => Object.fromEntries(pick.map(([alias, col]) => [alias, r[col]])))
  }

  then<A = Result, B = never>(ok?: ((r: Result) => A | PromiseLike<A>) | null, fail?: ((e: any) => B | PromiseLike<B>) | null) {
    let result: Result
    try {
      result = this.run()
    } catch (e: any) {
      const msg = String(e?.message || e)
      if (msg.startsWith("db: ")) return Promise.reject(e).then(ok, fail)
      result = { data: null, error: { message: msg, code: /UNIQUE constraint failed/i.test(msg) ? "23505" : undefined } }
    }
    return Promise.resolve(result).then(ok, fail)
  }
}

/**
 * `onChange` hears every row written, as full rows, after the write. It's the
 * fleet's change feed: the DO turns it into live updates for open browsers.
 */
export function sqlClient(sql: SqlStorage, onChange?: OnChange): Db {
  return { from: (table: string) => new Query(sql, table, onChange) }
}
