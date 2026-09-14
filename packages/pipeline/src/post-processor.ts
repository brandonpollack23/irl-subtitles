import {
  Emitter,
  errorMessage,
  newId,
  nowIso,
  resolveCluster,
  SAMPLE_RATE,
  sleep,
  type ClusterId,
  type Person,
  type ProcessingStage,
  type Recording,
  type SpeakerCluster,
  type SpeakerTurn,
  type StageStatus,
  type TimeRange,
  type TranscriptToken,
  type VoiceWindow,
  activeAttributions,
  speakerLabel,
  cosine,
  meanVector,
  canTransition,
} from "@irl/domain";
import { chunkPath, encodeOpus, opusEncoderRate, type RecordingAudio } from "@irl/capture";
import { writeVerified, type BlobStore, type Repository, type Sealer, type SettingsStore } from "@irl/storage";
import type { EphemeralKeys } from "./controller";
import type { IdentityService } from "./identity-service";
import { reconcile, selectTokens } from "./reconciler";
import type { ProcessingToolkit } from "./toolkit";

export type PostStage = Exclude<ProcessingStage, "liveStt">;
export const ALL_STAGES: readonly PostStage[] = ["finalStt", "diarization", "identity", "summary", "compression"];

export interface StageEvent {
  recordingId: string;
  stage: PostStage | "done";
  status: StageStatus;
  progress?: number;
  note?: string;
}

export interface PostProcessorDeps {
  repo: Repository;
  blobs: BlobStore;
  audio: RecordingAudio;
  toolkit: ProcessingToolkit;
  identity: IdentityService;
  settings: SettingsStore;
  ephemeral: EphemeralKeys;
  durable: Sealer;
  isCapturing: () => boolean;
}

const BLOCK_SAMPLES = 60 * SAMPLE_RATE;
const MAX_STT_WINDOW = 28 * SAMPLE_RATE;
/** How often a job paused for live capture checks whether capture ended. */
const CAPTURE_POLL_MS = 500;

/** Run ids whose tokens are the final pass for a recording. */
export async function finalRunIds(repo: Repository, recordingId: string): Promise<Set<string>> {
  return new Set((await repo.listRuns(recordingId)).filter((r) => r.kind === "final-stt" && r.state === "finished").map((r) => r.id));
}

export async function loadTranscript(repo: Repository, recordingId: string) {
  const [tokens, turns, clusterRows, runs] = await Promise.all([repo.listTokens(recordingId), repo.listTurns(recordingId), repo.listClusters(recordingId), finalRunIds(repo, recordingId)]);
  const clusters = new Map(clusterRows.map((c) => [c.clusterId, c]));
  const selected = selectTokens(tokens, runs);
  const segments = reconcile({ tokens: selected, turns, clusters });
  return { tokens: selected, turns, clusters, segments };
}

/**
 * After Stop (plan.md §9): final STT, diarization refinement, identity matching → captured; then summary →
 * ready; then audio compression or cleanup. Every stage records its own status so a failure is visible,
 * retryable, and never invalidates the recording.
 */
export class PostProcessor {
  readonly events = new Emitter<StageEvent>();
  /** The queue drained and the workers were released, whether jobs succeeded or not. */
  readonly idle = new Emitter<void>();
  private queue: { recordingId: string; stages: readonly PostStage[] }[] = [];
  private running: Promise<void> | null = null;
  private abort: AbortController | null = null;
  currentRecordingId: string | null = null;

  constructor(private readonly deps: PostProcessorDeps) {}

  enqueue(recordingId: string, stages: readonly PostStage[] = ALL_STAGES): void {
    const existing = this.queue.find((q) => q.recordingId === recordingId);
    if (existing) existing.stages = [...new Set([...existing.stages, ...stages])];
    else this.queue.push({ recordingId, stages });
    this.running ??= this.drain().finally(() => {
      this.running = null;
      this.idle.emit();
    });
  }

  get busy(): boolean {
    return this.running !== null;
  }

  cancelCurrent(): void {
    this.abort?.abort();
  }

