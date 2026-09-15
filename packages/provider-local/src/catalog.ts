import type { ExecutionTarget, ModelAdapter, ModelCatalogEntry, ModelRole, ModelSelection } from "@irl/domain";
import lockJson from "./catalog.lock.json" with { type: "json" };

/**
 * Bundled, versioned model catalog (plan.md §6.1). Entries are pinned manifests, never free-form URLs.
 * `scripts/pin-models.mjs` resolves each Hugging Face repo to a commit and records file sizes and SHA-256
 * in catalog.lock.json; downloads that don't match are rejected.
 *
 * Entries whose ONNX exports have no working web adapter yet are listed but unavailable, with the reason,
 * so the dropdown shows them disabled (plan.md §6.1 selection rules). Defaults fall to the first available
 * entry per role; CATALOG_VERSION changes whenever entries or defaults change.
 */
export const CATALOG_VERSION = "2026-09-13.1";

export interface LockedFile {
  path: string;
  size: number;
  sha256: string | null;
}

export interface LockedRepo {
  repo: string;
  revision: string;
  files: LockedFile[];
}

/** Files served from a versioned base URL (no commit to pin), pinned by size and SHA-256 alone. */
export interface LockedUrl {
  baseUrl: string;
  files: LockedFile[];
}

export const LOCK = lockJson as { generatedAt: string | null; repos: Record<string, LockedRepo>; urls?: Record<string, LockedUrl> };

type Dtype = string | Record<string, string>;

interface EntrySpec {
  id: string;
  role: ModelRole;
  displayName: string;
  parameters: number;
  downloadBytes: number;
  languages: readonly string[] | "auto";
  license: string;
  adapter: ModelAdapter;
  /** Hugging Face repo, or (with `baseUrl`) just a label. */
  repo: string;
  /** Versioned base URL for sources that aren't Hugging Face repos. */
  baseUrl?: string;
  /** Glob-ish file patterns to pin (for ORT adapters: the exact graph file first). */
  files: string[];
  dtype?: Partial<Record<ExecutionTarget, Dtype>>;
  targets?: Partial<Record<"android" | "ios" | "desktop", ExecutionTarget>>;
  requiredFeatures?: ("shader-f16")[];
  requiresWebGpu?: boolean;
  timing?: "word" | "segment-interpolated";
  embeddingSpace?: string;
  planDefault?: boolean;
  unavailable?: string;
  notes?: string;
  params?: Record<string, unknown>;
}

function entry(s: EntrySpec): ModelCatalogEntry {
  const locked = s.baseUrl ? LOCK.urls?.[s.baseUrl] : LOCK.repos[s.repo];
  const version = s.baseUrl ? (locked ? s.baseUrl.slice(s.baseUrl.lastIndexOf("/") + 1) : undefined) : (locked as LockedRepo | undefined)?.revision;
  const gpu = s.adapter === "tjs-llm" || s.adapter === "tjs-asr" ? "webgpu" : "wasm";
  return {
    id: s.id,
    role: s.role,
    displayName: s.displayName,
    parameters: s.parameters,
    downloadBytes: s.downloadBytes,
    languages: s.languages,
    license: s.license,
    ...(s.timing ? { timing: s.timing } : {}),
    ...(s.embeddingSpace ? { embeddingSpace: s.embeddingSpace } : {}),
    ...(s.planDefault ? { planDefault: true } : {}),
    ...(s.notes ? { notes: s.notes } : {}),
    availability: s.unavailable ? { status: "unavailable", reason: s.unavailable } : { status: "available" },
    manifest: {
      source: s.baseUrl ? { type: "url", baseUrl: s.baseUrl } : { type: "hf", repo: s.repo, revision: (locked as LockedRepo | undefined)?.revision ?? "main" },
      files: s.files.map((path) => {
        const f = locked?.files.find((x) => x.path === path);
        return { path, ...(f ? { bytes: f.size } : {}), ...(f?.sha256 ? { sha256: f.sha256 } : {}) };
      }),
      adapter: s.adapter,
      targets: { android: s.targets?.android ?? gpu, ios: s.targets?.ios ?? gpu, desktop: s.targets?.desktop ?? gpu },
      ...(s.requiredFeatures ? { requiredFeatures: s.requiredFeatures } : {}),
      quantization: typeof s.dtype?.webgpu === "string" ? s.dtype.webgpu : JSON.stringify(s.dtype?.webgpu ?? "fp32"),
      version: version ?? "unpinned",
      params: { dtype: s.dtype ?? {}, requiresWebGpu: !!s.requiresWebGpu, ...(s.params ?? {}) },
    },
  };
}

