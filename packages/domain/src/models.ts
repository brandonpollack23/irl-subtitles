export type ModelRole = "vad" | "stt-live" | "stt-final" | "speaker-embedding" | "summary";

export type ExecutionTarget = "webgpu" | "wasm";

export type PowerPolicy = "low-power" | "balanced" | "fast";

/** The user's choice of where local models run: "auto" picks per model (benchmarks, manifest, power policy). */
export type ComputeMode = "auto" | "webgpu" | "cpu";

/**
 * How the local provider runs an entry:
 * - ort-silero / ort-fbank-embedding / ort-waveform-embedding: hand-written ORT Web session loops.
 * - tjs-asr / tjs-embedding / tjs-llm: @huggingface/transformers pipelines (own decode loops, KV cache on GPU).
 * - moonshine-wasm: Moonshine Streaming through Moonshine Voice's own WASM runtime (incremental encoder and
 *   decoder caches, CPU only; vendor/moonshine-wasm).
 */
export type ModelAdapter =
  | "ort-silero"
  | "ort-fbank-embedding"
  | "ort-waveform-embedding"
  | "tjs-asr"
  | "tjs-embedding"
  | "tjs-llm"
  | "moonshine-wasm";

export interface ModelFile {
  /** Path within the repo, e.g. "onnx/encoder_model_fp16.onnx". */
  path: string;
  bytes?: number;
  /** Hex SHA-256 pinned by scripts/pin-models.mjs; downloads that don't match are rejected. */
  sha256?: string;
}

export interface ModelManifest {
  /** Hugging Face repo or absolute base URL. */
  source: { type: "hf"; repo: string; revision: string } | { type: "url"; baseUrl: string };
  files: ModelFile[];
  adapter: ModelAdapter;
  /** transformers.js dtype selection (per-module map allowed). */
  dtype?: string | Record<string, string>;
  /** Execution target per platform, before benchmark results override it. */
  targets: { android: ExecutionTarget; ios: ExecutionTarget; desktop: ExecutionTarget };
  requiredFeatures?: ("shader-f16")[];
  minFreeBytes?: number;
  /** Maximum absolute drift allowed between WebGPU and WASM on the known-answer probe. */
  tolerance?: number;
  quantization: string;
  version: string;
  /** Adapter-specific parameters (window sizes, prompt formats, etc.). */
  params?: Record<string, unknown>;
}

export type Availability =
  | { status: "available" }
  | { status: "unavailable"; reason: string };

export interface ModelCatalogEntry {
  id: string;
  role: ModelRole;
  displayName: string;
  parameters: number;
  downloadBytes: number;
  languages: readonly string[] | "auto";
  timing?: "word" | "segment-interpolated";
  embeddingSpace?: string;
  license: string;
  manifest: ModelManifest;
  availability: Availability;
  /** plan.md §6.1 default for its role (may be unavailable; see effectiveDefault). */
  planDefault?: boolean;
  notes?: string;
}

export interface ModelSelection {
  vad: string;
  sttLive: string | "off";
  sttFinal: string | "same-as-live";
  speakerEmbedding: string;
  summary: string | "cloud" | "off";
}

export interface BenchmarkResult {
  modelId: string;
  target: ExecutionTarget;
  ok: boolean;
  /** Processing time / audio time (STT, embedding, VAD); lower is better. */
  realTimeFactor?: number;
  tokensPerSecond?: number;
  loadMs?: number;
  p50Ms?: number;
  p95Ms?: number;
  knownAnswer?: { ok: boolean; detail: string };
  drift?: number;
  error?: string;
  measuredAt: string;
  userAgent: string;
}

export type PerformanceTier = "fast-live" | "final-local" | "battery-saver";

export function tierForSelection(sel: Pick<ModelSelection, "sttLive">): PerformanceTier {
  return sel.sttLive === "off" ? "battery-saver" : "fast-live";
}
