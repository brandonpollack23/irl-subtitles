import { Emitter, errorMessage, type BenchmarkResult, type ExecutionTarget, type ModelCatalogEntry, type PowerPolicy } from "@irl/domain";
import { catalogEntry } from "./catalog";
import { availabilityOnDevice, detectCapabilities, selectTarget, type DeviceCapabilities } from "./device";
import { downloadModelFiles, filesForTargets, missingFiles } from "./model-files";
import { isGpuFailure } from "./gpu-errors";
import { RpcClient } from "./rpc";
import type { AsrResult } from "./workers/asr.worker";

export type EngineKind = "audio" | "asr" | "llm";

export interface LoadProgress {
  modelId: string;
  status: "downloading" | "loading" | "ready" | "failed";
  loaded?: number;
  total?: number;
  error?: string;
}

export interface EngineEvent {
  type: "gpu-failure" | "worker-crash";
  engine: EngineKind;
  message: string;
}

/**
 * Owns the ML workers and which model each has loaded (plan.md §5 ComputeRuntime). Models load on demand
 * per execution target; a WebGPU failure disposes that worker's sessions and is reported so callers can
 * degrade to deferred processing without touching capture.
 */
export class LocalEngines {
  private clients = new Map<EngineKind, RpcClient>();
  private loaded = new Map<EngineKind, Map<string, Promise<void>>>();
  readonly progress = new Emitter<LoadProgress>();
  readonly events = new Emitter<EngineEvent>();
  caps: DeviceCapabilities | null = null;
  benchmarks: BenchmarkResult[] = [];
  policy: PowerPolicy = "balanced";

  constructor(private readonly workerFactory: Record<EngineKind, () => Worker>) {}

  async capabilities(): Promise<DeviceCapabilities> {
    this.caps ??= await detectCapabilities();
    return this.caps;
  }

  private client(kind: EngineKind): RpcClient {
    let c = this.clients.get(kind);
    if (!c || !c.alive) {
      c = new RpcClient(this.workerFactory[kind](), kind);
      this.clients.set(kind, c);
      this.loaded.set(kind, new Map());
    }
    return c;
  }

  async targetFor(entry: ModelCatalogEntry): Promise<ExecutionTarget> {
    return selectTarget(entry, await this.capabilities(), this.policy, this.benchmarks);
  }

  /**
   * Targets whose files a download covers: every target the model can run on here, so benchmarks and the
   * WebGPU-to-WASM fallback don't need the network.
   */
  private async downloadTargets(entry: ModelCatalogEntry): Promise<ExecutionTarget[]> {
    if (entry.manifest.params?.requiresWebGpu === true) return ["webgpu"];
    return (await this.capabilities()).webgpu.available ? ["webgpu", "wasm"] : ["wasm"];
  }

  /** Downloaded means every file those targets read is cached; cache keys carry the pinned revision. */
  async isDownloaded(modelId: string): Promise<boolean> {
    const e = catalogEntry(modelId);
    if (!e) return false;
    const files = filesForTargets(e, await this.downloadTargets(e));
    return files.length > 0 && (await missingFiles(e, files)).length === 0;
  }

  /**
   * Fetches and verifies a model's files into the browser cache without loading it; recordings and
   * benchmarks load it when they need it.
   */
  async download(modelId: string): Promise<void> {
    const entry = catalogEntry(modelId);
    if (!entry) throw new Error(`unknown model ${modelId}`);
    try {
      const availability = availabilityOnDevice(entry, await this.capabilities());
      if (availability.status === "unavailable") throw new Error(availability.reason);
      let lastEmit = 0;
      await downloadModelFiles(entry, filesForTargets(entry, await this.downloadTargets(entry)), (loaded, total) => {
        const now = performance.now();
        if (loaded < total && now - lastEmit < 100) return;
        lastEmit = now;
        this.progress.emit({ modelId, status: "downloading", loaded, total });
      });
      this.progress.emit({ modelId, status: "ready" });
    } catch (e) {
      this.progress.emit({ modelId, status: "failed", error: errorMessage(e) });
      throw e;
    }
  }

