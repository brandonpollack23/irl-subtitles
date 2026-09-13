import { errorMessage } from "@irl/domain";
import { IdbBlobStore, OpfsBlobStore, type BlobStore } from "./blobs";
import { KeyVault, type Sealer } from "./crypto";
import { IdbTableStore } from "./idb-store";
import { Repository } from "./repository";
import { VaultSecretStore } from "./secrets";
import { SqlTableStore } from "./sql-store";
import type { TableStore } from "./table-store";
import { openTursoDriver } from "./turso-driver";

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

/** Chooses Turso/OPFS when the page supports it, IndexedDB otherwise; domain code never sees which. */
export async function openStorage(opts: OpenStorageOptions): Promise<StorageHandles> {
  const reasons: string[] = [];
  const dbName = opts.dbName ?? "irl-subtitles";
  let table: TableStore | null = null;
  if (opts.preferTurso) {
    try {
      table = await SqlTableStore.open(await openTursoDriver(`${dbName}.db`));
    } catch (e) {
      reasons.push(`turso: ${errorMessage(e)}`);
    }
  } else {
    reasons.push("turso: disabled by setting");
  }
  table ??= await IdbTableStore.open(dbName);

  let blobs: BlobStore;
  try {
    blobs = await OpfsBlobStore.open();
  } catch (e) {
    reasons.push(`opfs: ${errorMessage(e)}`);
    blobs = await IdbBlobStore.open();
  }

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
