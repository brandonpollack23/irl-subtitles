import registryJson from "../models/registry.json";
import metadataJson from "../models/graph-metadata.json";
import type { BenchRequest, EpChoice, SustainedWindow } from "./bench.worker";
import type { GraphMetadata, RegistryGraph, RegistryModel } from "./model-inputs";

export const registry = registryJson.models as RegistryModel[];
const metadata = metadataJson as Record<string, GraphMetadata>;

export const EPS: EpChoice[] = ["webnn-npu", "webnn-gpu", "webnn-cpu", "wasm"];

type Log = (...p: unknown[]) => void;

export function graphMeta(modelId: string, graph: string): GraphMetadata | undefined {
  return metadata[`${modelId}/${graph}`];
}

export async function graphAvailable(modelId: string, graph: RegistryGraph): Promise<boolean> {
  for (const f of [graph.file, ...(graph.externalData ?? [])]) {
    const r = await fetch(`/models/${modelId}/${f}`, { method: "HEAD" }).catch(() => null);
    if (!r?.ok) return false;
  }
  return true;
}

export interface BenchOptions {
  iterations: number;
  warmup: number;
  sustainedSeconds: number;
  compareWithWasm: boolean;
}

/** Session compilation can hang on some graphs; a matrix run must still make progress. */
const BENCH_TIMEOUT_MS = 10 * 60_000;

/** One benchmark in a fresh worker, so each model's memory is released when it finishes. */
export function runBench(
  model: RegistryModel,
  graph: RegistryGraph,
  ep: EpChoice,
  opts: BenchOptions,
  log: Log,
  onWindow?: (w: SustainedWindow) => void,
): Promise<Record<string, unknown>> {
  const worker = new Worker(new URL("./bench.worker.ts", import.meta.url), { type: "module" });
  const req: BenchRequest = { modelId: model.id, graph, meta: graphMeta(model.id, graph.name), ep, ...opts };
  return new Promise((ok) => {
    let lastProgress = "";
    const finish = (result: Record<string, unknown>) => {
      clearTimeout(timer);
      worker.terminate();
      ok({ role: model.role, catalogDefault: !!model.catalogDefault, ...result });
    };
    const timer = setTimeout(
      () => finish({ modelId: model.id, graph: graph.name, ep, ok: false, stage: "timeout", error: `no result after ${BENCH_TIMEOUT_MS / 60_000} min (last step: ${lastProgress})` }),
      BENCH_TIMEOUT_MS + opts.sustainedSeconds * 1000,
    );
    worker.onmessage = (e) => {
      if (e.data.type === "progress") {
        lastProgress = e.data.message;
        log(`${model.id}/${graph.name} [${ep}] ${e.data.message}`);
      } else if (e.data.type === "window") onWindow?.(e.data.window);
      else if (e.data.type === "result") finish(e.data.result);
    };
    worker.onerror = (e) => finish({ modelId: model.id, graph: graph.name, ep, ok: false, stage: "worker", error: e.message });
    worker.postMessage(req);
  });
}

async function phoneBattery(): Promise<{ level: number; charging: boolean } | null> {
  try {
    const b = await (navigator as unknown as { getBattery?: () => Promise<{ level: number; charging: boolean }> }).getBattery?.();
    return b ? { level: Math.round(b.level * 100), charging: b.charging } : null;
  } catch {
    return null;
  }
}

export interface StackMember {
  model: RegistryModel;
  graph: RegistryGraph;
  ep: EpChoice;
}

/** The catalog-default live roles (VAD + live STT encoder/decoder + speaker embedding). */
export function defaultLiveStack(ep: EpChoice): StackMember[] {
  return registry
    .filter((m) => m.catalogDefault && (m.role === "vad" || m.role === "stt-live" || m.role === "speaker-embedding"))
    .map((m) => ({ model: m, graphs: m.role === "vad" ? m.graphs.slice(0, 1) : m.graphs }))
    .flatMap(({ model, graphs }) => graphs.map((graph) => ({ model, graph, ep })));
}

/**
 * Proxy for plan.md §13.3's concurrent live benchmark: every member runs at its
 * registry cadence in its own worker for the same wall-clock period.
 */
export async function runLiveStack(members: StackMember[], seconds: number, log: Log) {
  const battery: { tSec: number; phone: Awaited<ReturnType<typeof phoneBattery>> }[] = [];
  const start = performance.now();
  battery.push({ tSec: 0, phone: await phoneBattery() });
  const timer = setInterval(async () => battery.push({ tSec: Math.round((performance.now() - start) / 1000), phone: await phoneBattery() }), 30_000);
  const results = await Promise.all(
    members.map((m) =>
      runBench(m.model, m.graph, m.ep, { iterations: 5, warmup: 2, sustainedSeconds: seconds, compareWithWasm: false }, log, (w) =>
        log(`${m.model.id}/${m.graph.name} t=${w.tSec}s p95=${w.p95Ms}ms overruns=${w.overruns}`),
      ),
    ),
  );
  clearInterval(timer);
  battery.push({ tSec: Math.round((performance.now() - start) / 1000), phone: await phoneBattery() });
  return { seconds, members: members.map((m) => `${m.model.id}/${m.graph.name}@${m.ep}`), battery, results };
}
