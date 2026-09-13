export const SAMPLE_RATE = 16_000;
export const BYTES_PER_SAMPLE = 2;

/** 44-byte canonical WAV header for mono s16le. */
export function wavHeader(dataBytes: number, sampleRate = SAMPLE_RATE): Uint8Array {
  const h = new DataView(new ArrayBuffer(44));
  const ascii = (off: number, s: string) => [...s].forEach((ch, i) => h.setUint8(off + i, ch.charCodeAt(0)));
  ascii(0, "RIFF");
  h.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  h.setUint32(16, 16, true);
  h.setUint16(20, 1, true); // PCM
  h.setUint16(22, 1, true); // mono
  h.setUint32(24, sampleRate, true);
  h.setUint32(28, sampleRate * BYTES_PER_SAMPLE, true);
  h.setUint16(32, BYTES_PER_SAMPLE, true);
  h.setUint16(34, 16, true);
  ascii(36, "data");
  h.setUint32(40, dataBytes, true);
  return new Uint8Array(h.buffer);
}

export function pcmToFloat32(pcm: Uint8Array): Float32Array {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const out = new Float32Array(Math.floor(pcm.byteLength / 2));
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true) / 32768;
  return out;
}

/** RMS level in dBFS of s16le PCM; -Infinity for digital silence. */
export function rmsDbfs(pcm: Uint8Array): number {
  const f = pcmToFloat32(pcm);
  if (f.length === 0) return -Infinity;
  let acc = 0;
  for (const v of f) acc += v * v;
  return 10 * Math.log10(acc / f.length);
}
