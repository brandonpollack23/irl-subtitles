import type { RecordingId } from "./audio";
import type { UserErrorCode } from "./errors";
import type { ModelSelection } from "./models";
import { ROLE_KEYS, SERVICE_NAMES, serviceOption, selectionLocks, type CloudService, type SelectionLocks } from "./selection";
import type { Marker } from "./transcript";

/**
 * plan.md §9: starting → recording ⇄ paused → finalizing → captured → ready.
 * `interrupted` is a recovered session awaiting Finish processing / Discard.
 */
export type RecordingState =
  | "starting"
  | "recording"
  | "paused"
  | "finalizing"
  | "captured"
  | "ready"
  | "interrupted"
  | "failed";

const TRANSITIONS: Record<RecordingState, readonly RecordingState[]> = {
  starting: ["recording", "failed", "interrupted"],
  recording: ["paused", "finalizing", "interrupted"],
  paused: ["recording", "finalizing", "interrupted"],
  finalizing: ["captured", "failed", "interrupted"],
  captured: ["ready", "failed", "finalizing"],
  ready: ["finalizing", "captured"],
  interrupted: ["finalizing", "failed"],
  failed: ["finalizing"],
};

export function canTransition(from: RecordingState, to: RecordingState): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

/** States that mean a previous launch never finished the session (crash recovery candidates). */
export const UNFINISHED_STATES: readonly RecordingState[] = ["starting", "recording", "paused", "finalizing"];

export type StageStatus = "pending" | "running" | "done" | "failed" | "skipped";

export type ProcessingStage = "liveStt" | "finalStt" | "diarization" | "identity" | "summary" | "compression";

export type ProcessingStatus = Record<
  ProcessingStage,
  { status: StageStatus; error?: string; errorCode?: UserErrorCode; errorService?: CloudService; note?: StageNote; updatedAt?: string }
>;

/** What a processing stage is doing or did, as a code the UI renders; stageNoteText gives English for logs. */
export type StageNote =
  | { code: "detecting-speech" }
  | { code: "embedding-voices" }
  | { code: "uploading"; service: CloudService }
  | { code: "waiting"; service: CloudService }
  | { code: "fetching" }
  | { code: "summarizing"; parts: number }
  | { code: "summary-part"; part: number; parts: number }
  | { code: "sending-transcript" }
  | { code: "validating" }
  | { code: "final-tokens"; service: CloudService }
  | { code: "no-model" }
  | { code: "same-as-live" }
  | { code: "audio-unavailable" }
  | { code: "words"; words: number; speakers?: number; service?: CloudService; language?: string }
  | { code: "service-speakers"; service: CloudService }
  | { code: "no-speech" }
  | { code: "no-voice-windows" }
  | { code: "speakers"; speakers: number; windows: number }
  | { code: "no-local-evidence" }
  | { code: "labels-linked"; windows: number; merges: number }
  | { code: "recognized"; recognized: number; total?: number; service?: CloudService }
  | { code: "summary-off" }
  | { code: "empty-transcript" }
  | { code: "no-audio" }
  | { code: "audio-removed"; ephemeral: boolean }
  | { code: "keeping-pcm" }
  | { code: "compressed"; mib: number };

export function stageNoteText(n: StageNote): string {
  switch (n.code) {
    case "detecting-speech":
      return "detecting speech";
    case "embedding-voices":
      return "embedding voices";
    case "uploading":
      return `uploading audio to ${SERVICE_NAMES[n.service]}`;
    case "waiting":
      return `waiting for ${SERVICE_NAMES[n.service]}`;
    case "fetching":
      return "fetching the transcript";
    case "summarizing":
      return `summarizing ${n.parts} part${n.parts === 1 ? "" : "s"}`;
    case "summary-part":
      return `part ${n.part} of ${n.parts}`;
    case "sending-transcript":
      return "sending transcript";
    case "validating":
      return "validating";
    case "final-tokens":
      return `${SERVICE_NAMES[n.service]} final tokens are the transcript`;
    case "no-model":
      return "no STT model selected";
    case "same-as-live":
      return "same as live";
    case "audio-unavailable":
      return "audio unavailable";
    case "words":
      return `${n.words} words${n.speakers !== undefined ? `, ${n.speakers} speakers` : ""}${n.service ? ` from ${SERVICE_NAMES[n.service]}` : ""}${n.language ? `, language ${n.language}` : ""}`;
    case "service-speakers":
      return `speakers from ${SERVICE_NAMES[n.service]}`;
    case "no-speech":
      return "no speech found";
    case "no-voice-windows":
      return "no voice windows and audio unavailable";
    case "speakers":
      return `${n.speakers} speakers from ${n.windows} windows`;
    case "no-local-evidence":
      return "no local voice evidence for the service's speakers";
    case "labels-linked":
      return `${n.windows} local windows, ${n.merges} speaker labels linked across runs`;
    case "recognized":
      return n.service ? `${n.recognized} speakers recognized by ${SERVICE_NAMES[n.service]}` : `${n.recognized} of ${n.total ?? n.recognized} speakers recognized`;
    case "summary-off":
      return "summary off";
    case "empty-transcript":
      return "empty transcript";
    case "no-audio":
      return "no audio";
    case "audio-removed":
      return n.ephemeral ? "non-persisted audio removed" : "audio deleted after processing";
    case "keeping-pcm":
      return "Opus unavailable; keeping PCM";
    case "compressed":
      return `saved ${n.mib.toFixed(1)} MiB`;
  }
}

