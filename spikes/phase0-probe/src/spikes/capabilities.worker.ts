import { probeWebNN } from "./webnn-probe";

/** Runs inside a dedicated worker: WebNN-in-worker, OPFS sync access handles, SAB transfer. */
async function probe() {
  const result: Record<string, unknown> = {};
  result.crossOriginIsolated = (self as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;
  result.sharedArrayBuffer = typeof SharedArrayBuffer !== "undefined";

  try {
    const root = await navigator.storage.getDirectory();
    const fh = await root.getFileHandle("probe-sync-access.bin", { create: true });
    const createSync = (fh as unknown as { createSyncAccessHandle?: () => Promise<FileSystemSyncAccessHandleLike> }).createSyncAccessHandle;
    if (!createSync) {
      result.opfsSyncAccessHandle = { ok: false, error: "createSyncAccessHandle missing" };
    } else {
      const handle = await createSync.call(fh);
      const payload = new Uint8Array(1024 * 1024).map((_, i) => i & 0xff);
      const t0 = performance.now();
      handle.truncate(0);
      handle.write(payload, { at: 0 });
      handle.flush();
      const writeFlushMs = performance.now() - t0;
      const back = new Uint8Array(payload.length);
      handle.read(back, { at: 0 });
      const ok = back.every((v, i) => v === payload[i]);
      handle.close();
      await root.removeEntry("probe-sync-access.bin");
      result.opfsSyncAccessHandle = { ok, writeFlush1MiBMs: Math.round(writeFlushMs * 100) / 100 };
    }
  } catch (e) {
    result.opfsSyncAccessHandle = { ok: false, error: String(e) };
  }

  result.webnn = await probeWebNN(false).catch((e) => ({ error: String(e) }));
  return result;
}

interface FileSystemSyncAccessHandleLike {
  truncate(size: number): void;
  write(buf: Uint8Array, opts: { at: number }): number;
  read(buf: Uint8Array, opts: { at: number }): number;
  flush(): void;
  close(): void;
}

self.onmessage = (e: MessageEvent) => {
  if (e.data === "probe") {
    void probe().then((r) => postMessage({ result: r }), (err) => postMessage({ error: String(err) }));
  } else if (e.data instanceof SharedArrayBuffer) {
    new Int32Array(e.data)[0] = 42;
    postMessage({ sabEcho: true });
  }
};
