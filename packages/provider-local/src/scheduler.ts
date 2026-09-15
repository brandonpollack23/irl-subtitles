/**
 * Compute scheduler and thermal degradation (plan.md §6.1): VAD and persistence first, embeddings on
 * completed windows next, live STT last. Levels escalate when work falls behind real time (a backlog, or STT
 * needing more than a second of compute per second of new audio, a proxy for thermal throttling) and relax
 * after sustained headroom.
 *
 * 0 normal · 1 no interim captions (final per utterance only) · 2 live STT paused (captions off,
 * processed after Stop) · 3 embeddings paused too (capture + VAD only).
 */
import type { DegradedReason } from "@irl/domain";

export type DegradationLevel = 0 | 1 | 2 | 3;

export interface SchedulerSample {
  /** Seconds of speech audio queued for STT but not yet transcribed. */
  sttBacklogS: number;
  /** Seconds of audio queued for embedding. */
  embedBacklogS: number;
  /** STT compute since the previous sample (ms). */
  sttComputeMs: number;
  /** New audio STT covered since the previous sample (s): what a live transcript actually has to keep up with. */
  sttNewAudioS: number;
  /** A WebGPU device loss or inference failure since the last sample. */
  failure: boolean;
}

export interface SchedulerDecision {
  level: DegradationLevel;
  reason: DegradedReason | null;
  interimCaptions: boolean;
  liveStt: boolean;
  embeddings: boolean;
}

/** STT load is judged over the most recent this-many seconds of new audio, and only once there are this-few. */
const LOAD_WINDOW_S = 10;
const LOAD_MIN_S = 4;

export class ComputeScheduler {
  private level: DegradationLevel = 0;
  private healthySince = 0;
  /** Recent STT work, newest last. */
  private work: { ms: number; audioS: number }[] = [];

  constructor(private readonly now: () => number = () => performance.now(), private readonly relaxAfterMs = 30_000) {}

  get current(): DegradationLevel {
    return this.level;
  }

  /**
   * Compute per second of new audio over the recent window, or null until there's enough audio to judge. Per-call
   * ratios mislead: a short utterance or one streaming pass carries fixed overhead, so one "yeah" looked like
   * falling behind (irl-subt-kdl.5).
   */
  get sttLoad(): number | null {
    const audio = this.work.reduce((n, w) => n + w.audioS, 0);
    return audio >= LOAD_MIN_S ? this.work.reduce((n, w) => n + w.ms, 0) / 1000 / audio : null;
  }

  update(s: SchedulerSample): SchedulerDecision {
    if (s.sttComputeMs > 0 || s.sttNewAudioS > 0) {
      this.work.push({ ms: s.sttComputeMs, audioS: s.sttNewAudioS });
      let audio = this.work.reduce((n, w) => n + w.audioS, 0);
      while (this.work.length > 1 && audio - this.work[0]!.audioS >= LOAD_WINDOW_S) audio -= this.work.shift()!.audioS;
    }
    const load = this.sttLoad ?? 0;
    let target: DegradationLevel = 0;
    let reason: DegradedReason | null = null;
    // Below one second per second the transcript keeps up; interim updates only go when it can't.
    if (s.sttBacklogS > 4 || load > 1) {
      target = 1;
      reason = { code: "slowed" };
    }
    if (s.sttBacklogS > 20 || load > 1.5 || s.failure) {
      target = 2;
      reason = s.failure ? { code: "saving-later", detail: "local compute failed" } : { code: "saving-later" };
    }
    if (s.embedBacklogS > 30) {
      target = 3;
      reason = { code: "saving-later" };
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
        this.work = [];
      }
    } else {
      this.healthySince = t;
    }
    return {
      level: this.level,
      reason: this.level === 0 ? null : (reason ?? (this.level >= 2 ? { code: "saving-later" } : { code: "slowed" })),
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
