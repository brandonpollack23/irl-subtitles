import type { SecretStore } from "@irl/domain";
import { idbTx, type KeyVault, type Sealer } from "./crypto";

interface SecretRecord {
  name: string;
  sealed: Uint8Array;
  updatedAt: string;
}

/**
 * Provider credentials, isolated from settings: sealed with their own non-extractable key and kept in
 * the key vault database, never in the SQL store, never logged (plan.md §6.2).
 */
export class VaultSecretStore implements SecretStore {
  private constructor(private readonly vault: KeyVault, private readonly sealer: Sealer) {}

  static async open(vault: KeyVault): Promise<VaultSecretStore> {
    return new VaultSecretStore(vault, await vault.durableSealer("secrets-v1"));
  }

  async put(name: "soniox_api_key", value: string): Promise<void> {
    const sealed = await this.sealer.seal(new TextEncoder().encode(value));
    await idbTx(this.vault.database, "records", "readwrite", (s) => s.put({ name, sealed, updatedAt: new Date().toISOString() } satisfies SecretRecord));
  }

  async get(name: "soniox_api_key"): Promise<string | null> {
    const rec = await idbTx<SecretRecord | undefined>(this.vault.database, "records", "readonly", (s) => s.get(name) as IDBRequest<SecretRecord | undefined>);
    if (!rec) return null;
    return new TextDecoder().decode(await this.sealer.open(new Uint8Array(rec.sealed)));
  }

  async has(name: "soniox_api_key"): Promise<boolean> {
    const rec = await idbTx<SecretRecord | undefined>(this.vault.database, "records", "readonly", (s) => s.get(name) as IDBRequest<SecretRecord | undefined>);
    return !!rec;
  }

  async delete(name: "soniox_api_key"): Promise<void> {
    await idbTx(this.vault.database, "records", "readwrite", (s) => s.delete(name));
  }
}
