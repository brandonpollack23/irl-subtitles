/**
 * Which ONNX Runtime Web build a worker runs. "webgpu" is the asyncify build the WebGPU execution provider
 * needs; "wasm" is the plain SIMD build, for workers whose sessions all run on the CPU. On JavaScriptCore
 * (the Even simulator, iOS) asyncify costs seconds: a q4 Moonshine decoder session took 5.1 s to create vs
 * 0.6 s, and its first 2 s encoder run 8.0 s vs 0.17 s (irl-subt-kdl.2).
 */
export type OrtFlavor = "webgpu" | "wasm";

/** Workers carry their flavor in their name (`irl-asr:wasm`) so it's known before any module loads. */
export function workerName(base: string, flavor: OrtFlavor): string {
  return `${base}:${flavor}`;
}

export function flavorOfWorker(name = (globalThis as { name?: string }).name ?? ""): OrtFlavor {
  return name.endsWith(":wasm") ? "wasm" : "webgpu";
}