  private async drain(): Promise<void> {
    while (this.queue.length) {
      // Post-session work never contends with live capture.
      while (this.deps.isCapturing()) await sleep(2000);
      const job = this.queue.shift()!;
      this.currentRecordingId = job.recordingId;
      this.abort = new AbortController();
      try {
        await this.process(job.recordingId, job.stages, this.abort.signal);
      } catch (e) {
        console.error("post-processing failed", e);
      } finally {
        this.currentRecordingId = null;
        // A recording that started meanwhile has loaded its live models into these workers.
        if (!this.deps.isCapturing()) await this.deps.toolkit.release().catch(() => undefined);
      }
    }
  }

  /**
   * Live capture shares the model workers (one model per worker), so a job that was running when a recording started
   * waits at its next chunk boundary until capture ends; the toolkit reloads its model on the next call (irl-subt-kdl.14).
   */
  private async yieldToCapture(signal: AbortSignal): Promise<void> {
    while (this.deps.isCapturing() && !signal.aborted) await sleep(CAPTURE_POLL_MS);
  }

  private async setStage(recordingId: string, stage: PostStage, status: StageStatus, error?: string): Promise<void> {
    await this.deps.repo.updateRecording(recordingId, (r) => ({ processing: { ...r.processing, [stage]: { status, updatedAt: nowIso(), ...(error ? { error } : {}) } } }));
    this.events.emit({ recordingId, stage, status, ...(error ? { note: error } : {}) });
  }

  private async transition(recordingId: string, state: Recording["state"]): Promise<void> {
    await this.deps.repo.updateRecording(recordingId, (r) => (canTransition(r.state, state) ? { state } : {}));
  }

  private async audioAvailable(r: Recording): Promise<boolean> {
    if (r.audioRetention === "deleted") return false;
    const chunks = await this.deps.repo.listChunks(r.id);
    if (!chunks.length) return false;
    return r.audioRetention !== "ephemeral" || this.deps.ephemeral.get(r.id) !== null;
  }

  async process(recordingId: string, stages: readonly PostStage[], signal: AbortSignal): Promise<void> {
    const { repo } = this.deps;
    let rec = await repo.getRecording(recordingId);
    if (!rec) return;
    const upstream = stages.some((s) => s === "finalStt" || s === "diarization" || s === "identity");
    if (upstream && rec.state !== "finalizing") await this.transition(recordingId, "finalizing");
    let regions: TimeRange[] | null = null;
    const speech = async () => (regions ??= await this.speechRegions(rec!, signal));

    for (const stage of ["finalStt", "diarization", "identity"] as const) {
      if (!stages.includes(stage)) continue;
      await this.yieldToCapture(signal);
      if (signal.aborted) return;
      rec = (await repo.getRecording(recordingId))!;
      try {
        await this.setStage(recordingId, stage, "running");
        const result = stage === "finalStt" ? await this.finalStt(rec, speech, signal) : stage === "diarization" ? await this.diarize(rec, speech, signal) : await this.identify(rec);
        await this.setStage(recordingId, stage, result.status, result.note);
      } catch (e) {
        await this.setStage(recordingId, stage, "failed", errorMessage(e));
      }
    }
    if (upstream) await this.transition(recordingId, "captured");

    if (stages.includes("summary") && !signal.aborted) {
      await this.yieldToCapture(signal);
      try {
        await this.setStage(recordingId, "summary", "running");
        const r = await this.summarize((await repo.getRecording(recordingId))!, signal);
        await this.setStage(recordingId, "summary", r.status, r.note);
      } catch (e) {
        await this.setStage(recordingId, "summary", "failed", errorMessage(e));
        await repo.putSummary({ recordingId, status: "failed", summary: (await repo.getSummary(recordingId))?.summary ?? null, providerId: null, transcriptRevision: rec.transcriptRevision, error: errorMessage(e), updatedAt: nowIso() });
      }
    }
    // Summary failure is represented separately and does not block "ready" (plan.md §9 step 8).
    await this.transition(recordingId, "ready");

    if (stages.includes("compression") && !signal.aborted) {
      try {
        await this.setStage(recordingId, "compression", "running");
        const r = await this.retainAudio((await repo.getRecording(recordingId))!);
        await this.setStage(recordingId, "compression", r.status, r.note);
      } catch (e) {
        await this.setStage(recordingId, "compression", "failed", errorMessage(e));
      }
    }
    this.events.emit({ recordingId, stage: "done", status: "done" });
  }

