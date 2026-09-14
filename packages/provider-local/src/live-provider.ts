import {
  AsyncQueue,
  errorMessage,
  newId,
  overlap,
  pcmToFloat32,
  SAMPLE_RATE,
  type AudioFrame,
  type ClusterId,
  type LiveSpeechProvider,
  type LiveSpeechRun,
  type ProviderCapabilities,
  type SpeakerTurn,
  type SpeechEvent,
  type TimeRange,
  type TranscriptToken,
  type TranscriptionConfig,
} from "@irl/domain";
import { catalogEntry, embeddingSpaceOf } from "./catalog";
import { clusterParams, DEFAULT_WINDOWS, OnlineClusterer } from "./clustering";
import type { LocalEngines } from "./engines";
import { ComputeScheduler, interpolateWords, type SchedulerDecision } from "./scheduler";
import { VadSegmenter } from "./vad-segmenter";

const RING_SECONDS = 90;
const TICK_MS = 100;
const INTERIM_EVERY_SAMPLES = Math.round(1.2 * SAMPLE_RATE);
/**
 * Speech held while the caption model loads is captioned once it's ready, newest 15 s only: older lines would
 * scroll off the glasses before they appeared, and the final pass transcribes everything anyway.
 */
const CATCH_UP_SAMPLES = 15 * SAMPLE_RATE;

/** Recent audio for live jobs; older audio is only on disk. */
class RingBuffer {
  private parts: { start: number; samples: Float32Array }[] = [];
  end = 0;

  push(start: number, samples: Float32Array) {
    this.parts.push({ start, samples });
    this.end = start + samples.length;
    const keepFrom = this.end - RING_SECONDS * SAMPLE_RATE;
    while (this.parts.length && this.parts[0]!.start + this.parts[0]!.samples.length < keepFrom) this.parts.shift();
  }

  get start(): number {
    return this.parts[0]?.start ?? this.end;
  }

  slice(r: TimeRange): Float32Array {
    const out = new Float32Array(Math.max(0, r.endSample - r.startSample));
    for (const p of this.parts) {
      const a = Math.max(r.startSample, p.start);
      const b = Math.min(r.endSample, p.start + p.samples.length);
      if (b > a) out.set(p.samples.subarray(a - p.start, b - p.start), a - r.startSample);
    }
    return out;
  }
}

interface Utterance extends TimeRange {
  id: string;
  ended: boolean;
  transcribed: boolean;
  windowsQueued: number;
  windowsDone: number;
  lastInterimEnd: number;
  nextWindowStart: number;
}

interface WindowResult extends TimeRange {
  label: number;
  vector: Float32Array;
  quality: number;
  confirmed: boolean;
}

export interface LocalLiveConfig extends TranscriptionConfig {
  sttModelId: string | "off";
  embeddingModelId: string;
  vadModelId: string;
}

/**
 * Default local provider (plan.md §6.1): Silero VAD splits speech, the live STT model captions each
 * utterance (interim re-decodes while it grows, final when it ends), CAM++ windows feed online clustering,
 * and utterances become speaker turns once their windows are embedded. Model downloads never block:
 * a model that isn't downloaded or fails puts the run into capture-now/process-later.
 */
export class LocalLiveSpeechProvider implements LiveSpeechProvider {
  readonly id = "local";
  readonly capabilities: ProviderCapabilities = { transcription: "streaming", diarization: "streaming", persistentIdentity: true, languages: "auto", execution: "local" };

  constructor(private readonly engines: LocalEngines) {}

  async start(config: LocalLiveConfig): Promise<LiveSpeechRun> {
    const run = new LocalLiveRun(this.engines, config);
    void run.boot();
    return run;
  }
}

