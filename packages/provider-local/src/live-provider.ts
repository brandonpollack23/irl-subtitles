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
import { catalogEntry, embeddingSpaceOf, isStreamingStt } from "./catalog";
import { clusterParams, DEFAULT_WINDOWS, OnlineClusterer } from "./clustering";
import type { LocalEngines } from "./engines";
import type { StreamLine } from "./workers/moonshine.worker";
import { liveMetrics } from "./live-metrics";
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
  /** End of the audio the latest STT call for this utterance covered. */
  decodedTo: number;
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
 * Default local provider (plan.md §6.1): Silero VAD splits speech, CAM++ windows feed online clustering, and
 * utterances become speaker turns once their windows are embedded. Captions come from one of two live STT paths:
 * a Moonshine Streaming model is fed the audio continuously and reports lines as they grow and complete
 * (irl-subt-kdl.9); a transformers.js model captions each VAD utterance (interim re-decodes while it grows, final
 * when it ends). Model downloads never block:
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
  /** Streaming STT: audio goes to the Moonshine worker continuously instead of per utterance. */
  private readonly streaming: boolean;
  /** Next sample to send to the stream, and the sample its line times count from. */
  private streamFed = 0;
  private streamOrigin = 0;
  /** Stream lines already emitted as final (the worker reports each once; this keeps a retry from doubling text). */
  private finalLines = new Set<string>();
  private embedBusy = false;
  private vadBusy = false;
  /** STT work since the last scheduler sample. */
  private sttComputeMs = 0;
  private sttNewAudioS = 0;
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
    this.streaming = config.sttModelId !== "off" && isStreamingStt(config.sttModelId);
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
        : loadIfDownloaded(this.config.sttModelId, "Captions", () => this.engines.ensureLiveStt(this.config.sttModelId)).then((ok) => (ok ? this.sttBecameReady() : (this.stt = "unavailable"))),
    ]);
    if (this.ready.vad && this.ready.embed && (this.stt === "ready" || this.config.sttModelId === "off")) this.emitDegraded(null);
  }

  private sttBecameReady(): void {
    if (this.streaming) {
      // Speech held while the model loaded is streamed from where catch-up starts; the stream restarts there.
      const from = Math.max(this.ring.start, this.audioStart ?? 0, this.ring.end - CATCH_UP_SAMPLES);
      this.stt = "loading";
      void this.engines.streamStart().then(
        () => {
          this.streamFed = this.streamOrigin = this.lastStreamPass = from;
          this.finalLines.clear();
          this.sttReadyAt = this.ring.end;
          this.stt = "ready";
        },
        (e) => this.sttFailed(e),
      );
      return;
    }
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
      // Catch-up audio held while the model loaded isn't a sign of falling behind.
      sttBacklogS: this.streaming ? (this.stt === "ready" ? Math.max(0, this.ring.end - Math.max(this.streamFed, this.sttReadyAt)) / SAMPLE_RATE : 0) : this.utterances.filter((u) => u.ended && !u.transcribed && u.endSample > this.sttReadyAt && this.stt === "ready").slice(1).reduce((n, u) => n + (u.endSample - u.startSample), 0) / SAMPLE_RATE,
      embedBacklogS: this.utterances.reduce((n, u) => n + (u.windowsQueued - u.windowsDone) * 2, 0),
      sttComputeMs: this.sttComputeMs,
      sttNewAudioS: this.sttNewAudioS,
      failure: this.failure,
    };
    const prevLevel = this.decision.level;
    this.decision = this.scheduler.update(sample);
    if (this.decision.level !== prevLevel) liveMetrics.emit({ kind: "degraded", runId: this.providerRunId, level: this.decision.level, reason: this.decision.reason });
    if (this.decision.level !== prevLevel) console.warn(`[scheduler] level ${prevLevel} → ${this.decision.level}`, JSON.stringify({ ...sample, sttLoad: this.scheduler.sttLoad?.toFixed(2) }));
    this.failure = false;
    this.sttComputeMs = 0;
    this.sttNewAudioS = 0;
    // Model problems are reported where they happen; with every model healthy the scheduler owns the message.
    if (this.ready.vad && this.ready.embed && (this.stt === "ready" || this.config.sttModelId === "off")) this.emitDegraded(this.decision.reason);
    if (!this.sttBusy) void (this.streaming ? this.runStream() : this.runStt());
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
      const t0 = performance.now();
      const { probs, firstWindowStart } = await this.engines.vadPush(samples, from);
      liveMetrics.emit({ kind: "vad", runId: this.providerRunId, audioS: (to - from) / SAMPLE_RATE, computeMs: performance.now() - t0 });
      for (let i = 0; i < probs.length; i++) {
        for (const ev of this.segmenter.push(probs[i]!, firstWindowStart + i * 512)) {
          if (ev.type === "start") {
            // Padding can reach before the run's first audio, which live STT would treat as already evicted.
            const start = Math.max(ev.sample, this.audioStart ?? ev.sample);
            this.utterances.push({ id: newId("utt"), startSample: start, endSample: start, ended: false, transcribed: false, windowsQueued: 0, windowsDone: 0, lastInterimEnd: start, nextWindowStart: start, decodedTo: start });
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
      const t0 = performance.now();
      const results = await this.engines.embed(inputs);
      liveMetrics.emit({ kind: "embed", runId: this.providerRunId, windows: batch.length, computeMs: performance.now() - t0 });
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
      const computeMs = performance.now() - t0;
      const newAudioS = Math.max(0, range.endSample - Math.max(u.decodedTo, range.startSample)) / SAMPLE_RATE;
      this.sttComputeMs += computeMs;
      this.sttNewAudioS += newAudioS;
      liveMetrics.emit({
        kind: "stt", runId: this.providerRunId, final: job.final, audioS: (range.endSample - range.startSample) / SAMPLE_RATE,
        newAudioS, computeMs, lagS: (this.ring.end - range.endSample) / SAMPLE_RATE,
      });
      u.decodedTo = Math.max(u.decodedTo, range.endSample);
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
      void this.engines.ensureLiveStt(this.config.sttModelId).then(
        () => this.sttBecameReady(),
        () => (this.stt = "unavailable"),
      );
    } finally {
      this.sttBusy = false;
    }
  }

  /**
   * Streaming STT: sends the audio received since the last push; the stream decides when it has enough for a pass
   * (0.5 s, stretched while passes take longer). Open lines replace the provisional text, completed lines are final.
   */
  private async runStream(flush = false): Promise<void> {
    if (this.stt !== "ready" || (!this.decision.liveStt && !flush)) return;
    if (this.streamFed < this.ring.start) {
      // Fell behind the ring: what was skipped is left for the final pass, and line times restart from here.
      this.emitDegraded("Saving — processing later");
      this.stt = "loading";
      this.sttBecameReady();
      return;
    }
    const from = this.streamFed;
    const to = this.ring.end;
    if (to - from < SAMPLE_RATE / 10 && !flush) return;
    this.sttBusy = true;
    try {
      this.streamFed = to;
      const samples = this.ring.slice({ startSample: from, endSample: to });
      const out = samples.length ? await this.engines.streamPush(samples) : { lines: [], computeMs: 0 };
      const stopped = flush ? await this.engines.streamStop() : null;
      const lines = [...out.lines, ...(stopped?.lines ?? [])];
      const computeMs = out.computeMs + (stopped?.computeMs ?? 0);
      if (computeMs > 0 || lines.length) this.emitStreamLines(lines, computeMs, stopped !== null);
    } catch (e) {
      this.sttFailed(e);
    } finally {
      this.sttBusy = false;
    }
  }

  private emitStreamLines(lines: readonly StreamLine[], computeMs: number, flushed: boolean): void {
    const at = (s: number) => this.streamOrigin + Math.round(s * SAMPLE_RATE);
    const byId = new Map<string, StreamLine>();
    for (const l of lines) byId.set(l.id, l);
    const tokens: TranscriptToken[] = [];
    const entry = catalogEntry(this.config.sttModelId);
    let lastEnd: number | null = null;
    let finalEnd: number | null = null;
    for (const l of byId.values()) {
      if (this.finalLines.has(l.id)) continue;
      const final = l.isComplete || flushed;
      if (final) this.finalLines.add(l.id);
      if (!final && !this.decision.interimCaptions) continue;
      const start = at(l.startTime);
      const end = Math.max(start + 1, Math.min(this.ring.end, at(l.startTime + l.duration)));
      lastEnd = Math.max(lastEnd ?? 0, end);
      if (final) finalEnd = Math.max(finalEnd ?? 0, end);
      for (const w of interpolateWords(l.text.trim(), start, end)) {
        tokens.push({
          id: newId("tok"), recordingId: this.config.recordingId, providerRunId: this.providerRunId, startSample: w.startSample, endSample: w.endSample, text: w.text,
          final, timing: entry?.timing ?? "segment-interpolated", ...(this.config.language !== "auto" ? { language: this.config.language } : {}),
        });
      }
    }
    const newAudioS = computeMs > 0 ? Math.max(0, this.streamFed - this.lastStreamPass) / SAMPLE_RATE : 0;
    if (computeMs > 0) this.lastStreamPass = this.streamFed;
    this.sttComputeMs += computeMs;
    this.sttNewAudioS += newAudioS;
    liveMetrics.emit({ kind: "stt", runId: this.providerRunId, final: finalEnd !== null, audioS: newAudioS, newAudioS, computeMs, ...(lastEnd !== null ? { lagS: (this.ring.end - (finalEnd ?? lastEnd)) / SAMPLE_RATE } : {}) });
    this.emit({ type: "tokens", tokens, replaceProvisional: true });
  }

  /** Where the stream's last pass ended, for compute per second of new audio. */
  private lastStreamPass = 0;

  private sttFailed(e: unknown): void {
    this.failure = true;
    this.emit({ type: "error", message: `live transcription failed: ${errorMessage(e)}`, fatal: false });
    this.stt = "loading";
    this.emitDegraded("Captions paused — processing later");
    void this.engines.ensureLiveStt(this.config.sttModelId).then(
      () => this.sttBecameReady(),
      () => (this.stt = "unavailable"),
    );
  }

  /** Utterances become turns once ended and embedded (or when embeddings aren't running). */
  private finalizeTurns(force = false): void {
    const done: Utterance[] = [];
    for (const u of this.utterances) {
      if (!u.ended) continue;
      const embeddingsSettled = !this.ready.embed || !this.decision.embeddings || u.windowsDone >= u.windowsQueued;
      // Wait for text while the caption model is loading too, unless the audio has already left the ring.
      const awaitingText = !this.streaming && !u.transcribed && this.decision.liveStt && (this.stt === "ready" || (this.stt === "loading" && u.startSample >= this.ring.start));
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
    if (this.streaming) {
      const deadline = performance.now() + 45_000;
      // The final push waits for in-flight work, then flushes the stream's last line.
      while (this.sttBusy && performance.now() < deadline) await new Promise((ok) => setTimeout(ok, 20));
      if (this.stt === "ready") await this.runStream(true);
    }
    const deadline = performance.now() + 45_000;
    while (performance.now() < deadline) {
      const pending = this.pendingWindows.length > 0 || this.embedBusy || this.sttBusy || (!this.streaming && this.stt === "ready" && this.decision.liveStt && this.utterances.some((u) => !u.transcribed));
      if (!pending) break;
      await new Promise((ok) => setTimeout(ok, 50));
      if (!this.embedBusy) await this.runEmbeddings();
      if (!this.sttBusy && !this.streaming) await this.runStt();
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
