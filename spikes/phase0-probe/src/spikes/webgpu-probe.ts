/** WebGPU feature probe shared by the main thread and the capabilities worker. */

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Limits that decide whether large model weights and KV caches fit in GPU buffers. */
const LIMIT_KEYS = [
  "maxBufferSize",
  "maxStorageBufferBindingSize",
  "maxStorageBuffersPerShaderStage",
  "maxComputeWorkgroupStorageSize",
  "maxComputeInvocationsPerWorkgroup",
  "maxComputeWorkgroupSizeX",
  "maxComputeWorkgroupsPerDimension",
] as const;

export interface AdapterProbe {
  powerPreference: "high-performance" | "low-power";
  found: boolean;
  error?: string;
  info?: Record<string, unknown>;
  isFallbackAdapter?: boolean;
  features?: string[];
  limits?: Record<string, number>;
  device?: {
    created: boolean;
    error?: string;
    /** Features requested on the device (shader-f16 when the adapter has it). */
    requestedFeatures?: string[];
    /** add+relu compute shader with a known answer, including readback. */
    knownAnswer?: { ok: boolean; got?: number[]; error?: string };
    /** Same known answer in f16, only when shader-f16 is available. */
    knownAnswerF16?: { ok: boolean; got?: number[]; error?: string };
    /** Naive 256x256 matmul compute shader including upload and readback: a rough GPU speed hint. */
    matmul256?: { pipelineMs: number; firstMs: number; p50Ms: number; iterations: number; maxAbsError?: number; error?: string };
    /** A GPUDevice lost/uncaptured error during the probe. */
    errors?: string[];
  };
}

export interface WebGPUProbe {
  secureContext: boolean;
  navigatorGpu: boolean;
  preferredCanvasFormat?: string;
  wgslLanguageFeatures?: string[];
  adapters: AdapterProbe[];
}

function round(v: number) {
  return Math.round(v * 100) / 100;
}

function adapterInfo(adapter: any): Record<string, unknown> | undefined {
  const info = adapter.info;
  if (!info) return undefined;
  // GPUAdapterInfo fields are prototype getters, so spreading it yields {}.
  const out: Record<string, unknown> = {};
  for (const k of ["vendor", "architecture", "device", "description", "subgroupMinSize", "subgroupMaxSize", "isFallbackAdapter"]) {
    if (info[k] !== undefined && info[k] !== "") out[k] = info[k];
  }
  return out;
}

