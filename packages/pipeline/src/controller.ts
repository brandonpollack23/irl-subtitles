import {
  canTransition,
  Emitter,
  emptyProcessing,
  errorMessage,
  newId,
  nowIso,
  pcmToFloat32,
  providerKindFor,
  recordingLiveOption,
  selectionLocks,
  rmsDbfs,
  type ClusterId,
  type LiveSpeechProvider,
  type MatchDecision,
  type ProviderKind,
  type Recording,
  type RecordingState,
  type SpeakerCluster,
  type TranscriptSegment,
} from "@irl/domain";
import { ChunkRecorder, FrameSequencer, type AudioSource } from "@irl/capture";
import { ephemeralSealer, type BlobStore, type Repository, type Sealer, type SettingsStore } from "@irl/storage";
import { ProviderCoordinator } from "./coordinator";
import type { IdentityService } from "./identity-service";

export interface LiveSnapshot {
  recordingId: string | null;
  state: RecordingState | "idle";
  provider: ProviderKind;
  persistAudio: boolean;
  sourceLabel: string;
  capturedSamples: number;
  levelDbfs: number;
  speechActive: boolean;
  segments: TranscriptSegment[];
  provisionalText: string;
  currentClusterId: ClusterId | null;
  clusters: SpeakerCluster[];
  /** Latest live match decision per cluster, for the match readout. */
  matches: MatchDecision[];
  degraded: string | null;
  gaps: number;
  markers: number;
  pendingChunks: number;
  error: string | null;
  /** Bumped on identity changes so views re-resolve names. */
  labelsVersion: number;
}

export function idleSnapshot(provider: ProviderKind, persistAudio: boolean): LiveSnapshot {
  return {
    recordingId: null, state: "idle", provider, persistAudio, sourceLabel: "", capturedSamples: 0, levelDbfs: -Infinity, speechActive: false, segments: [],
    provisionalText: "", currentClusterId: null, clusters: [], matches: [], degraded: null, gaps: 0, markers: 0, pendingChunks: 0, error: null, labelsVersion: 0,
  };
}

/** In-memory keys for non-persisted recordings; lost on process death by design. */
export class EphemeralKeys {
  private keys = new Map<string, Sealer>();
  get(recordingId: string): Sealer | null {
    return this.keys.get(recordingId) ?? null;
  }
  set(recordingId: string, sealer: Sealer): void {
    this.keys.set(recordingId, sealer);
  }
  drop(recordingId: string): void {
    this.keys.delete(recordingId);
  }
}

export interface ControllerDeps {
  repo: Repository;
  blobs: BlobStore;
  durable: Sealer;
  ephemeral: EphemeralKeys;
  settings: SettingsStore;
  identity: IdentityService;
  /** The live provider for a recording's live option: a cloud option id, or "local" for on-device models. */
  providers: (optionId: string) => Promise<LiveSpeechProvider>;
  createSource: () => Promise<AudioSource>;
  /** Called with the recording id once capture has stopped and audio is flushed. */
  onCaptured: (recordingId: string) => void;
  modelVersions?: () => Record<string, string>;
}

interface Active {
  recording: Recording;
  source: AudioSource;
  sequencer: FrameSequencer;
  recorder: ChunkRecorder;
  coordinator: ProviderCoordinator | null;
  sawAudio: boolean;
  heartbeat: ReturnType<typeof setInterval>;
}

/**
 * Recording lifecycle (plan.md §9, irl-subt-2z2.4): starting → recording ⇄ paused → finalizing. Audio is
 * persisted before and independently of any provider; provider failure never stops capture.
 */
export class RecordingController {
  readonly live = new Emitter<LiveSnapshot>();
  private snapshot: LiveSnapshot;
  private active: Active | null = null;
  private busy: Promise<unknown> = Promise.resolve();
  private levelAt = 0;

  constructor(private readonly deps: ControllerDeps) {
    const s = deps.settings.get();
    this.snapshot = idleSnapshot(providerKindFor(s.models), s.persistAudio);
    deps.settings.changes.on((next) => {
      if (!this.active) this.update({ provider: providerKindFor(next.models), persistAudio: next.persistAudio });
    });
    deps.identity.changes.on(() => this.update({ labelsVersion: this.snapshot.labelsVersion + 1 }));
  }

