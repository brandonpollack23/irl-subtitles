import type { ClusterId, PersonId, RecordingId, TimeRange } from "./audio";

export interface VoiceEmbedding extends TimeRange {
  vector: Float32Array;
  embeddingSpace: string;
  /** 0..1 heuristic: speech ratio, level, no overlap. */
  quality: number;
}

/** A clean speech window embedded during a recording, kept (encrypted) for enrollment and refinement. */
export interface VoiceWindow extends TimeRange {
  id: string;
  recordingId: RecordingId;
  clusterId: ClusterId;
  embeddingSpace: string;
  quality: number;
  /** AES-GCM sealed Float32 vector. */
  sealedVector: Uint8Array;
}

export interface VoiceProfile {
  id: string;
  personId: PersonId;
  embeddingSpace: string;
  needsReenrollment: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface VoicePrototype {
  id: string;
  profileId: string;
  /** Sealed Float32 centroid of the windows it summarizes. */
  sealedVector: Uint8Array;
  quality: number;
  evidenceMs: number;
  sourceRecordingId: RecordingId;
  operationId: string;
  createdAt: string;
}

export interface VoiceSample extends TimeRange {
  id: string;
  profileId: string;
  recordingId: RecordingId;
  /** Blob path of a sealed PCM clip, when audio was retained and the user consented. */
  clipPath: string | null;
  consent: boolean;
  operationId: string;
  createdAt: string;
}

export interface MatchPolicy {
  minEvidenceMs: number;
  minScore: number;
  minMargin: number;
  /** Fraction of windows whose best candidate agrees with the aggregate best. */
  minWindowAgreement: number;
  /** Candidates above this are shown as "Possibly X" when not accepted. */
  candidateScore: number;
}

/** Initial thresholds per embedding space; calibrate with the evaluation harness (irl-subt-f9n.9). */
export const DEFAULT_POLICIES: Record<string, MatchPolicy> = {
  default: { minEvidenceMs: 8_000, minScore: 0.62, minMargin: 0.1, minWindowAgreement: 0.6, candidateScore: 0.5 },
};

export function policyFor(embeddingSpace: string, overrides?: Record<string, MatchPolicy>): MatchPolicy {
  return overrides?.[embeddingSpace] ?? DEFAULT_POLICIES[embeddingSpace] ?? DEFAULT_POLICIES.default!;
}

export function l2normalize(v: Float32Array): Float32Array {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i]! / n;
  return out;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) throw new Error(`embedding dims differ: ${a.length} vs ${b.length}`);
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export function meanVector(vectors: readonly Float32Array[], weights?: readonly number[]): Float32Array {
  if (!vectors.length) throw new Error("meanVector of nothing");
  const out = new Float32Array(vectors[0]!.length);
  let total = 0;
  vectors.forEach((v, i) => {
    const w = weights?.[i] ?? 1;
    total += w;
    const n = l2normalize(v);
    for (let k = 0; k < out.length; k++) out[k]! += n[k]! * w;
  });
  for (let k = 0; k < out.length; k++) out[k]! /= total || 1;
  return l2normalize(out);
}

export interface CandidateProfile {
  personId: PersonId;
  embeddingSpace: string;
  needsReenrollment: boolean;
  prototypes: Float32Array[];
}

export interface ClusterEvidence {
  clusterId: ClusterId;
  embeddingSpace: string;
  windows: { vector: Float32Array; durationMs: number; quality: number; overlap?: boolean }[];
}

export interface MatchDecision {
  clusterId: ClusterId;
  best: { personId: PersonId; score: number } | null;
  second: { personId: PersonId; score: number } | null;
  evidenceMs: number;
  agreement: number;
  status: "accepted" | "candidate" | "rejected";
  /** English, for logs and the evaluation view. The UI renders `failures` / `rejection`. */
  reason: string;
  /** Criteria a local match missed, with the measured value and the policy threshold. */
  failures?: MatchFailure[];
  /** Why nothing could be compared at all. */
  rejection?: "no-clean-windows" | "no-comparable-profiles";
  /** "service": the speech service recognized an enrolled voice (Speechmatics voice ID); scores don't apply. */
  source?: "local" | "service";
}

export interface MatchFailure {
  criterion: "evidence" | "score" | "margin" | "agreement";
  /** evidence in ms; the others are 0–1 scores or fractions. */
  value: number;
  threshold: number;
}

