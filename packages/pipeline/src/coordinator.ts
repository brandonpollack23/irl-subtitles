import {
  errorMessage,
  isVoiceIdOption,
  newId,
  nowIso,
  rangeDurationMs,
  type AudioFrame,
  type ClusterId,
  type LiveSpeechProvider,
  type LiveSpeechRun,
  type MatchDecision,
  type Recording,
  type SpeakerCluster,
  type SpeakerTurn,
  type SpeechEvent,
  type TranscriptSegment,
  type TranscriptToken,
  type VoiceWindow,
} from "@irl/domain";
import type { Repository } from "@irl/storage";
import type { IdentityService } from "./identity-service";
import { reconcile, selectTokens } from "./reconciler";

export interface CoordinatorUpdate {
  segments: TranscriptSegment[];
  provisionalText: string;
  currentClusterId: ClusterId | null;
  speechActive: boolean;
  degraded: string | null;
  clusters: SpeakerCluster[];
  /** Latest live match decision per cluster (scores, evidence, why a name was withheld), for match tuning. */
  matches: MatchDecision[];
  error: string | null;
}

const MAX_RESTARTS = 3;
const LIVE_ID_INTERVAL_MS = 10_000;
/**
 * A cluster with no live name or candidate yet is checked as each of its first windows arrives, so a short
 * utterance gets a name before the next tick; past this many windows the tick alone keeps checking it.
 */
const LIVE_ID_EAGER_WINDOWS = 8;

/**
 * plan.md §4 ProviderCoordinator for one recording: owns the canonical sample clock the frames already
 * carry, fans frames to the selected live provider, normalizes and persists its events (final tokens and
 * turns immediately, provisional text in memory), restarts a failed provider, and never lets processing
 * failures reach capture.
 */
