/// <reference lib="webworker" />
import { Transcriber } from "@irl/moonshine-wasm";
import { catalogEntry } from "../catalog";
import { loadModelFile } from "../model-files";
import { serveRpc } from "../rpc";

/**
 * Moonshine Streaming through Moonshine Voice's single-thread WASM runtime (irl-subt-kdl.9). One transcriber and at
 * most one live stream; the stream keeps encoder and decoder state between pushes, so each pass costs only the new
 * audio. Times in results are seconds since the stream's first sample.
 */

export interface StreamLine {
  id: string;
  text: string;
  startTime: number;
  duration: number;
  isComplete: boolean;
}

export interface StreamPushResult {
  /** Every open line (its text keeps changing) and each completed line once, oldest first. */
  lines: StreamLine[];
  /** Engine time for this push; 0 when the stream held back (not enough new audio for a pass). */
  computeMs: number;
}

let current: { id: string; transcriber: Transcriber } | null = null;
type Stream = ReturnType<Transcriber["createStream"]>;

let stream: Stream | null = null;
/** The stream's snapshot object is reused when it holds back a pass, so a new object means the engine ran. */
let lastSnapshot: unknown = null;
/** Ids of completed lines the host has already received. */
let delivered = new Set<string>();

async function load(modelId: string, progress: (p: unknown) => void) {
  if (current?.id === modelId) return;
  closeStream();
  current?.transcriber.close();
  current = null;
  const entry = catalogEntry(modelId);
  if (!entry || entry.manifest.adapter !== "moonshine-wasm") throw new Error(`not a Moonshine Streaming model: ${modelId}`);
  const files = new Map<string, Uint8Array>();
  const total = entry.manifest.files.reduce((n, f) => n + (f.bytes ?? 0), 0);
  let done = 0;
  for (const f of entry.manifest.files) {
    files.set(f.path, await loadModelFile(entry, f.path, (loaded) => progress({ file: f.path, loaded: done + loaded, total })));
    done += f.bytes ?? 0;
  }
  const params = entry.manifest.params ?? {};
  const options = (params.options ?? undefined) as Record<string, string> | undefined;
  const transcriber = await Transcriber.load({ files, modelArch: Number(params.arch), ...(options ? { options } : {}) });
  current = { id: modelId, transcriber };
  return { warmupMs: warmUp(transcriber) };
}

/** One short pass right after loading, so session setup and JIT tier-up don't land on the first utterance (irl-subt-kdl.3). */
function warmUp(transcriber: Transcriber): number {
  const t0 = performance.now();
  const s = transcriber.createStream({ updateInterval: 0 });
  s.start();
  const audio = new Float32Array(16000);
  for (let i = 0; i < audio.length; i++) audio[i] = (Math.random() - 0.5) * 1e-3;
  s.addAudio(audio, 16000);
  s.transcribe();
  s.stop();
  s.close();
  return performance.now() - t0;
}

function closeStream() {
  stream?.close();
  stream = null;
  lastSnapshot = null;
  delivered = new Set();
}

/** Open lines every time (their text keeps changing), completed lines once. */
function report(lines: readonly { id: string; text: string; startTime: number; duration: number; isComplete: boolean }[]): StreamLine[] {
  const out: StreamLine[] = [];
  for (const l of lines) {
    if (l.isComplete && delivered.has(l.id)) continue;
    if (l.isComplete) delivered.add(l.id);
    out.push({ id: l.id, text: l.text, startTime: l.startTime, duration: l.duration, isComplete: l.isComplete });
  }
  return out;
}

serveRpc({
  "ms.load": async (p: { modelId: string }, ctx) => load(p.modelId, ctx.progress),

  /** Starts a fresh stream (dropping any previous one). */
  "ms.start": async () => {
    if (!current) throw new Error("Moonshine model not loaded");
    closeStream();
    stream = current.transcriber.createStream({ updateInterval: 0.5 });
    stream.start();
  },

  "ms.push": async (p: { samples: Float32Array }): Promise<StreamPushResult> => {
    if (!stream) throw new Error("no Moonshine stream");
    stream.addAudio(p.samples, 16000);
    const t0 = performance.now();
    const snap = stream.transcribe();
    const ms = performance.now() - t0;
    const ran = snap !== lastSnapshot;
    lastSnapshot = snap;
    return { lines: ran ? report(snap.lines) : [], computeMs: ran ? ms : 0 };
  },

  /** Flushes the stream, returns its remaining lines, and closes it. */
  "ms.stop": async (): Promise<StreamPushResult> => {
    if (!stream) return { lines: [], computeMs: 0 };
    const t0 = performance.now();
    stream.stop();
    const lines = report(stream.transcribe().lines);
    const computeMs = performance.now() - t0;
    closeStream();
    return { lines, computeMs };
  },

  /** Whole-buffer transcription (final pass "same as live", benchmarks). */
  "ms.transcribe": async (p: { samples: Float32Array }): Promise<{ text: string; lines: StreamLine[] }> => {
    if (!current) throw new Error("Moonshine model not loaded");
    const t = current.transcriber.transcribe(p.samples, { sampleRate: 16000 });
    const lines = t.lines.map((l) => ({ id: l.id, text: l.text, startTime: l.startTime, duration: l.duration, isComplete: true }));
    return { text: lines.map((l) => l.text).join(" ").trim(), lines };
  },

  "release": async () => {
    closeStream();
    current?.transcriber.close();
    current = null;
  },
});
