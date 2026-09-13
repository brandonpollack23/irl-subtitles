/// <reference lib="webworker" />
import * as ort from "onnxruntime-web";
import {
  compare,
  decodeTensor,
  freeDimensionOverrides,
  makeInput,
  toNumbers,
  type Drift,
  type EncodedTensor,
  type GraphMetadata,
  type RawTensor,
  type RegistryGraph,
} from "./model-inputs";

export type EpChoice = "webnn-npu" | "webnn-gpu" | "webnn-cpu" | "wasm";

export interface BenchRequest {
  modelId: string;
  graph: RegistryGraph;
  meta?: GraphMetadata;
  ep: EpChoice;
  iterations: number;
  warmup: number;
  /** Seconds of paced running after the latency pass; 0 disables. */
  sustainedSeconds: number;
  /** Runs per second for the sustained pass; defaults to the graph cadence or flat out. */
  cadenceHz?: number;
  compareWithWasm: boolean;
}

export interface SustainedWindow {
  tSec: number;
  runs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  /** Runs whose latency exceeded the cadence budget. */
  overruns: number;
}

// Capture ORT's own logs: WebNN EP partitioning and fallback messages land here.
const logLines: string[] = [];
for (const level of ["log", "info", "warn", "error", "debug"] as const) {
  const orig = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    const line = args.map(String).join(" ");
    if (logLines.length < 400 && /webnn|fallback|not supported|unsupported|graph_partitioner|node placement|assigned to|ExecutionProvider/i.test(line)) logLines.push(`${level}: ${line.slice(0, 400)}`);
    orig(...args);
  };
}

/** Structured WebNN coverage from ORT's GetCapability log line (the key op-coverage signal). */
function webnnCoverage() {
  for (const line of logLines) {
    const m = /partitions supported by WebNN: (\d+) number of nodes in the graph: (\d+) number of nodes supported by WebNN: (\d+)/.exec(line);
    if (m) {
      const [partitions, nodes, supported] = [Number(m[1]), Number(m[2]), Number(m[3])];
      return { partitions, nodes, supported, fullyOnWebNN: partitions === 1 && nodes === supported };
    }
  }
  return null;
}

function progress(message: string) {
  postMessage({ type: "progress", message });
}

function toOrt(t: RawTensor): ort.Tensor {
  return new ort.Tensor(t.dtype, t.data as never, t.shape);
}

function percentile(sorted: number[], p: number) {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]! : NaN;
}

function stats(times: number[]) {
  const s = [...times].sort((a, b) => a - b);
  const r = (v: number) => Math.round(v * 100) / 100;
  return { n: s.length, p50: r(percentile(s, 0.5)), p95: r(percentile(s, 0.95)), max: r(s[s.length - 1] ?? NaN), mean: r(s.reduce((a, b) => a + b, 0) / Math.max(1, s.length)) };
}

function epOptions(ep: EpChoice): ort.InferenceSession.ExecutionProviderConfig[] {
  if (ep === "wasm") return ["wasm"];
  const deviceType = ep.slice("webnn-".length) as "npu" | "gpu" | "cpu";
  return [{ name: "webnn", deviceType, powerPreference: "default" } as ort.InferenceSession.ExecutionProviderConfig];
}

