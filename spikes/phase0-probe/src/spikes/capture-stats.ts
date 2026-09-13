import { BYTES_PER_SAMPLE, SAMPLE_RATE } from "../util/pcm";

export interface Gap {
  /** Wall ms since the first frame when the late frame arrived. */
  atWallMs: number;
  /** Sample cursor at the late frame (what a sample clock would believe). */
  atSample: number;
  gapMs: number;
  visibility: string;
}

export interface FrameStatsSummary {
  frames: number;
  bytes: number;
  samples: number;
  oddByteFrames: number;
  wallSeconds: number;
  audioSeconds: number;
  /** samples / wall time; ~16000 when nothing is dropped. */
  effectiveSampleRate: number;
  /** audio time / wall time, as a percentage. */
  coveragePct: number;
  frameSizes: Record<number, number>;
  interArrivalMs: { p50: number; p95: number; max: number };
  gapCount: number;
  totalGapMs: number;
  gaps: Gap[];
}

/**
 * Tracks arrival timing of PCM frames against a sample clock so drops, stalls,
 * and suspensions show up as a wall-time vs audio-time deficit.
 */
export class FrameStats {
  private firstAt: number | null = null;
  private lastAt: number | null = null;
  private frames = 0;
  private bytes = 0;
  private oddByteFrames = 0;
  private readonly frameSizes = new Map<number, number>();
  private readonly gaps: Gap[] = [];
  private gapCount = 0;
  private totalGapMs = 0;
  // Bounded reservoir of inter-arrival times; a 60-minute soak produces ~36k frames.
  private readonly interArrival: number[] = [];
  private maxInterArrival = 0;

  constructor(
    private readonly gapThresholdMs = 500,
    private readonly maxGapsKept = 500,
    private readonly reservoirSize = 20_000,
  ) {}

  push(nowMs: number, byteLength: number, visibility = "visible"): Gap | null {
    let gap: Gap | null = null;
    if (this.firstAt === null) this.firstAt = nowMs;
    if (this.lastAt !== null) {
      const dt = nowMs - this.lastAt;
      this.maxInterArrival = Math.max(this.maxInterArrival, dt);
      if (this.interArrival.length < this.reservoirSize) this.interArrival.push(dt);
      else this.interArrival[this.frames % this.reservoirSize] = dt;
      if (dt >= this.gapThresholdMs) {
        gap = { atWallMs: Math.round(nowMs - this.firstAt), atSample: this.bytes / BYTES_PER_SAMPLE, gapMs: Math.round(dt), visibility };
        this.gapCount++;
        this.totalGapMs += dt;
        if (this.gaps.length < this.maxGapsKept) this.gaps.push(gap);
      }
    }
    this.lastAt = nowMs;
    this.frames++;
    this.bytes += byteLength;
    if (byteLength % BYTES_PER_SAMPLE !== 0) this.oddByteFrames++;
    this.frameSizes.set(byteLength, (this.frameSizes.get(byteLength) ?? 0) + 1);
    return gap;
  }

  get lastFrameAt(): number | null {
    return this.lastAt;
  }

  summary(nowMs = this.lastAt ?? 0): FrameStatsSummary {
    const wallSeconds = this.firstAt === null ? 0 : (nowMs - this.firstAt) / 1000;
    const samples = Math.floor(this.bytes / BYTES_PER_SAMPLE);
    const audioSeconds = samples / SAMPLE_RATE;
    const sorted = [...this.interArrival].sort((a, b) => a - b);
    const pick = (p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]! : 0);
    return {
      frames: this.frames,
      bytes: this.bytes,
      samples,
      oddByteFrames: this.oddByteFrames,
      wallSeconds: Math.round(wallSeconds * 10) / 10,
      audioSeconds: Math.round(audioSeconds * 10) / 10,
      effectiveSampleRate: wallSeconds > 0 ? Math.round(samples / wallSeconds) : 0,
      coveragePct: wallSeconds > 0 ? Math.round((audioSeconds / wallSeconds) * 1000) / 10 : 0,
      frameSizes: Object.fromEntries(this.frameSizes),
      interArrivalMs: { p50: Math.round(pick(0.5)), p95: Math.round(pick(0.95)), max: Math.round(this.maxInterArrival) },
      gapCount: this.gapCount,
      totalGapMs: Math.round(this.totalGapMs),
      gaps: this.gaps,
    };
  }
}
