/// <reference lib="webworker" />
import { AutoFeatureExtractor, AutoModel, Tensor as TjsTensor, WeSpeakerFeatureExtractor } from "@huggingface/transformers";
import type { ExecutionTarget } from "@irl/domain";
import type * as Ort from "onnxruntime-web/webgpu";
import { catalogEntry } from "../catalog";
import { windowQuality } from "../clustering";
import { loadModelFile } from "../model-files";
import { setupRuntime } from "../ort-env";
import { serveRpc } from "../rpc";
import { regionsFromProbabilities } from "../vad-segmenter";

/**
 * Small, latency-sensitive graphs: Silero VAD and the speaker-embedding model. Both default to WASM, where
 * per-dispatch GPU overhead would dominate (irl-subt-0i6.3.9), but embeddings may target WebGPU.
 */
const ort = setupRuntime();

const WINDOW = 512;
const CONTEXT = 64;

interface VadModel {
  session: Ort.InferenceSession;
  sr: Ort.Tensor;
}

let vad: VadModel | null = null;
let vadId: string | null = null;
const stream = { state: new Float32Array(2 * 128), context: new Float32Array(CONTEXT), pending: new Float32Array(0), nextSample: 0 };

async function loadVad(modelId: string, progress: (p: unknown) => void): Promise<void> {
  if (vad && vadId === modelId) return;
  const entry = catalogEntry(modelId);
  if (!entry || entry.manifest.adapter !== "ort-silero") throw new Error(`not a VAD model: ${modelId}`);
  const bytes = await loadModelFile(entry, entry.manifest.files[0]!.path, (l, t) => progress({ loaded: l, total: t }));
  const session = await ort.InferenceSession.create(bytes, { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
  vad = { session, sr: new ort.Tensor("int64", BigInt64Array.from([16000n]), []) };
  vadId = modelId;
}

async function vadWindow(state: Float32Array, context: Float32Array, window: Float32Array): Promise<number> {
  const input = new Float32Array(CONTEXT + WINDOW);
  input.set(context);
  input.set(window, CONTEXT);
  const out = await vad!.session.run({
    input: new ort.Tensor("float32", input, [1, CONTEXT + WINDOW]),
    state: new ort.Tensor("float32", state, [2, 1, 128]),
    sr: vad!.sr,
  });
  state.set(out.stateN!.data as Float32Array);
  context.set(window.subarray(WINDOW - CONTEXT));
  return (out.output!.data as Float32Array)[0]!;
}

// Embeddings ---------------------------------------------------------------------------------

interface EmbedModel {
  id: string;
  target: ExecutionTarget;
  run(samples: Float32Array): Promise<Float32Array>;
}

let embedder: EmbedModel | null = null;
const fbank = new WeSpeakerFeatureExtractor({ feature_extractor_type: "WeSpeakerFeatureExtractor", sampling_rate: 16000, num_mel_bins: 80, min_num_frames: 9, fbank_centering_span: null } as never);

async function loadEmbedder(modelId: string, target: ExecutionTarget, progress: (p: unknown) => void): Promise<void> {
  if (embedder?.id === modelId && embedder.target === target) return;
  embedder = null;
  const entry = catalogEntry(modelId);
  if (!entry || entry.role !== "speaker-embedding") throw new Error(`not an embedding model: ${modelId}`);
  const eps = target === "webgpu" ? [{ name: "webgpu" }, "wasm"] : ["wasm"];
  const adapter = entry.manifest.adapter;
  if (adapter === "ort-fbank-embedding") {
    const bytes = await loadModelFile(entry, entry.manifest.files[0]!.path, (l, t) => progress({ loaded: l, total: t }));
    const session = await ort.InferenceSession.create(bytes, { executionProviders: eps as never, graphOptimizationLevel: "all" });
    const input = session.inputNames[0]!;
    const output = session.outputNames[0]!;
    embedder = {
      id: modelId, target,
      run: async (samples) => {
        const { input_features } = (await fbank(samples)) as { input_features: TjsTensor };
        const out = await session.run({ [input]: new ort.Tensor("float32", input_features.data as Float32Array, input_features.dims as number[]) });
        return new Float32Array(out[output]!.data as Float32Array);
      },
    };
  } else if (adapter === "ort-waveform-embedding") {
    const bytes = await loadModelFile(entry, entry.manifest.files[0]!.path, (l, t) => progress({ loaded: l, total: t }));
    const session = await ort.InferenceSession.create(bytes, { executionProviders: eps as never, graphOptimizationLevel: "all" });
    const n = Number(entry.manifest.params?.inputSamples ?? 96000);
    const input = session.inputNames[0]!;
    const output = session.outputNames[0]!;
    embedder = {
      id: modelId, target,
      run: async (samples) => {
        // Model card: repeat short clean speech to fill the window, centre-crop longer audio.
        const buf = new Float32Array(n);
        if (samples.length >= n) buf.set(samples.subarray((samples.length - n) >> 1, ((samples.length - n) >> 1) + n));
        else for (let off = 0; off < n; off += samples.length) buf.set(samples.subarray(0, Math.min(samples.length, n - off)), off);
        const out = await session.run({ [input]: new ort.Tensor("float32", buf, [1, n]) });
        return new Float32Array(out[output]!.data as Float32Array);
      },
    };
  } else if (adapter === "tjs-embedding") {
    const src = entry.manifest.source;
    if (src.type !== "hf") throw new Error("unsupported source");
    const dtype = (entry.manifest.params?.dtype as Record<string, string> | undefined)?.[target] ?? "fp32";
    const opts = { revision: src.revision, device: target, dtype, progress_callback: progress } as never;
    const [model, extractor] = await Promise.all([AutoModel.from_pretrained(src.repo, opts), AutoFeatureExtractor.from_pretrained(src.repo, { revision: src.revision } as never)]);
    embedder = {
      id: modelId, target,
      run: async (samples) => {
        const inputs = await (extractor as unknown as (a: Float32Array) => Promise<Record<string, TjsTensor>>)(samples);
        const out = (await (model as unknown as (i: unknown) => Promise<Record<string, TjsTensor>>)(inputs)) as Record<string, TjsTensor>;
        const t = out.embeddings ?? out.embs ?? Object.values(out)[0]!;
        return new Float32Array(t.data as Float32Array);
      },
    };
  } else {
    throw new Error(`unsupported embedding adapter ${adapter}`);
  }
}

serveRpc({
  "vad.load": async (p: { modelId: string }, ctx) => loadVad(p.modelId, ctx.progress),

  "vad.reset": async (p: { startSample: number }) => {
    stream.state.fill(0);
    stream.context.fill(0);
    stream.pending = new Float32Array(0);
    stream.nextSample = p.startSample;
  },

  /** Streaming: appends samples, returns one probability per complete 32 ms window. */
  "vad.push": async (p: { samples: Float32Array }, ctx) => {
    if (!vad) throw new Error("VAD not loaded");
    const joined = new Float32Array(stream.pending.length + p.samples.length);
    joined.set(stream.pending);
    joined.set(p.samples, stream.pending.length);
    const n = Math.floor(joined.length / WINDOW);
    const probs = new Float32Array(n);
    const firstWindowStart = stream.nextSample;
    for (let i = 0; i < n; i++) probs[i] = await vadWindow(stream.state, stream.context, joined.subarray(i * WINDOW, (i + 1) * WINDOW));
    stream.pending = joined.slice(n * WINDOW);
    stream.nextSample += n * WINDOW;
    ctx.transfer([probs.buffer]);
    return { probs, firstWindowStart };
  },

  /** Offline speech regions for a block (fresh recurrent state). */
  "vad.regions": async (p: { samples: Float32Array; startSample: number }) => {
    if (!vad) throw new Error("VAD not loaded");
    const state = new Float32Array(2 * 128);
    const context = new Float32Array(CONTEXT);
    const n = Math.floor(p.samples.length / WINDOW);
    const probs = new Float32Array(n);
    for (let i = 0; i < n; i++) probs[i] = await vadWindow(state, context, p.samples.subarray(i * WINDOW, (i + 1) * WINDOW));
    return regionsFromProbabilities(probs, p.startSample);
  },

  "embed.load": async (p: { modelId: string; target: ExecutionTarget }, ctx) => loadEmbedder(p.modelId, p.target, ctx.progress),

  "embed.run": async (p: { windows: { samples: Float32Array; startSample: number; endSample: number }[] }) => {
    if (!embedder) throw new Error("embedding model not loaded");
    const out: { vector: Float32Array; startSample: number; endSample: number; quality: number; ms: number }[] = [];
    for (const w of p.windows) {
      const t0 = performance.now();
      const vector = await embedder.run(w.samples);
      out.push({ vector, startSample: w.startSample, endSample: w.endSample, quality: windowQuality(w.samples), ms: performance.now() - t0 });
    }
    return out;
  },

  "release": async () => {
    await vad?.session.release().catch(() => undefined);
    vad = null;
    vadId = null;
    embedder = null;
  },
});
