import { newId, SAMPLE_RATE, type ClusterId, type SpeakerTurn, type SpeechEvent, type TranscriptToken } from "@irl/domain";

/** One entry of AddTranscript/AddPartialTranscript `results` (and batch json-v2 `results`). */
export interface SpeechmaticsResult {
  type: "word" | "punctuation" | "entity" | string;
  start_time: number;
  end_time: number;
  attaches_to?: "previous" | "next" | "both" | "none";
  is_eos?: boolean;
  alternatives?: { content: string; confidence?: number; language?: string; speaker?: string }[];
}

const DEDUP_TOLERANCE = Math.round(0.08 * SAMPLE_RATE);
const TURN_GAP = Math.round(1.5 * SAMPLE_RATE);
/** Speechmatics labels speech it can't attribute to anyone "UU". */
const UNKNOWN_SPEAKER = "UU";

/** Cluster id for a Speechmatics speaker label: enrolled voices are stable across connections, generic S1, S2… are not. */
export function speechmaticsClusterId(connection: number | "batch", label: string, enrolled: ReadonlySet<string>): ClusterId {
  if (enrolled.has(label)) return `SM-${label}`;
  return connection === "batch" ? `B-${label}` : `S${connection}-${label}`;
}

/**
 * Converts Speechmatics realtime results into canonical events (irl-subt-3xb.5), the same way SonioxNormalizer does:
 * times are seconds from each connection's first audio sample, so every connection carries its sample offset; the
 * overlap resent after a reconnect is de-duplicated by sample range; generic speaker labels are scoped per connection
 * because numbering restarts. Labels of enrolled voices (opaque person tokens) aren't scoped. Partials never form turns.
 */
export class SpeechmaticsNormalizer {
  private lastFinalEnd = 0;
  private clusters = new Map<ClusterId, number>();
  private open: { clusterId: ClusterId; start: number; end: number; confidences: number[] } | null = null;
  private speaking = false;

  constructor(
    private readonly recordingId: string,
    private readonly providerRunId: string,
    private readonly enrolled: ReadonlySet<string> = new Set(),
  ) {}

  get finalizedUntil(): number {
    return this.lastFinalEnd;
  }

  private cluster(connection: number | "batch", label: string | undefined, events: SpeechEvent[]): ClusterId | null {
    if (!label || label === UNKNOWN_SPEAKER) return null;
    const id = speechmaticsClusterId(connection, label, this.enrolled);
    if (!this.clusters.has(id)) {
      this.clusters.set(id, this.clusters.size + 1);
      events.push({ type: "cluster", clusterId: id, ordinal: this.clusters.size, providerLabel: label });
    }
    return id;
  }

  /** The cluster a label of a connection maps to, if that label produced one. */
  clusterIdFor(connection: number | "batch", label: string): ClusterId | null {
    const id = speechmaticsClusterId(connection, label, this.enrolled);
    return this.clusters.has(id) ? id : null;
  }

  partial(connection: number, connectionStartSample: number, results: readonly SpeechmaticsResult[]): SpeechEvent[] {
    const events: SpeechEvent[] = [];
    const provisional = toTokens(results, connectionStartSample, this.recordingId, this.providerRunId, false).filter((t) => t.token.endSample > this.lastFinalEnd);
    for (const t of provisional) this.cluster(connection, t.speaker, events);
    if (provisional.some((t) => t.token.text.trim()) && !this.speaking) {
      this.speaking = true;
      events.push({ type: "speech", active: true, sample: provisional[0]!.token.startSample });
    }
    events.push({ type: "tokens", tokens: provisional.map((t) => t.token), replaceProvisional: true });
    return events;
  }

  final(connection: number | "batch", connectionStartSample: number, results: readonly SpeechmaticsResult[]): SpeechEvent[] {
    const events: SpeechEvent[] = [];
    const finals: TranscriptToken[] = [];
    const turns: SpeakerTurn[] = [];
    for (const { token, speaker, confidence } of toTokens(results, connectionStartSample, this.recordingId, this.providerRunId, true)) {
      // Overlap resent after a reconnect produces finals we already have.
      if (token.endSample <= this.lastFinalEnd + DEDUP_TOLERANCE && token.startSample < this.lastFinalEnd) continue;
      const clusterId = this.cluster(connection, speaker, events);
      finals.push(speaker ? { ...token, providerSpeakerId: `${connection}:${speaker}` } : token);
      this.lastFinalEnd = Math.max(this.lastFinalEnd, token.endSample);
      if (clusterId) {
        if (this.open && (this.open.clusterId !== clusterId || token.startSample - this.open.end > TURN_GAP)) turns.push(this.closeTurn()!);
        this.open ??= { clusterId, start: token.startSample, end: token.endSample, confidences: [] };
        this.open.end = Math.max(this.open.end, token.endSample);
        this.open.confidences.push(confidence);
      }
    }
    // Final tokens replace the partials that covered them, even when this message carried none.
    events.push({ type: "tokens", tokens: finals, replaceProvisional: true });
    if (turns.length) events.push({ type: "turns", turns });
    return events;
  }

  /** EndOfUtterance: the speaker stopped (after the configured silence). */
  endOfUtterance(connectionStartSample: number, endTimeSeconds: number): SpeechEvent[] {
    if (!this.speaking) return [];
    this.speaking = false;
    return [{ type: "speech", active: false, sample: connectionStartSample + Math.round(endTimeSeconds * SAMPLE_RATE) }];
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

/**
 * Result entries → tokens that carry their own leading whitespace (the reconciler joins token text as is): words get a
 * space, punctuation attaching to the previous word doesn't, and a token after one attaching to the next doesn't.
 */
export function toTokens(results: readonly SpeechmaticsResult[], offsetSample: number, recordingId: string, providerRunId: string, final: boolean): { token: TranscriptToken; speaker: string | undefined; confidence: number }[] {
  const out: { token: TranscriptToken; speaker: string | undefined; confidence: number }[] = [];
  let glueNext = false;
  for (const r of results) {
    const alt = r.alternatives?.[0];
    if (!alt?.content) continue;
    const attachesPrevious = r.attaches_to === "previous" || r.attaches_to === "both" || (r.type === "punctuation" && r.attaches_to === undefined);
    const text = (attachesPrevious || glueNext || !out.length && r.type === "punctuation" ? "" : " ") + alt.content;
    glueNext = r.attaches_to === "next" || r.attaches_to === "both";
    const start = offsetSample + Math.round(r.start_time * SAMPLE_RATE);
    const end = offsetSample + Math.round(r.end_time * SAMPLE_RATE);
    const confidence = alt.confidence ?? 1;
    out.push({
      token: {
        id: newId("tok"), recordingId, providerRunId, startSample: start, endSample: Math.max(end, start + 1), text, final, timing: "word", confidence,
        ...(alt.language ? { language: alt.language } : {}),
      },
      speaker: alt.speaker,
      confidence,
    });
  }
  return out;
}
