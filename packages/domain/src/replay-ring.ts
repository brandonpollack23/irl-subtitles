import { float32ToPcm, pcmToFloat32, SAMPLE_RATE, type AudioFrame } from "./audio";

/** Context resent to a new connection before the last finalized sample. */
export const RECONNECT_OVERLAP_SAMPLES = SAMPLE_RATE;

/** Exponential reconnect backoff: 1 s, 2 s, 4 s… capped at 30 s. */
export function reconnectDelayMs(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** attempt);
}

/**
 * Recent audio a cloud stream keeps so a reconnect can resend from its last finalized sample (Soniox and Speechmatics
 * runs). Older audio than the ring holds comes from storage through `replay`.
 */
export class ReplayRing {
  private parts: { start: number; samples: Float32Array }[] = [];
  end = 0;

  constructor(private readonly seconds = 120) {}

  get start(): number {
    return this.parts[0]?.start ?? this.end;
  }

  push(frame: AudioFrame): void {
    const samples = pcmToFloat32(frame.pcm);
    this.parts.push({ start: frame.startSample, samples });
    this.end = frame.startSample + samples.length;
    while (this.parts.length && this.parts[0]!.start + this.parts[0]!.samples.length < this.end - this.seconds * SAMPLE_RATE) this.parts.shift();
  }

  /**
   * PCM for [fromSample, end): storage replay for what the ring dropped, then the ring. The ring part is read after
   * the replay resolves, so frames pushed meanwhile are included and nothing falls between the two.
   */
  async since(fromSample: number, replay?: (startSample: number, endSample: number) => Promise<Float32Array | null>): Promise<Uint8Array[]> {
    const out: Uint8Array[] = [];
    const ringStart = this.start;
    if (fromSample < ringStart && replay) {
      const older = await replay(fromSample, ringStart).catch(() => null);
      if (older) out.push(float32ToPcm(older));
    }
    const from = Math.max(fromSample, ringStart);
    for (const part of this.parts) {
      const partEnd = part.start + part.samples.length;
      if (partEnd <= from) continue;
      out.push(float32ToPcm(part.samples.subarray(Math.max(0, from - part.start))));
    }
    return out;
  }
}