export class ProviderCoordinator {
  private run: LiveSpeechRun | null = null;
  private restarts = 0;
  private tokens = new Map<string, TranscriptToken>();
  private turns = new Map<string, SpeakerTurn>();
  private clusters = new Map<ClusterId, SpeakerCluster>();
  private windowsByCluster = new Map<ClusterId, VoiceWindow[]>();
  private pendingTokens: TranscriptToken[] = [];
  private pendingTurns: SpeakerTurn[] = [];
  private pendingWindows: VoiceWindow[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private liveIdTimer: ReturnType<typeof setInterval> | null = null;
  /** Clusters whose last live decision named them or found a candidate. */
  private identified = new Set<ClusterId>();
  private identifyQueued = new Set<ClusterId>();
  private matches = new Map<ClusterId, MatchDecision>();
  /** Live identification runs one cluster at a time, so a tick and a new window never write the same row at once. */
  private identifyTail: Promise<void> = Promise.resolve();
  private speechActive = false;
  private degraded: string | null = null;
  private error: string | null = null;
  private currentCluster: ClusterId | null = null;
  private emitScheduled = false;
  private pumps: Promise<void>[] = [];
  private finished = false;
  /** Speechmatics voice ID: the service names enrolled voices; local matching doesn't run. */
  private readonly serviceVoices: boolean;
  private serviceIdentifiers: { clusterId: ClusterId; identifiers: string[] }[] = [];
  readonly runIds: string[] = [];

  constructor(
    private readonly repo: Repository,
    private readonly recording: Recording,
    private readonly provider: LiveSpeechProvider,
    private readonly identity: IdentityService,
    private readonly onUpdate: (u: CoordinatorUpdate) => void,
  ) {
    this.serviceVoices = isVoiceIdOption(recording.models.speakerEmbedding);
  }

  async start(): Promise<void> {
    this.flushTimer = setInterval(() => void this.flush(), 1000);
    this.liveIdTimer = setInterval(() => this.liveIdentify(), LIVE_ID_INTERVAL_MS);
    await this.startRun();
  }

  private async startRun(): Promise<void> {
    const providerRunId = newId("run");
    const r = this.recording;
    await this.repo.putRun({ id: providerRunId, recordingId: r.id, provider: this.provider.id, kind: "live", config: { models: r.models, language: r.language }, startedAt: nowIso(), endedAt: null, state: "running", error: null, resume: null });
    this.runIds.push(providerRunId);
    try {
      this.run = await this.provider.start({
        recordingId: r.id, providerRunId, language: r.language, modelId: r.models.sttLive, sttModelId: r.models.sttLive,
        embeddingModelId: r.models.speakerEmbedding, vadModelId: r.models.vad,
      });
    } catch (e) {
      await this.repo.updateRun(providerRunId, { state: "failed", error: errorMessage(e), endedAt: nowIso() });
      this.setDegraded(`Saving — processing later (${errorMessage(e)})`);
      this.run = null;
      return;
    }
    const run = this.run;
    this.pumps.push(this.pump(run));
  }

  private async pump(run: LiveSpeechRun): Promise<void> {
    try {
      for await (const ev of run.events) this.handle(ev);
      await this.repo.updateRun(run.providerRunId, { state: "finished", endedAt: nowIso() });
    } catch (e) {
      await this.repo.updateRun(run.providerRunId, { state: "failed", error: errorMessage(e), endedAt: nowIso() });
      await this.onRunFailure(run, errorMessage(e));
    }
  }

  private async onRunFailure(run: LiveSpeechRun, message: string): Promise<void> {
    if (this.run !== run || this.finished) return;
    this.run = null;
    if (this.restarts++ < MAX_RESTARTS) {
      this.setDegraded(`Restarting live processing (${message})`);
      await this.startRun();
      if (this.run) this.setDegraded(null);
    } else {
      this.setDegraded("Saving — processing later");
    }
  }

  push(frame: AudioFrame): void {
    if (!this.run) return;
    try {
      this.run.push(frame);
    } catch (e) {
      void this.onRunFailure(this.run, errorMessage(e));
    }
  }

  private handle(ev: SpeechEvent): void {
    switch (ev.type) {
      case "tokens": {
        if (ev.replaceProvisional) {
          // One live run is active at a time, so its provisional set is replaced wholesale (even by an empty set).
          for (const [id, t] of this.tokens) if (!t.final) this.tokens.delete(id);
        }
        for (const t of ev.tokens) {
          this.tokens.set(t.id, t);
          if (t.final) this.pendingTokens.push(t);
        }
        break;
      }
      case "turns":
        for (const t of ev.turns) {
          this.turns.set(t.id, t);
          if (t.final) this.pendingTurns.push(t);
          this.currentCluster = t.clusterId;
        }
        break;
      case "cluster": {
        const c: SpeakerCluster = { recordingId: this.recording.id, clusterId: ev.clusterId, ordinal: ev.ordinal, evidenceMs: 0, ...(ev.providerLabel ? { providerLabel: ev.providerLabel } : {}) };
        this.clusters.set(c.clusterId, { ...c, ...this.clusters.get(c.clusterId) });
        const stored = this.repo.putCluster(this.clusters.get(c.clusterId)!);
        if (this.serviceVoices && ev.providerLabel) {
          const label = ev.providerLabel;
          void stored.then(() => this.identifyByService(ev.clusterId, label));
        }
        break;
      }
      case "window": {
        void this.identity.sealVector(ev.embedding.vector).then((sealedVector) => {
          const w: VoiceWindow = { id: newId("win"), recordingId: this.recording.id, clusterId: ev.clusterId, startSample: ev.embedding.startSample, endSample: ev.embedding.endSample, embeddingSpace: ev.embedding.embeddingSpace, quality: ev.embedding.quality, sealedVector };
          this.pendingWindows.push(w);
          this.windowsByCluster.set(ev.clusterId, [...(this.windowsByCluster.get(ev.clusterId) ?? []), w]);
          const c = this.clusters.get(ev.clusterId);
          if (c) this.clusters.set(ev.clusterId, { ...c, evidenceMs: c.evidenceMs + rangeDurationMs(w) });
          const count = this.windowsByCluster.get(ev.clusterId)!.length;
          if (!this.serviceVoices && !this.identified.has(ev.clusterId) && count <= LIVE_ID_EAGER_WINDOWS) this.identifySoon(ev.clusterId);
        });
        break;
      }
      case "speech":
        this.speechActive = ev.active;
        break;
      case "speakers":
        this.serviceIdentifiers.push(...ev.speakers);
        return;
      case "degraded":
        this.setDegraded(ev.reason);
        return;
      case "error":
        this.error = ev.message;
        if (ev.fatal && this.run) void this.onRunFailure(this.run, ev.message);
        break;
    }
    this.scheduleEmit();
  }

  private setDegraded(reason: string | null): void {
    this.degraded = reason;
    void this.repo.updateRecording(this.recording.id, { degraded: reason }).catch(() => undefined);
    this.scheduleEmit();
  }

  private scheduleEmit(): void {
    if (this.emitScheduled) return;
    this.emitScheduled = true;
    setTimeout(() => {
      this.emitScheduled = false;
      this.emit();
    }, 150);
  }

  private emit(): void {
    const tokens = selectTokens([...this.tokens.values()], new Set());
    const finals = tokens.filter((t) => t.final);
    const provisional = tokens.filter((t) => !t.final);
    const segments = reconcile({ tokens: finals, turns: [...this.turns.values()], clusters: this.clusters });
    this.onUpdate({
      segments: segments.slice(-60),
      provisionalText: provisional.map((t) => t.text).join("").trim(),
      currentClusterId: this.currentCluster,
      speechActive: this.speechActive,
      degraded: this.degraded,
      clusters: [...this.clusters.values()],
      matches: [...this.matches.values()],
      error: this.error,
    });
  }

  private async flush(): Promise<void> {
    const tokens = this.pendingTokens.splice(0);
    const turns = this.pendingTurns.splice(0);
    const windows = this.pendingWindows.splice(0);
    try {
      if (tokens.length) await this.repo.putTokens(tokens);
      if (turns.length) await this.repo.putTurns(turns);
      if (windows.length) await this.repo.putWindows(windows);
      for (const c of this.clusters.values()) await this.repo.putCluster(c);
    } catch (e) {
      // Keep them for the next flush; storage trouble must not break live processing.
      this.pendingTokens.unshift(...tokens);
      this.pendingTurns.unshift(...turns);
      this.pendingWindows.unshift(...windows);
      this.error = `saving transcript failed: ${errorMessage(e)}`;
    }
  }

  /** Live name updates (plan.md §2, irl-subt-f9n.7): conservative matching on clusters with enough evidence. */
  private liveIdentify(): void {
    if (this.serviceVoices) return;
    for (const [clusterId, windows] of this.windowsByCluster) if (windows.length >= 3) this.identifySoon(clusterId);
  }

  private identifySoon(clusterId: ClusterId): void {
    if (this.finished || this.identifyQueued.has(clusterId)) return;
    this.identifyQueued.add(clusterId);
    this.identifyTail = this.identifyTail.then(async () => {
      this.identifyQueued.delete(clusterId);
      await this.identifyCluster(clusterId);
      this.scheduleEmit();
    });
  }

  /** A cluster the service labeled with a saved person's token is named at once (the glasses show it live). */
  private identifyByService(clusterId: ClusterId, providerLabel: string): void {
    this.identifyTail = this.identifyTail.then(async () => {
      try {
        const d = await this.identity.serviceDecision(clusterId, providerLabel);
        if (!d) return;
        this.matches.set(clusterId, d);
        this.identified.add(clusterId);
        await this.identity.applyDecision(this.recording.id, d);
        this.scheduleEmit();
      } catch {
        /* identification is best-effort during capture */
      }
    });
  }

  private async identifyCluster(clusterId: ClusterId): Promise<void> {
    const windows = this.windowsByCluster.get(clusterId);
    if (!windows?.length) return;
    try {
      const d = await this.identity.evaluateCluster(this.recording.id, clusterId, windows);
      if (!d) return;
      this.matches.set(clusterId, d);
      // Nothing to show or undo: skip the write and the identity change it would announce.
      if (d.status === "rejected" && !this.identified.has(clusterId)) return;
      if (d.status === "rejected") this.identified.delete(clusterId);
      else this.identified.add(clusterId);
      const written = await this.identity.applyDecision(this.recording.id, d);
      // Flushes write our copy of the cluster, so take the candidate ("Possibly X") from the stored row, or it is
      // overwritten within a second and never reaches the live labels.
      const c = this.clusters.get(clusterId);
      if (written && c) {
        const { candidatePersonId: _p, candidateScore: _s, ...rest } = c;
        this.clusters.set(clusterId, written.candidatePersonId ? { ...rest, candidatePersonId: written.candidatePersonId, ...(written.candidateScore !== undefined ? { candidateScore: written.candidateScore } : {}) } : rest);
      }
    } catch {
      /* identification is best-effort during capture */
    }
  }

  async finish(timeoutMs = 60_000): Promise<void> {
    this.finished = true;
    if (this.liveIdTimer) clearInterval(this.liveIdTimer);
    const run = this.run;
    if (run) {
      await Promise.race([run.finish().catch(() => undefined), new Promise((ok) => setTimeout(ok, timeoutMs))]);
      await Promise.race([Promise.all(this.pumps), new Promise((ok) => setTimeout(ok, 5_000))]);
    }
    // Let pending window sealing promises settle before the last flush, and live identification land before
    // post-processing takes the clusters over.
    await new Promise((ok) => setTimeout(ok, 50));
    await Promise.race([this.identifyTail, new Promise((ok) => setTimeout(ok, 5_000))]);
    if (this.flushTimer) clearInterval(this.flushTimer);
    await this.flush();
    if (this.serviceIdentifiers.length) await this.identity.storeServiceIdentifiers(this.recording.id, this.serviceIdentifiers).catch(() => undefined);
    this.emit();
  }

  async abort(reason: string): Promise<void> {
    this.finished = true;
    if (this.liveIdTimer) clearInterval(this.liveIdTimer);
    if (this.flushTimer) clearInterval(this.flushTimer);
    await this.run?.abort(reason).catch(() => undefined);
    await this.flush();
  }
}
