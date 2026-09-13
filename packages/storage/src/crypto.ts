import type { KeyKind } from "./repository";

/**
 * App-level AES-GCM encryption (plan.md §8, §11). Sealed format: [version=1][iv:12][ciphertext+tag].
 * Keys are non-extractable CryptoKeys; the durable key lives in IndexedDB (CryptoKey objects are
 * structured-cloneable there but cannot be stored in SQLite).
 */
export interface Sealer {
  readonly kind: KeyKind;
  seal(plain: Uint8Array): Promise<Uint8Array>;
  open(sealed: Uint8Array): Promise<Uint8Array>;
}

const VERSION = 1;

class AesGcmSealer implements Sealer {
  constructor(readonly kind: KeyKind, private readonly key: CryptoKey) {}

  async seal(plain: Uint8Array): Promise<Uint8Array> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, this.key, plain as BufferSource));
    const out = new Uint8Array(1 + iv.length + ct.length);
    out[0] = VERSION;
    out.set(iv, 1);
    out.set(ct, 1 + iv.length);
    return out;
  }

  async open(sealed: Uint8Array): Promise<Uint8Array> {
    if (sealed[0] !== VERSION) throw new Error(`unknown sealed format version ${sealed[0]}`);
    const iv = sealed.subarray(1, 13);
    const ct = sealed.subarray(13);
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as BufferSource }, this.key, ct as BufferSource));
  }
}

function generateKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]) as Promise<CryptoKey>;
}

function idbOpen(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((ok, fail) => {
    const r = factory.open(name, 1);
    r.onupgradeneeded = () => {
      if (!r.result.objectStoreNames.contains("keys")) r.result.createObjectStore("keys");
      if (!r.result.objectStoreNames.contains("records")) r.result.createObjectStore("records", { keyPath: "name" });
    };
    r.onsuccess = () => ok(r.result);
    r.onerror = () => fail(r.error);
  });
}

function idbTx<T>(db: IDBDatabase, store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((ok, fail) => {
    const t = db.transaction(store, mode, { durability: "strict" });
    const r = fn(t.objectStore(store));
    t.oncomplete = () => ok(r.result);
    t.onerror = () => fail(t.error);
    t.onabort = () => fail(t.error ?? new Error("aborted"));
  });
}

export class KeyVault {
  private constructor(private readonly db: IDBDatabase) {}

  static async open(factory: IDBFactory = indexedDB, name = "irl-keys"): Promise<KeyVault> {
    return new KeyVault(await idbOpen(factory, name));
  }

  /** Returns the named durable key, creating it on first use. */
  async key(name: string): Promise<CryptoKey> {
    const existing = await idbTx<CryptoKey | undefined>(this.db, "keys", "readonly", (s) => s.get(name) as IDBRequest<CryptoKey | undefined>);
    if (existing) return existing;
    const key = await generateKey();
    await idbTx(this.db, "keys", "readwrite", (s) => s.put(key, name));
    return key;
  }

  async durableSealer(name = "master-v1"): Promise<Sealer> {
    return new AesGcmSealer("durable", await this.key(name));
  }

  get database(): IDBDatabase {
    return this.db;
  }
}

/**
 * Non-persisted mode: a key that only ever exists in memory. If the app is killed, anything sealed with
 * it is unreadable, so crash leftovers are crypto-erased and simply deleted on the next launch.
 */
export async function ephemeralSealer(): Promise<Sealer> {
  return new AesGcmSealer("ephemeral", await generateKey());
}

export { idbOpen as openVaultDb, idbTx };