function personScore(vector: Float32Array, profile: CandidateProfile): number {
  // Several prototypes per person represent different conditions; the closest one counts.
  return Math.max(...profile.prototypes.map((p) => cosine(vector, p)));
}

/**
 * plan.md §7.3: never name a speaker from one short high-scoring window. Aggregates clean windows,
 * then requires evidence, absolute score, margin over the runner-up, and per-window agreement.
 * Profiles from another embedding space or needing re-enrollment are never compared.
 */
export function decideMatch(evidence: ClusterEvidence, profiles: readonly CandidateProfile[], policy: MatchPolicy): MatchDecision {
  const usable = evidence.windows.filter((w) => !w.overlap && w.quality >= 0.3);
  const evidenceMs = usable.reduce((n, w) => n + w.durationMs, 0);
  const eligible = profiles.filter((p) => p.embeddingSpace === evidence.embeddingSpace && !p.needsReenrollment && p.prototypes.length > 0);
  const base = { clusterId: evidence.clusterId, evidenceMs };
  if (!usable.length || !eligible.length) {
    return { ...base, best: null, second: null, agreement: 0, status: "rejected", reason: !usable.length ? "no clean windows" : "no comparable profiles", rejection: !usable.length ? "no-clean-windows" : "no-comparable-profiles" };
  }
  const aggregate = meanVector(usable.map((w) => w.vector), usable.map((w) => w.durationMs * w.quality));
  const ranked = eligible
    .map((p) => ({ personId: p.personId, score: personScore(aggregate, p) }))
    .sort((a, b) => b.score - a.score);
  const best = ranked[0]!;
  const second = ranked[1] ?? null;
  let agree = 0;
  for (const w of usable) {
    const top = eligible.map((p) => ({ id: p.personId, s: personScore(w.vector, p) })).sort((a, b) => b.s - a.s)[0]!;
    if (top.id === best.personId) agree++;
  }
  const agreement = agree / usable.length;
  const margin = best.score - (second?.score ?? 0);
  const failures: MatchFailure[] = [];
  if (evidenceMs < policy.minEvidenceMs) failures.push({ criterion: "evidence", value: evidenceMs, threshold: policy.minEvidenceMs });
  if (best.score < policy.minScore) failures.push({ criterion: "score", value: best.score, threshold: policy.minScore });
  if (second && margin < policy.minMargin) failures.push({ criterion: "margin", value: margin, threshold: policy.minMargin });
  if (agreement < policy.minWindowAgreement) failures.push({ criterion: "agreement", value: agreement, threshold: policy.minWindowAgreement });
  if (!failures.length) return { ...base, best, second, agreement, status: "accepted", reason: "all criteria met" };
  const status = best.score >= policy.candidateScore ? "candidate" : "rejected";
  return { ...base, best, second, agreement, status, reason: failures.map(failureText).join("; "), failures };
}

function failureText(f: MatchFailure): string {
  switch (f.criterion) {
    case "evidence":
      return `evidence ${Math.round(f.value)}ms < ${f.threshold}ms`;
    case "score":
      return `score ${f.value.toFixed(3)} < ${f.threshold}`;
    case "margin":
      return `margin ${f.value.toFixed(3)} < ${f.threshold}`;
    case "agreement":
      return `agreement ${f.value.toFixed(2)} < ${f.threshold}`;
  }
}

/** Equal error rate and threshold from same/different-speaker score lists (evaluation harness). */
export function equalErrorRate(same: readonly number[], different: readonly number[]): { eer: number; threshold: number } {
  const thresholds = [...same, ...different].sort((a, b) => a - b);
  let best = { eer: 1, threshold: 0, gap: Infinity };
  for (const t of thresholds) {
    const frr = same.filter((s) => s < t).length / Math.max(1, same.length);
    const far = different.filter((d) => d >= t).length / Math.max(1, different.length);
    const gap = Math.abs(frr - far);
    if (gap < best.gap) best = { eer: (frr + far) / 2, threshold: t, gap };
  }
  return { eer: best.eer, threshold: best.threshold };
}

export function rates(same: readonly number[], different: readonly number[], threshold: number): { far: number; frr: number } {
  return {
    frr: same.filter((s) => s < threshold).length / Math.max(1, same.length),
    far: different.filter((d) => d >= threshold).length / Math.max(1, different.length),
  };
}