const MOONSHINE_STREAMING_FILES = ["adapter.ort", "cross_kv.ort", "decoder_kv.ort", "encoder.ort", "frontend.model.ort", "frontend.weights.ort", "streaming_config.json", "tokenizer.bin"];
const STREAMING_ARCH = { tiny: 2, small: 4, medium: 5 } as const;
const STREAMING_PARAMS = { tiny: 34e6, small: 123e6, medium: 245e6 } as const;
const LANGUAGE_NAMES: Record<string, string> = { en: "English", ja: "Japanese", zh: "Chinese", es: "Spanish", de: "German", ar: "Arabic", vi: "Vietnamese" };

/**
 * Moonshine v2 Streaming (MIT in every language) through Moonshine Voice's single-thread WASM runtime: the encoder and
 * decoder cache their state, so each update costs only the new audio (irl-subt-kdl.7). Files are the official ORT-format
 * exports on Moonshine's CDN, under versioned paths, pinned by SHA-256 in catalog.lock.json.
 */
function moonshineStreaming(size: keyof typeof STREAMING_ARCH, lang: string, version: string, bytes: number, extra: Partial<EntrySpec> = {}): ModelCatalogEntry {
  const nonLatin = ["ja", "zh", "ar"].includes(lang);
  return entry({
    id: `moonshine-streaming-${size}-${lang}`, role: "stt-live", displayName: `Moonshine Streaming ${size[0]!.toUpperCase()}${size.slice(1)} (${lang})`,
    parameters: STREAMING_PARAMS[size], downloadBytes: bytes, languages: [lang], license: "MIT", adapter: "moonshine-wasm",
    repo: `moonshine-ai/${size}-streaming-${lang}`, baseUrl: `https://download.moonshine.ai/model/${size}-streaming-${lang}/${version}`,
    files: MOONSHINE_STREAMING_FILES, timing: "segment-interpolated", targets: { android: "wasm", ios: "wasm", desktop: "wasm" },
    notes: `${LANGUAGE_NAMES[lang] ?? lang}; streaming captions, CPU only.`,
    // Non-Latin tokenizers emit many more tokens per second; Moonshine's repetition guard needs a higher ceiling.
    params: { arch: STREAMING_ARCH[size], ...(nonLatin ? { options: { max_tokens_per_second: "13.0" } } : {}) },
    ...extra,
  });
}
const moonshineDtype = { webgpu: { encoder_model: "fp32", decoder_model_merged: "q4" }, wasm: { encoder_model: "fp32", decoder_model_merged: "q4" } };
const whisperLiveDtype = { webgpu: { encoder_model: "fp32", decoder_model_merged: "q4" }, wasm: { encoder_model: "q8", decoder_model_merged: "q8" } };

function moonshine(id: string, size: "tiny" | "base", lang: string, repo: string, params: number, bytes: number, extra: Partial<EntrySpec> = {}): ModelCatalogEntry {
  return entry({
    id, role: "stt-live", displayName: `Moonshine ${size === "tiny" ? "Tiny" : "Base"} (${lang})`, parameters: params, downloadBytes: bytes, languages: [lang],
    license: lang === "en" ? "MIT" : "Moonshine Community License (review)", adapter: "tjs-asr", repo, files: ["config.json", "generation_config.json", "preprocessor_config.json", "tokenizer.json", "tokenizer_config.json", "onnx/encoder_model.onnx", "onnx/decoder_model_merged_q4.onnx", "onnx/decoder_model_q4.onnx"],
    dtype: moonshineDtype, timing: "segment-interpolated", targets: { android: "webgpu", ios: "webgpu", desktop: "webgpu" }, ...extra,
  });
}

