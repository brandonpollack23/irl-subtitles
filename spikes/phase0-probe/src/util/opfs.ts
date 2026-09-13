/** Promise wrapper around opfs-writer.worker.ts. One worker, one open file at a time. */
export class OpfsAppender {
  private readonly worker = new Worker(new URL("./opfs-writer.worker.ts", import.meta.url), { type: "module" });
  private nextId = 1;
  private readonly pending = new Map<number, { ok: (v: WriterReply) => void; fail: (e: Error) => void }>();

  constructor() {
    this.worker.onmessage = (e: MessageEvent<WriterReply & { id: number; error?: string }>) => {
      const p = this.pending.get(e.data.id);
      this.pending.delete(e.data.id);
      if (e.data.error) p?.fail(new Error(e.data.error));
      else p?.ok(e.data);
    };
  }

  private call(msg: Record<string, unknown>, transfer: Transferable[] = []): Promise<WriterReply> {
    const id = this.nextId++;
    return new Promise((ok, fail) => {
      this.pending.set(id, { ok, fail });
      this.worker.postMessage({ ...msg, id }, transfer);
    });
  }

  /** Returns the existing file size, so a relaunch can see what survived. */
  async open(path: string): Promise<number> {
    return (await this.call({ op: "open", path })).size;
  }

  append(data: Uint8Array, flush: boolean): Promise<WriterReply> {
    const copy = data.slice().buffer;
    return this.call({ op: "append", data: copy, flush }, [copy]);
  }

  /** Flushes and closes the current file; the worker stays up for the next open(). */
  async close(): Promise<number> {
    return (await this.call({ op: "close" })).size;
  }

  dispose(): void {
    this.worker.terminate();
  }
}

export interface WriterReply {
  size: number;
  ms?: number;
}

export async function opfsFile(path: string): Promise<File | null> {
  try {
    const parts = path.split("/");
    let dir = await navigator.storage.getDirectory();
    for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p);
    return await (await dir.getFileHandle(parts[parts.length - 1]!)).getFile();
  } catch {
    return null;
  }
}

export async function opfsRemove(path: string): Promise<void> {
  const parts = path.split("/");
  let dir = await navigator.storage.getDirectory();
  for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p);
  await dir.removeEntry(parts[parts.length - 1]!, { recursive: true });
}
