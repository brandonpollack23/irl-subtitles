import type * as Ort from "onnxruntime-web/webgpu";
import type * as Tjs from "@huggingface/transformers";
import asyncifyWasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";
import asyncifyMjsUrl from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url";
import plainWasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.wasm?url";
import plainMjsUrl from "onnxruntime-web/ort-wasm-simd-threaded.mjs?url";
import { verifyingFetch } from "./model-files";
import { flavorOfWorker, type OrtFlavor } from "./ort-flavor";

export type { OrtFlavor } from "./ort-flavor";

export interface Runtime {
  ort: typeof Ort;
  tjs: typeof Tjs;
  flavor: OrtFlavor;
}

let runtime: Promise<Runtime> | null = null;

/**
 * One ONNX Runtime Web build per worker, shared by transformers.js (for the CPU build, through its
 * `Symbol.for("onnxruntime")` hook, set before transformers.js is imported) and our direct sessions. Everything loads from the app
 * bundle, never a CDN (plan.md §11), and every Hugging Face download is verified against catalog.lock.json.
 */
export function setupRuntime(flavor: OrtFlavor = flavorOfWorker()): Promise<Runtime> {
  runtime ??= (async () => {
    const ort = (flavor === "wasm" ? await import("onnxruntime-web/wasm") : await import("onnxruntime-web/webgpu")) as typeof Ort;
    const urls = flavor === "wasm" ? { wasm: plainWasmUrl, mjs: plainMjsUrl } : { wasm: asyncifyWasmUrl, mjs: asyncifyMjsUrl };
    ort.env.wasm.wasmPaths = { wasm: new URL(urls.wasm, self.location.href).href, mjs: new URL(urls.mjs, self.location.href).href };
    ort.env.wasm.numThreads = globalThis.crossOriginIsolated ? Math.max(1, Math.min(4, (navigator.hardwareConcurrency ?? 2) - 1)) : 1;
    ort.env.wasm.proxy = false;
    ort.env.logLevel = "warning";
    // transformers.js imports the WebGPU build itself; hand it the CPU build instead. With an injected runtime it
    // knows no device names, so callers in a wasm worker leave `device` unset (ORT's default is the CPU).
    if (flavor === "wasm") (globalThis as Record<symbol, unknown>)[Symbol.for("onnxruntime")] = ort;
    const tjs = await import("@huggingface/transformers");
    const env = tjs.env;
    env.allowLocalModels = false;
    env.allowRemoteModels = true;
    env.useBrowserCache = true;
    env.fetch = verifyingFetch(globalThis.fetch.bind(globalThis));
    env.logLevel = tjs.LogLevel.WARNING;
    const onnx = env.backends.onnx as { wasm?: { wasmPaths?: unknown; numThreads?: number; proxy?: boolean } };
    if (onnx.wasm) {
      onnx.wasm.wasmPaths = ort.env.wasm.wasmPaths;
      onnx.wasm.numThreads = ort.env.wasm.numThreads;
      onnx.wasm.proxy = false;
    }
    return { ort, tjs, flavor };
  })();
  return runtime;
}