export const CATALOG: readonly ModelCatalogEntry[] = [
  // VAD ---------------------------------------------------------------------------------------
  entry({
    id: "silero-vad-v6", role: "vad", displayName: "Silero VAD v6", parameters: 2e6, downloadBytes: 2.8e6, languages: "auto", license: "MIT",
    adapter: "ort-silero", repo: "istupakov/silero-vad-onnx", files: ["silero_vad_op18_ifless.onnx"], planDefault: true,
    notes: "Runs on WASM: per-frame GPU dispatch costs more than the whole graph, and the native WebGPU EP drifts on its recurrent state (irl-subt-0i6.3.1.1).",
  }),
  entry({
    id: "ten-vad", role: "vad", displayName: "TEN VAD", parameters: 3e5, downloadBytes: 3e5, languages: "auto", license: "Apache-2.0 with conditions",
    adapter: "ort-silero", repo: "TEN-framework/ten-vad", files: [], unavailable: "License review pending, and its feature frontend is not ported",
  }),

  // Live STT ----------------------------------------------------------------------------------
  moonshineStreaming("small", "en", "quantized_26_08_21", 142300974, { planDefault: true, notes: "Accurate and real time on one core of a desktop-class CPU (0.64x in the Even simulator)." }),
  moonshineStreaming("medium", "en", "quantized_26_08_21", 269141623, { notes: "Most accurate; needs a fast core (0.88x in the Even simulator, single thread)." }),
  moonshineStreaming("tiny", "en", "quantized_26_08_21", 45233659, { notes: "Fastest and lightest (0.22x in the Even simulator); battery and slower phones." }),
  moonshineStreaming("small", "ja", "quantized_26_08_23", 121803780, { planDefault: true }),
  moonshineStreaming("tiny", "ja", "quantized_26_08_23", 32319961),
  moonshineStreaming("small", "es", "quantized_26_08_24", 121800392, { planDefault: true }),
  moonshineStreaming("tiny", "es", "quantized_26_08_24", 32316573),
  moonshineStreaming("small", "de", "quantized_26_08_24", 121800823, { planDefault: true }),
  moonshineStreaming("tiny", "de", "quantized_26_08_24", 32317004),
  moonshineStreaming("tiny", "zh", "quantized_26_08_24", 32290152, { planDefault: true }),
  moonshineStreaming("tiny", "ar", "quantized_26_08_24", 32349411, { planDefault: true }),
  moonshineStreaming("tiny", "vi", "quantized_26_08_24", 32309008, { planDefault: true }),
  moonshine("moonshine-base-en", "base", "en", "onnx-community/moonshine-base-ONNX", 61e6, 155e6, { notes: "Utterance-level live captions: VAD-segmented, re-decoded as the utterance grows." }),
  moonshine("moonshine-tiny-en", "tiny", "en", "onnx-community/moonshine-tiny-ONNX", 27e6, 60e6, { notes: "Battery/thermal fallback." }),
  moonshine("moonshine-base-ja", "base", "ja", "onnx-community/moonshine-base-ja-ONNX", 61e6, 155e6),
  moonshine("moonshine-tiny-ja", "tiny", "ja", "onnx-community/moonshine-tiny-ja-ONNX", 27e6, 75e6),
  moonshine("moonshine-base-zh", "base", "zh", "onnx-community/moonshine-base-zh-ONNX", 61e6, 155e6),
  moonshine("moonshine-base-ko", "base", "ko", "onnx-community/moonshine-base-ko-ONNX", 61e6, 155e6),
  moonshine("moonshine-tiny-fr", "tiny", "fr", "onnx-community/moonshine-tiny-fr-ONNX", 27e6, 75e6),
  moonshine("moonshine-tiny-ar", "tiny", "ar", "onnx-community/moonshine-tiny-ar-ONNX", 27e6, 75e6),
  moonshine("moonshine-tiny-vi", "tiny", "vi", "onnx-community/moonshine-tiny-vi-ONNX", 27e6, 75e6),
  moonshine("moonshine-tiny-uk", "tiny", "uk", "onnx-community/moonshine-tiny-uk-ONNX", 27e6, 75e6),
  entry({
    id: "whisper-small", role: "stt-live", displayName: "Whisper Small (multilingual)", parameters: 244e6, downloadBytes: 590e6, languages: "auto", license: "Apache-2.0",
    adapter: "tjs-asr", repo: "onnx-community/whisper-small", files: ["config.json", "generation_config.json", "preprocessor_config.json", "tokenizer.json", "tokenizer_config.json", "onnx/encoder_model.onnx", "onnx/decoder_model_merged_q4.onnx", "onnx/encoder_model_quantized.onnx", "onnx/decoder_model_merged_quantized.onnx"],
    dtype: whisperLiveDtype, timing: "segment-interpolated", notes: "Live choice for Automatic language; heavier per update than Moonshine.",
  }),
  entry({
    id: "whisper-base", role: "stt-live", displayName: "Whisper Base (multilingual)", parameters: 74e6, downloadBytes: 210e6, languages: "auto", license: "Apache-2.0",
    adapter: "tjs-asr", repo: "onnx-community/whisper-base", files: ["config.json", "generation_config.json", "preprocessor_config.json", "tokenizer.json", "tokenizer_config.json", "onnx/encoder_model.onnx", "onnx/decoder_model_merged_q4.onnx", "onnx/encoder_model_quantized.onnx", "onnx/decoder_model_merged_quantized.onnx"],
    dtype: whisperLiveDtype, timing: "segment-interpolated",
  }),
  entry({
    id: "whisper-tiny", role: "stt-live", displayName: "Whisper Tiny (multilingual)", parameters: 39e6, downloadBytes: 110e6, languages: "auto", license: "Apache-2.0",
    adapter: "tjs-asr", repo: "onnx-community/whisper-tiny", files: ["config.json", "generation_config.json", "preprocessor_config.json", "tokenizer.json", "tokenizer_config.json", "onnx/encoder_model.onnx", "onnx/decoder_model_merged_q4.onnx", "onnx/encoder_model_quantized.onnx", "onnx/decoder_model_merged_quantized.onnx"],
    dtype: whisperLiveDtype, timing: "segment-interpolated",
  }),

  // Final STT ---------------------------------------------------------------------------------
  entry({ id: "qwen3-asr-0.6b-aligner", role: "stt-final", displayName: "Qwen3-ASR-0.6B + ForcedAligner", parameters: 1.2e9, downloadBytes: 1.3e9, languages: "auto", license: "Apache-2.0", adapter: "tjs-asr", repo: "andrewleech/qwen3-asr-0.6b-onnx", files: [], planDefault: true, timing: "word", unavailable: "No web adapter for the Qwen3-ASR decoder and ForcedAligner yet (irl-subt-dp8.9)" }),
  entry({
    id: "whisper-large-v3-turbo-ts", role: "stt-final", displayName: "Whisper Large-v3-Turbo (word timestamps)", parameters: 809e6, downloadBytes: 770e6, languages: "auto", license: "MIT",
    adapter: "tjs-asr", repo: "onnx-community/whisper-large-v3-turbo_timestamped", files: ["config.json", "generation_config.json", "preprocessor_config.json", "tokenizer.json", "tokenizer_config.json", "onnx/encoder_model_q4.onnx", "onnx/decoder_model_merged_q4.onnx"],
    dtype: { webgpu: { encoder_model: "q4", decoder_model_merged: "q4" }, wasm: { encoder_model: "q4", decoder_model_merged: "q4" } }, timing: "word", requiresWebGpu: true,
  }),
  entry({
    id: "whisper-small-ts", role: "stt-final", displayName: "Whisper Small (word timestamps)", parameters: 244e6, downloadBytes: 590e6, languages: "auto", license: "Apache-2.0",
    adapter: "tjs-asr", repo: "onnx-community/whisper-small_timestamped", files: ["config.json", "generation_config.json", "preprocessor_config.json", "tokenizer.json", "tokenizer_config.json", "onnx/encoder_model.onnx", "onnx/decoder_model_merged_q4.onnx", "onnx/encoder_model_quantized.onnx", "onnx/decoder_model_merged_quantized.onnx"],
    dtype: whisperLiveDtype, timing: "word",
  }),
  entry({
    id: "whisper-base-ts", role: "stt-final", displayName: "Whisper Base (word timestamps)", parameters: 74e6, downloadBytes: 210e6, languages: "auto", license: "Apache-2.0",
    adapter: "tjs-asr", repo: "onnx-community/whisper-base_timestamped", files: ["config.json", "generation_config.json", "preprocessor_config.json", "tokenizer.json", "tokenizer_config.json", "onnx/encoder_model.onnx", "onnx/decoder_model_merged_q4.onnx"],
    dtype: { webgpu: { encoder_model: "fp32", decoder_model_merged: "q4" }, wasm: { encoder_model: "fp32", decoder_model_merged: "q4" } }, timing: "word",
  }),
  entry({ id: "parakeet-tdt-0.6b-v3", role: "stt-final", displayName: "Parakeet TDT 0.6B v3 (European)", parameters: 6e8, downloadBytes: 670e6, languages: ["en", "de", "es", "fr"], license: "CC-BY-4.0", adapter: "tjs-asr", repo: "istupakov/parakeet-tdt-0.6b-v3-onnx", files: [], timing: "word", unavailable: "TDT decoding is not supported by transformers.js 4.2, and the nemo128 frontend is not ported" }),

  // Speaker embedding -------------------------------------------------------------------------
  entry({
    id: "campplus-voxceleb", role: "speaker-embedding", displayName: "CAM++ (WeSpeaker, VoxCeleb)", parameters: 7.2e6, downloadBytes: 29.3e6, languages: "auto", license: "Apache-2.0",
    adapter: "ort-fbank-embedding", repo: "Wespeaker/wespeaker-voxceleb-campplus", files: ["voxceleb_CAM++.onnx"], embeddingSpace: "campplus-voxceleb@wespeaker-1", planDefault: true,
    notes: "Measured 40 ms/window on desktop WASM vs 198 ms on WebGPU (irl-subt-0i6.3.4), so WASM is the default target.",
  }),
  entry({
    id: "wespeaker-resnet34-lm", role: "speaker-embedding", displayName: "WeSpeaker ResNet34-LM (VoxCeleb)", parameters: 6.6e6, downloadBytes: 26.5e6, languages: "auto", license: "CC-BY-4.0",
    adapter: "tjs-embedding", repo: "onnx-community/wespeaker-voxceleb-resnet34-LM", files: ["config.json", "preprocessor_config.json", "onnx/model.onnx"], embeddingSpace: "wespeaker-resnet34-lm@onnx-community-1",
    dtype: { webgpu: "fp32", wasm: "fp32" },
  }),
  entry({ id: "ecapa-tdnn", role: "speaker-embedding", displayName: "ECAPA-TDNN (SpeechBrain)", parameters: 20e6, downloadBytes: 83e6, languages: "auto", license: "Apache-2.0", adapter: "ort-fbank-embedding", repo: "penta2himajin/ecapa-tdnn-onnx", files: [], embeddingSpace: "ecapa-tdnn@speechbrain-1", unavailable: "Needs SpeechBrain's own fbank frontend; the community export's I/O contract is project-specific" }),
  entry({
    id: "redimnet2-b6", role: "speaker-embedding", displayName: "ReDimNet2-B6 (highest accuracy, heaviest)", parameters: 12.3e6, downloadBytes: 51.2e6, languages: "auto", license: "MIT",
    adapter: "ort-waveform-embedding", repo: "soniqo/ReDimNet2-B6-ONNX-FP32", files: ["ReDimNet2B6.onnx"], embeddingSpace: "redimnet2-b6@soniqo-fp32-1",
    params: { inputSamples: 96000 },
  }),

  // Summary -----------------------------------------------------------------------------------
  entry({
    id: "gemma-4-e2b-qat-mobile", role: "summary", displayName: "Gemma 4 E2B (mobile QAT)", parameters: 5.1e9, downloadBytes: 2.33e9, languages: "auto", license: "Gemma Terms of Use",
    adapter: "tjs-llm", repo: "onnx-community/gemma-4-E2B-it-qat-mobile-ONNX", files: ["config.json", "generation_config.json", "tokenizer.json", "tokenizer_config.json", "chat_template.jinja", "onnx/decoder_model_merged_q2f16.onnx", "onnx/decoder_model_merged_q2f16.onnx_data", "onnx/embed_tokens_q2f16.onnx", "onnx/embed_tokens_q2f16.onnx_data"],
    dtype: { webgpu: { embed_tokens: "q2f16", decoder_model_merged: "q2f16" } }, requiresWebGpu: true, requiredFeatures: ["shader-f16"], planDefault: true,
    params: { contextTokens: 8192, maxNewTokens: 1200 },
  }),
  entry({
    id: "gemma-4-e2b-q4", role: "summary", displayName: "Gemma 4 E2B (q4, no fp16 GPU needed)", parameters: 5.1e9, downloadBytes: 3.6e9, languages: "auto", license: "Gemma Terms of Use",
    adapter: "tjs-llm", repo: "onnx-community/gemma-4-E2B-it-ONNX", files: ["config.json", "generation_config.json", "tokenizer.json", "tokenizer_config.json", "chat_template.jinja", "onnx/decoder_model_merged_q4.onnx", "onnx/decoder_model_merged_q4.onnx_data", "onnx/embed_tokens_q4.onnx", "onnx/embed_tokens_q4.onnx_data"],
    dtype: { webgpu: { embed_tokens: "q4", decoder_model_merged: "q4" } }, requiresWebGpu: true, params: { contextTokens: 8192, maxNewTokens: 1200 },
  }),
  entry({
    id: "gemma-4-e4b", role: "summary", displayName: "Gemma 4 E4B (better quality, more memory)", parameters: 8e9, downloadBytes: 5e9, languages: "auto", license: "Gemma Terms of Use",
    adapter: "tjs-llm", repo: "onnx-community/gemma-4-E4B-it-ONNX", files: ["config.json", "generation_config.json", "tokenizer.json", "tokenizer_config.json", "chat_template.jinja", "onnx/decoder_model_merged_q4f16.onnx", "onnx/decoder_model_merged_q4f16.onnx_data", "onnx/embed_tokens_q4f16.onnx", "onnx/embed_tokens_q4f16.onnx_data"],
    dtype: { webgpu: { embed_tokens: "q4f16", decoder_model_merged: "q4f16" } }, requiresWebGpu: true, requiredFeatures: ["shader-f16"], params: { contextTokens: 8192, maxNewTokens: 1200 },
  }),
  entry({
    id: "qwen3.5-2b", role: "summary", displayName: "Qwen3.5-2B", parameters: 2e9, downloadBytes: 1.4e9, languages: "auto", license: "Apache-2.0",
    adapter: "tjs-llm", repo: "onnx-community/Qwen3.5-2B-ONNX", files: ["config.json", "generation_config.json", "tokenizer.json", "tokenizer_config.json", "chat_template.jinja", "onnx/decoder_model_merged_q4f16.onnx", "onnx/decoder_model_merged_q4f16.onnx_data", "onnx/embed_tokens_q4f16.onnx", "onnx/embed_tokens_q4f16.onnx_data"],
    dtype: { webgpu: { embed_tokens: "q4f16", decoder_model_merged: "q4f16" } }, requiresWebGpu: true, requiredFeatures: ["shader-f16"], params: { contextTokens: 16384, maxNewTokens: 1200, disableThinking: true },
  }),
];

