import {
  overlap,
  resolveCluster,
  SAMPLE_RATE,
  type ClusterId,
  type SpeakerCluster,
  type SpeakerTurn,
  type TranscriptSegment,
  type TranscriptToken,
} from "@irl/domain";

export interface ReconcileInput {
  tokens: readonly TranscriptToken[];
  turns: readonly SpeakerTurn[];
  clusters: ReadonlyMap<ClusterId, SpeakerCluster>;
  /** Break a segment when the silence between tokens exceeds this. */
  pauseBreakSamples?: number;
  /** Soft cap on segment length; breaks at the next sentence end past it. */
  maxSegmentSamples?: number;
}

/**
 * Chooses the token set to render: final-pass tokens replace live tokens wherever the final pass covered
 * audio; live provisional tokens only render after the last final token.
 */
export function selectTokens(tokens: readonly TranscriptToken[], finalRunIds: ReadonlySet<string>): TranscriptToken[] {
  const finalPass = tokens.filter((t) => finalRunIds.has(t.providerRunId));
  if (finalPass.length) return [...finalPass].sort((a, b) => a.startSample - b.startSample);
  const finals = tokens.filter((t) => t.final);
  const lastFinalEnd = finals.reduce((m, t) => Math.max(m, t.endSample), 0);
  const provisional = tokens.filter((t) => !t.final && t.startSample >= lastFinalEnd - SAMPLE_RATE / 4);
  return [...finals, ...provisional].sort((a, b) => a.startSample - b.startSample);
}

function clusterFor(token: TranscriptToken, turns: readonly SpeakerTurn[], from: number): { clusterId: ClusterId | null; index: number } {
  let best: { id: ClusterId; ov: number } | null = null;
  let i = from;
  // Turns are sorted; advance past turns that end before this token.
  while (i < turns.length && turns[i]!.endSample <= token.startSample) i++;
  for (let j = Math.max(0, i - 1); j < turns.length && turns[j]!.startSample < token.endSample; j++) {
    const ov = overlap(turns[j]!, token);
    if (ov > 0 && (!best || ov > best.ov)) best = { id: turns[j]!.clusterId, ov };
  }
  if (best) return { clusterId: best.id, index: i };
  // No overlap (token between turns): nearest turn within one second.
  const near = [turns[i - 1], turns[i]].filter((t): t is SpeakerTurn => !!t).map((t) => ({ t, d: Math.min(Math.abs(t.endSample - token.startSample), Math.abs(t.startSample - token.endSample)) }));
  near.sort((a, b) => a.d - b.d);
  return { clusterId: near[0] && near[0].d <= SAMPLE_RATE ? near[0].t.clusterId : null, index: i };
}

/**
 * Joins word timing with speaker turns into stable, render-ready segments (plan.md §4 TranscriptReconciler).
 * Segment IDs derive from their first token's sample so summaries can anchor to them across renders; names
 * are never baked in, only cluster IDs (resolved through merges).
 */
export function reconcile(input: ReconcileInput): TranscriptSegment[] {
  const pause = input.pauseBreakSamples ?? Math.round(1.5 * SAMPLE_RATE);
  const maxLen = input.maxSegmentSamples ?? 20 * SAMPLE_RATE;
  const tokens = [...input.tokens].sort((a, b) => a.startSample - b.startSample);
  const turns = [...input.turns].sort((a, b) => a.startSample - b.startSample);
  const out: TranscriptSegment[] = [];
  let cur: TranscriptSegment | null = null;
  let cursor = 0;
  for (const tok of tokens) {
    if (!tok.text.trim() && !cur) continue;
    const found = clusterFor(tok, turns, cursor);
    cursor = found.index;
    const clusterId = found.clusterId ? resolveCluster(input.clusters, found.clusterId) : null;
    const sentenceEnded = !!cur && /[.!?。！？]\s*$/.test(cur.text);
    const breakHere =
      !cur ||
      (clusterId !== null && cur.clusterId !== null && clusterId !== cur.clusterId) ||
      tok.startSample - cur.endSample > pause ||
      (cur.endSample - cur.startSample > maxLen && sentenceEnded) ||
      cur.final !== tok.final;
    if (breakHere) {
      if (cur) out.push(finish(cur));
      cur = { id: `seg_${tok.startSample}`, startSample: tok.startSample, endSample: tok.endSample, clusterId, text: tok.text, final: tok.final, tokenIds: [tok.id], ...(tok.language ? { language: tok.language } : {}) };
    } else {
      cur = cur!;
      cur.text += tok.text;
      cur.endSample = Math.max(cur.endSample, tok.endSample);
      cur.tokenIds.push(tok.id);
      cur.clusterId ??= clusterId;
    }
  }
  if (cur) out.push(finish(cur));
  return out.filter((s) => s.text.length > 0);
}

function finish(s: TranscriptSegment): TranscriptSegment {
  return { ...s, text: s.text.replace(/\s+/g, " ").trim() };
}

/** Joins tokens that carry their own leading whitespace (Whisper/Soniox style) or bare words. */
export function joinTokenText(tokens: readonly Pick<TranscriptToken, "text">[]): string {
  return tokens.map((t) => t.text).join("").replace(/\s+/g, " ").trim();
}
