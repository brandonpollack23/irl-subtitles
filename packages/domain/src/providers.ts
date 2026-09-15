import type { AudioFrame, ClusterId, RecordingId, TimeRange } from "./audio";
import type { VoiceEmbedding } from "./identity";
import type { BenchmarkResult, ExecutionTarget, ModelCatalogEntry, ModelManifest, PowerPolicy } from "./models";
import type { StageNote } from "./recording";
import type { ConversationSummary } from "./summary";
import { SERVICE_NAMES, type CloudService } from "./selection";
import type { SpeakerTurn, TranscriptSegment, TranscriptToken } from "./transcript";

/** plan.md §5 */
export interface StreamingRun<Input, Event> {
  push(frame: Input): Promise<void>;
  events(): AsyncIterable<Event>;
  finish(): Promise<void>;
  abort(reason: string): Promise<void>;
}

export interface TranscriptionConfig {
  recordingId: RecordingId;
  providerRunId: string;
  language: string;
  modelId: string;
}

export interface DiarizationConfig {
  recordingId: RecordingId;
  providerRunId: string;
  embeddingModelId: string;
}

export interface TranscriptionProvider {
  readonly id: string;
  start(config: TranscriptionConfig): Promise<StreamingRun<AudioFrame, TranscriptToken>>;
}

export interface DiarizationProvider {
  readonly id: string;
  start(config: DiarizationConfig): Promise<StreamingRun<AudioFrame, SpeakerTurn>>;
}

export interface AudioSlice extends TimeRange {
  samples: Float32Array;
}

export interface VoiceIdentityProvider {
  readonly id: string;
  readonly embeddingSpace: string;
  embed(samples: AudioSlice[]): Promise<VoiceEmbedding[]>;
}

export interface SummaryInput {
  recordingId: RecordingId;
  language: string;
  transcriptRevision: number;
  segments: readonly TranscriptSegment[];
  /** Display name per cluster, used only for cloud summaries and prompt readability. */
  speakerNames: ReadonlyMap<ClusterId, string>;
  signal?: AbortSignal;
  onProgress?: (fraction: number, note: StageNote) => void;
}

export interface SummaryProvider {
  readonly id: string;
  summarize(input: SummaryInput): Promise<ConversationSummary>;
}

/** Reserved (plan.md §15): not exposed in the MVP UI. */
export interface TranslationProvider {
  readonly id: string;
  translate(tokens: readonly TranscriptToken[], targetLanguage: string): Promise<TranscriptToken[]>;
}

export interface ProviderCapabilities {
  transcription: "none" | "streaming" | "batch";
  diarization: "none" | "streaming" | "batch" | "fused-with-stt";
  persistentIdentity: boolean;
  languages: readonly string[] | "auto";
  execution: "local" | "cloud";
}

/** Normalized events from a live speech provider. UI and storage never see provider objects. */
export type SpeechEvent =
  | { type: "tokens"; tokens: TranscriptToken[]; /** Provisional tokens replace earlier provisional tokens of the run. */ replaceProvisional: boolean }
  | { type: "turns"; turns: SpeakerTurn[] }
  | { type: "cluster"; clusterId: ClusterId; ordinal: number; providerLabel?: string }
  | { type: "window"; clusterId: ClusterId; embedding: VoiceEmbedding }
  | { type: "speech"; active: boolean; sample: number }
  /** Voiceprint identifiers a service issued for this run's speakers (Speechmatics get_speakers), per cluster. */
  | { type: "speakers"; speakers: { clusterId: ClusterId; identifiers: string[] }[] }
  | { type: "degraded"; reason: DegradedReason | null }
  | { type: "error"; message: string; fatal: boolean };

export interface LiveSpeechRun {
  readonly providerRunId: string;
  push(frame: AudioFrame): void;
  readonly events: AsyncIterable<SpeechEvent>;
  /** Flushes buffered audio and resolves after the last events are emitted. */
  finish(): Promise<void>;
  abort(reason: string): Promise<void>;
}

export interface LiveSpeechProvider {
  readonly id: string;
  readonly capabilities: ProviderCapabilities;
  start(config: TranscriptionConfig & { embeddingModelId: string; sttModelId: string | "off"; vadModelId: string }): Promise<LiveSpeechRun>;
}

