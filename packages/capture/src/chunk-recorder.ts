import { concatBytes, errorMessage, SAMPLE_RATE, sleep, type AudioFrame } from "@irl/domain";
import { writeVerified, type BlobStore, type Repository, type Sealer } from "@irl/storage";

export interface ChunkRecorderOptions {
  repo: Repository;
  blobs: BlobStore;
  sealer: Sealer;
  recordingId: string;
  chunkSeconds?: number;
  /** Continue numbering after chunks written before a pause or crash. */
  startSequence?: number;
  onError?: (message: string) => void;
  onChunk?: (info: { sequence: number; endSample: number; pendingChunks: number }) => void;
}

export function chunkPath(recordingId: string, sequence: number, keyKind: "durable" | "ephemeral", codec = "pcm"): string {
  const dir = keyKind === "ephemeral" ? "scratch" : "rec";
  return `${dir}/${recordingId}/${String(sequence).padStart(6, "0")}.${codec}`;
}

/**
 * Persists ordered, sealed, checksummed PCM chunks every few seconds and advances the recording's
 * recovery cursor only after each chunk verifies (plan.md §9). `push` never awaits, so capture is never
 * blocked by storage; failed writes are retried and kept in memory until they succeed.
 */
export class ChunkRecorder {
  private readonly chunkSamples: number;
  private buffer: Uint8Array[] = [];
  private bufferStart: number | null = null;
  private bufferSamples = 0;
  private sequence: number;
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  writtenChunks = 0;
  failedWrites = 0;
  /** Chunks that could not be persisted after retries (audio still usable in this session). */
  readonly unwritten: { sequence: number; startSample: number; endSample: number; pcm: Uint8Array }[] = [];
  lastError: string | null = null;

  constructor(private readonly opts: ChunkRecorderOptions) {
    this.chunkSamples = Math.round((opts.chunkSeconds ?? 5) * SAMPLE_RATE);
    this.sequence = opts.startSequence ?? 0;
  }

  get pendingChunks(): number {
    return this.pending;
  }

  push(frame: AudioFrame): void {
    // A discontinuity (resume after pause) closes the current chunk so every chunk is contiguous.
    if (this.bufferStart !== null && frame.startSample !== this.bufferStart + this.bufferSamples) this.cut();
    this.bufferStart ??= frame.startSample;
    this.buffer.push(frame.pcm);
    this.bufferSamples += frame.pcm.byteLength / 2;
    if (this.bufferSamples >= this.chunkSamples) this.cut();
  }

  private cut(): void {
    if (this.bufferStart === null || this.bufferSamples === 0) return;
    const pcm = concatBytes(this.buffer);
    const start = this.bufferStart;
    const end = start + this.bufferSamples;
    const seq = this.sequence++;
    this.buffer = [];
    this.bufferStart = null;
    this.bufferSamples = 0;
    this.pending++;
    this.tail = this.tail.then(() => this.write(seq, start, end, pcm));
  }

  private async write(sequence: number, startSample: number, endSample: number, pcm: Uint8Array): Promise<void> {
    const { repo, blobs, sealer, recordingId } = this.opts;
    const path = chunkPath(recordingId, sequence, sealer.kind);
    for (let attempt = 0; ; attempt++) {
      try {
        const sealed = await sealer.seal(pcm);
        const checksum = await writeVerified(blobs, path, sealed);
        await repo.putChunk({ recordingId, sequence, startSample, endSample, codec: "pcm_s16le", path, byteLength: sealed.byteLength, checksum, keyKind: sealer.kind, verified: true, createdAt: new Date().toISOString() });
        await repo.updateRecording(recordingId, (r) => ({ recoveryCursor: Math.max(r.recoveryCursor, endSample), totalSamples: Math.max(r.totalSamples, endSample) }));
        this.pending--;
        this.writtenChunks++;
        this.opts.onChunk?.({ sequence, endSample, pendingChunks: this.pending });
        return;
      } catch (e) {
        this.failedWrites++;
        this.lastError = errorMessage(e);
        this.opts.onError?.(`chunk ${sequence} write failed (attempt ${attempt + 1}): ${this.lastError}`);
        if (attempt >= 6) {
          // Storage is persistently failing: keep the audio in memory so processing can still use it.
          this.pending--;
          this.unwritten.push({ sequence, startSample, endSample, pcm });
          return;
        }
        await sleep(Math.min(10_000, 250 * 2 ** attempt));
      }
    }
  }

  /** Writes the partial chunk and waits for every queued write. */
  async flush(): Promise<void> {
    this.cut();
    await this.tail;
  }

  get nextSequence(): number {
    return this.sequence;
  }
}