async function fetchBytes(url: string): Promise<{ bytes: Uint8Array; ms: number }> {
  const t0 = performance.now();
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status} (run the models fetch script on the laptop)`);
  return { bytes: new Uint8Array(await res.arrayBuffer()), ms: performance.now() - t0 };
}

async function createSession(req: BenchRequest, ep: EpChoice, modelBytes: Uint8Array) {
  const base = `/models/${req.modelId}/`;
  const t0 = performance.now();
  const session = await ort.InferenceSession.create(modelBytes, {
    executionProviders: epOptions(ep),
    freeDimensionOverrides: freeDimensionOverrides(req.graph, req.meta),
    graphOptimizationLevel: "all",
    logSeverityLevel: 1,
    externalData: (req.graph.externalData ?? []).map((p) => ({ path: p.split("/").pop()!, data: `${base}${p}` })),
  });
  return { session, createMs: performance.now() - t0 };
}

async function run(req: BenchRequest) {
  ort.env.logLevel = "info";
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency) : 1;
  const result: Record<string, unknown> = { modelId: req.modelId, graph: req.graph.name, ep: req.ep, ortVersion: ort.env.versions.web };

  progress(`downloading ${req.graph.file}`);
  const { bytes, ms: downloadMs } = await fetchBytes(`/models/${req.modelId}/${req.graph.file}`);
  result.downloadMs = Math.round(downloadMs);
  result.graphBytes = bytes.byteLength;

  progress(`creating ${req.ep} session`);
  let created;
  try {
    created = await createSession(req, req.ep, bytes);
  } catch (e) {
    return { ...result, ok: false, stage: "create", error: String(e), webnnCoverage: webnnCoverage(), ortLog: logLines };
  }
  const { session, createMs } = created;
  result.createMs = Math.round(createMs);
  result.inputs = session.inputMetadata;
  result.outputs = session.outputMetadata;

  let fixture: { reference: string; inputs: Record<string, EncodedTensor>; outputs: Record<string, EncodedTensor> } | null = null;
  try {
    const res = await fetch(`/models/${req.modelId}/fixtures/${req.graph.name}.json`);
    if (res.ok) fixture = await res.json();
  } catch {
    fixture = null;
  }
  const feeds: Record<string, ort.Tensor> = {};
  session.inputNames.forEach((name, i) => {
    const encoded = fixture?.inputs[name];
    const metaInput = session.inputMetadata[i] as { name: string; type?: string; shape?: (number | string)[] };
    feeds[name] = toOrt(encoded ? decodeTensor(encoded) : makeInput({ name, dtype: metaInput.type ?? "float32", shape: [...(metaInput.shape ?? [])] }, req.graph, 1234 + i));
  });
  result.inputSource = fixture ? `fixture (${fixture.reference})` : "generated";

  progress("first run");
  let outputs: ort.InferenceSession.ReturnType;
  try {
    const t0 = performance.now();
    outputs = await session.run(feeds);
    result.firstRunMs = Math.round(performance.now() - t0);
  } catch (e) {
    await session.release();
    return { ...result, ok: false, stage: "first-run", error: String(e), webnnCoverage: webnnCoverage(), ortLog: logLines };
  }

  const drift = (reference: Record<string, { dtype: string; data: ArrayLike<number | bigint> }>) => {
    const out: Record<string, Drift> = {};
    for (const [name, ref] of Object.entries(reference)) {
      const actual = outputs[name];
      if (actual) out[name] = compare(toNumbers(ref), toNumbers({ dtype: actual.type, data: actual.data as ArrayLike<number> }));
    }
    return out;
  };
  if (fixture) result.driftVsFixture = drift(Object.fromEntries(Object.entries(fixture.outputs).map(([k, v]) => [k, decodeTensor(v)])));

  for (let i = 0; i < req.warmup; i++) await session.run(feeds);
  progress(`timing ${req.iterations} runs`);
  const times: number[] = [];
  for (let i = 0; i < req.iterations; i++) {
    const t0 = performance.now();
    outputs = await session.run(feeds);
    times.push(performance.now() - t0);
  }
  result.latencyMs = stats(times);
  const cadence = req.cadenceHz ?? req.graph.cadenceHz;
  if (cadence) result.realTimeHeadroom = Math.round((1000 / cadence / (result.latencyMs as { p95: number }).p95) * 100) / 100;

  if (req.sustainedSeconds > 0) {
    progress(`sustained ${req.sustainedSeconds}s`);
    const windows: SustainedWindow[] = [];
    const budget = cadence ? 1000 / cadence : Infinity;
    const start = performance.now();
    let windowTimes: number[] = [];
    let overruns = 0;
    let nextWindow = start + 10_000;
    let nextRun = start;
    while (performance.now() - start < req.sustainedSeconds * 1000) {
      const t0 = performance.now();
      await session.run(feeds);
      const dt = performance.now() - t0;
      windowTimes.push(dt);
      if (dt > budget) overruns++;
      if (cadence) {
        nextRun += budget;
        const wait = nextRun - performance.now();
        if (wait > 0) await new Promise((ok) => setTimeout(ok, wait));
        else nextRun = performance.now(); // fell behind: don't try to catch up in a burst
      }
      if (performance.now() >= nextWindow) {
        const s = stats(windowTimes);
        const w = { tSec: Math.round((performance.now() - start) / 1000), runs: s.n, p50Ms: s.p50, p95Ms: s.p95, maxMs: s.max, overruns };
        windows.push(w);
        postMessage({ type: "window", window: w });
        windowTimes = [];
        overruns = 0;
        nextWindow += 10_000;
      }
    }
    result.sustained = { cadenceHz: cadence ?? null, windows };
  }

  if (req.compareWithWasm && req.ep !== "wasm") {
    progress("WASM reference run");
    try {
      const { session: ref } = await createSession(req, "wasm", bytes);
      const refOut = await ref.run(feeds);
      result.driftVsWasm = drift(Object.fromEntries(Object.entries(refOut).map(([k, v]) => [k, { dtype: v.type, data: v.data as ArrayLike<number> }])));
      await ref.release();
    } catch (e) {
      result.driftVsWasm = { error: String(e) };
    }
  }

  await session.release();
  return { ...result, ok: true, webnnCoverage: webnnCoverage(), ortLog: logLines };
}

self.onmessage = async (e: MessageEvent<BenchRequest>) => {
  try {
    postMessage({ type: "result", result: await run(e.data) });
  } catch (err) {
    postMessage({ type: "result", result: { ok: false, stage: "harness", error: String(err), ortLog: logLines } });
  }
};