  // Stages ------------------------------------------------------------------------------------

  private async speechRegions(rec: Recording, signal: AbortSignal): Promise<TimeRange[]> {
    const regions: TimeRange[] = [];
    const total = rec.totalSamples;
    for (let start = 0; start < total; start += BLOCK_SAMPLES) {
      await this.yieldToCapture(signal);
      if (signal.aborted) break;
      const end = Math.min(total, start + BLOCK_SAMPLES);
      const samples = await this.deps.audio.readRange(rec.id, { startSample: start, endSample: end });
      const found = await this.deps.toolkit.detectSpeech(rec.models.vad, samples, start);
      for (const r of found) {
        const last = regions[regions.length - 1];
        // Merge speech that continues across block boundaries.
        if (last && r.startSample - last.endSample < SAMPLE_RATE / 4) last.endSample = Math.max(last.endSample, r.endSample);
        else regions.push({ ...r });
      }
      this.events.emit({ recordingId: rec.id, stage: "finalStt", status: "running", progress: end / Math.max(1, total), note: "detecting speech" });
    }
    return regions;
  }

  private async finalStt(rec: Recording, speech: () => Promise<TimeRange[]>, signal: AbortSignal): Promise<{ status: StageStatus; note?: string }> {
    if (rec.provider === "soniox") return { status: "skipped", note: "Soniox final tokens are the transcript" };
    const liveOk = rec.processing.liveStt.status === "done" && !rec.degraded;
    const modelId = rec.models.sttFinal === "same-as-live" ? (liveOk ? null : rec.models.sttLive === "off" ? null : rec.models.sttLive) : rec.models.sttFinal;
    if (!modelId) return { status: "skipped", note: rec.models.sttLive === "off" ? "no STT model selected" : "same as live" };
    if (!(await this.audioAvailable(rec))) return { status: "skipped", note: "audio unavailable" };
    const runId = newId("final");
    await this.deps.repo.putRun({ id: runId, recordingId: rec.id, provider: "local", kind: "final-stt", config: { modelId, language: rec.language }, startedAt: nowIso(), endedAt: null, state: "running", error: null, resume: null });
    const groups = groupRegions(await speech(), MAX_STT_WINDOW);
    const tokens: TranscriptToken[] = [];
    let detected: string | undefined;
    for (let i = 0; i < groups.length; i++) {
      await this.yieldToCapture(signal);
      if (signal.aborted) throw new Error("cancelled");
      const g = groups[i]!;
      const samples = await this.deps.audio.readRange(rec.id, g);
      const out = await this.deps.toolkit.transcribe(modelId, samples, g.startSample, rec.language, { wordTimestamps: true });
      detected ??= out.language;
      for (const w of out.words) {
        tokens.push({ id: newId("tok"), recordingId: rec.id, providerRunId: runId, startSample: w.startSample, endSample: w.endSample, text: w.text, final: true, timing: out.timing, ...(w.confidence !== undefined ? { confidence: w.confidence } : {}), ...(out.language ?? rec.language ? { language: out.language ?? rec.language } : {}) });
      }
      this.events.emit({ recordingId: rec.id, stage: "finalStt", status: "running", progress: (i + 1) / groups.length });
    }
    // Write the new pass before removing the old one, so an interruption never leaves no transcript.
    await this.deps.repo.putTokens(tokens);
    await this.deps.repo.updateRun(runId, { state: "finished", endedAt: nowIso() });
    await this.deps.repo.deleteTokens(rec.id, (t) => t.providerRunId !== runId);
    for (const r of await this.deps.repo.listRuns(rec.id)) if (r.kind === "final-stt" && r.id !== runId && r.state === "finished") await this.deps.repo.updateRun(r.id, { state: "aborted" });
    await this.deps.repo.updateRecording(rec.id, (r) => ({ transcriptRevision: r.transcriptRevision + 1, modelVersions: { ...r.modelVersions, "stt-final": modelId } }));
    return { status: "done", note: `${tokens.length} words${detected ? `, language ${detected}` : ""}` };
  }

