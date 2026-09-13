import { SCHEMA_V1, SCHEMA_VERSION, tableDef } from "./schema";
import type { KeyValue, TableStore } from "./table-store";

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((ok, fail) => {
    r.onsuccess = () => ok(r.result);
    r.onerror = () => fail(r.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((ok, fail) => {
    tx.oncomplete = () => ok();
    tx.onerror = () => fail(tx.error);
    tx.onabort = () => fail(tx.error ?? new Error("transaction aborted"));
  });
}

const keyPath = (cols: readonly string[]) => (cols.length === 1 ? cols[0]! : [...cols]);
const indexName = (cols: readonly string[]) => cols.join("+");
const keyOf = (values: readonly KeyValue[]) => (values.length === 1 ? values[0]! : [...values]);

/** IndexedDB fallback backend (plan.md §8) with the same tables and indexes as the SQL schema. */
export class IdbTableStore implements TableStore {
  readonly backend = "indexeddb" as const;

  private constructor(private readonly db: IDBDatabase) {}

  static open(name: string, factory: IDBFactory = indexedDB): Promise<IdbTableStore> {
    return new Promise((ok, fail) => {
      const r = factory.open(name, SCHEMA_VERSION);
      r.onupgradeneeded = () => {
        const db = r.result;
        for (const def of SCHEMA_V1) {
          if (db.objectStoreNames.contains(def.name)) continue;
          const store = db.createObjectStore(def.name, { keyPath: keyPath(def.key) });
          for (const idx of def.indexes) store.createIndex(indexName(idx), keyPath(idx));
        }
      };
      r.onsuccess = () => ok(new IdbTableStore(r.result));
      r.onerror = () => fail(r.error);
      r.onblocked = () => fail(new Error("IndexedDB upgrade blocked by another open connection"));
    });
  }

  private clean<T extends object>(table: string, row: T): T {
    // Only schema columns are stored, matching the SQL backend's behaviour.
    const def = tableDef(table);
    const out: Record<string, unknown> = {};
    for (const col of Object.keys(def.columns)) {
      const v = (row as Record<string, unknown>)[col];
      if (v !== undefined) out[col] = v;
    }
    return out as T;
  }

  async put<T extends object>(table: string, row: T): Promise<void> {
    const tx = this.db.transaction(table, "readwrite", { durability: "strict" });
    tx.objectStore(table).put(this.clean(table, row));
    await done(tx);
  }

  async putMany<T extends object>(table: string, rows: readonly T[]): Promise<void> {
    if (!rows.length) return;
    const tx = this.db.transaction(table, "readwrite", { durability: "strict" });
    const store = tx.objectStore(table);
    for (const row of rows) store.put(this.clean(table, row));
    await done(tx);
  }

  async get<T>(table: string, key: readonly KeyValue[]): Promise<T | undefined> {
    return (await req(this.db.transaction(table).objectStore(table).get(keyOf(key)))) as T | undefined;
  }

  async all<T>(table: string): Promise<T[]> {
    return (await req(this.db.transaction(table).objectStore(table).getAll())) as T[];
  }

  async where<T>(table: string, index: readonly string[], values: readonly KeyValue[]): Promise<T[]> {
    const def = tableDef(table);
    const store = this.db.transaction(table).objectStore(table);
    const isKey = def.key.length === index.length && def.key.every((k, i) => k === index[i]);
    if (isKey) {
      const row = await req(store.get(keyOf(values)));
      return row ? [row as T] : [];
    }
    return (await req(store.index(indexName(index)).getAll(keyOf(values)))) as T[];
  }

  async delete(table: string, key: readonly KeyValue[]): Promise<void> {
    const tx = this.db.transaction(table, "readwrite", { durability: "strict" });
    tx.objectStore(table).delete(keyOf(key));
    await done(tx);
  }

  async deleteWhere(table: string, index: readonly string[], values: readonly KeyValue[]): Promise<void> {
    const tx = this.db.transaction(table, "readwrite", { durability: "strict" });
    const store = tx.objectStore(table);
    const keys = await req(store.index(indexName(index)).getAllKeys(keyOf(values)));
    for (const k of keys) store.delete(k);
    await done(tx);
  }

  async deleteMany(table: string, keys: readonly (readonly KeyValue[])[]): Promise<void> {
    if (!keys.length) return;
    const tx = this.db.transaction(table, "readwrite", { durability: "strict" });
    const store = tx.objectStore(table);
    for (const k of keys) store.delete(keyOf(k));
    await done(tx);
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
