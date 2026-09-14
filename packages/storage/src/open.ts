import { errorMessage } from "@irl/domain";
import { IdbBlobStore, OpfsBlobStore, type BlobStore } from "./blobs";
import { KeyVault, type Sealer } from "./crypto";
import { IdbTableStore } from "./idb-store";
import { Repository } from "./repository";
import { VaultSecretStore } from "./secrets";
import { SqlTableStore } from "./sql-store";
import type { TableStore } from "./table-store";
import { openTursoDriver, tursoUnsupportedReason } from "./turso-driver";

export interface StorageHandles {
  repo: Repository;
  blobs: BlobStore;
  vault: KeyVault;
  durable: Sealer;
  secrets: VaultSecretStore;
  diagnostics: StorageDiagnostics;
}

export interface StorageDiagnostics {
  database: TableStore["backend"];
  blobs: BlobStore["kind"];
  fallbackReasons: string[];
  persisted: boolean | null;
  quotaBytes: number | null;
  usageBytes: number | null;
}

export interface OpenStorageOptions {
  /** Try Turso/OPFS first (needs cross-origin isolation); otherwise go straight to IndexedDB. */
  preferTurso: boolean;
  dbName?: string;
}

/** Some engines hang instead of rejecting when a worker can't clone OPFS handles (seen in WebKitGTK). */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([p, new Promise<never>((_, fail) => setTimeout(() => fail(new Error(`${what} timed out after ${ms / 1000}s`)), ms))]);
}

/** Chooses Turso/OPFS when the page supports it, IndexedDB otherwise; domain code never sees which. */
export async function openStorage(opts: OpenStorageOptions & { onStep?: (step: string) => void }): Promise<StorageHandles> {
  const reasons: string[] = [];
  const dbName = opts.dbName ?? "irl-subtitles";

  // Audio storage opens first: its probe writes through an OPFS sync access handle in a worker, which is
  // exactly what Turso needs, so a failed probe rules Turso out without waiting on Turso's own timeout.
  let blobs: BlobStore;
  opts.onStep?.("Opening audio storage");
  try {
    blobs = await withTimeout(OpfsBlobStore.open(), 8_000, "OPFS probe");
  } catch (e) {
    reasons.push(`opfs: ${errorMessage(e)}`);
    blobs = await IdbBlobStore.open();
  }

  let table: TableStore | null = null;
  const skipTurso = !opts.preferTurso ? "disabled by setting" : (tursoUnsupportedReason() ?? (blobs.kind === "opfs" ? null : "OPFS sync access handles don't work here"));
  if (skipTurso) {
    reasons.push(`turso: ${skipTurso}`);
  } else {
    opts.onStep?.("Opening database");
    try {
      table = await withTimeout(openTursoDriver(`${dbName}.db`).then((d) => SqlTableStore.open(d)), 10_000, "Turso open");
    } catch (e) {
      reasons.push(`turso: ${errorMessage(e)}`);
    }
  }
  if (!table) opts.onStep?.("Opening IndexedDB");
  table ??= await IdbTableStore.open(dbName);

  opts.onStep?.("Opening keys");
  const vault = await KeyVault.open();
  const durable = await vault.durableSealer();
  const secrets = await VaultSecretStore.open(vault);

  let persisted: boolean | null = null;
  let quotaBytes: number | null = null;
  let usageBytes: number | null = null;
  try {
    persisted = (await navigator.storage.persisted()) || (await navigator.storage.persist());
    const est = await navigator.storage.estimate();
    quotaBytes = est.quota ?? null;
    usageBytes = est.usage ?? null;
  } catch (e) {
    reasons.push(`storage manager: ${errorMessage(e)}`);
  }

  return {
    repo: new Repository(table),
    blobs,
    vault,
    durable,
    secrets,
    diagnostics: { database: table.backend, blobs: blobs.kind, fallbackReasons: reasons, persisted, quotaBytes, usageBytes },
  };
}

export async function storageEstimate(): Promise<{ quotaBytes: number | null; usageBytes: number | null }> {
  try {
    const est = await navigator.storage.estimate();
    return { quotaBytes: est.quota ?? null, usageBytes: est.usage ?? null };
  } catch {
    return { quotaBytes: null, usageBytes: null };
  }
}
