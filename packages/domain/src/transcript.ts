import type { ClusterId, PersonId, RecordingId, TimeRange } from "./audio";

export type TokenTiming = "word" | "segment-interpolated";

export interface TranscriptToken extends TimeRange {
  id: string;
  recordingId: RecordingId;
  /** Provider run that produced the token; final-pass tokens replace live-run tokens. */
  providerRunId: string;
  text: string;
  confidence?: number;
  language?: string;
  final: boolean;
  /** Provider-local speaker label (Soniox "1", "2"); normalized separately into clusters. */
  providerSpeakerId?: string;
  timing: TokenTiming;
}

export interface SpeakerTurn extends TimeRange {
  id: string;
  recordingId: RecordingId;
  providerRunId: string;
  clusterId: ClusterId;
  confidence?: number;
  final: boolean;
}

export interface SpeakerCluster {
  recordingId: RecordingId;
  clusterId: ClusterId;
  /** 1-based display ordinal: "Speaker 2". Stable once assigned. */
  ordinal: number;
  evidenceMs: number;
  /** Provider label when the cluster came from Soniox. */
  providerLabel?: string;
  /** Set when post-session refinement merged this cluster into another. */
  mergedInto?: ClusterId;
  /** Best below-threshold identity candidate, shown as "Possibly X"; never an attribution. */
  candidatePersonId?: string;
  candidateScore?: number;
}

export interface VoiceMatch {
  clusterId: ClusterId;
  personId: PersonId;
  confidence: number;
  runnerUpMargin: number;
  evidenceMs: number;
  status: "candidate" | "accepted" | "rejected";
}

export type AttributionSource = "auto" | "manual";

/** Maps a session cluster to a person. History rows are kept so undo can restore the previous mapping. */
export interface SpeakerAttribution {
  id: string;
  recordingId: RecordingId;
  clusterId: ClusterId;
  /** null records an explicit "unknown" correction that overrides auto matches. */
  personId: PersonId | null;
  confidence: number;
  source: AttributionSource;
  revision: number;
  operationId: string;
  createdAt: string;
  undone: boolean;
}

/** Reconciled, render-ready transcript line. Names are resolved at render time from clusterId. */
export interface TranscriptSegment extends TimeRange {
  id: string;
  clusterId: ClusterId | null;
  text: string;
  final: boolean;
  tokenIds: string[];
  language?: string;
}

export interface Marker {
  sample: number;
  label: string;
  createdAt: string;
}

/** Latest non-undone attribution per cluster. */
export function activeAttributions(rows: readonly SpeakerAttribution[]): Map<ClusterId, SpeakerAttribution> {
  const out = new Map<ClusterId, SpeakerAttribution>();
  for (const r of rows) {
    if (r.undone) continue;
    const cur = out.get(r.clusterId);
    if (!cur || r.revision > cur.revision) out.set(r.clusterId, r);
  }
  return out;
}

/** Follows mergedInto links so references to merged clusters resolve to the surviving cluster. */
export function resolveCluster(clusters: ReadonlyMap<ClusterId, SpeakerCluster>, id: ClusterId): ClusterId {
  let cur = id;
  for (let i = 0; i < 32; i++) {
    const next = clusters.get(cur)?.mergedInto;
    if (!next) return cur;
    cur = next;
  }
  return cur;
}
