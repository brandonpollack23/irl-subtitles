import { connect, type Database } from "@tursodatabase/database-wasm/vite";
import { lsGet, lsSet } from "../report";
import { crc32 } from "../util/crc32";
import { OpfsAppender, opfsFile, opfsRemove } from "../util/opfs";
import { roundSummary, summarize } from "../util/stats";

const DB_NAME = "probe-storage.db";
const TORTURE_DB = "probe-torture.db";
const LS_ACKED = "probe.torture.ackedCounter";
const LS_TORTURE_RUNNING = "probe.torture.runningSince";

type Log = (...p: unknown[]) => void;

async function quota() {
  try {
    const e = await navigator.storage.estimate();
    return { quotaMiB: Math.round((e.quota ?? 0) / 2 ** 20), usageMiB: Math.round(((e.usage ?? 0) / 2 ** 20) * 10) / 10, persisted: await navigator.storage.persisted() };
  } catch (e) {
    return { error: String(e) };
  }
}

function pseudoPcm(bytes: number, seed: number): Uint8Array {
  // Speech-like entropy (not zeros) so any compression/dedup in the stack can't flatter results.
  const out = new Uint8Array(bytes);
  let x = seed * 2654435761 || 1;
  for (let i = 0; i < bytes; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}

let cryptoKey: CryptoKey | null = null;
async function encrypt(data: Uint8Array): Promise<Uint8Array> {
  cryptoKey ??= await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, cryptoKey, data as BufferSource));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return out;
}

async function openDb(name: string): Promise<Database> {
  const db = await connect(name);
  await db.exec("PRAGMA journal_mode = WAL");
  return db;
}

