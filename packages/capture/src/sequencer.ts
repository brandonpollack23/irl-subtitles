import { SAMPLE_RATE, type AudioFrame } from "@irl/domain";

export interface GapReport {
  /** Sample index where audio resumed. */
  atSample: number;
  /** Wall-clock time with no audio beyond the expected frame spacing. */
  missingMs: number;
}

/**
 * Validates PCM (s16le, even byte length), assigns sequence numbers and sample offsets from the running
 * sample count, and reports delivery gaps (plan.md §4 G2AudioSource). Gaps are reported, never filled
 * with fabricated audio; the sample clock counts only captured samples.
 */
export class FrameSequencer {
  private sequence = 0;
  private sample: number;
  private carry: Uint8Array | null = null;
  private lastAt: number | null = null;
  private lastDurationMs = 0;
  gaps = 0;
  invalidFrames = 0;

  constructor(
    private readonly sessionId: string,
    startSample = 0,
    startSequence = 0,
    private readonly now: () => number = () => performance.now(),
    private readonly gapToleranceMs = 400,
  ) {
    this.sample = startSample;
    this.sequence = startSequence;
  }

  get nextSample(): number {
    return this.sample;
  }

  /** Call after pause/resume so the pause itself is not reported as a gap. */
  resetClock(): void {
    this.lastAt = null;
  }

  push(pcm: Uint8Array): { frame: AudioFrame; gap: GapReport | null } | null {
    if (!(pcm instanceof Uint8Array)) {
      this.invalidFrames++;
      return null;
    }
    let bytes = pcm;
    if (this.carry) {
      bytes = new Uint8Array(this.carry.byteLength + pcm.byteLength);
      bytes.set(this.carry);
      bytes.set(pcm, this.carry.byteLength);
      this.carry = null;
    }
    if (bytes.byteLength % 2 === 1) {
      this.carry = bytes.slice(bytes.byteLength - 1);
      bytes = bytes.subarray(0, bytes.byteLength - 1);
    }
    if (bytes.byteLength === 0) return null;
    const t = this.now();
    let gap: GapReport | null = null;
    if (this.lastAt !== null) {
      const missing = t - this.lastAt - this.lastDurationMs;
      if (missing > this.gapToleranceMs) {
        gap = { atSample: this.sample, missingMs: Math.round(missing) };
        this.gaps++;
      }
    }
    const samples = bytes.byteLength / 2;
    const frame: AudioFrame = {
      sessionId: this.sessionId,
      sequence: this.sequence++,
      startSample: this.sample,
      sampleRateHz: SAMPLE_RATE,
      channels: 1,
      encoding: "pcm_s16le",
      pcm: bytes.slice(),
    };
    this.sample += samples;
    this.lastAt = t;
    this.lastDurationMs = (samples / SAMPLE_RATE) * 1000;
    return { frame, gap };
  }
}
