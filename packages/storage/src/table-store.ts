export type KeyValue = string | number;

/** Minimal persistence surface both backends implement; repositories are written once on top. */
export interface TableStore {
  readonly backend: "turso-opfs" | "sqlite-node" | "indexeddb" | "memory";
  put<T extends object>(table: string, row: T): Promise<void>;
  putMany<T extends object>(table: string, rows: readonly T[]): Promise<void>;
  get<T>(table: string, key: readonly KeyValue[]): Promise<T | undefined>;
  all<T>(table: string): Promise<T[]>;
  where<T>(table: string, index: readonly string[], values: readonly KeyValue[]): Promise<T[]>;
  delete(table: string, key: readonly KeyValue[]): Promise<void>;
  deleteMany(table: string, keys: readonly (readonly KeyValue[])[]): Promise<void>;
  deleteWhere(table: string, index: readonly string[], values: readonly KeyValue[]): Promise<void>;
  close(): Promise<void>;
}