function idbOpen(): Promise<IDBDatabase> {
  return new Promise((ok, fail) => {
    const req = indexedDB.open("probe-storage-bench", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("chunks", { keyPath: "seq" });
    req.onsuccess = () => ok(req.result);
    req.onerror = () => fail(req.error);
  });
}

function idbPut(db: IDBDatabase, value: unknown): Promise<void> {
  return new Promise((ok, fail) => {
    const tx = db.transaction("chunks", "readwrite", { durability: "strict" });
    tx.objectStore("chunks").put(value);
    tx.oncomplete = () => ok();
    tx.onerror = () => fail(tx.error);
  });
}

export interface LatencyOptions {
  chunks: number;
  chunkSeconds: number;
  encrypt: boolean;
}

/**
 * Compares the three candidate audio-chunk layouts from plan.md §8 using
 * realistic 5 s PCM chunks: OPFS file + Turso row, Turso BLOB, IndexedDB record.
 */
export async function benchLatency(opts: LatencyOptions, log: Log) {
  const bytes = opts.chunkSeconds * 16000 * 2;
  const result: Record<string, unknown> = { options: opts, chunkBytes: bytes, quotaBefore: await quota() };

  const chunk = async (i: number) => {
    const raw = pseudoPcm(bytes, i + 1);
    const t0 = performance.now();
    const data = opts.encrypt ? await encrypt(raw) : raw;
    return { data, crc: crc32(data), cryptoMs: performance.now() - t0 };
  };

  // A. OPFS file per chunk, referenced + checksummed from Turso.
  log("A: OPFS chunk files + Turso rows…");
  {
    const db = await openDb(DB_NAME);
    await db.exec("DROP TABLE IF EXISTS audio_chunks; CREATE TABLE audio_chunks (recording_id TEXT, seq INTEGER, start_sample INTEGER, end_sample INTEGER, path TEXT, byte_length INTEGER, crc32 INTEGER, PRIMARY KEY (recording_id, seq))");
    const insert = await db.prepare("INSERT INTO audio_chunks VALUES (?, ?, ?, ?, ?, ?, ?)");
    const fileMs: number[] = [], dbMs: number[] = [], totalMs: number[] = [], cryptoMs: number[] = [];
    const w = new OpfsAppender();
    for (let i = 0; i < opts.chunks; i++) {
      const c = await chunk(i);
      cryptoMs.push(c.cryptoMs);
      const t0 = performance.now();
      const path = `bench/rec1/${String(i).padStart(6, "0")}.chunk`;
      await w.open(path);
      await w.append(c.data, true);
      await w.close();
      const t1 = performance.now();
      await insert.run("rec1", i, i * bytes / 2, (i + 1) * bytes / 2, path, c.data.byteLength, c.crc);
      const t2 = performance.now();
      fileMs.push(t1 - t0);
      dbMs.push(t2 - t1);
      totalMs.push(t2 - t0);
    }
    w.dispose();
    await db.close();
    result.opfsFilesPlusTurso = { fileMs: roundSummary(summarize(fileMs)), dbMs: roundSummary(summarize(dbMs)), totalMs: roundSummary(summarize(totalMs)), cryptoMs: roundSummary(summarize(cryptoMs)) };
  }

  // B. Chunks as BLOBs inside Turso.
  log("B: Turso BLOBs…");
  {
    const db = await openDb(DB_NAME);
    await db.exec("DROP TABLE IF EXISTS audio_blobs; CREATE TABLE audio_blobs (recording_id TEXT, seq INTEGER, data BLOB, crc32 INTEGER, PRIMARY KEY (recording_id, seq))");
    const insert = await db.prepare("INSERT INTO audio_blobs VALUES (?, ?, ?, ?)");
    const totalMs: number[] = [];
    for (let i = 0; i < opts.chunks; i++) {
      const c = await chunk(i);
      const t0 = performance.now();
      await insert.run("rec1", i, c.data, c.crc);
      totalMs.push(performance.now() - t0);
    }
    const check = await db.get("SELECT length(data) AS len, crc32 FROM audio_blobs WHERE seq = 0");
    await db.close();
    const dbFile = await opfsFile(DB_NAME);
    const walFile = await opfsFile(`${DB_NAME}-wal`);
    result.tursoBlobs = {
      totalMs: roundSummary(summarize(totalMs)),
      firstRowLength: check?.len,
      dbFileMiB: dbFile ? Math.round((dbFile.size / 2 ** 20) * 10) / 10 : null,
      walFileMiB: walFile ? Math.round((walFile.size / 2 ** 20) * 10) / 10 : null,
    };
  }

  // C. IndexedDB records (fallback backend).
  log("C: IndexedDB…");
  {
    const idb = await idbOpen();
    const totalMs: number[] = [];
    for (let i = 0; i < opts.chunks; i++) {
      const c = await chunk(i);
      const t0 = performance.now();
      await idbPut(idb, { seq: i, data: c.data.buffer, crc: c.crc });
      totalMs.push(performance.now() - t0);
    }
    idb.close();
    result.indexedDb = { totalMs: roundSummary(summarize(totalMs)) };
  }

  result.quotaAfter = await quota();
  log("latency bench done");
  return result;
}

export async function clearStorageSpike(log: Log): Promise<void> {
  for (const p of [DB_NAME, `${DB_NAME}-wal`, TORTURE_DB, `${TORTURE_DB}-wal`, "bench", "torture"]) {
    await opfsRemove(p).catch(() => undefined);
  }
  await new Promise<void>((ok) => {
    const req = indexedDB.deleteDatabase("probe-storage-bench");
    req.onsuccess = req.onerror = req.onblocked = () => ok();
  });
  localStorage.removeItem(LS_ACKED);
  localStorage.removeItem(LS_TORTURE_RUNNING);
  log("storage spike data cleared");
}

/**
 * Durability torture writer. Each committed transaction is acknowledged in
 * localStorage only after commit resolves, so after a force-stop every acked
 * counter must be present in the database. Every 20th row also writes an
 * audio-sized OPFS chunk file referenced by the row.
 */
export class TortureWriter {
  private stopRequested = false;
  counter = 0;

  constructor(private readonly onProgress: (counter: number, rowsPerSec: number) => void) {}

  async run(log: Log): Promise<void> {
    this.stopRequested = false;
    const db = await openDb(TORTURE_DB);
    await db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS rows (counter INTEGER PRIMARY KEY, payload BLOB NOT NULL, crc32 INTEGER NOT NULL, chunk_path TEXT, chunk_crc32 INTEGER, app_version TEXT, created_at TEXT)`);
    await db.run("INSERT OR IGNORE INTO meta VALUES ('created_by_version', ?)", __APP_VERSION__);
    await db.run("INSERT OR IGNORE INTO meta VALUES ('created_at', ?)", new Date().toISOString());
    const max = await db.get("SELECT COALESCE(MAX(counter), 0) AS m FROM rows");
    this.counter = Number(max?.m ?? 0);
    lsSet(LS_TORTURE_RUNNING, new Date().toISOString());
    log(`torture writer resuming at counter ${this.counter}`);

    const insert = await db.prepare("INSERT INTO rows VALUES (?, ?, ?, ?, ?, ?, ?)");
    const chunkWriter = new OpfsAppender();
    const started = performance.now();
    const startCounter = this.counter;
    while (!this.stopRequested) {
      const next = this.counter + 1;
      const payload = pseudoPcm(512 + (next % 3584), next);
      let chunkPath: string | null = null;
      let chunkCrc: number | null = null;
      if (next % 20 === 0) {
        const pcm = pseudoPcm(160_000, next);
        chunkPath = `torture/${String(next).padStart(9, "0")}.chunk`;
        await chunkWriter.open(chunkPath);
        await chunkWriter.append(pcm, true);
        await chunkWriter.close();
        chunkCrc = crc32(pcm);
      }
      await db.exec("BEGIN IMMEDIATE");
      await insert.run(next, payload, crc32(payload), chunkPath, chunkCrc, __APP_VERSION__, new Date().toISOString());
      await db.exec("COMMIT");
      this.counter = next;
      lsSet(LS_ACKED, String(next));
      if (next % 10 === 0) this.onProgress(next, ((next - startCounter) * 1000) / (performance.now() - started));
    }
    chunkWriter.dispose();
    await db.close();
    localStorage.removeItem(LS_TORTURE_RUNNING);
    log(`torture writer stopped cleanly at ${this.counter}`);
  }

  stop(): void {
    this.stopRequested = true;
  }
}

/** Launch-time check: was the torture writer killed rather than stopped? */
export function tortureWasInterrupted(): string | null {
  return lsGet(LS_TORTURE_RUNNING);
}

export async function verifyTorture(log: Log) {
  const acked = Number(lsGet(LS_ACKED) ?? "0");
  const interruptedSince = tortureWasInterrupted();
  const t0 = performance.now();
  let db: Database;
  try {
    db = await openDb(TORTURE_DB);
  } catch (e) {
    return { ok: false, openError: String(e), acked, interruptedSince };
  }
  const result: Record<string, unknown> = { acked, interruptedSince, currentAppVersion: __APP_VERSION__, openMs: Math.round(performance.now() - t0) };
  try {
    result.integrityCheck = await db.all("PRAGMA integrity_check");
  } catch (e) {
    result.integrityCheck = { unsupported: String(e) };
  }
  try {
    result.meta = await db.all("SELECT * FROM meta");
    const rows = await db.all("SELECT counter, payload, crc32, chunk_path, chunk_crc32, app_version FROM rows ORDER BY counter");
    let badCrc = 0, missingChunks = 0, badChunkCrc = 0, holes = 0, prev = 0;
    const versions = new Map<string, number>();
    for (const r of rows) {
      const counter = Number(r.counter);
      if (counter !== prev + 1) holes++;
      prev = counter;
      if (crc32(new Uint8Array(r.payload)) !== Number(r.crc32)) badCrc++;
      versions.set(r.app_version, (versions.get(r.app_version) ?? 0) + 1);
      if (r.chunk_path) {
        const f = await opfsFile(r.chunk_path);
        if (!f) missingChunks++;
        else if (crc32(new Uint8Array(await f.arrayBuffer())) !== Number(r.chunk_crc32)) badChunkCrc++;
      }
    }
    const maxCounter = rows.length ? Number(rows[rows.length - 1].counter) : 0;
    Object.assign(result, {
      rows: rows.length,
      maxCounter,
      // Durability: every counter acknowledged after COMMIT must be present.
      lostAckedCommits: Math.max(0, acked - maxCounter),
      unackedButCommitted: Math.max(0, maxCounter - acked),
      holes,
      badPayloadCrc: badCrc,
      missingChunkFiles: missingChunks,
      badChunkCrc,
      rowsByAppVersion: Object.fromEntries(versions),
    });
    result.ok = holes === 0 && badCrc === 0 && missingChunks === 0 && badChunkCrc === 0 && acked <= maxCounter;
  } catch (e) {
    result.ok = false;
    result.readError = String(e);
  }
  await db.close();
  result.quota = await quota();
  log(`verify: ${result.ok ? "OK" : "FAILED"}`);
  return result;
}
