import type { Availability, BenchmarkResult, ComputeMode, ExecutionTarget, ModelCatalogEntry, PowerPolicy } from "@irl/domain";

export interface DeviceCapabilities {
  platform: "android" | "ios" | "desktop";
  userAgent: string;
  secureContext: boolean;
  crossOriginIsolated: boolean;
  webgpu: {
    available: boolean;
    error?: string;
    vendor?: string;
    architecture?: string;
    shaderF16: boolean;
    maxBufferSize?: number;
    maxStorageBufferBindingSize?: number;
    inWorker?: boolean;
  };
  wasmSimd: boolean;
  wasmThreads: boolean;
  hardwareConcurrency: number;
  deviceMemoryGb: number | null;
  webCodecsOpus: boolean;
}

export function detectPlatform(ua = navigator.userAgent): DeviceCapabilities["platform"] {
  if (/Android/i.test(ua)) return "android";
  if (/iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return "ios";
  return "desktop";
}

// A minimal SIMD module (i32x4 + i32x4); validates only where WASM SIMD is implemented.
const SIMD_PROBE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);

export async function detectCapabilities(): Promise<DeviceCapabilities> {
  const gpu: DeviceCapabilities["webgpu"] = { available: false, shaderF16: false };
  const nav = navigator as Navigator & { gpu?: { requestAdapter(o?: unknown): Promise<GPUAdapterLike | null> }; deviceMemory?: number };
  if (nav.gpu) {
    try {
      const adapter = await nav.gpu.requestAdapter({ powerPreference: "high-performance" });
      if (adapter) {
        gpu.available = true;
        gpu.shaderF16 = adapter.features.has("shader-f16");
        gpu.maxBufferSize = adapter.limits.maxBufferSize;
        gpu.maxStorageBufferBindingSize = adapter.limits.maxStorageBufferBindingSize;
        const info = adapter.info ?? {};
        gpu.vendor = info.vendor;
        gpu.architecture = info.architecture;
      } else gpu.error = "no adapter";
    } catch (e) {
      gpu.error = String(e);
    }
  } else gpu.error = "navigator.gpu missing";
  let simd = false;
  try {
    simd = WebAssembly.validate(SIMD_PROBE);
  } catch {
    simd = false;
  }
  let opus = false;
  try {
    const AE = (globalThis as { AudioEncoder?: { isConfigSupported(c: unknown): Promise<{ supported: boolean }> } }).AudioEncoder;
    opus = !!AE && (await AE.isConfigSupported({ codec: "opus", sampleRate: 48000, numberOfChannels: 1, bitrate: 32000 })).supported;
  } catch {
    opus = false;
  }
  return {
    platform: detectPlatform(),
    userAgent: navigator.userAgent,
    secureContext: globalThis.isSecureContext,
    crossOriginIsolated: globalThis.crossOriginIsolated === true,
    webgpu: gpu,
    wasmSimd: simd,
    wasmThreads: globalThis.crossOriginIsolated === true && typeof SharedArrayBuffer !== "undefined",
    hardwareConcurrency: navigator.hardwareConcurrency ?? 1,
    deviceMemoryGb: nav.deviceMemory ?? null,
    webCodecsOpus: opus,
  };
}

interface GPUAdapterLike {
  features: { has(f: string): boolean };
  limits: { maxBufferSize: number; maxStorageBufferBindingSize: number };
  info?: { vendor?: string; architecture?: string };
}

/** Device-level eligibility on top of catalog availability. */
export function availabilityOnDevice(entry: ModelCatalogEntry, caps: DeviceCapabilities | null): Availability {
  if (entry.availability.status === "unavailable") return entry.availability;
  if (!caps) return entry.availability;
  const needsGpu = entry.manifest.params?.requiresWebGpu === true;
  if (needsGpu && !caps.webgpu.available) return { status: "unavailable", reason: `Needs WebGPU (${caps.webgpu.error ?? "unavailable"})` };
  if (entry.manifest.requiredFeatures?.includes("shader-f16") && !caps.webgpu.shaderF16) return { status: "unavailable", reason: "Needs the WebGPU shader-f16 feature, which this GPU lacks" };
  const biggest = Math.max(0, ...entry.manifest.files.map((f) => f.bytes ?? 0));
  if (needsGpu && caps.webgpu.maxBufferSize && biggest > caps.webgpu.maxBufferSize * 1.05) return { status: "unavailable", reason: `Largest file (${(biggest / 2 ** 30).toFixed(1)} GiB) exceeds this GPU's maxBufferSize` };
  return { status: "available" };
}

/**
 * Per-model execution target (plan.md §5 ComputeRuntimeSelector): benchmark evidence first, then the
 * manifest's platform target, adjusted by power policy; WebGPU only when present. A compute mode other than "auto"
 * overrides all of that for models that can run on either target.
 */
export function selectTarget(entry: ModelCatalogEntry, caps: DeviceCapabilities, policy: PowerPolicy, benchmarks: readonly BenchmarkResult[] = [], mode: ComputeMode = "auto"): ExecutionTarget {
  const needsGpu = entry.manifest.params?.requiresWebGpu === true;
  if (!caps.webgpu.available) return "wasm";
  if (needsGpu) return "webgpu";
  if (mode === "cpu") return "wasm";
  if (mode === "webgpu") return "webgpu";
  const ok = benchmarks.filter((b) => b.modelId === entry.id && b.ok && b.realTimeFactor !== undefined);
  const gpu = ok.find((b) => b.target === "webgpu");
  const cpu = ok.find((b) => b.target === "wasm");
  if (gpu && cpu && !needsGpu) {
    // low-power prefers WASM unless WebGPU is clearly faster; fast prefers the lower RTF.
    const margin = policy === "low-power" ? 0.5 : policy === "fast" ? 1 : 0.8;
    return gpu.realTimeFactor! < cpu.realTimeFactor! * margin ? "webgpu" : "wasm";
  }
  if (gpu && !cpu) return "webgpu";
  if (cpu && !gpu && !needsGpu) return "wasm";
  const t = entry.manifest.targets[caps.platform];
  return needsGpu ? "webgpu" : policy === "low-power" && entry.role !== "summary" ? "wasm" : t;
}
