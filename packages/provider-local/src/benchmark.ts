import { cosine, errorMessage, SAMPLE_RATE, type BenchmarkResult, type ExecutionTarget, type ModelCatalogEntry, type ModelRole, type ModelSelection } from "@irl/domain";
import { catalogEntry, entriesForRole, ROLE_KEYS, supportsLanguage } from "./catalog";
import { availabilityOnDevice } from "./device";
import type { LocalEngines } from "./engines";

/** Public-domain JFK inaugural clip ("ask not what your country can do for you"), 16 kHz mono. */
export const KNOWN_ANSWER_PHRASE = /ask not what your country can do for you/i;

function result(entry: ModelCatalogEntry, target: ExecutionTarget, partial: Partial<BenchmarkResult>): BenchmarkResult {
  return { modelId: entry.id, target, ok: false, measuredAt: new Date().toISOString(), userAgent: navigator.userAgent, ...partial };
}

/**
 * One model on one target (plan.md §5: eligible only after load, a known-answer inference, tolerance and a
 * latency benchmark). Uses the bundled clip; RTF counts the whole call including feature extraction,
 * upload, decode, and readback.
 */
export async function benchmarkModel(engines: LocalEngines, modelId: string, clip: Float32Array, target: ExecutionTarget): Promise<BenchmarkResult> {
  const entry = catalogEntry(modelId)!;
  const seconds = clip.length / SAMPLE_RATE;
  const t0 = performance.now();
  try {
    switch (entry.role) {
      case "vad": {
        await engines.ensureVad(modelId);
        const loadMs = performance.now() - t0;
        const t1 = performance.now();
        const regions = await engines.call<{ startSample: number; endSample: number }[]>("audio", "vad.regions", { samples: clip, startSample: 0 });
        const ms = performance.now() - t1;
        const speech = regions.reduce((n, r) => n + r.endSample - r.startSample, 0) / clip.length;
        return result(entry, "wasm", { ok: speech > 0.4, loadMs, realTimeFactor: ms / 1000 / seconds, knownAnswer: { ok: speech > 0.4, detail: `${Math.round(speech * 100)}% of the clip detected as speech` } });
      }
      case "stt-live":
      case "stt-final": {
        engines.benchmarks = engines.benchmarks.filter((b) => !(b.modelId === modelId && b.target !== target));
        const actual = await engines.ensureAsr(modelId);
        const loadMs = performance.now() - t0;
        // Warm-up compiles shaders; the timed run is the second.
        await engines.transcribe(clip.slice(0, SAMPLE_RATE * 3), "en", false);
        const t1 = performance.now();
        const out = await engines.transcribe(clip.slice(), "en", entry.role === "stt-final");
        const ms = performance.now() - t1;
        const english = supportsLanguage(entry, "en");
        const known = english ? KNOWN_ANSWER_PHRASE.test(out.text.replace(/[^\w\s]/g, "")) : true;
        return result(entry, actual, { ok: known, loadMs, realTimeFactor: ms / 1000 / seconds, knownAnswer: { ok: known, detail: english ? out.text.trim().slice(0, 120) : "non-English model: latency only" } });
      }
      case "speaker-embedding": {
        await engines.ensureEmbedding(modelId);
        const loadMs = performance.now() - t0;
        const w = (s: number) => ({ samples: clip.slice(s * SAMPLE_RATE, (s + 2) * SAMPLE_RATE), startSample: s * SAMPLE_RATE, endSample: (s + 2) * SAMPLE_RATE });
        await engines.embed([w(0)]);
        const t1 = performance.now();
        const outs = await engines.embed([w(1), w(4), w(7)]);
        const ms = (performance.now() - t1) / 3;
        const same = Math.min(cosine(outs[0]!.vector, outs[1]!.vector), cosine(outs[1]!.vector, outs[2]!.vector));
        return result(entry, target, { ok: same > 0.3, loadMs, p50Ms: ms, realTimeFactor: ms / 2000, knownAnswer: { ok: same > 0.3, detail: `same-speaker cosine ${same.toFixed(3)}` } });
      }
      case "summary": {
        await engines.ensureLlm(modelId);
        const loadMs = performance.now() - t0;
        const t1 = performance.now();
        const out = await engines.call<{ text: string; tokens: number; ms: number }>("llm", "llm.generate", {
          messages: [{ role: "user", content: 'Reply with only this JSON, filled in: {"capital_of_france": ""}' }],
          maxNewTokens: 32,
          disableThinking: true,
        });
        const ok = /paris/i.test(out.text);
        return result(entry, "webgpu", { ok, loadMs, tokensPerSecond: (out.tokens * 1000) / (performance.now() - t1), knownAnswer: { ok, detail: out.text.trim().slice(0, 80) } });
      }
    }
  } catch (e) {
    return result(entry, target, { error: errorMessage(e) });
  }
}

/** Real-time budgets per role for pre-selection. */
const BUDGET: Record<ModelRole, (b: BenchmarkResult) => boolean> = {
  vad: (b) => (b.realTimeFactor ?? 9) < 0.1,
  "stt-live": (b) => (b.realTimeFactor ?? 9) < 0.5,
  "stt-final": (b) => (b.realTimeFactor ?? 9) < 0.5,
  "speaker-embedding": (b) => (b.realTimeFactor ?? 9) < 0.25,
  summary: (b) => (b.tokensPerSecond ?? 0) > 4,
};

export interface FirstRunReport {
  results: BenchmarkResult[];
  selection: Partial<ModelSelection>;
}

/**
 * First-run benchmark (plan.md §6.1): measures downloaded, available options and pre-selects, per role,
 * the most preferred entry (catalog order) that passes its known answer and budget. The user can override.
 */
export async function firstRunBenchmark(engines: LocalEngines, clip: Float32Array, language: string, onProgress: (note: string) => void): Promise<FirstRunReport> {
  const caps = await engines.capabilities();
  const results: BenchmarkResult[] = [];
  const selection: Partial<ModelSelection> = {};
  for (const role of ["vad", "speaker-embedding", "stt-live", "stt-final", "summary"] as ModelRole[]) {
    for (const entry of entriesForRole(role)) {
      if (availabilityOnDevice(entry, caps).status !== "available" || !supportsLanguage(entry, language)) continue;
      if (!(await engines.isDownloaded(entry.id))) continue;
      const targets: ExecutionTarget[] = role === "summary" ? ["webgpu"] : role === "vad" ? ["wasm"] : caps.webgpu.available ? ["webgpu", "wasm"] : ["wasm"];
      for (const t of targets) {
        onProgress(`${entry.displayName} on ${t}`);
        const r = await benchmarkModel(engines, entry.id, clip, t);
        results.push(r);
        engines.benchmarks = [...engines.benchmarks.filter((b) => !(b.modelId === r.modelId && b.target === r.target)), r];
      }
      const key = ROLE_KEYS[role];
      if (!(key in selection) && results.some((r) => r.modelId === entry.id && r.ok && BUDGET[role](r))) (selection as Record<string, string>)[key] = entry.id;
      await engines.release(["asr", "llm"]);
    }
  }
  return { results, selection };
}