  private async diarize(rec: Recording, speech: () => Promise<TimeRange[]>, signal: AbortSignal): Promise<{ status: StageStatus; note?: string }> {
    const { repo, toolkit, identity } = this.deps;
    const modelId = rec.models.speakerEmbedding;
    const space = toolkit.embeddingSpace(modelId);
    const clusters = new Map((await repo.listClusters(rec.id)).map((c) => [c.clusterId, c]));
    const liveWindows = (await repo.listWindows(rec.id)).filter((w) => w.embeddingSpace === space);
    const haveAudio = await this.audioAvailable(rec);

    if (rec.provider === "soniox") return this.fuseSoniox(rec, clusters, liveWindows, haveAudio, space, signal);

    // Embed speech the live pass missed (degraded, battery saver, or model not ready).
    const newWindows: VoiceWindow[] = [];
    if (haveAudio) {
      const grid = toolkit.windowGrid(await speech());
      const missing = grid.filter((g) => !liveWindows.some((w) => Math.abs(w.startSample - g.startSample) < SAMPLE_RATE / 2));
      for (let i = 0; i < missing.length; i += 16) {
        await this.yieldToCapture(signal);
        if (signal.aborted) throw new Error("cancelled");
        const batch = missing.slice(i, i + 16);
        const inputs = await Promise.all(batch.map(async (range) => ({ range, samples: await this.deps.audio.readRange(rec.id, range) })));
        for (const e of await toolkit.embed(modelId, inputs)) {
          newWindows.push({ id: newId("win"), recordingId: rec.id, clusterId: "", startSample: e.startSample, endSample: e.endSample, embeddingSpace: e.embeddingSpace, quality: e.quality, sealedVector: await identity.sealVector(e.vector) });
        }
        this.events.emit({ recordingId: rec.id, stage: "diarization", status: "running", progress: Math.min(1, (i + 16) / missing.length), note: "embedding voices" });
      }
    }
    const windows = [...liveWindows, ...newWindows].sort((a, b) => a.startSample - b.startSample);
    if (!windows.length) return { status: "skipped", note: haveAudio ? "no speech found" : "no voice windows and audio unavailable" };
    const vectors = await Promise.all(windows.map((w) => identity.openVector(w.sealedVector)));

    const liveIds = [...new Set(windows.map((w) => (w.clusterId ? resolveCluster(clusters, w.clusterId) : "")).filter(Boolean))];
    const initial = windows.map((w) => (w.clusterId ? liveIds.indexOf(resolveCluster(clusters, w.clusterId)) : null));
    const { labels } = toolkit.cluster(vectors, initial, space);

    // Keep live cluster ids (and any names already attached to them) where the refined cluster overlaps them.
    const labelToId = new Map<number, ClusterId>();
    const claimed = new Set<ClusterId>();
    const uniqueLabels = [...new Set(labels)].sort((a, b) => countOf(labels, b) - countOf(labels, a));
    let nextOrdinal = Math.max(0, ...[...clusters.values()].map((c) => c.ordinal)) + 1;
    for (const label of uniqueLabels) {
      const votes = new Map<ClusterId, number>();
      windows.forEach((w, i) => {
        if (labels[i] !== label || !w.clusterId) return;
        const id = resolveCluster(clusters, w.clusterId);
        votes.set(id, (votes.get(id) ?? 0) + 1);
      });
      const best = [...votes.entries()].filter(([id]) => !claimed.has(id)).sort((a, b) => b[1] - a[1])[0];
      const id = best ? best[0] : `L${nextOrdinal}`;
      if (!best) {
        clusters.set(id, { recordingId: rec.id, clusterId: id, ordinal: nextOrdinal++, evidenceMs: 0 });
      }
      claimed.add(id);
      labelToId.set(label, id);
    }
    // Unclaimed live clusters merged into whichever refined cluster absorbed most of their windows.
    for (const [id, c] of clusters) {
      if (claimed.has(id) || c.mergedInto) continue;
      const votes = new Map<ClusterId, number>();
      windows.forEach((w, i) => {
        if (w.clusterId && resolveCluster(clusters, w.clusterId) === id) votes.set(labelToId.get(labels[i]!)!, (votes.get(labelToId.get(labels[i]!)!) ?? 0) + 1);
      });
      const into = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      if (into) clusters.set(id, { ...c, mergedInto: into });
    }
    const assigned = windows.map((w, i) => ({ ...w, clusterId: labelToId.get(labels[i]!)! }));
    for (const id of claimed) {
      const c = clusters.get(id)!;
      clusters.set(id, { ...c, mergedInto: undefined, evidenceMs: assigned.filter((w) => w.clusterId === id).reduce((n, w) => n + ((w.endSample - w.startSample) * 1000) / SAMPLE_RATE, 0) } as SpeakerCluster);
    }
    for (const c of clusters.values()) {
      const clean = { ...c };
      if (!clean.mergedInto) delete clean.mergedInto;
      await repo.putCluster(clean);
    }
    await repo.putWindows(assigned);

    const runId = newId("diar");
    await repo.putRun({ id: runId, recordingId: rec.id, provider: "local", kind: "diarization-refine", config: { modelId, windows: windows.length }, startedAt: nowIso(), endedAt: nowIso(), state: "finished", error: null, resume: null });
    const turns = windowsToTurns(rec.id, runId, assigned, haveAudio ? await speech() : null);
    await repo.putTurns(turns);
    await repo.deleteTurns(rec.id, (t) => t.providerRunId !== runId);
    return { status: "done", note: `${claimed.size} speakers from ${windows.length} windows` };
  }