  get current(): LiveSnapshot {
    return this.snapshot;
  }

  get activeRecordingId(): string | null {
    return this.active?.recording.id ?? null;
  }

  private update(patch: Partial<LiveSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.live.emit(this.snapshot);
  }

  /** Actions are serialized so a double-tap on the glasses can't interleave start/stop. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.busy.then(fn, fn);
    this.busy = next.catch(() => undefined);
    return next;
  }

  private async setState(state: RecordingState, extra: Partial<Recording> = {}): Promise<void> {
    const a = this.active;
    if (!a) return;
    if (!canTransition(a.recording.state, state)) throw new Error(`invalid transition ${a.recording.state} → ${state}`);
    a.recording = await this.deps.repo.updateRecording(a.recording.id, { state, ...extra });
    this.update({ state });
  }

  start(opts: { persistAudio?: boolean; source?: AudioSource } = {}): Promise<string> {
    return this.serial(async () => {
      if (this.active) throw new Error("A recording is already in progress");
      const settings = this.deps.settings.get();
      const persist = opts.persistAudio ?? settings.persistAudio;
      const id = newId("rec");
      const sealer = persist ? this.deps.durable : await ephemeralSealer();
      if (!persist) this.deps.ephemeral.set(id, sealer);
      const recording: Recording = {
        id, createdAt: nowIso(), startedAt: null, endedAt: null, state: "starting", audioRetention: persist ? "persisted" : "ephemeral",
        language: settings.language, provider: providerKindFor(settings.models), models: { ...settings.models }, selection: { locks: selectionLocks(settings.models) }, modelVersions: this.deps.modelVersions?.() ?? {},
        totalSamples: 0, recoveryCursor: 0, title: null, markers: [], processing: emptyProcessing(), transcriptRevision: 0, degraded: null, gaps: 0, error: null,
      };
      if (recording.models.sttLive === "off") recording.processing.liveStt = { status: "skipped" };
      await this.deps.repo.putRecording(recording);

      const source = opts.source ?? (await this.deps.createSource());
      const sequencer = new FrameSequencer(id);
      const recorder = new ChunkRecorder({
        repo: this.deps.repo, blobs: this.deps.blobs, sealer, recordingId: id,
        onError: (m) => this.update({ error: m }),
        onChunk: (c) => this.update({ pendingChunks: c.pendingChunks }),
      });
      const heartbeat = setInterval(() => void this.heartbeat(), 5000);
      this.active = { recording, source, sequencer, recorder, coordinator: null, sawAudio: false, heartbeat };
      this.update({ ...idleSnapshot(recording.provider, persist), recordingId: id, state: "starting", sourceLabel: source.label, labelsVersion: this.snapshot.labelsVersion });

      // The chunk recorder is live before any provider connection (plan.md §9 step 4).
      try {
        await source.start((pcm) => this.onPcm(pcm));
      } catch (e) {
        clearInterval(heartbeat);
        await this.deps.repo.updateRecording(id, { state: "failed", error: errorMessage(e), endedAt: nowIso() });
        this.deps.ephemeral.drop(id);
        this.active = null;
        this.update({ ...idleSnapshot(providerKindFor(settings.models), settings.persistAudio), error: `Could not start capture: ${errorMessage(e)}` });
        throw e;
      }
      void this.startProcessing(recording);
      return id;
    });
  }

  private async startProcessing(recording: Recording): Promise<void> {
    const a = this.active;
    if (!a) return;
    try {
      const provider = await this.deps.providers(recordingLiveOption(recording)?.id ?? "local");
      if (this.active !== a) return;
      const coordinator = new ProviderCoordinator(this.deps.repo, recording, provider, this.deps.identity, (u) => {
        if (this.active === a) this.update({ ...u });
      });
      a.coordinator = coordinator;
      await coordinator.start();
      await this.deps.repo.updateRecording(recording.id, (r) => ({ processing: { ...r.processing, liveStt: { status: r.models.sttLive === "off" ? "skipped" : "running", updatedAt: nowIso() } } }));
    } catch (e) {
      this.update({ degraded: `Saving — processing later (${errorMessage(e)})` });
      await this.deps.repo.updateRecording(recording.id, { degraded: `live processing unavailable: ${errorMessage(e)}` });
    }
  }

  private onPcm(pcm: Uint8Array): void {
    const a = this.active;
    if (!a || a.recording.state === "paused" || a.recording.state === "finalizing") return;
    const pushed = a.sequencer.push(pcm);
    if (!pushed) return;
    a.recorder.push(pushed.frame);
    a.coordinator?.push(pushed.frame);
    if (!a.sawAudio) {
      a.sawAudio = true;
      // Durable capture is flowing: only now is the session "recording" (plan.md §9 step 6).
      void this.serial(() => this.setState("recording", { startedAt: nowIso() }));
    }
    const now = performance.now();
    const patch: Partial<LiveSnapshot> = { capturedSamples: a.sequencer.nextSample, gaps: a.sequencer.gaps };
    if (now - this.levelAt > 250) {
      this.levelAt = now;
      patch.levelDbfs = Math.round(rmsDbfs(pcmToFloat32(pushed.frame.pcm)));
    }
    this.update(patch);
  }

  private async heartbeat(): Promise<void> {
    const a = this.active;
    if (!a) return;
    await this.deps.repo.updateRecording(a.recording.id, (r) => ({ totalSamples: Math.max(r.totalSamples, a.sequencer.nextSample), gaps: a.sequencer.gaps })).catch(() => undefined);
  }

  pause(): Promise<void> {
    return this.serial(async () => {
      const a = this.active;
      if (!a || a.recording.state !== "recording") return;
      await this.setState("paused");
      await a.source.stop();
      a.sequencer.resetClock();
    });
  }

  resume(): Promise<void> {
    return this.serial(async () => {
      const a = this.active;
      if (!a || a.recording.state !== "paused") return;
      a.sequencer.resetClock();
      await a.source.start((pcm) => this.onPcm(pcm));
      await this.setState("recording");
    });
  }

  addMarker(label = "Marker"): Promise<void> {
    return this.serial(async () => {
      const a = this.active;
      if (!a) return;
      const marker = { sample: a.sequencer.nextSample, label, createdAt: nowIso() };
      a.recording = await this.deps.repo.updateRecording(a.recording.id, (r) => ({ markers: [...r.markers, marker] }));
      this.update({ markers: a.recording.markers.length });
    });
  }

  /** Stop and summarize: stop the mic, flush and verify the last chunk, finish providers, hand off. */
  stop(): Promise<string | null> {
    return this.serial(async () => {
      const a = this.active;
      if (!a) return null;
      const id = a.recording.id;
      if (a.recording.state === "starting") a.recording = await this.deps.repo.updateRecording(id, { state: "recording" });
      this.update({ state: "finalizing" });
      clearInterval(a.heartbeat);
      await a.source.stop().catch(() => undefined);
      await a.recorder.flush();
      await a.coordinator?.finish().catch((e) => this.update({ error: errorMessage(e) }));
      const liveStatus = a.coordinator ? "done" : a.recording.models.sttLive === "off" ? "skipped" : "failed";
      await this.setState("finalizing", {
        endedAt: nowIso(), totalSamples: a.sequencer.nextSample, gaps: a.sequencer.gaps,
        processing: { ...a.recording.processing, liveStt: { status: a.recording.processing.liveStt.status === "skipped" ? "skipped" : liveStatus, updatedAt: nowIso() } },
      });
      this.active = null;
      const s = this.deps.settings.get();
      this.update({ ...idleSnapshot(providerKindFor(s.models), s.persistAudio), labelsVersion: this.snapshot.labelsVersion });
      this.deps.onCaptured(id);
      return id;
    });
  }

  /** Glasses "Save audio" toggle: changes the default for the next recording only. */
  async setPersistAudio(persist: boolean): Promise<void> {
    if (this.active) throw new Error("Audio saving can be changed between recordings");
    await this.deps.settings.update({ persistAudio: persist });
  }
}