async function runCompute(device: any, code: string, inputs: ArrayBufferView[], outBytes: number, dispatch: [number, number?], pipeline?: any) {
  const GPUBufferUsage = (globalThis as any).GPUBufferUsage;
  const GPUMapMode = (globalThis as any).GPUMapMode;
  pipeline ??= device.createComputePipeline({ layout: "auto", compute: { module: device.createShaderModule({ code }), entryPoint: "main" } });
  const buffers = inputs.map((data) => {
    const b = device.createBuffer({ size: Math.ceil(data.byteLength / 4) * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(b, 0, data);
    return b;
  });
  const out = device.createBuffer({ size: outBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const staging = device.createBuffer({ size: outBytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [...buffers, out].map((buffer, binding) => ({ binding, resource: { buffer } })),
  });
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(dispatch[0], dispatch[1] ?? 1);
  pass.end();
  encoder.copyBufferToBuffer(out, 0, staging, 0, outBytes);
  device.queue.submit([encoder.finish()]);
  await staging.mapAsync(GPUMapMode.READ);
  const bytes = staging.getMappedRange().slice(0);
  staging.unmap();
  for (const b of [...buffers, out, staging]) b.destroy();
  return { bytes, pipeline };
}

const ADD_RELU = (t: "f32" | "f16") => `${t === "f16" ? "enable f16;" : ""}
@group(0) @binding(0) var<storage, read> x: array<${t}, 4>;
@group(0) @binding(1) var<storage, read_write> y: array<${t}, 4>;
const c = array<${t}, 4>(1.0, -5.0, 0.5, 2.0);
@compute @workgroup_size(4)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x < 4u) { y[id.x] = max(x[id.x] + c[id.x], 0.0); }
}`;

const MATMUL_N = 256;
const MATMUL = `
@group(0) @binding(0) var<storage, read> a: array<f32>;
@group(0) @binding(1) var<storage, read> b: array<f32>;
@group(0) @binding(2) var<storage, read_write> c: array<f32>;
const N: u32 = ${MATMUL_N}u;
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= N || id.y >= N) { return; }
  var s: f32 = 0.0;
  for (var k: u32 = 0u; k < N; k++) { s += a[id.y * N + k] * b[k * N + id.x]; }
  c[id.y * N + id.x] = s;
}`;

const want = [2, 0, 3.5, 0];

async function probeDevice(adapter: any, features: string[]): Promise<NonNullable<AdapterProbe["device"]>> {
  const requestedFeatures = features.includes("shader-f16") ? ["shader-f16"] : [];
  const result: NonNullable<AdapterProbe["device"]> = { created: false, requestedFeatures, errors: [] };
  let device: any;
  try {
    // Like ORT: ask for the adapter's maximum buffer sizes, so the reported limits are what models get.
    const requiredLimits: Record<string, number> = {};
    for (const k of ["maxBufferSize", "maxStorageBufferBindingSize", "maxComputeWorkgroupStorageSize"]) {
      if (typeof adapter.limits?.[k] === "number") requiredLimits[k] = adapter.limits[k];
    }
    device = await adapter.requestDevice({ requiredFeatures: requestedFeatures, requiredLimits });
    result.created = true;
  } catch (e) {
    result.error = String(e);
    return result;
  }
  device.lost?.then((info: any) => result.errors!.push(`lost: ${info?.reason} ${info?.message}`));
  device.addEventListener?.("uncapturederror", (ev: any) => result.errors!.push(`uncaptured: ${ev.error?.message ?? ev}`));

  const kat = async (t: "f32" | "f16") => {
    try {
      const x = t === "f16" ? new Uint16Array(4) : new Float32Array([1, 2, 3, -4]);
      if (t === "f16") {
        const F16 = (globalThis as any).Float16Array;
        if (!F16) return { ok: false, error: "Float16Array unavailable to encode f16 input" };
        new Uint8Array(x.buffer).set(new Uint8Array(new F16([1, 2, 3, -4]).buffer));
      }
      const { bytes } = await runCompute(device, ADD_RELU(t), [x], 4 * (t === "f16" ? 2 : 4), [1]);
      const got = t === "f16" ? [...new (globalThis as any).Float16Array(bytes)] as number[] : [...new Float32Array(bytes)];
      return { ok: want.every((w, i) => Math.abs(w - got[i]!) < 1e-3), got };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  };
  result.knownAnswer = await kat("f32");
  if (requestedFeatures.includes("shader-f16")) result.knownAnswerF16 = await kat("f16");

  try {
    const n = MATMUL_N;
    const a = Float32Array.from({ length: n * n }, (_, i) => ((i * 104729) % 17) / 17);
    const b = Float32Array.from({ length: n * n }, (_, i) => ((i * 7919) % 13) / 13 - 0.5);
    const t0 = performance.now();
    const module = device.createShaderModule({ code: MATMUL });
    const pipeline = await device.createComputePipelineAsync({ layout: "auto", compute: { module, entryPoint: "main" } });
    const pipelineMs = performance.now() - t0;
    const iterations = 30;
    const times: number[] = [];
    let last: ArrayBuffer | undefined;
    for (let i = 0; i < iterations; i++) {
      const s = performance.now();
      last = (await runCompute(device, MATMUL, [a, b], n * n * 4, [Math.ceil(n / 8), Math.ceil(n / 8)], pipeline)).bytes;
      times.push(performance.now() - s);
    }
    // Spot-check a few cells against the CPU.
    const c = new Float32Array(last!);
    let maxAbsError = 0;
    for (const [row, col] of [[0, 0], [17, 200], [255, 255]] as const) {
      let s = 0;
      for (let k = 0; k < n; k++) s += a[row * n + k]! * b[k * n + col]!;
      maxAbsError = Math.max(maxAbsError, Math.abs(s - c[row * n + col]!));
    }
    const sorted = times.slice(1).sort((p, q) => p - q);
    result.matmul256 = { pipelineMs: Math.round(pipelineMs), firstMs: Math.round(times[0]!), p50Ms: round(sorted[Math.floor(sorted.length / 2)]!), iterations, maxAbsError };
  } catch (e) {
    result.matmul256 = { pipelineMs: 0, firstMs: 0, p50Ms: 0, iterations: 0, error: String(e) };
  }
  if (!result.errors!.length) delete result.errors;
  device.destroy();
  return result;
}

async function probeAdapter(gpu: any, powerPreference: AdapterProbe["powerPreference"]): Promise<AdapterProbe> {
  const result: AdapterProbe = { powerPreference, found: false };
  let adapter: any;
  try {
    adapter = await gpu.requestAdapter({ powerPreference });
  } catch (e) {
    result.error = String(e);
    return result;
  }
  if (!adapter) return result;
  result.found = true;
  result.info = adapterInfo(adapter);
  result.isFallbackAdapter = adapter.info?.isFallbackAdapter ?? adapter.isFallbackAdapter;
  result.features = [...(adapter.features ?? [])].sort();
  result.limits = Object.fromEntries(LIMIT_KEYS.filter((k) => typeof adapter.limits?.[k] === "number").map((k) => [k, adapter.limits[k]]));
  result.device = await probeDevice(adapter, result.features);
  return result;
}

export async function probeWebGPU(): Promise<WebGPUProbe> {
  const g = globalThis as any;
  const gpu = g.navigator?.gpu;
  const out: WebGPUProbe = { secureContext: g.isSecureContext === true, navigatorGpu: !!gpu, adapters: [] };
  if (!gpu) return out;
  out.preferredCanvasFormat = typeof gpu.getPreferredCanvasFormat === "function" ? gpu.getPreferredCanvasFormat() : undefined;
  out.wgslLanguageFeatures = gpu.wgslLanguageFeatures ? [...gpu.wgslLanguageFeatures].sort() : undefined;
  // Phones have one GPU; both preferences show whether the browser distinguishes them at all.
  for (const p of ["high-performance", "low-power"] as const) out.adapters.push(await probeAdapter(gpu, p));
  return out;
}

/** One-line summary for the capabilities panel. */
export function summarizeWebGPU(p: WebGPUProbe | { error: string } | undefined): string {
  if (!p) return "no result";
  if ("error" in p) return `error: ${p.error}`;
  if (!p.navigatorGpu) return p.secureContext ? "navigator.gpu missing" : "navigator.gpu missing (not a secure context)";
  const a = p.adapters.find((x) => x.found);
  if (!a) return "no adapter";
  const d = a.device;
  const kat = d?.created ? (d.knownAnswer?.ok ? "ok" : "KAT-fail") : "no-device";
  const f16 = a.features?.includes("shader-f16") ? (d?.knownAnswerF16?.ok ? " f16:ok" : " f16:fail") : " f16:none";
  const maxBuf = a.limits?.maxBufferSize ? ` maxBuffer ${Math.round(a.limits.maxBufferSize / 2 ** 20)} MiB` : "";
  return `${a.info?.vendor ?? "?"}/${a.info?.architecture ?? "?"} ${kat}${f16}${maxBuf}`;
}
