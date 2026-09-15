import { describe, expect, it } from "vitest";
import type { BenchmarkResult } from "@irl/domain";
import { catalogEntry } from "../src/catalog";
import { selectTarget, type DeviceCapabilities } from "../src/device";

const caps = (gpu: boolean): DeviceCapabilities => ({
  platform: "android",
  userAgent: "test",
  secureContext: true,
  crossOriginIsolated: false,
  webgpu: { available: gpu, shaderF16: gpu },
  wasmSimd: true,
  wasmThreads: false,
  hardwareConcurrency: 8,
  deviceMemoryGb: 8,
  webCodecsOpus: true,
});

const bench = (modelId: string, target: "webgpu" | "wasm", realTimeFactor: number) => ({ modelId, target, ok: true, realTimeFactor }) as BenchmarkResult;

describe("selectTarget compute mode", () => {
  const embedding = catalogEntry("campplus-voxceleb")!;
  const whisper = catalogEntry("whisper-small")!;
  const summary = catalogEntry("gemma-4-e2b-q4")!;

  it("auto keeps benchmark evidence and the manifest target", () => {
    expect(selectTarget(embedding, caps(true), "balanced")).toBe("wasm");
    expect(selectTarget(whisper, caps(true), "balanced")).toBe("webgpu");
    expect(selectTarget(embedding, caps(true), "balanced", [bench(embedding.id, "webgpu", 0.01), bench(embedding.id, "wasm", 0.1)], "auto")).toBe("webgpu");
  });

  it("webgpu and cpu override benchmarks, manifest and power policy for models that run on either", () => {
    const cpuWins = [bench(embedding.id, "webgpu", 0.5), bench(embedding.id, "wasm", 0.01)];
    expect(selectTarget(embedding, caps(true), "low-power", cpuWins, "webgpu")).toBe("webgpu");
    expect(selectTarget(whisper, caps(true), "fast", [], "cpu")).toBe("wasm");
  });

  it("models that need WebGPU keep it, and nothing picks WebGPU without a GPU", () => {
    expect(selectTarget(summary, caps(true), "balanced", [], "cpu")).toBe("webgpu");
    expect(selectTarget(whisper, caps(false), "balanced", [], "webgpu")).toBe("wasm");
  });
});
