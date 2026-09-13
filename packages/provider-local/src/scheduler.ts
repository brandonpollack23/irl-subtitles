/**
 * Compute scheduler and thermal degradation (plan.md §6.1): VAD and persistence first, embeddings on
 * completed windows next, live STT last. Levels escalate when work falls behind real time or latency
 * climbs (a proxy for thermal throttling) and relax after sustained headroom.
 *
 * 0 normal · 1 no interim captions (final per utterance only) · 2 live STT paused (captions off,
 * processed after Stop) · 3 embeddings paused too (capture + VAD only).
 */
export type DegradationLevel = 0 | 1 | 2 | 3;

export interface SchedulerSample {
  /** Seconds of speech audio queued for STT but not yet transcribed. */
  sttBacklogS: number;
  /** Seconds of audio queued for embedding. */
  embedBacklogS: number;
  /** Recent STT real-time factor (processing time / audio time). */
  sttRtf: number | null;
  /** A WebGPU device loss or inference failure since the last sample. */
  failure: boolean;
}

export interface SchedulerDecision {
  level: DegradationLevel;
  reason: string | null;
  interimCaptions: boolean;
  liveStt: boolean;
  embeddings: boolean;
}

export class ComputeScheduler {
  private level: DegradationLevel = 0;
  private healthySince = 0;
  private rtfHistory: number[] = [];

  constructor(private readonly now: () => number = () => performance.now(), private readonly relaxAfterMs = 30_000) {}

  get current(): DegradationLevel {
    return this.level;
  }

  private sttRuns = 0;
  private lastRtfSample: number | null = null;

  update(s: SchedulerSample): SchedulerDecision {
    // Each STT run reports once; the first runs include model warm-up and shader compilation, so they
    // don't count, and the median keeps one slow outlier from pinning the level.
    if (s.sttRtf !== null && s.sttRtf !== this.lastRtfSample) {
      this.lastRtfSample = s.sttRtf;
      if (++this.sttRuns > 2) this.rtfHistory = [...this.rtfHistory.slice(-8), s.sttRtf];
    }
    const sorted = [...this.rtfHistory].sort((a, b) => a - b);
    const rtf = sorted.length ? sorted[Math.floor(sorted.length / 2)]! : 0;
    let target: DegradationLevel = 0;
    let reason: string | null = null;
    if (s.sttBacklogS > 4 || rtf > 0.8) {
      target = 1;
      reason = "Live captions slowed to keep up";
    }
    if (s.sttBacklogS > 20 || rtf > 1.5 || s.failure) {
      target = 2;
      reason = s.failure ? "Saving — processing later (local compute failed)" : "Saving — processing later";
    }
    if (s.embedBacklogS > 30) {
      target = 3;
      reason = "Saving — processing later";
    }
    const t = this.now();
    if (target > this.level) {
      this.level = target;
      this.healthySince = t;
    } else if (target < this.level) {
      // Relax one level at a time after sustained headroom, so load doesn't oscillate.
      if (t - this.healthySince >= this.relaxAfterMs) {
        this.level = (this.level - 1) as DegradationLevel;
        this.healthySince = t;
        this.rtfHistory = [];
      }
    } else {
      this.healthySince = t;
    }
    return {
      level: this.level,
      reason: this.level === 0 ? null : (reason ?? (this.level >= 2 ? "Saving — processing later" : "Live captions slowed to keep up")),
      interimCaptions: this.level === 0,
      liveStt: this.level <= 1,
      embeddings: this.level <= 2,
    };
  }
}

/**
 * Streaming models without alignment give text for a whole utterance; spread words across it in
 * proportion to their length (TranscriptToken.timing = "segment-interpolated").
 */
export function interpolateWords(text: string, startSample: number, endSample: number): { text: string; startSample: number; endSample: number }[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  // CJK text without spaces becomes one token per sentence-ish chunk.
  if (words.length === 1 && [...words[0]!].length > 12) {
    const chunks = words[0]!.match(/[^。！？、,.!?]+[。！？、,.!?]?/g) ?? [words[0]!];
    return spread(chunks, startSample, endSample, "");
  }
  return spread(words, startSample, endSample, " ");
}

function spread(parts: string[], start: number, end: number, sep: string) {
  const total = parts.reduce((n, w) => n + [...w].length + 1, 0);
  const span = Math.max(0, end - start);
  let cursor = start;
  return parts.map((w, i) => {
    const len = Math.round((span * ([...w].length + 1)) / Math.max(1, total));
    const s = cursor;
    const e = i === parts.length - 1 ? end : Math.min(end, cursor + len);
    cursor = e;
    return { text: `${sep}${w}`, startSample: s, endSample: e };
  });
}
