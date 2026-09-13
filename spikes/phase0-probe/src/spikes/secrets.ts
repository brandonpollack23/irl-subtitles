import { getBridge } from "../bridge";
import { launchNumber } from "../lifecycle";
import { lsGet, lsSet } from "../report";

const DB = "probe-secrets";
const LS_FINGERPRINT = "probe.secret.fingerprint";
const BRIDGE_KEY = "probe.secret.fingerprint";

interface SecretRecord {
  name: string;
  iv: ArrayBuffer;
  ciphertext: ArrayBuffer;
  appVersion: string;
  buildId: string;
  launch: number;
  createdAt: string;
}

function idb(): Promise<IDBDatabase> {
  return new Promise((ok, fail) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore("keys");
      req.result.createObjectStore("records", { keyPath: "name" });
    };
    req.onsuccess = () => ok(req.result);
    req.onerror = () => fail(req.error);
  });
}

function tx<T>(db: IDBDatabase, store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((ok, fail) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => ok(req.result);
    t.onerror = () => fail(t.error);
  });
}

async function fingerprint(value: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(d).slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Stores a random test secret the way plan.md §6.2 proposes for the Soniox key:
 * a non-extractable AES-GCM CryptoKey in IndexedDB plus an encrypted record.
 * Only a SHA-256 fingerprint is kept elsewhere, to verify later without the plaintext.
 */
export async function storeTestSecret() {
  const secret = `probe-${crypto.randomUUID()}`;
  const db = await idb();
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(secret));
  await tx(db, "keys", "readwrite", (s) => s.put(key, "master"));
  const record: SecretRecord = { name: "test_secret", iv: iv.buffer, ciphertext, appVersion: __APP_VERSION__, buildId: __BUILD_ID__, launch: launchNumber, createdAt: new Date().toISOString() };
  await tx(db, "records", "readwrite", (s) => s.put(record));
  db.close();
  const fp = await fingerprint(secret);
  lsSet(LS_FINGERPRINT, fp);
  const bridge = await getBridge();
  const bridgeStored = bridge ? await bridge.setLocalStorage(BRIDGE_KEY, `${fp}|${__APP_VERSION__}`).catch((e) => String(e)) : "no bridge";
  return { stored: true, fingerprint: fp, appVersion: __APP_VERSION__, launch: launchNumber, bridgeStored };
}

export async function verifyTestSecret() {
  const result: Record<string, unknown> = { currentAppVersion: __APP_VERSION__, currentBuildId: __BUILD_ID__, launch: launchNumber };
  const db = await idb();
  const key = await tx<CryptoKey | undefined>(db, "keys", "readonly", (s) => s.get("master"));
  const record = await tx<SecretRecord | undefined>(db, "records", "readonly", (s) => s.get("test_secret"));
  db.close();
  result.keyPresent = !!key;
  result.keyExtractable = key?.extractable ?? null;
  result.recordPresent = !!record;
  if (record) Object.assign(result, { writtenByVersion: record.appVersion, writtenByBuild: record.buildId, writtenAtLaunch: record.launch, writtenAt: record.createdAt });
  if (key && record) {
    try {
      const plain = new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: record.iv }, key, record.ciphertext));
      const fp = await fingerprint(plain);
      result.decrypted = true;
      result.fingerprintMatchesLocalStorage = fp === lsGet(LS_FINGERPRINT);
      result.localStorageFingerprintPresent = lsGet(LS_FINGERPRINT) !== null;
      const bridge = await getBridge();
      if (bridge) {
        const stored = await bridge.getLocalStorage(BRIDGE_KEY).catch(() => "");
        result.bridgeStorage = stored ? { present: true, fingerprintMatches: stored.split("|")[0] === fp, writtenByVersion: stored.split("|")[1] } : { present: false };
      } else {
        result.bridgeStorage = "no bridge";
      }
    } catch (e) {
      result.decrypted = false;
      result.decryptError = String(e);
    }
  }
  if (key) {
    // A non-extractable key must refuse export.
    result.exportRefused = await crypto.subtle.exportKey("raw", key).then(() => false, () => true);
  }
  result.ok = result.decrypted === true && result.keyExtractable === false && result.exportRefused === true;
  return result;
}