class LocalLiveRun implements LiveSpeechRun {
  readonly providerRunId: string;
  readonly events = new AsyncQueue<SpeechEvent>();
  private ring = new RingBuffer();
  private vadFed = 0;
  /** First sample this run received; frames are on the recording's clock, which started before the run attached. */
  private audioStart: number | null = null;
  private segmenter = new VadSegmenter();
  private utterances: Utterance[] = [];
  private windows: WindowResult[] = [];
  private clusterer: OnlineClusterer;
  private confirmedLabels = new Map<number, ClusterId>();
  private scheduler = new ComputeScheduler();
  private decision: SchedulerDecision = { level: 0, reason: null, interimCaptions: true, liveStt: true, embeddings: true };
  private ready = { vad: false, embed: false };
  /** "loading" holds ended utterances for captions; "unavailable" lets them become turns without text (the final pass covers them). */
  private stt: "loading" | "ready" | "unavailable";
  /** Where the caption model became ready: speech held before this is catch-up, not a sign of falling behind. */
  private sttReadyAt = 0;
  private sttBusy = false;
  private embedBusy = false;
  private vadBusy = false;
  private lastRtf: number | null = null;
  private failure = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private lastDegraded: string | null = null;
  private lastTurnCluster: ClusterId | null = null;
  private readonly space: string;

  constructor(private readonly engines: LocalEngines, private readonly config: LocalLiveConfig) {
    this.providerRunId = config.providerRunId;
    this.space = embeddingSpaceOf(config.embeddingModelId);
    this.clusterer = new OnlineClusterer(clusterParams(this.space));
    this.stt = config.sttModelId === "off" ? "unavailable" : "loading";
  }

  async boot(): Promise<void> {
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    const loadIfDownloaded = async (modelId: string, what: string, load: () => Promise<unknown>) => {
      if (!(await this.engines.isDownloaded(modelId))) {
        this.emitDegraded(`${what} model not downloaded — processing later`);
        return false;
      }
      try {
        await load();
        return true;
      } catch (e) {
        this.emit({ type: "error", message: `${what}: ${errorMessage(e)}`, fatal: false });
        this.emitDegraded(`${what} unavailable — processing later`);
        return false;
      }
    };
    this.ready.vad = await loadIfDownloaded(this.config.vadModelId, "Speech detection", () => this.engines.ensureVad(this.config.vadModelId));
    // Each model is used as soon as it's loaded: the caption model can take far longer than the speaker model.
    await Promise.all([
      loadIfDownloaded(this.config.embeddingModelId, "Speaker", () => this.engines.ensureEmbedding(this.config.embeddingModelId)).then((ok) => (this.ready.embed = ok)),
      this.config.sttModelId === "off"
        ? null
        : loadIfDownloaded(this.config.sttModelId, "Captions", () => this.engines.ensureAsr(this.config.sttModelId)).then((ok) => (ok ? this.sttBecameReady() : (this.stt = "unavailable"))),
    ]);
    if (this.ready.vad && this.ready.embed && (this.stt === "ready" || this.config.sttModelId === "off")) this.emitDegraded(null);
  }

  private sttBecameReady(): void {
    this.stt = "ready";
    this.sttReadyAt = this.ring.end;
    for (const u of this.utterances) if (u.ended && !u.transcribed && u.endSample < this.ring.end - CATCH_UP_SAMPLES) u.transcribed = true;
  }

  push(frame: AudioFrame): void {
    if (this.closed) return;
    this.audioStart ??= frame.startSample;
    this.ring.push(frame.startSample, pcmToFloat32(frame.pcm));
  }

  private emit(ev: SpeechEvent): void {
    // Errors are otherwise only visible on the live screen; keep them in diagnostics.
    if (ev.type === "error") console.warn(`[live] ${ev.message}`);
    if (!this.closed || ev.type !== "degraded") this.events.push(ev);
  }

  private emitDegraded(reason: string | null): void {
    if (reason === this.lastDegraded) return;
    this.lastDegraded = reason;
    this.events.push({ type: "degraded", reason });
  }

