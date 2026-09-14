import { SAMPLE_RATE, type LiveSpeechProvider, type ModelCatalogEntry, type Settings, type SummaryProvider, type TimeRange, type VoiceEmbedding } from "@irl/domain";
import type { ClusterAssignment, FinalWord, ProcessingToolkit } from "@irl/pipeline";
import { ChunkedSummaryProvider, CloudSummaryProvider, type ChatModel } from "@irl/provider-summary";
import { CATALOG, catalogEntry, embeddingSpaceOf, isStreamingStt } from "./catalog";
import { clusterParams, refineClusters, windowGrid } from "./clustering";
import type { EngineKind, LocalEngines } from "./engines";
import { LocalLiveSpeechProvider } from "./live-provider";
import { workerName, type OrtFlavor } from "./ort-flavor";
import { interpolateWords } from "./scheduler";

export function defaultWorkers(): Record<EngineKind, (flavor: OrtFlavor) => Worker> {
  return {
    audio: (f) => new Worker(new URL("./workers/audio.worker.ts", import.meta.url), { type: "module", name: workerName("irl-audio-ml", f) }),
    asr: (f) => new Worker(new URL("./workers/asr.worker.ts", import.meta.url), { type: "module", name: workerName("irl-asr", f) }),
    llm: (f) => new Worker(new URL("./workers/llm.worker.ts", import.meta.url), { type: "module", name: workerName("irl-llm", f) }),
    stream: (f) => new Worker(new URL("./workers/moonshine.worker.ts", import.meta.url), { type: "module", name: workerName("irl-moonshine", f) }),
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
    if (isStreamingStt(modelId)) {
      await this.engines.ensureLiveStt(modelId);
      const out = await this.engines.streamTranscribe(samples.slice());
      const at = (s: number) => startSample + Math.round(s * SAMPLE_RATE);
      const words = out.lines.flatMap((l) => interpolateWords(l.text, at(l.startTime), Math.min(startSample + samples.length, at(l.startTime + l.duration))));
      return { words, timing: "segment-interpolated" as const, ...(language !== "auto" ? { language } : {}) };
    }
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

  /**
   * Frees the post-processing models. The live caption model stays loaded in its own worker, so the next conversation
   * captions at once (irl-subt-kdl.11); on iOS it is dropped before a summary model loads (see LlmChatModel).
   */
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

  /**
   * iOS gives a WebView one memory budget and kills the whole page past it: a multi-GB summary model on top of the
   * live caption model risks that, so the caption model goes first there (warmup reloads it once processing is idle).
   */
  private async ensureLoaded(): Promise<void> {
    if ((await this.engines.capabilities()).platform === "ios") this.engines.reset("stream");
    await this.engines.ensureLlm(this.entry.id);
  }

  async countTokens(text: string): Promise<number> {
    await this.ensureLoaded();
    return this.engines.call<number>("llm", "llm.countTokens", { text });
  }

  async generate(messages: { role: string; content: string }[], opts: { signal?: AbortSignal; onTokens?: (n: number) => void }): Promise<string> {
    await this.ensureLoaded();
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
