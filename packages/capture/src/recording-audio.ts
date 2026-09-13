import { crc32, float32ToPcm, pcmToFloat32, wavHeader, type TimeRange } from "@irl/domain";
import type { AudioChunkRow, BlobStore, KeyKind, Repository, Sealer } from "@irl/storage";
import { decodeOpus } from "./opus";

export type SealerLookup = (keyKind: KeyKind, recordingId: string) => Sealer | null;

/** In-memory audio for chunks that never reached storage (see ChunkRecorder.unwritten). */
export type MemoryChunks = (recordingId: string) => { startSample: number; endSample: number; pcm: Uint8Array }[];

export class ChunkUnreadableError extends Error {}

/**
 * Reads recording audio back from sealed chunks (PCM or Opus) as 16 kHz Float32. Used by the final STT
 * pass, speaker embedding, voice clips, playback, and Soniox overlap resends. Missing chunks read as
 * silence so sample offsets stay aligned.
 */
export class RecordingAudio {
  private cache = new Map<string, Float32Array>();
  private readonly cacheLimit = 24;

  constructor(
    private readonly repo: Repository,
    private readonly blobs: BlobStore,
    private readonly sealers: SealerLookup,
    private readonly memory: MemoryChunks = () => [],
  ) {}

  async decodeChunk(chunk: AudioChunkRow): Promise<Float32Array> {
    const key = `${chunk.path}:${chunk.checksum}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const sealed = await this.blobs.read(chunk.path);
    if (!sealed) throw new ChunkUnreadableError(`chunk file missing: ${chunk.path}`);
    if (crc32(sealed) !== chunk.checksum) throw new ChunkUnreadableError(`checksum mismatch: ${chunk.path}`);
    const sealer = this.sealers(chunk.keyKind, chunk.recordingId);
    if (!sealer) throw new ChunkUnreadableError(`no ${chunk.keyKind} key for ${chunk.recordingId}`);
    const plain = await sealer.open(sealed);
    const samples = chunk.codec === "opus" ? await decodeOpus(plain) : pcmToFloat32(plain);
    this.cache.set(key, samples);
    if (this.cache.size > this.cacheLimit) this.cache.delete(this.cache.keys().next().value!);
    return samples;
  }

  async readRange(recordingId: string, range: TimeRange, chunks?: AudioChunkRow[]): Promise<Float32Array> {
    const len = Math.max(0, range.endSample - range.startSample);
    const out = new Float32Array(len);
    const rows = chunks ?? (await this.repo.listChunks(recordingId));
    const sources: { startSample: number; endSample: number; load: () => Promise<Float32Array> }[] = [
      ...rows.map((c) => ({ startSample: c.startSample, endSample: c.endSample, load: () => this.decodeChunk(c) })),
      ...this.memory(recordingId).map((m) => ({ startSample: m.startSample, endSample: m.endSample, load: async () => pcmToFloat32(m.pcm) })),
    ];
    for (const src of sources) {
      const a = Math.max(range.startSample, src.startSample);
      const b = Math.min(range.endSample, src.endSample);
      if (b <= a) continue;
      try {
        const samples = await src.load();
        out.set(samples.subarray(a - src.startSample, b - src.startSample), a - range.startSample);
      } catch (e) {
        if (!(e instanceof ChunkUnreadableError)) throw e;
      }
    }
    return out;
  }

  /** Verified end of contiguous readable audio, for crash recovery. */
  async verify(recordingId: string): Promise<{ readableChunks: number; badChunks: AudioChunkRow[]; lastSample: number }> {
    const rows = await this.repo.listChunks(recordingId);
    const bad: AudioChunkRow[] = [];
    let last = 0;
    let readable = 0;
    for (const c of rows) {
      const sealed = await this.blobs.read(c.path);
      const sealer = this.sealers(c.keyKind, recordingId);
      let ok = !!sealed && crc32(sealed) === c.checksum && !!sealer;
      if (ok) {
        try {
          await sealer!.open(sealed!);
        } catch {
          ok = false;
        }
      }
      if (ok) {
        readable++;
        last = Math.max(last, c.endSample);
      } else bad.push(c);
    }
    return { readableChunks: readable, badChunks: bad, lastSample: last };
  }

  /** WAV for playback/export, assembled chunk by chunk. */
  async wav(recordingId: string): Promise<Blob> {
    const rows = await this.repo.listChunks(recordingId);
    const parts: BlobPart[] = [];
    let bytes = 0;
    for (const c of rows) {
      try {
        const pcm = float32ToPcm(await this.decodeChunk(c));
        parts.push(pcm as BlobPart);
        bytes += pcm.byteLength;
      } catch (e) {
        if (!(e instanceof ChunkUnreadableError)) throw e;
      }
    }
    return new Blob([wavHeader(bytes) as BlobPart, ...parts], { type: "audio/wav" });
  }

  clearCache(): void {
    this.cache.clear();
  }
}
