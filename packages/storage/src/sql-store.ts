import { parseSpec, snake, SQL_MIGRATIONS, tableDef, type TableDef } from "./schema";
import type { KeyValue, TableStore } from "./table-store";

export type SqlValue = string | number | null | Uint8Array;

/** The subset of a SQLite connection the repositories need. Implemented by Turso WASM and node:sqlite. */
export interface SqlDriver {
  readonly kind: "turso-opfs" | "sqlite-node";
  exec(sql: string): Promise<void>;
  run(sql: string, params: readonly SqlValue[]): Promise<void>;
  all(sql: string, params: readonly SqlValue[]): Promise<Record<string, unknown>[]>;
  close(): Promise<void>;
}

function toSql(value: unknown, type: string): SqlValue {
  if (value === undefined || value === null) return null;
  switch (type) {
    case "json":
      return JSON.stringify(value);
    case "bool":
      return value ? 1 : 0;
    case "blob":
      return value instanceof Uint8Array ? value : new Uint8Array(value as ArrayBuffer);
    default:
      return value as SqlValue;
  }
}

function fromSql(value: unknown, type: string): unknown {
  switch (type) {
    case "json":
      return typeof value === "string" ? JSON.parse(value) : value;
    case "bool":
      return Boolean(value);
    case "int":
    case "real":
      return typeof value === "bigint" ? Number(value) : value;
    case "blob":
      if (value instanceof Uint8Array) return new Uint8Array(value);
      if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
      if (value instanceof ArrayBuffer) return new Uint8Array(value);
      return value;
    default:
      return value;
  }
}

/** Serializes statements: SQLite connections are single-writer and Turso's promise API isn't reentrant. */
class Lock {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

export class SqlTableStore implements TableStore {
  private readonly lock = new Lock();

  private constructor(private readonly driver: SqlDriver) {}

  get backend() {
    return this.driver.kind;
  }

  static async open(driver: SqlDriver): Promise<SqlTableStore> {
    const store = new SqlTableStore(driver);
    await store.migrate();
    return store;
  }

  private async migrate(): Promise<void> {
    await this.driver.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    const applied = new Set((await this.driver.all("SELECT version FROM schema_migrations", [])).map((r) => Number(r.version)));
    for (const m of SQL_MIGRATIONS) {
      if (applied.has(m.version)) continue;
      await this.driver.exec("BEGIN");
      try {
        for (const s of m.statements) await this.driver.exec(s);
        await this.driver.run("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", [m.version, new Date().toISOString()]);
        await this.driver.exec("COMMIT");
      } catch (e) {
        await this.driver.exec("ROLLBACK").catch(() => undefined);
        throw e;
      }
    }
  }

  private rowToSql(def: TableDef, row: object): SqlValue[] {
    const r = row as Record<string, unknown>;
    return Object.entries(def.columns).map(([name, spec]) => toSql(r[name], parseSpec(spec).type));
  }

  private sqlToRow<T>(def: TableDef, sqlRow: Record<string, unknown>): T {
    const out: Record<string, unknown> = {};
    for (const [name, spec] of Object.entries(def.columns)) {
      const { type, mode } = parseSpec(spec);
      const v = sqlRow[snake(name)];
      if (v === null || v === undefined) {
        if (mode === "nullable") out[name] = null;
        continue;
      }
      out[name] = fromSql(v, type);
    }
    return out as T;
  }

  private upsertSql(def: TableDef): string {
    const cols = Object.keys(def.columns).map(snake);
    return `INSERT OR REPLACE INTO ${def.name} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`;
  }

  put<T extends object>(table: string, row: T): Promise<void> {
    const def = tableDef(table);
    return this.lock.run(() => this.driver.run(this.upsertSql(def), this.rowToSql(def, row)));
  }

  putMany<T extends object>(table: string, rows: readonly T[]): Promise<void> {
    if (!rows.length) return Promise.resolve();
    const def = tableDef(table);
    const sql = this.upsertSql(def);
    return this.lock.run(async () => {
      await this.driver.exec("BEGIN");
      try {
        for (const row of rows) await this.driver.run(sql, this.rowToSql(def, row));
        await this.driver.exec("COMMIT");
      } catch (e) {
        await this.driver.exec("ROLLBACK").catch(() => undefined);
        throw e;
      }
    });
  }

  private whereClause(columns: readonly string[]): string {
    return columns.map((c) => `${snake(c)} = ?`).join(" AND ");
  }

  async get<T>(table: string, key: readonly KeyValue[]): Promise<T | undefined> {
    const def = tableDef(table);
    const rows = await this.lock.run(() => this.driver.all(`SELECT * FROM ${def.name} WHERE ${this.whereClause(def.key)} LIMIT 1`, key));
    return rows[0] ? this.sqlToRow<T>(def, rows[0]) : undefined;
  }

  async all<T>(table: string): Promise<T[]> {
    const def = tableDef(table);
    const rows = await this.lock.run(() => this.driver.all(`SELECT * FROM ${def.name}`, []));
    return rows.map((r) => this.sqlToRow<T>(def, r));
  }

  async where<T>(table: string, index: readonly string[], values: readonly KeyValue[]): Promise<T[]> {
    const def = tableDef(table);
    const rows = await this.lock.run(() => this.driver.all(`SELECT * FROM ${def.name} WHERE ${this.whereClause(index)}`, values));
    return rows.map((r) => this.sqlToRow<T>(def, r));
  }

  delete(table: string, key: readonly KeyValue[]): Promise<void> {
    const def = tableDef(table);
    return this.lock.run(() => this.driver.run(`DELETE FROM ${def.name} WHERE ${this.whereClause(def.key)}`, key));
  }

  deleteMany(table: string, keys: readonly (readonly KeyValue[])[]): Promise<void> {
    if (!keys.length) return Promise.resolve();
    const def = tableDef(table);
    const sql = `DELETE FROM ${def.name} WHERE ${this.whereClause(def.key)}`;
    return this.lock.run(async () => {
      await this.driver.exec("BEGIN");
      try {
        for (const k of keys) await this.driver.run(sql, k);
        await this.driver.exec("COMMIT");
      } catch (e) {
        await this.driver.exec("ROLLBACK").catch(() => undefined);
        throw e;
      }
    });
  }

  deleteWhere(table: string, index: readonly string[], values: readonly KeyValue[]): Promise<void> {
    const def = tableDef(table);
    return this.lock.run(() => this.driver.run(`DELETE FROM ${def.name} WHERE ${this.whereClause(index)}`, values));
  }

  close(): Promise<void> {
    return this.lock.run(() => this.driver.close());
  }
}