export { ROLE_KEYS } from "@irl/domain";

export function catalogEntry(id: string): ModelCatalogEntry | undefined {
  return CATALOG.find((e) => e.id === id);
}

/** Live STT models that stream through the Moonshine worker rather than re-decoding utterances. */
export function isStreamingStt(modelId: string): boolean {
  return catalogEntry(modelId)?.manifest.adapter === "moonshine-wasm";
}

export function entriesForRole(role: ModelRole): ModelCatalogEntry[] {
  return CATALOG.filter((e) => e.role === role);
}

export function supportsLanguage(e: ModelCatalogEntry, language: string): boolean {
  if (e.languages === "auto") return true;
  return language !== "auto" && e.languages.includes(language);
}

/** Best available default per role for a language (plan default when it is available). */
export function defaultSelection(language = "en"): ModelSelection {
  const first = (role: ModelRole) => {
    const options = entriesForRole(role).filter((e) => e.availability.status === "available" && supportsLanguage(e, language));
    return (options.find((e) => e.planDefault) ?? options[0])?.id;
  };
  return {
    vad: first("vad") ?? "silero-vad-v6",
    sttLive: first("stt-live") ?? "off",
    sttFinal: first("stt-final") ?? "same-as-live",
    speakerEmbedding: first("speaker-embedding") ?? "campplus-voxceleb",
    summary: first("summary") ?? "off",
  };
}

export function embeddingSpaceOf(modelId: string): string {
  return catalogEntry(modelId)?.embeddingSpace ?? `${modelId}@unknown`;
}
