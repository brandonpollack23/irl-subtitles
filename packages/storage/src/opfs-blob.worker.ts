/// <reference lib="webworker" />

interface SyncHandle {
  write(buf: ArrayBufferView, opts: { at: number }): number;
  truncate(size: number): void;
  flush(): void;
  close(): void;
}

async function writeFile(path: string, data: ArrayBuffer): Promise<void> {
  const parts = path.split("/").filter(Boolean);
  let dir = await navigator.storage.getDirectory();
  for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true });
  const file = await dir.getFileHandle(parts[parts.length - 1]!, { create: true });
  const handle = (await (file as unknown as { createSyncAccessHandle(): Promise<SyncHandle> }).createSyncAccessHandle()) as SyncHandle;
  try {
    const bytes = new Uint8Array(data);
    let off = 0;
    while (off < bytes.byteLength) off += handle.write(bytes.subarray(off), { at: off });
    handle.truncate(bytes.byteLength);
    handle.flush();
  } finally {
    handle.close();
  }
}

self.onmessage = async (e: MessageEvent<{ id: number; op: string; path: string; data: ArrayBuffer }>) => {
  const { id, op } = e.data;
  try {
    if (op === "write") await writeFile(e.data.path, e.data.data);
    else throw new Error(`unknown op ${op}`);
    postMessage({ id });
  } catch (err) {
    postMessage({ id, error: String(err) });
  }
};
