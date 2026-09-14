/// <reference lib="webworker" />
import type { AutomaticSpeechRecognitionPipeline } from "@huggingface/transformers";
import type { ExecutionTarget } from "@irl/domain";
import { catalogEntry } from "../catalog";
import { setupRuntime } from "../ort-env";
import { serveRpc } from "../rpc";

/**
 * Speech-to-text through transformers.js (Whisper and Moonshine). A `:webgpu` worker keeps decode loops and KV
 * cache on the GPU; a `:wasm` worker runs the plain CPU build (ort-env.ts).
 */
const runtime = setupRuntime();

let current: { id: string; target: ExecutionTarget; pipe: AutomaticSpeechRecognitionPipeline } | null = null;

async function load(modelId: string, target: ExecutionTarget, progress: (p: unknown) => void) {
  if (current?.id === modelId && current.target === target) return;
  await current?.pipe.dispose().catch(() => undefined);
  current = null;
  const entry = catalogEntry(modelId);
  if (!entry || entry.manifest.adapter !== "tjs-asr" || entry.manifest.source.type !== "hf") throw new Error(`not an ASR model: ${modelId}`);
  const dtype = (entry.manifest.params?.dtype as Record<string, unknown> | undefined)?.[target];
  const { tjs, flavor } = await runtime;
  if (target === "webgpu" && flavor !== "webgpu") throw new Error("this ASR worker runs the CPU build; WebGPU needs a :webgpu worker");
  const pipe = (await tjs.pipeline("automatic-speech-recognition", entry.manifest.source.repo, {
    revision: entry.manifest.source.revision,
    ...(flavor === "webgpu" ? { device: target } : {}),
    ...(dtype ? { dtype } : {}),
    progress_callback: progress,
  } as never)) as AutomaticSpeechRecognitionPipeline;
  current = { id: modelId, target, pipe };
}

export interface AsrResult {
  text: string;
  words: { text: string; start: number; end: number }[] | null;
  language: string | null;
  ms: number;
}

serveRpc({
  "asr.load": async (p: { modelId: string; target: ExecutionTarget }, ctx) => load(p.modelId, p.target, ctx.progress),

  "asr.run": async (p: { samples: Float32Array; language: string; wordTimestamps: boolean }): Promise<AsrResult> => {
    if (!current) throw new Error("ASR model not loaded");
    const t0 = performance.now();
    const whisper = current.id.startsWith("whisper");
    const seconds = p.samples.length / 16000;
    const opts: Record<string, unknown> = whisper
      ? { task: "transcribe", ...(p.language !== "auto" ? { language: p.language } : {}), return_timestamps: p.wordTimestamps ? "word" : false }
      : // Moonshine: bound tokens by audio length to avoid repetition loops on silence.
        { max_new_tokens: Math.ceil(seconds * 6.5) + 8 };
    const out = (await current.pipe(p.samples, opts as never)) as { text: string; chunks?: { text: string; timestamp: [number, number | null] }[] };
    const words = out.chunks?.length
      ? out.chunks.map((c) => ({ text: c.text, start: c.timestamp[0] ?? 0, end: c.timestamp[1] ?? c.timestamp[0] ?? 0 }))
      : null;
    return { text: out.text ?? "", words, language: whisper && p.language !== "auto" ? p.language : null, ms: performance.now() - t0 };
  },

  "release": async () => {
    await current?.pipe.dispose().catch(() => undefined);
    current = null;
  },
}, runtime);
