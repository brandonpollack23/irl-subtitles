import { crc32 } from "@irl/domain";

/** Sealed audio chunks and voice clips live outside the database (plan.md §8 "Audio blobs"). */
export interface BlobStore {
  readonly kind: "opfs" | "indexeddb" | "memory";
  write(path: string, bytes: Uint8Array): Promise<void>;
  read(path: string): Promise<Uint8Array | null>;
  delete(path: string): Promise<void>;
  deletePrefix(prefix: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}

/** Writes and reads back, comparing CRC-32, so the recovery cursor only advances over verified bytes. */
export async function writeVerified(store: BlobStore, path: string, bytes: Uint8Array): Promise<number> {
  const checksum = crc32(bytes);
  await store.write(path, bytes);
  const back = await store.read(path);
  if (!back || back.byteLength !== bytes.byteLength || crc32(back) !== checksum) {
    throw new Error(`blob verification failed for ${path}`);
  }
  return checksum;
}

export class MemoryBlobStore implements BlobStore {
  readonly kind = "memory" as const;
  readonly files = new Map<string, Uint8Array>();

  async write(path: string, bytes: Uint8Array) {
    this.files.set(path, bytes.slice());
  }
  async read(path: string) {
    return this.files.get(path)?.slice() ?? null;
  }
  async delete(path: string) {
    this.files.delete(path);
  }
  async deletePrefix(prefix: string) {
    for (const k of [...this.files.keys()]) if (k.startsWith(prefix)) this.files.delete(k);
  }
  async list(prefix: string) {
    return [...this.files.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
}

export class IdbBlobStore implements BlobStore {
  readonly kind = "indexeddb" as const;

  private constructor(private readonly db: IDBDatabase) {}

  static open(name = "irl-blobs", factory: IDBFactory = indexedDB): Promise<IdbBlobStore> {
    return new Promise((ok, fail) => {
      const r = factory.open(name, 1);
      r.onupgradeneeded = () => r.result.createObjectStore("blobs");
      r.onsuccess = () => ok(new IdbBlobStore(r.result));
      r.onerror = () => fail(r.error);
    });
  }

  private tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    return new Promise((ok, fail) => {
      const t = this.db.transaction("blobs", mode, { durability: "strict" });
      const r = fn(t.objectStore("blobs"));
      t.oncomplete = () => ok(r.result);
      t.onerror = () => fail(t.error);
    });
  }

  async write(path: string, bytes: Uint8Array) {
    await this.tx("readwrite", (s) => s.put(bytes.slice(), path));
  }
  async read(path: string) {
    const v = await this.tx<Uint8Array | undefined>("readonly", (s) => s.get(path) as IDBRequest<Uint8Array | undefined>);
    return v ? new Uint8Array(v) : null;
  }
  async delete(path: string) {
    await this.tx("readwrite", (s) => s.delete(path));
  }
  async deletePrefix(prefix: string) {
    await this.tx("readwrite", (s) => s.delete(IDBKeyRange.bound(prefix, `${prefix}￿`)));
  }
  async list(prefix: string) {
    const keys = await this.tx("readonly", (s) => s.getAllKeys(IDBKeyRange.bound(prefix, `${prefix}￿`)));
    return (keys as string[]).sort();
  }
}

interface WorkerReply {
  id: number;
  error?: string;
}

/**
 * OPFS files written through synchronous access handles in a dedicated worker, the durable write path
 * that works in both Chrome and Safari (Safari has no main-thread createWritable).
 */
export class OpfsBlobStore implements BlobStore {
  readonly kind = "opfs" as const;
  private readonly worker: Worker;
  private nextId = 1;
  private readonly pending = new Map<number, { ok: () => void; fail: (e: Error) => void }>();

  private constructor(private readonly root: string) {
    this.worker = new Worker(new URL("./opfs-blob.worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (e: MessageEvent<WorkerReply>) => {
      const p = this.pending.get(e.data.id);
      this.pending.delete(e.data.id);
      if (e.data.error) p?.fail(new Error(e.data.error));
      else p?.ok();
    };
  }

  /** Probes a real write/read so a WebView without sync access handles falls back to IndexedDB. */
  static async open(root = "irl"): Promise<OpfsBlobStore> {
    if (!navigator.storage?.getDirectory) throw new Error("OPFS unavailable");
    const store = new OpfsBlobStore(root);
    const probe = new Uint8Array([1, 2, 3, 4]);
    await writeVerified(store, ".probe", probe);
    await store.delete(".probe");
    return store;
  }

  private call(msg: Record<string, unknown>, transfer: Transferable[] = []): Promise<void> {
    const id = this.nextId++;
    return new Promise((ok, fail) => {
      this.pending.set(id, { ok, fail });
      this.worker.postMessage({ ...msg, id }, transfer);
    });
  }

  private full(path: string) {
    return `${this.root}/${path}`;
  }

  private async dirFor(path: string, create: boolean): Promise<{ dir: FileSystemDirectoryHandle; name: string } | null> {
    const parts = this.full(path).split("/").filter(Boolean);
    let dir = await navigator.storage.getDirectory();
    try {
      for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create });
    } catch {
      return null;
    }
    return { dir, name: parts[parts.length - 1]! };
  }

  write(path: string, bytes: Uint8Array): Promise<void> {
    const copy = bytes.slice().buffer;
    return this.call({ op: "write", path: this.full(path), data: copy }, [copy]);
  }

  async read(path: string): Promise<Uint8Array | null> {
    const loc = await this.dirFor(path, false);
    if (!loc) return null;
    try {
      const file = await (await loc.dir.getFileHandle(loc.name)).getFile();
      return new Uint8Array(await file.arrayBuffer());
    } catch {
      return null;
    }
  }

  async delete(path: string): Promise<void> {
    const loc = await this.dirFor(path, false);
    await loc?.dir.removeEntry(loc.name).catch(() => undefined);
  }

  async deletePrefix(prefix: string): Promise<void> {
    // Prefixes are directory paths ("rec_x/"), so removal is recursive on the directory.
    const trimmed = prefix.replace(/\/$/, "");
    const loc = await this.dirFor(trimmed, false);
    await loc?.dir.removeEntry(loc.name, { recursive: true }).catch(() => undefined);
  }

  async list(prefix: string): Promise<string[]> {
    const trimmed = prefix.replace(/\/$/, "");
    const loc = await this.dirFor(`${trimmed}/x`, false);
    if (!loc) return [];
    const out: string[] = [];
    const walk = async (dir: FileSystemDirectoryHandle, base: string) => {
      for await (const [name, handle] of (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
        const p = `${base}/${name}`;
        if (handle.kind === "directory") await walk(handle as FileSystemDirectoryHandle, p);
        else out.push(p);
      }
    };
    await walk(loc.dir, trimmed);
    return out.sort();
  }
}
