import { SAMPLE_RATE, type LiveSpeechProvider, type ModelCatalogEntry, type Settings, type SummaryProvider, type TimeRange, type VoiceEmbedding } from "@irl/domain";
import type { ClusterAssignment, FinalWord, ProcessingToolkit } from "@irl/pipeline";
import { ChunkedSummaryProvider, CloudSummaryProvider, type ChatModel } from "@irl/provider-summary";
import { CATALOG, catalogEntry, embeddingSpaceOf } from "./catalog";
import { clusterParams, refineClusters, windowGrid } from "./clustering";
import type { EngineKind, LocalEngines } from "./engines";
import { LocalLiveSpeechProvider } from "./live-provider";
import { interpolateWords } from "./scheduler";

export function defaultWorkers(): Record<EngineKind, () => Worker> {
  return {
    audio: () => new Worker(new URL("./workers/audio.worker.ts", import.meta.url), { type: "module", name: "irl-audio-ml" }),
    asr: () => new Worker(new URL("./workers/asr.worker.ts", import.meta.url), { type: "module", name: "irl-asr" }),
    llm: () => new Worker(new URL("./workers/llm.worker.ts", import.meta.url), { type: "module", name: "irl-llm" }),
  };
}

/** Local implementation of the pipeline's ProcessingToolkit. */
export class LocalToolkit implements ProcessingToolkit {
  private live: LocalLiveSpeechProvider;

  constructor(private readonly engines: LocalEngines, private readonly settings: () => Settings) {
    this.live = new LocalLiveSpeechProvider(engines);
  }

  catalog(): readonly ModelCatalogEntry[] {
    return CATALOG;
  }

  embeddingSpace(modelId: string): string {
    return embeddingSpaceOf(modelId);
  }

  async detectSpeech(vadModelId: string, samples: Float32Array, startSample: number): Promise<TimeRange[]> {
    await this.engines.ensureVad(vadModelId);
    return this.engines.call<TimeRange[]>("audio", "vad.regions", { samples, startSample });
  }

  async transcribe(modelId: string, samples: Float32Array, startSample: number, language: string, opts: { wordTimestamps: boolean }) {
    await this.engines.ensureAsr(modelId);
    const entry = catalogEntry(modelId);
    const wantWords = opts.wordTimestamps && entry?.timing === "word";
    const out = await this.engines.transcribe(samples.slice(), language, wantWords);
    let words: FinalWord[];
    let timing: "word" | "segment-interpolated" = "segment-interpolated";
    if (out.words?.length) {
      timing = "word";
      words = out.words.map((w) => ({ text: w.text, startSample: startSample + Math.round(w.start * SAMPLE_RATE), endSample: startSample + Math.round(Math.max(w.end, w.start + 0.05) * SAMPLE_RATE) }));
    } else {
      words = interpolateWords(out.text, startSample, startSample + samples.length);
    }
    return { words, timing, ...(out.language ? { language: out.language } : {}) };
  }

  async embed(modelId: string, windows: { samples: Float32Array; range: TimeRange }[]): Promise<VoiceEmbedding[]> {
    await this.engines.ensureEmbedding(modelId);
    const space = embeddingSpaceOf(modelId);
    const out: VoiceEmbedding[] = [];
    for (let i = 0; i < windows.length; i += 8) {
      const batch = windows.slice(i, i + 8).map((w) => ({ samples: w.samples, startSample: w.range.startSample, endSample: w.range.endSample }));
      for (const r of await this.engines.embed(batch)) out.push({ startSample: r.startSample, endSample: r.endSample, vector: r.vector, quality: r.quality, embeddingSpace: space });
    }
    return out;
  }

  windowGrid(regions: readonly TimeRange[]): TimeRange[] {
    return windowGrid(regions);
  }

  cluster(vectors: readonly Float32Array[], initial: readonly (number | null)[], embeddingSpace: string): ClusterAssignment {
    return refineClusters(vectors, initial, clusterParams(embeddingSpace));
  }

  mergeThreshold(embeddingSpace: string): number {
    return clusterParams(embeddingSpace).merge;
  }

  liveProvider(): LiveSpeechProvider {
    return this.live;
  }

  summaryProvider(modelId: string | "cloud"): SummaryProvider | null {
    if (modelId === "cloud") {
      const endpoint = this.settings().cloudSummaryEndpoint;
      return endpoint ? new CloudSummaryProvider(endpoint) : null;
    }
    const entry = catalogEntry(modelId);
    if (!entry || entry.role !== "summary" || entry.availability.status !== "available") return null;
    return new ChunkedSummaryProvider(`local:${modelId}`, new LlmChatModel(this.engines, entry));
  }

  async release(): Promise<void> {
    await this.engines.release(["asr", "llm"]);
  }
}

class LlmChatModel implements ChatModel {
  readonly id: string;
  readonly contextTokens: number;
  readonly maxNewTokens: number;

  constructor(private readonly engines: LocalEngines, private readonly entry: ModelCatalogEntry) {
    this.id = entry.id;
    this.contextTokens = Number(entry.manifest.params?.contextTokens ?? 8192);
    this.maxNewTokens = Number(entry.manifest.params?.maxNewTokens ?? 1024);
  }

  async countTokens(text: string): Promise<number> {
    await this.engines.ensureLlm(this.entry.id);
    return this.engines.call<number>("llm", "llm.countTokens", { text });
  }

  async generate(messages: { role: string; content: string }[], opts: { signal?: AbortSignal; onTokens?: (n: number) => void }): Promise<string> {
    await this.engines.ensureLlm(this.entry.id);
    const stop = () => void this.engines.call("llm", "llm.stop", {}).catch(() => undefined);
    opts.signal?.addEventListener("abort", stop, { once: true });
    try {
      const r = await this.engines.call<{ text: string }>("llm", "llm.generate", { messages, maxNewTokens: this.maxNewTokens, disableThinking: this.entry.manifest.params?.disableThinking === true }, {
        progress: (p) => opts.onTokens?.((p as { tokens: number }).tokens),
      });
      return r.text;
    } finally {
      opts.signal?.removeEventListener("abort", stop);
    }
  }
}