export function emptyProcessing(): ProcessingStatus {
  const s = { status: "pending" as const };
  return { liveStt: { ...s }, finalStt: { ...s }, diarization: { ...s }, identity: { ...s }, summary: { ...s }, compression: { ...s } };
}

/**
 * Audio retention for this recording:
 * - persisted: encrypted chunks under the durable key, kept until the user deletes them.
 * - ephemeral: non-persisted mode; chunks are sealed with an in-memory key and removed after processing.
 * - deleted: audio removed; transcript, summary, attributions remain.
 */
export type AudioRetention = "persisted" | "ephemeral" | "deleted";

/** Where live captions came from, for history labels; derived from the live option when the recording starts. */
export type ProviderKind = "local" | "soniox" | "speechmatics";

export interface Recording {
  id: RecordingId;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  state: RecordingState;
  audioRetention: AudioRetention;
  language: string;
  provider: ProviderKind;
  /** Snapshot of the model selection used; applies for the life of the recording. */
  models: ModelSelection;
  /** Roles provided by another role's cloud option, resolved when the recording started (absent on older recordings). */
  selection?: { locks: SelectionLocks };
  /** Pinned model revisions/manifests actually loaded, keyed by role. */
  modelVersions: Record<string, string>;
  /** Samples captured (monotonic sample clock). */
  totalSamples: number;
  /** Last sample covered by a verified durable chunk. */
  recoveryCursor: number;
  title: string | null;
  markers: Marker[];
  processing: ProcessingStatus;
  /** Incremented whenever transcript text changes (final pass, reprocess). */
  transcriptRevision: number;
  /** Why live processing degraded, if it did: shown as "Saving — processing later". */
  degraded: string | null;
  gaps: number;
  error: string | null;
}

export function providerKindFor(models: ModelSelection): ProviderKind {
  const s = serviceOption(models.sttLive)?.service;
  return s === "soniox" || s === "speechmatics" ? s : "local";
}

/**
 * The recording's locks: its snapshot, or for recordings made before the snapshot existed, the rules applied to
 * their models, with provider "soniox" meaning Soniox streamed the live captions.
 */
export function recordingLocks(r: Pick<Recording, "models" | "provider" | "selection">): SelectionLocks {
  if (r.selection) return r.selection.locks;
  if (r.provider === "soniox" && !serviceOption(r.models.sttLive)) return selectionLocks({ ...r.models, sttLive: "soniox:stt-rt-v5" });
  return selectionLocks(r.models);
}

/** The cloud live option a recording streamed to, if any (older Soniox recordings stored a local id). */
export function recordingLiveOption(r: Pick<Recording, "models" | "provider">) {
  return serviceOption(r.models.sttLive) ?? (r.provider === "soniox" ? serviceOption("soniox:stt-rt-v5") : undefined);
}

/** Where a recording was processed ("Speechmatics + on-device"), for its details line: cloud services and whether anything ran locally. */
export function recordingServices(r: Pick<Recording, "models" | "provider" | "selection">): { services: CloudService[]; local: boolean } {
  const locks = recordingLocks(r);
  const names = new Set<CloudService>();
  let local = false;
  for (const role of ["vad", "stt-live", "stt-final", "speaker-embedding"] as const) {
    const id = locks[role] ?? r.models[ROLE_KEYS[role]];
    if (id === "off" || id === "same-as-live") continue;
    const o = serviceOption(id) ?? (role === "stt-live" ? recordingLiveOption(r) : undefined);
    if (o) names.add(o.service);
    else local = true;
  }
  return { services: [...names], local: local || !names.size };
}

export function recordingDurationSamples(r: Pick<Recording, "totalSamples">): number {
  return r.totalSamples;
}
