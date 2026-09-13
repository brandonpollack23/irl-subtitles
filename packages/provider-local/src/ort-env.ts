import * as ort from "onnxruntime-web/webgpu";
import { env as tjsEnv, LogLevel } from "@huggingface/transformers";
import wasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";
import mjsUrl from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url";
import { verifyingFetch } from "./model-files";

let configured = false;

/**
 * One ONNX Runtime Web build (the native-WebGPU asyncify build, which also runs on Safari) shared by
 * transformers.js and our direct sessions. Everything loads from the app bundle, never a CDN (plan.md §11),
 * and every Hugging Face download is verified against catalog.lock.json.
 */
export function setupRuntime(): typeof ort {
  if (configured) return ort;
  configured = true;
  ort.env.wasm.wasmPaths = { wasm: new URL(wasmUrl, self.location.href).href, mjs: new URL(mjsUrl, self.location.href).href };
  ort.env.wasm.numThreads = globalThis.crossOriginIsolated ? Math.max(1, Math.min(4, (navigator.hardwareConcurrency ?? 2) - 1)) : 1;
  ort.env.wasm.proxy = false;
  ort.env.logLevel = "warning";
  tjsEnv.allowLocalModels = false;
  tjsEnv.allowRemoteModels = true;
  tjsEnv.useBrowserCache = true;
  tjsEnv.fetch = verifyingFetch(globalThis.fetch.bind(globalThis));
  tjsEnv.logLevel = LogLevel.WARNING;
  const onnx = tjsEnv.backends.onnx as { wasm?: { wasmPaths?: unknown; numThreads?: number; proxy?: boolean } };
  if (onnx.wasm) {
    onnx.wasm.wasmPaths = ort.env.wasm.wasmPaths;
    onnx.wasm.numThreads = ort.env.wasm.numThreads;
    onnx.wasm.proxy = false;
  }
  return ort;
}
