/** Framework- and runtime-free helpers shared by the benchmark worker and tests. */

export type WebDtype = "float32" | "float16" | "float64" | "int64" | "int32" | "int8" | "uint8" | "bool";

export interface RegistryGraph {
  name: string;
  file: string;
  externalData?: string[];
  dims?: Record<string, number>;
  shapes?: Record<string, number[]>;
  values?: Record<string, number | boolean>;
  cadenceHz?: number;
  notes?: string;
}

export interface RegistryModel {
  id: string;
  role: "vad" | "stt-live" | "stt-final" | "speaker-embedding" | "summary";
  displayName: string;
  catalogDefault?: boolean;
  license: string;
  status?: "needs-export";
  notes?: string;
  graphs: RegistryGraph[];
}

export interface IoSpec {
  name: string;
  dtype: string;
  shape: (number | string)[];
}

export interface GraphMetadata {
  inputs: IoSpec[];
  outputs: IoSpec[];
  opCounts: Record<string, number>;
  fileBytes: number;
}

export interface EncodedTensor {
  dtype: WebDtype;
  shape: number[];
  b64: string;
}

export type TypedData = Float32Array | Float64Array | Uint16Array | BigInt64Array | Int32Array | Int8Array | Uint8Array;

export interface RawTensor {
  dtype: WebDtype;
  shape: number[];
  data: TypedData;
}

/**
 * Symbolic dims to pin as freeDimensionOverrides. Static shapes keep the WebGPU EP from
 * re-specializing kernels per call, so per-input shape overrides are translated back into
 * their symbolic names.
 */
export function freeDimensionOverrides(graph: RegistryGraph, meta: GraphMetadata | undefined): Record<string, number> {
  const out: Record<string, number> = { ...(graph.dims ?? {}) };
  for (const input of meta?.inputs ?? []) {
    const override = graph.shapes?.[input.name];
    if (!override) continue;
    input.shape.forEach((d, i) => {
      if (typeof d === "string" && d !== "?" && override[i] !== undefined) out[d] = override[i]!;
    });
  }
  for (const input of meta?.inputs ?? []) {
    for (const d of input.shape) if (typeof d === "string" && d !== "?" && !(d in out)) out[d] = 1;
  }
  return out;
}

export function resolveShape(input: IoSpec, graph: RegistryGraph): number[] {
  if (graph.shapes?.[input.name]) return [...graph.shapes[input.name]!];
  return input.shape.map((d) => (typeof d === "number" && d > 0 ? d : typeof d === "string" && graph.dims?.[d] !== undefined ? graph.dims[d]! : 1));
}

/** Deterministic xorshift so generated inputs are repeatable across runs and EPs. */
function rng(seed: number) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 0x1_0000_0000;
  };
}

export function float16Bits(v: number): number {
  const f32 = new Float32Array([v]);
  const i = new Uint32Array(f32.buffer)[0]!;
  const sign = (i >>> 16) & 0x8000;
  const exp = ((i >>> 23) & 0xff) - 127 + 15;
  const mant = i & 0x7fffff;
  if (exp <= 0) return sign;
  if (exp >= 31) return sign | 0x7c00;
  return sign | (exp << 10) | (mant >>> 13);
}

export function float16Value(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const exp = (bits >>> 10) & 0x1f;
  const mant = bits & 0x3ff;
  if (exp === 0) return sign * 2 ** -14 * (mant / 1024);
  if (exp === 31) return mant ? NaN : sign * Infinity;
  return sign * 2 ** (exp - 15) * (1 + mant / 1024);
}

export function makeInput(input: IoSpec, graph: RegistryGraph, seed: number): RawTensor {
  const shape = resolveShape(input, graph);
  const n = shape.reduce((a, b) => a * b, 1);
  const name = input.name.toLowerCase();
  const fixed = graph.values?.[input.name];
  const rand = rng(seed);
  const dtype = input.dtype as WebDtype;
  switch (dtype) {
    case "bool":
      return { dtype, shape, data: new Uint8Array(n).fill(fixed === false ? 0 : 1) };
    case "int64": {
      const data = new BigInt64Array(n);
      for (let i = 0; i < n; i++) {
        const v =
          fixed !== undefined ? Number(fixed)
          : name.includes("mask") ? 1
          : name.includes("position") ? i % (shape[shape.length - 1] ?? 1)
          : name.includes("length") ? (shape[shape.length - 1] ?? 1)
          : 1 + Math.floor(rand() * 999);
        data[i] = BigInt(v);
      }
      return { dtype, shape, data };
    }
    case "int32": {
      const data = new Int32Array(n);
      for (let i = 0; i < n; i++) data[i] = fixed !== undefined ? Number(fixed) : name.includes("mask") ? 1 : 1 + Math.floor(rand() * 999);
      return { dtype, shape, data };
    }
    case "float16": {
      const data = new Uint16Array(n);
      for (let i = 0; i < n; i++) data[i] = float16Bits(fixed !== undefined ? Number(fixed) : (rand() - 0.5) * 1);
      return { dtype, shape, data };
    }
    default: {
      const data = new Float32Array(n);
      for (let i = 0; i < n; i++) data[i] = fixed !== undefined ? Number(fixed) : (rand() - 0.5) * 1;
      return { dtype: "float32", shape, data };
    }
  }
}

export function decodeTensor(t: EncodedTensor): RawTensor {
  const bin = atob(t.b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const buf = bytes.buffer;
  const data: TypedData =
    t.dtype === "float32" ? new Float32Array(buf)
    : t.dtype === "float64" ? new Float64Array(buf)
    : t.dtype === "float16" ? new Uint16Array(buf)
    : t.dtype === "int64" ? new BigInt64Array(buf)
    : t.dtype === "int32" ? new Int32Array(buf)
    : t.dtype === "int8" ? new Int8Array(buf)
    : new Uint8Array(buf);
  return { dtype: t.dtype, shape: t.shape, data };
}

export function toNumbers(t: { dtype: string; data: ArrayLike<number | bigint> }): Float64Array {
  const out = new Float64Array(t.data.length);
  for (let i = 0; i < t.data.length; i++) {
    const v = t.data[i]!;
    // float16 may arrive as raw Uint16Array bits or as a native Float16Array.
    out[i] = t.dtype === "float16" && t.data instanceof Uint16Array ? float16Value(Number(v)) : Number(v);
  }
  return out;
}

export interface Drift {
  maxAbsDiff: number;
  meanAbsDiff: number;
  cosine: number;
  nonFinite: number;
}

export function compare(expected: Float64Array, actual: Float64Array): Drift {
  if (expected.length !== actual.length) return { maxAbsDiff: Infinity, meanAbsDiff: Infinity, cosine: NaN, nonFinite: 0 };
  let max = 0, sum = 0, dot = 0, ne = 0, na = 0, nonFinite = 0;
  for (let i = 0; i < expected.length; i++) {
    const e = expected[i]!, a = actual[i]!;
    if (!Number.isFinite(a)) {
      nonFinite++;
      continue;
    }
    const d = Math.abs(e - a);
    max = Math.max(max, d);
    sum += d;
    dot += e * a;
    ne += e * e;
    na += a * a;
  }
  return { maxAbsDiff: max, meanAbsDiff: sum / Math.max(1, expected.length), cosine: ne && na ? dot / Math.sqrt(ne * na) : ne === na ? 1 : 0, nonFinite };
}
