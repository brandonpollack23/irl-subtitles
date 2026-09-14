import { Worker as ThreadWorker } from "node:worker_threads";
import type { EngineKind } from "../../src/engines";
import { workerName, type OrtFlavor } from "../../src/ort-flavor";

const entry = new URL("./worker-entry.mjs", import.meta.url);
const modules: Record<EngineKind, URL> = {
  audio: new URL("../../src/workers/audio.worker.ts", import.meta.url),
  asr: new URL("../../src/workers/asr.worker.ts", import.meta.url),
  llm: new URL("../../src/workers/llm.worker.ts", import.meta.url),
};

/** The subset of the web Worker API that RpcClient uses, backed by a worker thread. */
class ThreadBackedWorker {
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: { message: string }) => void) | null = null;
  private thread: ThreadWorker;

  constructor(kind: EngineKind, cacheDir: string, flavor: OrtFlavor) {
    this.thread = new ThreadWorker(entry, { workerData: { module: modules[kind].href, cacheDir, name: workerName(`irl-${kind}`, flavor) } });
    this.thread.on("message", (data) => this.onmessage?.({ data }));
    this.thread.on("error", (e: Error) => this.onerror?.({ message: e.message }));
  }

  postMessage(data: unknown, transfer: Transferable[] = []): void {
    this.thread.postMessage(data, transfer as never);
  }

  terminate(): void {
    void this.thread.terminate();
  }
}

/** Drop-in for toolkit's defaultWorkers(): the app's own worker modules, one thread each. */
export function nodeWorkers(cacheDir: string): Record<EngineKind, (flavor: OrtFlavor) => Worker> {
  const make = (kind: EngineKind) => (flavor: OrtFlavor) => new ThreadBackedWorker(kind, cacheDir, flavor) as unknown as Worker;
  return { audio: make("audio"), asr: make("asr"), llm: make("llm") };
}
