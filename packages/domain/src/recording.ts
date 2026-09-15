import type { RecordingId } from "./audio";
import type { ModelSelection } from "./models";
import { serviceOption, selectionLocks, type SelectionLocks } from "./selection";
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

export type ProcessingStatus = Record<ProcessingStage, { status: StageStatus; error?: string; updatedAt?: string }>;

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

export function recordingDurationSamples(r: Pick<Recording, "totalSamples">): number {
  return r.totalSamples;
}
