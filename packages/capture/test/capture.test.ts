import { describe, expect, it } from "vitest";
import { emptyProcessing, float32ToPcm, type Recording } from "@irl/domain";
import { MemoryBlobStore, Repository, SqlTableStore, ephemeralSealer } from "@irl/storage";
import { nodeSqliteDriver } from "../../storage/test/node-sqlite-driver";
import { ChunkRecorder } from "../src/chunk-recorder";
import { RecordingAudio } from "../src/recording-audio";
import { FrameSequencer } from "../src/sequencer";

function rec(id: string): Recording {
  return {
    id, createdAt: "x", startedAt: "x", endedAt: null, state: "recording", audioRetention: "ephemeral", language: "en", provider: "local",
    models: { vad: "v", sttLive: "off", sttFinal: "same-as-live", speakerEmbedding: "e", summary: "off" }, modelVersions: {},
    totalSamples: 0, recoveryCursor: 0, title: null, markers: [], processing: emptyProcessing(), transcriptRevision: 0, degraded: null, gaps: 0, error: null,
  };
}

describe("FrameSequencer", () => {
  it("assigns sample offsets, carries odd bytes, and reports gaps", () => {
    let t = 0;
    const seq = new FrameSequencer("s", 0, 0, () => t);
    const a = seq.push(new Uint8Array(3201))!;
    expect(a.frame.startSample).toBe(0);
    expect(a.frame.pcm.byteLength).toBe(3200);
    t = 100;
    const b = seq.push(new Uint8Array(3199))!;
    expect(b.frame.startSample).toBe(1600);
    expect(b.frame.pcm.byteLength).toBe(3200);
    expect(b.gap).toBeNull();
    t = 1300;
    const c = seq.push(new Uint8Array(3200))!;
    expect(c.gap).toEqual({ atSample: 3200, missingMs: 1100 });
    seq.resetClock();
    t = 99999;
    expect(seq.push(new Uint8Array(3200))!.gap).toBeNull();
  });
});

describe("ChunkRecorder + RecordingAudio", () => {
  it("writes verified chunks, advances the recovery cursor, and reads ranges back", async () => {
    const repo = new Repository(await SqlTableStore.open(nodeSqliteDriver()));
    const blobs = new MemoryBlobStore();
    const sealer = await ephemeralSealer();
    await repo.putRecording(rec("r"));
    const recorder = new ChunkRecorder({ repo, blobs, sealer, recordingId: "r", chunkSeconds: 1 });
    const seq = new FrameSequencer("r");
    // 2.5 s ramp so every sample is distinguishable.
    const all = new Float32Array(40000).map((_, i) => ((i % 1000) - 500) / 1000);
    for (let off = 0; off < all.length; off += 1600) recorder.push(seq.push(float32ToPcm(all.subarray(off, off + 1600)))!.frame);
    await recorder.flush();
    const chunks = await repo.listChunks("r");
    expect(chunks.map((c) => [c.startSample, c.endSample])).toEqual([[0, 16000], [16000, 32000], [32000, 40000]]);
    expect(chunks.every((c) => c.path.startsWith("scratch/") && c.keyKind === "ephemeral")).toBe(true);
    expect((await repo.getRecording("r"))!.recoveryCursor).toBe(40000);

    const audio = new RecordingAudio(repo, blobs, (kind) => (kind === "ephemeral" ? sealer : null));
    const slice = await audio.readRange("r", { startSample: 15000, endSample: 17000 });
    expect(slice.length).toBe(2000);
    expect(slice[0]).toBeCloseTo(all[15000]!, 3);
    expect(slice[1999]).toBeCloseTo(all[16999]!, 3);

    // Corrupt the middle chunk: verification reports it and reads fill silence.
    const mid = chunks[1]!;
    const bytes = (await blobs.read(mid.path))!;
    bytes[20] = bytes[20]! ^ 0xff;
    await blobs.write(mid.path, bytes);
    audio.clearCache();
    const v = await audio.verify("r");
    expect(v.badChunks.map((c) => c.sequence)).toEqual([1]);
    expect((await audio.readRange("r", { startSample: 16000, endSample: 16010 }))[5]).toBe(0);

    // A fresh ephemeral key (next launch) cannot read anything.
    const other = await ephemeralSealer();
    const relaunch = new RecordingAudio(repo, blobs, () => other);
    expect((await relaunch.verify("r")).readableChunks).toBe(0);
  });
});