  private ensure(kind: EngineKind, method: string, modelId: string, payload: Record<string, unknown>): Promise<void> {
    const entry = catalogEntry(modelId);
    if (!entry) return Promise.reject(new Error(`unknown model ${modelId}`));
    const client = this.client(kind);
    const key = `${modelId}:${JSON.stringify(payload)}`;
    const cache = this.loaded.get(kind)!;
    const existing = cache.get(key);
    if (existing) return existing;
    // One model per engine: loading another replaces it inside the worker.
    cache.clear();
    const p = (async () => {
      const availability = availabilityOnDevice(entry, await this.capabilities());
      if (availability.status === "unavailable") throw new Error(availability.reason);
      this.progress.emit({ modelId, status: "loading" });
      // transformers.js reports each file separately (plus its own running totals); sum per file so
      // the model's progress doesn't jump back to 0% when the next file starts.
      const files = new Map<string, { loaded: number; total: number }>();
      await client.call(method, { modelId, ...payload }, {
        progress: (raw) => {
          const r = raw as { status?: string; file?: string; loaded?: number; total?: number };
          if (r.loaded === undefined || r.status === "progress_total") return;
          files.set(r.file ?? "", { loaded: r.loaded, total: Math.max(r.total ?? 0, r.loaded) });
          let loaded = 0;
          let total = 0;
          for (const f of files.values()) {
            loaded += f.loaded;
            total += f.total;
          }
          this.progress.emit({ modelId, status: "downloading", loaded, total });
        },
      });
      this.progress.emit({ modelId, status: "ready" });
    })().catch((e) => {
      cache.delete(key);
      this.progress.emit({ modelId, status: "failed", error: errorMessage(e) });
      throw e;
    });
    cache.set(key, p);
    return p;
  }

  async ensureVad(modelId: string): Promise<void> {
    return this.ensure("audio", "vad.load", modelId, {});
  }

  async ensureEmbedding(modelId: string): Promise<void> {
    const target = await this.targetFor(catalogEntry(modelId)!);
    return this.ensure("audio", "embed.load", `${modelId}`, { target }).catch(async (e) => {
      if (target === "webgpu") return this.ensure("audio", "embed.load", modelId, { target: "wasm" });
      throw e;
    });
  }

  async ensureAsr(modelId: string): Promise<ExecutionTarget> {
    const entry = catalogEntry(modelId)!;
    const target = await this.targetFor(entry);
    try {
      await this.ensure("asr", "asr.load", modelId, { target });
      return target;
    } catch (e) {
      if (target === "webgpu" && entry.manifest.params?.requiresWebGpu !== true) {
        await this.ensure("asr", "asr.load", modelId, { target: "wasm" });
        return "wasm";
      }
      throw e;
    }
  }

  async ensureLlm(modelId: string): Promise<void> {
    return this.ensure("llm", "llm.load", modelId, {});
  }

  async call<T>(kind: EngineKind, method: string, payload: unknown, opts: { transfer?: Transferable[]; progress?: (p: unknown) => void } = {}): Promise<T> {
    try {
      return await this.client(kind).call<T>(method, payload, opts);
    } catch (e) {
      if (isGpuFailure(e) || !this.clients.get(kind)?.alive) {
        this.events.emit({ type: isGpuFailure(e) ? "gpu-failure" : "worker-crash", engine: kind, message: errorMessage(e) });
        this.reset(kind);
      }
      throw e;
    }
  }

  vadPush(samples: Float32Array) {
    return this.call<{ probs: Float32Array; firstWindowStart: number }>("audio", "vad.push", { samples }, { transfer: [samples.buffer] });
  }

  transcribe(samples: Float32Array, language: string, wordTimestamps: boolean) {
    return this.call<AsrResult>("asr", "asr.run", { samples, language, wordTimestamps }, { transfer: [samples.buffer] });
  }

  embed(windows: { samples: Float32Array; startSample: number; endSample: number }[]) {
    return this.call<{ vector: Float32Array; startSample: number; endSample: number; quality: number; ms: number }[]>("audio", "embed.run", { windows });
  }

  /** Terminates a worker; its models reload on next use. */
  reset(kind: EngineKind): void {
    this.clients.get(kind)?.terminate();
    this.clients.delete(kind);
    this.loaded.delete(kind);
  }

  async release(kinds: readonly EngineKind[] = ["asr", "llm"]): Promise<void> {
    for (const k of kinds) this.reset(k);
  }
}
