import { SAMPLE_RATE, type TimeRange } from "@irl/domain";

export interface VadParams {
  /** Silero window at 16 kHz. */
  windowSamples: number;
  threshold: number;
  negThreshold: number;
  minSpeechMs: number;
  minSilenceMs: number;
  speechPadMs: number;
  /** Force a cut so live STT gets bounded utterances. */
  maxSpeechMs: number;
}

export const DEFAULT_VAD: VadParams = { windowSamples: 512, threshold: 0.5, negThreshold: 0.35, minSpeechMs: 250, minSilenceMs: 400, speechPadMs: 120, maxSpeechMs: 15_000 };

export type VadEvent = { type: "start"; sample: number } | { type: "end"; range: TimeRange; forced: boolean };

/**
 * Silero-style hysteresis over per-window speech probabilities, in absolute samples (plan.md §6.1 step 1).
 * Feed probabilities in order with the sample index at which each window starts.
 */
export class VadSegmenter {
  private inSpeech = false;
  private speechStart = 0;
  private silenceStart: number | null = null;
  private readonly p: VadParams;

  constructor(params: Partial<VadParams> = {}) {
    this.p = { ...DEFAULT_VAD, ...params };
  }

  get active(): boolean {
    return this.inSpeech;
  }

  get currentStart(): number | null {
    return this.inSpeech ? this.speechStart : null;
  }

  push(prob: number, windowStart: number): VadEvent[] {
    const ms = (n: number) => Math.round((n * SAMPLE_RATE) / 1000);
    const out: VadEvent[] = [];
    const windowEnd = windowStart + this.p.windowSamples;
    if (prob >= this.p.threshold) {
      this.silenceStart = null;
      if (!this.inSpeech) {
        this.inSpeech = true;
        this.speechStart = Math.max(0, windowStart - ms(this.p.speechPadMs));
        out.push({ type: "start", sample: this.speechStart });
      } else if (windowEnd - this.speechStart >= ms(this.p.maxSpeechMs)) {
        out.push({ type: "end", range: { startSample: this.speechStart, endSample: windowEnd }, forced: true });
        this.speechStart = windowEnd;
        out.push({ type: "start", sample: this.speechStart });
      }
      return out;
    }
    if (!this.inSpeech) return out;
    if (prob < this.p.negThreshold) {
      this.silenceStart ??= windowStart;
      if (windowEnd - this.silenceStart >= ms(this.p.minSilenceMs)) {
        const end = this.silenceStart + ms(this.p.speechPadMs);
        this.inSpeech = false;
        this.silenceStart = null;
        // Minimum duration is judged on the unpadded speech.
        if (end - this.speechStart - 2 * ms(this.p.speechPadMs) >= ms(this.p.minSpeechMs)) out.push({ type: "end", range: { startSample: this.speechStart, endSample: end }, forced: false });
      }
    }
    return out;
  }

  /** Closes an open utterance at end of stream. */
  flush(endSample: number): VadEvent[] {
    if (!this.inSpeech) return [];
    this.inSpeech = false;
    const end = this.silenceStart !== null ? Math.min(endSample, this.silenceStart + Math.round((this.p.speechPadMs * SAMPLE_RATE) / 1000)) : endSample;
    return end - this.speechStart >= Math.round((this.p.minSpeechMs * SAMPLE_RATE) / 1000) ? [{ type: "end", range: { startSample: this.speechStart, endSample: end }, forced: false }] : [];
  }
}

/** Offline helper: probabilities (one per window) → speech regions. */
export function regionsFromProbabilities(probs: ArrayLike<number>, startSample: number, params: Partial<VadParams> = {}): TimeRange[] {
  const seg = new VadSegmenter(params);
  const win = params.windowSamples ?? DEFAULT_VAD.windowSamples;
  const out: TimeRange[] = [];
  const take = (evs: VadEvent[]) => evs.forEach((e) => e.type === "end" && out.push(e.range));
  for (let i = 0; i < probs.length; i++) take(seg.push(probs[i]!, startSample + i * win));
  take(seg.flush(startSample + probs.length * win));
  // Forced cuts are for live bounding only; offline regions merge them back.
  const merged: TimeRange[] = [];
  for (const r of out) {
    const last = merged[merged.length - 1];
    if (last && r.startSample <= last.endSample) last.endSample = Math.max(last.endSample, r.endSample);
    else merged.push({ ...r });
  }
  return merged;
}
