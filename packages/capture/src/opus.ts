import { resampleLinear, SAMPLE_RATE } from "@irl/domain";

/**
 * Opus via WebCodecs (plan.md §8: 24–32 kbit/s, ~11–14 MB/hour). Container: "IRLO", u8 version,
 * u32 encoder sample rate, u32 original 16 kHz sample count, then [u16 length][packet]*.
 * WebCodecs is native code, so no WASM Opus build is bundled; when it is missing chunks stay PCM.
 */
const MAGIC = [0x49, 0x52, 0x4c, 0x4f];
const CANDIDATE_RATES = [16_000, 48_000];

interface CodecApis {
  AudioEncoder: typeof AudioEncoder;
  AudioDecoder: typeof AudioDecoder;
  AudioData: typeof AudioData;
}

function apis(): CodecApis | null {
  const g = globalThis as unknown as Partial<CodecApis>;
  return g.AudioEncoder && g.AudioDecoder && g.AudioData ? (g as CodecApis) : null;
}

let supportedRate: Promise<number | null> | null = null;

export function opusEncoderRate(bitrate = 32_000): Promise<number | null> {
  supportedRate ??= (async () => {
    const a = apis();
    if (!a) return null;
    for (const sampleRate of CANDIDATE_RATES) {
      try {
        const r = await a.AudioEncoder.isConfigSupported({ codec: "opus", sampleRate, numberOfChannels: 1, bitrate });
        if (r.supported) return sampleRate;
      } catch {
        /* try next */
      }
    }
    return null;
  })();
  return supportedRate;
}

export async function encodeOpus(samples16k: Float32Array, bitrate = 32_000): Promise<Uint8Array> {
  const a = apis();
  const rate = await opusEncoderRate(bitrate);
  if (!a || !rate) throw new Error("Opus encoding unsupported in this WebView");
  const input = rate === SAMPLE_RATE ? samples16k : resampleLinear(samples16k, SAMPLE_RATE, rate);
  const packets: Uint8Array[] = [];
  let failure: Error | null = null;
  const encoder = new a.AudioEncoder({
    output: (chunk) => {
      const buf = new Uint8Array(chunk.byteLength);
      chunk.copyTo(buf);
      packets.push(buf);
    },
    error: (e) => (failure = e as Error),
  });
  encoder.configure({ codec: "opus", sampleRate: rate, numberOfChannels: 1, bitrate });
  const frame = rate / 50; // 20 ms
  for (let off = 0; off < input.length; off += frame) {
    const slice = input.slice(off, Math.min(input.length, off + frame));
    encoder.encode(new a.AudioData({ format: "f32", sampleRate: rate, numberOfFrames: slice.length, numberOfChannels: 1, timestamp: Math.round((off / rate) * 1e6), data: slice }));
  }
  await encoder.flush();
  encoder.close();
  if (failure) throw failure;
  const size = 13 + packets.reduce((n, p) => n + 2 + p.byteLength, 0);
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set(MAGIC, 0);
  out[4] = 1;
  view.setUint32(5, rate, true);
  view.setUint32(9, samples16k.length, true);
  let off = 13;
  for (const p of packets) {
    view.setUint16(off, p.byteLength, true);
    out.set(p, off + 2);
    off += 2 + p.byteLength;
  }
  return out;
}

export async function decodeOpus(bytes: Uint8Array): Promise<Float32Array> {
  const a = apis();
  if (!a) throw new Error("Opus decoding unsupported in this WebView");
  if (!MAGIC.every((m, i) => bytes[i] === m)) throw new Error("not an IRLO container");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const rate = view.getUint32(5, true);
  const total = view.getUint32(9, true);
  const parts: Float32Array[] = [];
  let failure: Error | null = null;
  const decoder = new a.AudioDecoder({
    output: (data) => {
      const buf = new Float32Array(data.numberOfFrames);
      data.copyTo(buf, { planeIndex: 0, format: "f32-planar" });
      parts.push(buf);
      data.close();
    },
    error: (e) => (failure = e as Error),
  });
  decoder.configure({ codec: "opus", sampleRate: rate, numberOfChannels: 1 });
  let off = 13;
  let ts = 0;
  while (off + 2 <= bytes.byteLength) {
    const len = view.getUint16(off, true);
    const data = bytes.slice(off + 2, off + 2 + len);
    decoder.decode(new EncodedAudioChunk({ type: "key", timestamp: ts, data }));
    ts += 20_000;
    off += 2 + len;
  }
  await decoder.flush();
  decoder.close();
  if (failure) throw failure;
  const joined = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    joined.set(p, o);
    o += p.length;
  }
  const at16k = rate === SAMPLE_RATE ? joined : resampleLinear(joined, rate, SAMPLE_RATE);
  // Encoder priming shifts audio by a few ms; trim or pad the tail to the original length.
  const out = new Float32Array(total);
  out.set(at16k.subarray(0, total));
  return out;
}