  private async tick(): Promise<void> {
    if (this.ready.vad && !this.vadBusy) void this.feedVad();
    const sample = {
      // The oldest ended utterance is the one being (or about to be) transcribed; only what waits behind it is backlog.
      sttBacklogS: this.utterances.filter((u) => u.ended && !u.transcribed && u.endSample > this.sttReadyAt && this.stt === "ready").slice(1).reduce((n, u) => n + (u.endSample - u.startSample), 0) / SAMPLE_RATE,
      embedBacklogS: this.utterances.reduce((n, u) => n + (u.windowsQueued - u.windowsDone) * 2, 0),
      sttRtf: this.lastRtf,
      failure: this.failure,
    };
    const prevLevel = this.decision.level;
    this.decision = this.scheduler.update(sample);
    if (this.decision.level !== prevLevel) console.warn(`[scheduler] level ${prevLevel} → ${this.decision.level}`, JSON.stringify({ ...sample, sttRtf: sample.sttRtf?.toFixed(2) }));
    this.failure = false;
    // Model problems are reported where they happen; with every model healthy the scheduler owns the message.
    if (this.ready.vad && this.ready.embed && (this.stt === "ready" || this.config.sttModelId === "off")) this.emitDegraded(this.decision.reason);
    if (!this.sttBusy) void this.runStt();
    if (!this.embedBusy) void this.runEmbeddings();
    this.finalizeTurns();
  }

  private async feedVad(): Promise<void> {
    const from = Math.max(this.vadFed, this.ring.start);
    const to = this.ring.end;
    if (to - from < 512) return;
    this.vadBusy = true;
    try {
      const samples = this.ring.slice({ startSample: from, endSample: to });
      this.vadFed = to;
      const { probs, firstWindowStart } = await this.engines.vadPush(samples, from);
      for (let i = 0; i < probs.length; i++) {
        for (const ev of this.segmenter.push(probs[i]!, firstWindowStart + i * 512)) {
          if (ev.type === "start") {
            // Padding can reach before the run's first audio, which live STT would treat as already evicted.
            const start = Math.max(ev.sample, this.audioStart ?? ev.sample);
            this.utterances.push({ id: newId("utt"), startSample: start, endSample: start, ended: false, transcribed: false, windowsQueued: 0, windowsDone: 0, lastInterimEnd: start, nextWindowStart: start });
            this.emit({ type: "speech", active: true, sample: start });
          } else {
            const u = this.utterances.find((x) => !x.ended);
            if (u) {
              u.endSample = ev.range.endSample;
              u.ended = true;
            }
            this.emit({ type: "speech", active: false, sample: ev.range.endSample });
          }
        }
      }
      const open = this.utterances.find((x) => !x.ended);
      if (open) open.endSample = firstWindowStart + probs.length * 512;
      this.scheduleWindows();
    } catch (e) {
      this.failure = true;
      this.ready.vad = false;
      this.emit({ type: "error", message: `VAD failed: ${errorMessage(e)}`, fatal: false });
      this.emitDegraded("Speech detection failed — processing later");
    } finally {
      this.vadBusy = false;
    }
  }

  private scheduleWindows(): void {
    if (!this.decision.embeddings || !this.ready.embed) return;
    const win = Math.round((DEFAULT_WINDOWS.windowMs * SAMPLE_RATE) / 1000);
    const hop = Math.round((DEFAULT_WINDOWS.hopMs * SAMPLE_RATE) / 1000);
    for (const u of this.utterances) {
      while (u.nextWindowStart + win <= u.endSample) {
        this.pendingWindows.push({ startSample: u.nextWindowStart, endSample: u.nextWindowStart + win, utteranceId: u.id });
        u.windowsQueued++;
        u.nextWindowStart += hop;
      }
      // Short utterances (1.2–2 s) get one window when they end.
      const len = u.endSample - u.startSample;
      if (u.ended && u.windowsQueued === 0 && len >= DEFAULT_WINDOWS.minMs * 16) {
        this.pendingWindows.push({ startSample: u.startSample, endSample: u.endSample, utteranceId: u.id });
        u.windowsQueued++;
        u.nextWindowStart = u.endSample;
      }
    }
  }

  private pendingWindows: (TimeRange & { utteranceId: string })[] = [];