  /**
   * Soniox mode (plan.md §6.2): Soniox turns stay authoritative; local embeddings over those ranges link
   * Soniox speaker labels across reconnect runs and feed persistent identification. Embeddings stay local.
   */
  private async fuseSoniox(rec: Recording, clusters: Map<ClusterId, SpeakerCluster>, existing: VoiceWindow[], haveAudio: boolean, space: string, signal: AbortSignal): Promise<{ status: StageStatus; note?: string }> {
    const { repo, toolkit, identity } = this.deps;
    const turns = (await repo.listTurns(rec.id)).filter((t) => t.final);
    const windows = [...existing];
    if (haveAudio) {
      for (const t of turns) {
        await this.yieldToCapture(signal);
        if (signal.aborted) throw new Error("cancelled");
        const grid = toolkit.windowGrid([t]).filter((g) => !windows.some((w) => Math.abs(w.startSample - g.startSample) < SAMPLE_RATE / 2));
        if (!grid.length) continue;
        const inputs = await Promise.all(grid.map(async (range) => ({ range, samples: await this.deps.audio.readRange(rec.id, range) })));
        for (const e of await toolkit.embed(rec.models.speakerEmbedding, inputs)) {
          const w: VoiceWindow = { id: newId("win"), recordingId: rec.id, clusterId: t.clusterId, startSample: e.startSample, endSample: e.endSample, embeddingSpace: e.embeddingSpace, quality: e.quality, sealedVector: await identity.sealVector(e.vector) };
          windows.push(w);
          await repo.putWindows([w]);
        }
      }
    }
    if (!windows.length) return { status: "skipped", note: "no local voice evidence for Soniox speakers" };
    const byCluster = new Map<ClusterId, Float32Array[]>();
    for (const w of windows) byCluster.set(w.clusterId, [...(byCluster.get(w.clusterId) ?? []), await identity.openVector(w.sealedVector)]);
    const centroids = [...byCluster.entries()].map(([id, vs]) => ({ id, c: meanVector(vs), n: vs.length })).sort((a, b) => b.n - a.n);
    const threshold = toolkit.mergeThreshold(space);
    let merges = 0;
    for (let i = 0; i < centroids.length; i++) {
      for (let j = 0; j < i; j++) {
        const a = centroids[j]!, b = centroids[i]!;
        if (clusters.get(a.id)?.mergedInto || clusters.get(b.id)?.mergedInto) continue;
        if (cosine(a.c, b.c) >= threshold) {
          const c = clusters.get(b.id);
          if (c) {
            clusters.set(b.id, { ...c, mergedInto: a.id });
            await repo.putCluster(clusters.get(b.id)!);
            merges++;
          }
        }
      }
    }
    return { status: "done", note: `${windows.length} local windows, ${merges} speaker labels linked across runs` };
  }

