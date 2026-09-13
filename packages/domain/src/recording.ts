import type { RecordingId } from "./audio";
import type { ModelSelection } from "./models";
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

export type ProviderKind = "local" | "soniox";

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

export function recordingDurationSamples(r: Pick<Recording, "totalSamples">): number {
  return r.totalSamples;
}
