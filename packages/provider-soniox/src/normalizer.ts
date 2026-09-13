import { newId, SAMPLE_RATE, type ClusterId, type SpeakerTurn, type SpeechEvent, type TranscriptToken } from "@irl/domain";

export interface SonioxTokenLike {
  text: string;
  start_ms?: number;
  end_ms?: number;
  confidence: number;
  is_final: boolean;
  speaker?: string;
  language?: string;
}

const DEDUP_TOLERANCE = Math.round(0.08 * SAMPLE_RATE);
const TURN_GAP = Math.round(1.5 * SAMPLE_RATE);

/**
 * Converts Soniox results into canonical events (plan.md §6.2). Token times are relative to each
 * connection's first audio sample, so every connection carries its sample offset. After a reconnect the
 * overlap that was resent for context is de-duplicated by sample range. Speaker labels are scoped per
 * connection (`S<conn>-<label>`) because Soniox numbering restarts; post-processing links them with local
 * embeddings. Provisional speakers never reach profiles: only final tokens form turns.
 */
export class SonioxNormalizer {
  private lastFinalEnd = 0;
  private clusters = new Map<string, number>();
  private open: { clusterId: ClusterId; start: number; end: number; confidences: number[] } | null = null;

  constructor(private readonly recordingId: string, private readonly providerRunId: string) {}

  get finalizedUntil(): number {
    return this.lastFinalEnd;
  }

  clusterFor(connection: number, speaker: string | undefined): { clusterId: ClusterId; created: boolean; ordinal: number } | null {
    if (!speaker) return null;
    const id = `S${connection}-${speaker}`;
    const existing = this.clusters.get(id);
    if (existing) return { clusterId: id, created: false, ordinal: existing };
    const ordinal = this.clusters.size + 1;
    this.clusters.set(id, ordinal);
    return { clusterId: id, created: true, ordinal };
  }

  result(connection: number, connectionStartSample: number, tokens: readonly SonioxTokenLike[]): SpeechEvent[] {
    const events: SpeechEvent[] = [];
    const finals: TranscriptToken[] = [];
    const provisional: TranscriptToken[] = [];
    const turns: SpeakerTurn[] = [];
    for (const t of tokens) {
      if (t.text === "<end>" || t.text === "<fin>") continue;
      const start = connectionStartSample + Math.round(((t.start_ms ?? 0) * SAMPLE_RATE) / 1000);
      const end = connectionStartSample + Math.round(((t.end_ms ?? t.start_ms ?? 0) * SAMPLE_RATE) / 1000);
      const cluster = this.clusterFor(connection, t.speaker);
      if (cluster?.created) events.push({ type: "cluster", clusterId: cluster.clusterId, ordinal: cluster.ordinal, providerLabel: t.speaker });
      const token: TranscriptToken = {
        id: newId("tok"), recordingId: this.recordingId, providerRunId: this.providerRunId, startSample: start, endSample: Math.max(end, start + 1), text: t.text,
        final: t.is_final, timing: "word", confidence: t.confidence, ...(t.language ? { language: t.language } : {}), ...(t.speaker ? { providerSpeakerId: `${connection}:${t.speaker}` } : {}),
      };
      if (!t.is_final) {
        if (end > this.lastFinalEnd) provisional.push(token);
        continue;
      }
      // Overlap resent after a reconnect produces finals we already have.
      if (end <= this.lastFinalEnd + DEDUP_TOLERANCE && start < this.lastFinalEnd) continue;
      finals.push(token);
      this.lastFinalEnd = Math.max(this.lastFinalEnd, end);
      if (cluster) {
        if (this.open && (this.open.clusterId !== cluster.clusterId || start - this.open.end > TURN_GAP)) turns.push(this.closeTurn()!);
        this.open ??= { clusterId: cluster.clusterId, start, end, confidences: [] };
        this.open.end = Math.max(this.open.end, end);
        this.open.confidences.push(t.confidence);
      }
    }
    if (finals.length) events.push({ type: "tokens", tokens: finals, replaceProvisional: true });
    // Provisional tokens always replace the previous provisional set, even when empty.
    events.push({ type: "tokens", tokens: provisional, replaceProvisional: true });
    if (turns.length) events.push({ type: "turns", turns });
    return events;
  }

  private closeTurn(): SpeakerTurn | null {
    const o = this.open;
    this.open = null;
    if (!o) return null;
    return {
      id: newId("turn"), recordingId: this.recordingId, providerRunId: this.providerRunId, clusterId: o.clusterId, startSample: o.start, endSample: o.end, final: true,
      confidence: o.confidences.reduce((a, b) => a + b, 0) / Math.max(1, o.confidences.length),
    };
  }

  flush(): SpeechEvent[] {
    const t = this.closeTurn();
    return t ? [{ type: "turns", turns: [t] }] : [];
  }
}