  private async identify(rec: Recording): Promise<{ status: StageStatus; note?: string }> {
    const decisions = await this.deps.identity.identifyRecording(rec.id);
    const accepted = decisions.filter((d) => d.status === "accepted").length;
    return { status: "done", note: `${accepted} of ${decisions.length} speakers recognized` };
  }

  private async summarize(rec: Recording, signal: AbortSignal): Promise<{ status: StageStatus; note?: string }> {
    const { repo, toolkit } = this.deps;
    const choice = rec.models.summary;
    if (choice === "off") {
      await repo.putSummary({ recordingId: rec.id, status: "off", summary: null, providerId: null, transcriptRevision: rec.transcriptRevision, error: null, updatedAt: nowIso() });
      return { status: "skipped", note: "summary off" };
    }
    const provider = toolkit.summaryProvider(choice);
    if (!provider) throw new Error(`summary model ${choice} unavailable`);
    const { segments, clusters } = await loadTranscript(repo, rec.id);
    if (!segments.length) {
      await repo.putSummary({ recordingId: rec.id, status: "failed", summary: null, providerId: provider.id, transcriptRevision: rec.transcriptRevision, error: "transcript is empty", updatedAt: nowIso() });
      return { status: "skipped", note: "empty transcript" };
    }
    const people = new Map<string, Person>((await repo.listPeople()).map((p) => [p.id, p]));
    const attributions = activeAttributions(await repo.listAttributions(rec.id));
    const names = new Map<ClusterId, string>();
    for (const id of new Set(segments.map((s) => s.clusterId).filter((x): x is string => !!x))) names.set(id, speakerLabel(id, clusters, attributions, people).text);
    await repo.putSummary({ recordingId: rec.id, status: "running", summary: null, providerId: provider.id, transcriptRevision: rec.transcriptRevision, error: null, updatedAt: nowIso() });
    const summary = await provider.summarize({
      recordingId: rec.id, language: rec.language, transcriptRevision: rec.transcriptRevision, segments, speakerNames: names, signal,
      onProgress: (f, note) => this.events.emit({ recordingId: rec.id, stage: "summary", status: "running", progress: f, note }),
    });
    await repo.putSummary({ recordingId: rec.id, status: "ready", summary, providerId: provider.id, transcriptRevision: rec.transcriptRevision, error: null, updatedAt: nowIso() });
    await repo.updateRecording(rec.id, (r) => ({ title: r.title ?? summary.title, modelVersions: { ...r.modelVersions, summary: String(choice) } }));
    return { status: "done" };
  }

