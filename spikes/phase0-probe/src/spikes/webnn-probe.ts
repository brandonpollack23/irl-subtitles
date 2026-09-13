/** WebNN feature probe shared by the main thread and the capabilities worker. */

/* eslint-disable @typescript-eslint/no-explicit-any */
type ML = { createContext(opts?: Record<string, unknown>): Promise<any> };

export type DeviceType = "npu" | "gpu" | "cpu";

export interface ContextProbe {
  deviceType: DeviceType;
  created: boolean;
  error?: string;
  accelerated?: unknown;
  opSupportLimitsKeys?: number;
  opSupportLimits?: Record<string, unknown>;
  /** A tiny add+relu graph with a known answer, executed end to end. */
  knownAnswer?: { ok: boolean; api: "dispatch" | "compute"; got?: number[]; error?: string };
  /** 256x256 matmul timing: a rough hint of which silicon actually backs the context. */
  matmul256?: { buildMs: number; firstMs: number; p50Ms: number; iterations: number; error?: string };
}

export interface WebNNProbe {
  navigatorMl: boolean;
  globals: Record<string, boolean>;
  contexts: ContextProbe[];
}

function descriptor(shape: number[]) {
  // Chromium renamed `dimensions` to `shape`; pass both so older WebViews still accept it.
  return { dataType: "float32", shape, dimensions: shape };
}

async function run(context: any, graph: any, inputs: Record<string, Float32Array>, outputShape: number[], inputShapes: Record<string, number[]>) {
  if (typeof context.dispatch === "function" && typeof context.createTensor === "function") {
    const inT: Record<string, any> = {};
    for (const [name, data] of Object.entries(inputs)) {
      inT[name] = await context.createTensor({ ...descriptor(inputShapes[name]!), writable: true });
      context.writeTensor(inT[name], data);
    }
    const out = await context.createTensor({ ...descriptor(outputShape), readable: true });
    context.dispatch(graph, inT, { y: out });
    const buf = await context.readTensor(out);
    return { api: "dispatch" as const, y: new Float32Array(buf) };
  }
  const y = new Float32Array(outputShape.reduce((a, b) => a * b, 1));
  const r = await context.compute(graph, inputs, { y });
  return { api: "compute" as const, y: r.outputs.y as Float32Array };
}

async function probeContext(ml: ML, deviceType: DeviceType, includeLimits: boolean): Promise<ContextProbe> {
  const result: ContextProbe = { deviceType, created: false };
  let context: any;
  try {
    context = await ml.createContext({ deviceType, powerPreference: "default" });
    result.created = true;
    result.accelerated = context.accelerated;
  } catch (e) {
    result.error = String(e);
    return result;
  }
  try {
    if (typeof context.opSupportLimits === "function") {
      const limits = context.opSupportLimits();
      result.opSupportLimitsKeys = Object.keys(limits).length;
      if (includeLimits) result.opSupportLimits = JSON.parse(JSON.stringify(limits));
    }
  } catch (e) {
    result.opSupportLimitsKeys = -1;
  }

  const MLGraphBuilder = (globalThis as any).MLGraphBuilder;
  try {
    const b = new MLGraphBuilder(context);
    const x = b.input("x", descriptor([1, 4]));
    const c = b.constant(descriptor([1, 4]), new Float32Array([1, -5, 0.5, 2]));
    const graph = await b.build({ y: b.relu(b.add(x, c)) });
    const { api, y } = await run(context, graph, { x: new Float32Array([1, 2, 3, -4]) }, [1, 4], { x: [1, 4] });
    const got = [...y];
    const want = [2, 0, 3.5, 0];
    result.knownAnswer = { ok: want.every((w, i) => Math.abs(w - got[i]!) < 1e-5), api, got };
  } catch (e) {
    result.knownAnswer = { ok: false, api: "dispatch", error: String(e) };
  }

  try {
    const n = 256;
    const t0 = performance.now();
    const b = new MLGraphBuilder(context);
    const a = b.input("a", descriptor([n, n]));
    const w = b.constant(descriptor([n, n]), Float32Array.from({ length: n * n }, (_, i) => ((i * 7919) % 13) / 13 - 0.5));
    const graph = await b.build({ y: b.matmul(a, w) });
    const buildMs = performance.now() - t0;
    const input = Float32Array.from({ length: n * n }, (_, i) => ((i * 104729) % 17) / 17);
    const times: number[] = [];
    const iterations = 30;
    for (let i = 0; i < iterations; i++) {
      const s = performance.now();
      await run(context, graph, { a: input }, [n, n], { a: [n, n] });
      times.push(performance.now() - s);
    }
    const sorted = times.slice(1).sort((p, q) => p - q);
    result.matmul256 = {
      buildMs: Math.round(buildMs),
      firstMs: Math.round(times[0]!),
      p50Ms: Math.round(sorted[Math.floor(sorted.length / 2)]! * 100) / 100,
      iterations,
    };
  } catch (e) {
    result.matmul256 = { buildMs: 0, firstMs: 0, p50Ms: 0, iterations: 0, error: String(e) };
  }
  context.destroy?.();
  return result;
}

export async function probeWebNN(includeLimits = false): Promise<WebNNProbe> {
  const g = globalThis as any;
  const ml: ML | undefined = g.navigator?.ml;
  const out: WebNNProbe = {
    navigatorMl: !!ml,
    globals: {
      MLContext: typeof g.MLContext !== "undefined",
      MLGraphBuilder: typeof g.MLGraphBuilder !== "undefined",
      MLTensor: typeof g.MLTensor !== "undefined",
      MLGraph: typeof g.MLGraph !== "undefined",
    },
    contexts: [],
  };
  if (!ml) return out;
  for (const d of ["npu", "gpu", "cpu"] as const) out.contexts.push(await probeContext(ml, d, includeLimits));
  return out;
}
