import { DatabaseSync } from "node:sqlite";
import type { SqlDriver, SqlValue } from "../src/sql-store";

/** node:sqlite stand-in for Turso so the SQL backend runs under vitest. */
export function nodeSqliteDriver(path = ":memory:"): SqlDriver {
  const db = new DatabaseSync(path);
  return {
    kind: "sqlite-node",
    exec: async (sql) => void db.exec(sql),
    run: async (sql, params: readonly SqlValue[]) => void db.prepare(sql).run(...(params as never[])),
    all: async (sql, params: readonly SqlValue[]) => db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[],
    close: async () => db.close(),
  };
}