  /** Non-persisted audio is removed; persisted audio is compressed to Opus or deleted per retention settings. */
  private async retainAudio(rec: Recording): Promise<{ status: StageStatus; note?: string }> {
    const { repo, blobs, settings } = this.deps;
    if (rec.audioRetention === "deleted") return { status: "skipped", note: "no audio" };
    if (rec.audioRetention === "ephemeral" || settings.get().deleteAudioAfterProcessing) {
      await deleteAudio(repo, blobs, rec.id);
      this.deps.ephemeral.drop(rec.id);
      return { status: "done", note: rec.audioRetention === "ephemeral" ? "non-persisted audio removed" : "audio deleted after processing" };
    }
    if (!(await opusEncoderRate())) return { status: "skipped", note: "Opus unavailable; keeping PCM" };
    let saved = 0;
    for (const c of await repo.listChunks(rec.id)) {
      if (c.codec === "opus") continue;
      const samples = await this.deps.audio.decodeChunk(c);
      const opus = await encodeOpus(samples);
      const sealed = await this.deps.durable.seal(opus);
      const path = chunkPath(rec.id, c.sequence, "durable", "opus");
      const checksum = await writeVerified(blobs, path, sealed);
      await repo.putChunk({ ...c, codec: "opus", path, byteLength: sealed.byteLength, checksum, verified: true });
      // Raw chunk removed only after the compressed chunk verified.
      await blobs.delete(c.path);
      saved += c.byteLength - sealed.byteLength;
    }
    return { status: "done", note: `saved ${(saved / 2 ** 20).toFixed(1)} MiB` };
  }
}

export async function deleteAudio(repo: Repository, blobs: BlobStore, recordingId: string): Promise<void> {
  const chunks = await repo.listChunks(recordingId);
  for (const c of chunks) await blobs.delete(c.path);
  await blobs.deletePrefix(`rec/${recordingId}/`);
  await blobs.deletePrefix(`scratch/${recordingId}/`);
  await repo.deleteChunks(recordingId);
  await repo.updateRecording(recordingId, { audioRetention: "deleted" });
}

function countOf(labels: readonly number[], l: number): number {
  return labels.reduce((n, x) => n + (x === l ? 1 : 0), 0);
}

export function groupRegions(regions: readonly TimeRange[], maxSamples: number): TimeRange[] {
  const pad = Math.round(SAMPLE_RATE * 0.2);
  const out: TimeRange[] = [];
  for (const r of regions) {
    // Very long speech regions are cut into consecutive windows.
    for (let s = r.startSample; s < r.endSample; s += maxSamples) {
      const piece = { startSample: Math.max(0, s - pad), endSample: Math.min(r.endSample, s + maxSamples) + pad };
      const last = out[out.length - 1];
      if (last && piece.endSample - last.startSample <= maxSamples && piece.startSample - last.endSample < 2 * SAMPLE_RATE) last.endSample = piece.endSample;
      else out.push(piece);
    }
  }
  return out;
}

/** Consecutive same-cluster windows become turns; boundaries fall midway between differing windows. */
export function windowsToTurns(recordingId: string, runId: string, windows: readonly VoiceWindow[], speech: readonly TimeRange[] | null): SpeakerTurn[] {
  const sorted = [...windows].sort((a, b) => a.startSample - b.startSample);
  const turns: SpeakerTurn[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const w = sorted[i]!;
    const prev = sorted[i - 1];
    const next = sorted[i + 1];
    const start = prev && prev.endSample > w.startSample ? Math.round((w.startSample + prev.endSample) / 2) : w.startSample;
    const end = next && next.startSample < w.endSample ? Math.round((next.startSample + w.endSample) / 2) : w.endSample;
    const last = turns[turns.length - 1];
    if (last && last.clusterId === w.clusterId && start - last.endSample < SAMPLE_RATE) last.endSample = Math.max(last.endSample, end);
    else turns.push({ id: newId("turn"), recordingId, providerRunId: runId, clusterId: w.clusterId, startSample: start, endSample: end, final: true, confidence: w.quality });
  }
  if (!speech) return turns;
  // Extend turns to cover whole speech regions they overlap, so short leading/trailing words attach.
  for (const region of speech) {
    const inside = turns.filter((t) => t.endSample > region.startSample && t.startSample < region.endSample);
    if (!inside.length) continue;
    inside[0]!.startSample = Math.min(inside[0]!.startSample, region.startSample);
    inside[inside.length - 1]!.endSample = Math.max(inside[inside.length - 1]!.endSample, region.endSample);
  }
  return turns;
}
