/**
 * Canonical audio clock (plan.md §5). Every timestamp is a sample index at 16 kHz, derived from
 * the number of captured samples, never from Date.now().
 *
 * Deviation from the plan's `bigint`: sample indices are integer `number`s. Number.MAX_SAFE_INTEGER
 * samples is ~17,800 years of 16 kHz audio, and plain numbers survive JSON, SQL, and IndexedDB
 * without custom codecs.
 */
export const SAMPLE_RATE = 16_000;
export const BYTES_PER_SAMPLE = 2;

export type SessionId = string;
export type RecordingId = SessionId;
export type PersonId = string;
export type ClusterId = string;

export interface AudioFrame {
  sessionId: SessionId;
  sequence: number;
  startSample: number;
  sampleRateHz: typeof SAMPLE_RATE;
  channels: 1;
  encoding: "pcm_s16le";
  pcm: Uint8Array;
}

export interface TimeRange {
  startSample: number;
  endSample: number;
}

export function frameSamples(frame: Pick<AudioFrame, "pcm">): number {
  return Math.floor(frame.pcm.byteLength / BYTES_PER_SAMPLE);
}

export function frameEnd(frame: AudioFrame): number {
  return frame.startSample + frameSamples(frame);
}

export function samplesToMs(samples: number): number {
  return (samples * 1000) / SAMPLE_RATE;
}

export function msToSamples(ms: number): number {
  return Math.round((ms * SAMPLE_RATE) / 1000);
}

export function rangeDurationMs(r: TimeRange): number {
  return samplesToMs(Math.max(0, r.endSample - r.startSample));
}

export function overlap(a: TimeRange, b: TimeRange): number {
  return Math.max(0, Math.min(a.endSample, b.endSample) - Math.max(a.startSample, b.startSample));
}

export function formatClock(samples: number): string {
  const total = Math.floor(samples / SAMPLE_RATE);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function pcmToFloat32(pcm: Uint8Array): Float32Array {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const out = new Float32Array(Math.floor(pcm.byteLength / 2));
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true) / 32768;
  return out;
}

export function float32ToPcm(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(i * 2, v < 0 ? Math.round(v * 32768) : Math.round(v * 32767), true);
  }
  return out;
}

/** RMS level in dBFS of s16le PCM; -Infinity for digital silence. */
export function rmsDbfs(samples: Float32Array): number {
  if (samples.length === 0) return -Infinity;
  let acc = 0;
  for (const v of samples) acc += v * v;
  return 10 * Math.log10(acc / samples.length);
}

/** 44-byte canonical WAV header for mono s16le. */
export function wavHeader(dataBytes: number, sampleRate = SAMPLE_RATE): Uint8Array {
  const h = new DataView(new ArrayBuffer(44));
  const ascii = (off: number, s: string) => [...s].forEach((ch, i) => h.setUint8(off + i, ch.charCodeAt(0)));
  ascii(0, "RIFF");
  h.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  h.setUint32(16, 16, true);
  h.setUint16(20, 1, true);
  h.setUint16(22, 1, true);
  h.setUint32(24, sampleRate, true);
  h.setUint32(28, sampleRate * BYTES_PER_SAMPLE, true);
  h.setUint16(32, BYTES_PER_SAMPLE, true);
  h.setUint16(34, 16, true);
  ascii(36, "data");
  h.setUint32(40, dataBytes, true);
  return new Uint8Array(h.buffer);
}

export interface DecodedWav {
  sampleRate: number;
  channels: number;
  /** Mono mixdown in [-1, 1]. */
  samples: Float32Array;
}

/** Parses PCM (8/16/24/32-bit int, 32-bit float) WAV files and mixes down to mono. */
export function parseWav(bytes: Uint8Array): DecodedWav {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (off: number) => String.fromCharCode(...bytes.subarray(off, off + 4));
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("not a RIFF/WAVE file");
  let off = 12;
  let format = 0, channels = 0, sampleRate = 0, bits = 0;
  let data: Uint8Array | null = null;
  while (off + 8 <= bytes.byteLength) {
    const id = tag(off);
    const size = view.getUint32(off + 4, true);
    const body = off + 8;
    if (id === "fmt ") {
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
      if (format === 0xfffe && size >= 26) format = view.getUint16(body + 24, true);
    } else if (id === "data") {
      data = bytes.subarray(body, Math.min(bytes.byteLength, body + size));
    }
    off = body + size + (size % 2);
  }
  if (!data || !channels || !sampleRate) throw new Error("WAV is missing fmt or data chunk");
  const bytesPer = bits / 8;
  const frames = Math.floor(data.byteLength / (bytesPer * channels));
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const out = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let acc = 0;
    for (let c = 0; c < channels; c++) {
      const p = (f * channels + c) * bytesPer;
      let v: number;
      if (format === 3 && bits === 32) v = dv.getFloat32(p, true);
      else if (bits === 16) v = dv.getInt16(p, true) / 32768;
      else if (bits === 8) v = (dv.getUint8(p) - 128) / 128;
      else if (bits === 24) v = ((dv.getUint8(p) | (dv.getUint8(p + 1) << 8) | (dv.getInt8(p + 2) << 16)) / 8388608);
      else if (bits === 32) v = dv.getInt32(p, true) / 2147483648;
      else throw new Error(`unsupported WAV sample format ${format}/${bits}`);
      acc += v;
    }
    out[f] = acc / channels;
  }
  return { sampleRate, channels, samples: out };
}

/** Linear-interpolation resampler; adequate for speech models at 16 kHz. */
export function resampleLinear(input: Float32Array, fromRate: number, toRate = SAMPLE_RATE): Float32Array {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(input.length - 1, i0 + 1);
    const t = pos - i0;
    out[i] = input[i0]! * (1 - t) + input[i1]! * t;
  }
  return out;
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

export function concatFloat32(parts: readonly Float32Array[]): Float32Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Float32Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
