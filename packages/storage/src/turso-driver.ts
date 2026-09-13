import type { SqlDriver, SqlValue } from "./sql-store";

interface TursoDatabase {
  exec(sql: string): Promise<void>;
  run(sql: string, ...params: unknown[]): Promise<unknown>;
  all(sql: string, ...params: unknown[]): Promise<Record<string, unknown>[]>;
  close(): Promise<void>;
}

/**
 * Turso (SQLite-compatible, Rust→WASM) persisted on OPFS. Its browser build does file I/O in its own
 * worker through SharedArrayBuffer, so it needs a cross-origin isolated page (plan.md §8).
 */
export async function openTursoDriver(name: string): Promise<SqlDriver> {
  if (!globalThis.crossOriginIsolated) throw new Error("Turso on OPFS needs a cross-origin isolated page (COOP/COEP)");
  const { connect } = (await import("@tursodatabase/database-wasm/vite")) as unknown as { connect(path: string): Promise<TursoDatabase> };
  const db = await connect(name);
  await db.exec("PRAGMA journal_mode = WAL");
  return {
    kind: "turso-opfs",
    exec: (sql) => db.exec(sql),
    run: async (sql, params: readonly SqlValue[]) => {
      await db.run(sql, ...params);
    },
    all: (sql, params: readonly SqlValue[]) => db.all(sql, ...params),
    close: () => db.close(),
  };
}