  private async runEmbeddings(): Promise<void> {
    if (!this.pendingWindows.length || !this.ready.embed) return;
    this.embedBusy = true;
    const batch = this.pendingWindows.splice(0, 4);
    try {
      const inputs = batch.map((w) => ({ samples: this.ring.slice(w), startSample: w.startSample, endSample: w.endSample }));
      const results = await this.engines.embed(inputs);
      results.forEach((r, i) => {
        const w = batch[i]!;
        const u = this.utterances.find((x) => x.id === w.utteranceId);
        if (u) u.windowsDone++;
        if (r.quality < 0.15) return;
        const a = this.clusterer.assign(r.vector);
        const result: WindowResult = { startSample: r.startSample, endSample: r.endSample, label: a.label, vector: r.vector, quality: r.quality, confirmed: a.confirmed };
        this.windows.push(result);
        if (a.newlyConfirmed) {
          // Release the windows held while this speaker was tentative.
          this.confirm(a.label);
          for (const held of this.windows.filter((x) => x.label === a.label && !x.confirmed)) {
            held.confirmed = true;
            this.emitWindow(held);
          }
        } else if (a.confirmed) {
          this.emitWindow(result);
        }
      });
    } catch (e) {
      for (const w of batch) {
        const u = this.utterances.find((x) => x.id === w.utteranceId);
        if (u) u.windowsDone++;
      }
      this.failure = true;
      this.emit({ type: "error", message: `speaker embedding failed: ${errorMessage(e)}`, fatal: false });
      this.ready.embed = false;
      void this.engines.ensureEmbedding(this.config.embeddingModelId).then(() => (this.ready.embed = true), () => undefined);
    } finally {
      this.embedBusy = false;
    }
  }

  private confirm(label: number): ClusterId {
    let id = this.confirmedLabels.get(label);
    if (!id) {
      id = `L${this.confirmedLabels.size + 1}`;
      this.confirmedLabels.set(label, id);
      this.emit({ type: "cluster", clusterId: id, ordinal: this.confirmedLabels.size });
    }
    return id;
  }

  private emitWindow(w: WindowResult): void {
    this.emit({ type: "window", clusterId: this.confirm(w.label), embedding: { startSample: w.startSample, endSample: w.endSample, vector: w.vector, embeddingSpace: this.space, quality: w.quality } });
  }

  private async runStt(): Promise<void> {
    if (this.stt !== "ready" || !this.decision.liveStt) return;
    // Finals first (oldest ended utterance), then an interim for the open utterance.
    const final = this.utterances.find((u) => u.ended && !u.transcribed);
    const open = this.utterances.find((u) => !u.ended);
    let job: { u: Utterance; final: boolean } | null = null;
    if (final) job = { u: final, final: true };
    else if (open && this.decision.interimCaptions && open.endSample - open.lastInterimEnd >= INTERIM_EVERY_SAMPLES) job = { u: open, final: false };
    if (!job) return;
    const { u } = job;
    const range = { startSample: u.startSample, endSample: u.endSample };
    if (range.endSample - range.startSample < SAMPLE_RATE / 4) {
      if (job.final) u.transcribed = true;
      return;
    }
    if (range.startSample < this.ring.start) {
      // Fell too far behind: this utterance is left for the final pass.
      u.transcribed = true;
      this.emitDegraded("Saving — processing later");
      return;
    }
    this.sttBusy = true;
    if (!job.final) u.lastInterimEnd = range.endSample;
    try {
      const samples = this.ring.slice(range);
      const t0 = performance.now();
      const out = await this.engines.transcribe(samples, this.config.language, false);
      this.lastRtf = (performance.now() - t0) / 1000 / ((range.endSample - range.startSample) / SAMPLE_RATE);
      if (job.final) u.transcribed = true;
      const text = out.text.trim();
      const words = text ? interpolateWords(text, range.startSample, range.endSample) : [];
      const entry = catalogEntry(this.config.sttModelId);
      const tokens: TranscriptToken[] = words.map((w) => ({
        id: newId("tok"), recordingId: this.config.recordingId, providerRunId: this.providerRunId, startSample: w.startSample, endSample: w.endSample, text: w.text,
        final: job!.final, timing: entry?.timing ?? "segment-interpolated", ...(this.config.language !== "auto" ? { language: this.config.language } : {}),
      }));
      this.emit({ type: "tokens", tokens, replaceProvisional: true });
    } catch (e) {
      if (job.final) u.transcribed = true;
      this.failure = true;
      this.emit({ type: "error", message: `live transcription failed: ${errorMessage(e)}`, fatal: false });
      this.stt = "loading";
      this.emitDegraded("Captions paused — processing later");
      // Try to recover the model (e.g. after a WebGPU device loss) without stopping capture.
      void this.engines.ensureAsr(this.config.sttModelId).then(
        () => this.sttBecameReady(),
        () => (this.stt = "unavailable"),
      );
    } finally {
      this.sttBusy = false;
    }
  }