/** Enrolled voices a service should recognize, labeled with opaque tokens (never names). */
export interface ServiceSpeaker {
  label: string;
  identifiers: string[];
}

export interface FinalTranscriptJob {
  recordingId: RecordingId;
  providerRunId: string;
  /** The cloud option id, e.g. "speechmatics-batch:enhanced". */
  optionId: string;
  language: string;
  /** The whole recording as a 16 kHz mono PCM WAV. */
  wav: Uint8Array;
  signal: AbortSignal;
  onProgress?: (note: StageNote) => void;
  /** Voices to label by token (Speechmatics voice identification). */
  speakers?: readonly ServiceSpeaker[];
  /** Ask the service for voiceprint identifiers of the speakers it found. */
  getSpeakers?: boolean;
  /** How readily the service assigns speech to enrolled voices (0–1). */
  speakersSensitivity?: number;
}

export interface FinalTranscriptResult {
  /** Final tokens, with sample times from the start of the recording. */
  tokens: TranscriptToken[];
  turns: SpeakerTurn[];
  /** One entry per service speaker label that has turns; cluster ids match the turns. */
  clusters: { clusterId: ClusterId; ordinal: number; providerLabel: string }[];
  /** Identifiers per cluster, when getSpeakers was requested. */
  speakers?: { clusterId: ClusterId; identifiers: string[] }[];
  language?: string;
}

/** A cloud batch service that makes the final transcript and speaker turns after Stop (irl-subt-3xb.3). */
export interface CloudFinalProvider {
  readonly id: string;
  transcribe(job: FinalTranscriptJob): Promise<FinalTranscriptResult>;
}

export interface ModelSession {
  readonly modelId: string;
  readonly target: ExecutionTarget;
  dispose(): Promise<void>;
}

export interface BenchmarkProbe {
  entry: ModelCatalogEntry;
  seconds: number;
}

export interface ComputeRuntime {
  readonly target: ExecutionTarget;
  load(model: ModelManifest): Promise<ModelSession>;
  benchmark(probe: BenchmarkProbe): Promise<BenchmarkResult>;
  dispose(): Promise<void>;
}

export interface ComputeRuntimeSelector {
  candidates(): Promise<ComputeRuntime[]>;
  select(model: ModelManifest, policy: PowerPolicy): Promise<ComputeRuntime>;
}

/** Why live processing is behind; rendered by the UI, and as English by degradedText for storage and logs. */
export type DegradedReason =
  | { code: "slowed" }
  | { code: "saving-later"; detail?: string }
  | { code: "captions-paused" }
  | { code: "not-downloaded"; part: LivePart }
  | { code: "unavailable"; part: LivePart }
  | { code: "vad-failed" }
  | { code: "restarting"; detail: string }
  | { code: "reconnecting"; service: CloudService };

/** The local live models: speech detection, the speaker model, and captions. */
export type LivePart = "vad" | "speaker" | "captions";

/** English part names for logs. */
export const LIVE_PART_NAMES: Record<LivePart, string> = { vad: "Speech detection", speaker: "Speaker", captions: "Captions" };

export function degradedText(r: DegradedReason): string {
  switch (r.code) {
    case "slowed":
      return "Live captions slowed to keep up";
    case "saving-later":
      return r.detail ? `Saving — processing later (${r.detail})` : "Saving — processing later";
    case "captions-paused":
      return "Captions paused — processing later";
    case "not-downloaded":
      return `${LIVE_PART_NAMES[r.part]} model not downloaded — processing later`;
    case "unavailable":
      return `${LIVE_PART_NAMES[r.part]} unavailable — processing later`;
    case "vad-failed":
      return "Speech detection failed — processing later";
    case "restarting":
      return `Restarting live processing (${r.detail})`;
    case "reconnecting":
      return `${SERVICE_NAMES[r.service]} reconnecting — audio is still saving`;
  }
}

export function sameDegraded(a: DegradedReason | null, b: DegradedReason | null): boolean {
  return a === b || (!!a && !!b && degradedText(a) === degradedText(b));
}

/** A service key check: `code` for the UI, `message` in English for logs. */
export interface KeyTestResult {
  ok: boolean;
  code: "ok" | "rejected" | "http" | "unreachable";
  status?: number;
  message: string;
}
