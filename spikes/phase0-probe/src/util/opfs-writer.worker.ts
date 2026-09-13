/// <reference lib="webworker" />
// Appends to one OPFS file through a synchronous access handle, the fastest
// durable write path available to the WebView (dedicated worker only).

interface SyncHandle {
  getSize(): number;
  write(buf: ArrayBufferView, opts: { at: number }): number;
  flush(): void;
  close(): void;
}

let handle: SyncHandle | null = null;
let size = 0;

async function open(path: string): Promise<number> {
  handle?.close();
  handle = null;
  const parts = path.split("/");
  let dir = await navigator.storage.getDirectory();
  for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true });
  const file = await dir.getFileHandle(parts[parts.length - 1]!, { create: true });
  handle = (await (file as unknown as { createSyncAccessHandle(): Promise<SyncHandle> }).createSyncAccessHandle()) as SyncHandle;
  size = handle.getSize();
  return size;
}

self.onmessage = async (e: MessageEvent) => {
  const { id, op } = e.data as { id: number; op: string };
  try {
    if (op === "open") {
      postMessage({ id, size: await open(e.data.path as string) });
    } else if (op === "append") {
      if (!handle) throw new Error("not open");
      const t0 = performance.now();
      const data = new Uint8Array(e.data.data as ArrayBuffer);
      size += handle.write(data, { at: size });
      if (e.data.flush) handle.flush();
      postMessage({ id, size, ms: performance.now() - t0 });
    } else if (op === "close") {
      handle?.flush();
      handle?.close();
      handle = null;
      postMessage({ id, size });
    }
  } catch (err) {
    postMessage({ id, error: String(err) });
  }
};