  /** Utterances become turns once ended and embedded (or when embeddings aren't running). */
  private finalizeTurns(force = false): void {
    const done: Utterance[] = [];
    for (const u of this.utterances) {
      if (!u.ended) continue;
      const embeddingsSettled = !this.ready.embed || !this.decision.embeddings || u.windowsDone >= u.windowsQueued;
      // Wait for text while the caption model is loading too, unless the audio has already left the ring.
      const awaitingText = !u.transcribed && this.decision.liveStt && (this.stt === "ready" || (this.stt === "loading" && u.startSample >= this.ring.start));
      if (!force && (!embeddingsSettled || awaitingText)) continue;
      done.push(u);
    }
    if (!done.length) return;
    const turns: SpeakerTurn[] = [];
    for (const u of done) turns.push(...this.turnsFor(u));
    this.utterances = this.utterances.filter((u) => !done.includes(u));
    // Windows older than the ring are no longer needed for turn building.
    this.windows = this.windows.filter((w) => w.endSample > this.ring.start - 30 * SAMPLE_RATE);
    if (turns.length) this.emit({ type: "turns", turns });
  }

  private turnsFor(u: Utterance): SpeakerTurn[] {
    const inside = this.windows
      .filter((w) => overlap(w, u) > 0)
      .map((w) => ({ ...w, label: w.confirmed ? w.label : (this.clusterer.nearestConfirmed(w.vector) ?? w.label) }))
      .sort((a, b) => a.startSample - b.startSample);
    const make = (clusterId: ClusterId, r: TimeRange, confidence: number): SpeakerTurn => ({ id: newId("turn"), recordingId: this.config.recordingId, providerRunId: this.providerRunId, clusterId, startSample: r.startSample, endSample: r.endSample, final: true, confidence });
    if (!inside.length) {
      // Too short to embed: attribute to the previous speaker with low confidence.
      return this.lastTurnCluster ? [make(this.lastTurnCluster, u, 0.3)] : [];
    }
    const out: SpeakerTurn[] = [];
    let start = u.startSample;
    for (let i = 0; i < inside.length; i++) {
      const w = inside[i]!;
      const next = inside[i + 1];
      if (next && next.label === w.label) continue;
      const end = next ? Math.round((w.endSample + next.startSample) / 2) : u.endSample;
      const id = this.confirm(w.label);
      out.push(make(id, { startSample: start, endSample: Math.max(start + 1, Math.min(end, u.endSample)) }, w.quality));
      start = end;
    }
    this.lastTurnCluster = out[out.length - 1]?.clusterId ?? this.lastTurnCluster;
    return out;
  }

  async finish(): Promise<void> {
    for (const ev of this.segmenter.flush(this.ring.end)) {
      if (ev.type === "end") {
        const u = this.utterances.find((x) => !x.ended);
        if (u) {
          u.endSample = ev.range.endSample;
          u.ended = true;
        }
      }
    }
    for (const u of this.utterances) u.ended = true;
    this.scheduleWindows();
    const deadline = performance.now() + 45_000;
    while (performance.now() < deadline) {
      const pending = this.pendingWindows.length > 0 || this.embedBusy || this.sttBusy || (this.stt === "ready" && this.decision.liveStt && this.utterances.some((u) => !u.transcribed));
      if (!pending) break;
      await new Promise((ok) => setTimeout(ok, 50));
      if (!this.embedBusy) await this.runEmbeddings();
      if (!this.sttBusy) await this.runStt();
    }
    this.finalizeTurns(true);
    if (this.timer) clearInterval(this.timer);
    this.closed = true;
    this.events.close();
  }

  async abort(reason: string): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.emit({ type: "error", message: `aborted: ${reason}`, fatal: false });
    this.closed = true;
    this.events.close();
  }
}
