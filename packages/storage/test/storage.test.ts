import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { emptyProcessing, type Recording, type TranscriptToken } from "@irl/domain";
import { IdbTableStore } from "../src/idb-store";
import { KeyVault, ephemeralSealer } from "../src/crypto";
import { MemoryBlobStore, writeVerified, IdbBlobStore } from "../src/blobs";
import { Repository } from "../src/repository";
import { VaultSecretStore } from "../src/secrets";
import { SqlTableStore } from "../src/sql-store";
import { nodeSqliteDriver } from "./node-sqlite-driver";

function recording(id: string, createdAt = "2026-09-13T10:00:00Z"): Recording {
  return {
    id,
    createdAt,
    startedAt: null,
    endedAt: null,
    state: "starting",
    audioRetention: "persisted",
    language: "en",
    provider: "local",
    models: { vad: "silero", sttLive: "off", sttFinal: "same-as-live", speakerEmbedding: "campplus", summary: "off" },
    modelVersions: {},
    totalSamples: 0,
    recoveryCursor: 0,
    title: null,
    markers: [],
    processing: emptyProcessing(),
    transcriptRevision: 0,
    degraded: null,
    gaps: 0,
    error: null,
  };
}

const backends: [string, () => Promise<Repository>][] = [
  ["sqlite", async () => new Repository(await SqlTableStore.open(nodeSqliteDriver()))],
  ["indexeddb", async () => new Repository(await IdbTableStore.open(`t-${Math.random()}`, new IDBFactory()))],
];

describe.each(backends)("repository contract on %s", (_name, open) => {
  it("round-trips recordings with json, nullable and bool columns", async () => {
    const repo = await open();
    await repo.putRecording(recording("r1"));
    await repo.putRecording(recording("r2", "2026-09-14T10:00:00Z"));
    const got = await repo.getRecording("r1");
    expect(got).toEqual(recording("r1"));
    expect((await repo.listRecordings()).map((r) => r.id)).toEqual(["r2", "r1"]);
    await Promise.all([
      repo.updateRecording("r1", { state: "recording" }),
      repo.updateRecording("r1", (r) => ({ totalSamples: r.totalSamples + 16000 })),
      repo.updateRecording("r1", (r) => ({ markers: [...r.markers, { sample: 5, label: "m", createdAt: "x" }] })),
    ]);
    const updated = await repo.getRecording("r1");
    expect(updated).toMatchObject({ state: "recording", totalSamples: 16000 });
    expect(updated?.markers).toHaveLength(1);
    expect((await repo.recordingsInStates(["recording"])).map((r) => r.id)).toEqual(["r1"]);
  });

  it("stores chunks, tokens and blobs, and cascades recording deletion", async () => {
    const repo = await open();
    await repo.putRecording(recording("r1"));
    await repo.putChunk({ recordingId: "r1", sequence: 1, startSample: 80000, endSample: 160000, codec: "pcm_s16le", path: "r1/1", byteLength: 10, checksum: 42, keyKind: "durable", verified: true, createdAt: "x" });
    await repo.putChunk({ recordingId: "r1", sequence: 0, startSample: 0, endSample: 80000, codec: "pcm_s16le", path: "r1/0", byteLength: 10, checksum: 41, keyKind: "durable", verified: false, createdAt: "x" });
    expect((await repo.listChunks("r1")).map((c) => [c.sequence, c.verified])).toEqual([[0, false], [1, true]]);
    const tok = (id: string, start: number, final: boolean): TranscriptToken => ({ id, recordingId: "r1", providerRunId: "run", startSample: start, endSample: start + 10, text: id, final, timing: "word" });
    await repo.putTokens([tok("b", 20, true), tok("a", 10, false), { ...tok("c", 30, true), confidence: 0.5, language: "en" }]);
    expect((await repo.listTokens("r1")).map((t) => t.id)).toEqual(["a", "b", "c"]);
    expect((await repo.listTokens("r1"))[0]).not.toHaveProperty("confidence");
    await repo.deleteTokens("r1", (t) => !t.final);
    expect((await repo.listTokens("r1")).map((t) => t.id)).toEqual(["b", "c"]);
    await repo.putWindows([{ id: "w", recordingId: "r1", clusterId: "c1", startSample: 0, endSample: 1, embeddingSpace: "s", quality: 1, sealedVector: new Uint8Array([9, 8, 7]) }]);
    expect([...(await repo.listWindows("r1"))[0]!.sealedVector]).toEqual([9, 8, 7]);
    await repo.putSummary({ recordingId: "r1", status: "ready", summary: null, providerId: null, transcriptRevision: 1, error: null, updatedAt: "x" });
    await repo.deleteRecordingRows("r1");
    expect(await repo.getRecording("r1")).toBeUndefined();
    expect(await repo.listChunks("r1")).toEqual([]);
    expect(await repo.listTokens("r1")).toEqual([]);
    expect(await repo.getSummary("r1")).toBeUndefined();
  });

  it("keeps attribution history and settings", async () => {
    const repo = await open();
    await repo.putAttribution({ id: "a1", recordingId: "r", clusterId: "c", personId: "p", confidence: 1, source: "manual", revision: 1, operationId: "o1", createdAt: "x", undone: false });
    await repo.putAttribution({ id: "a2", recordingId: "r", clusterId: "c", personId: null, confidence: 1, source: "manual", revision: 2, operationId: "o2", createdAt: "x", undone: true });
    expect((await repo.listAttributions("r")).find((a) => a.id === "a2")?.personId).toBeNull();
    expect((await repo.attributionsForOperation("o1")).map((a) => a.id)).toEqual(["a1"]);
    await repo.putSetting("k", { nested: [1, 2] });
    expect(await repo.getSetting("k")).toEqual({ nested: [1, 2] });
  });
});

describe("crypto and secrets", () => {
  it("seals and opens with a non-extractable durable key that persists", async () => {
    const factory = new IDBFactory();
    const vault = await KeyVault.open(factory);
    const sealer = await vault.durableSealer();
    const sealed = await sealer.seal(new Uint8Array([1, 2, 3]));
    expect(sealed.byteLength).toBe(1 + 12 + 3 + 16);
    const again = await (await KeyVault.open(factory)).durableSealer();
    expect([...(await again.open(sealed))]).toEqual([1, 2, 3]);
    const key = await vault.key("master-v1");
    expect(key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("raw", key)).rejects.toThrow();
  });

  it("ephemeral keys cannot open data sealed by a previous session", async () => {
    const a = await ephemeralSealer();
    const b = await ephemeralSealer();
    const sealed = await a.seal(new Uint8Array([5]));
    await expect(b.open(sealed)).rejects.toThrow();
  });

  it("stores the Soniox key outside settings", async () => {
    const vault = await KeyVault.open(new IDBFactory());
    const secrets = await VaultSecretStore.open(vault);
    expect(await secrets.get("soniox_api_key")).toBeNull();
    await secrets.put("soniox_api_key", "sk-test-123");
    expect(await secrets.has("soniox_api_key")).toBe(true);
    expect(await secrets.get("soniox_api_key")).toBe("sk-test-123");
    await secrets.delete("soniox_api_key");
    expect(await secrets.get("soniox_api_key")).toBeNull();
  });

  it("verifies blob writes", async () => {
    for (const store of [new MemoryBlobStore(), await IdbBlobStore.open("b", new IDBFactory())]) {
      await writeVerified(store, "rec/0001", new Uint8Array([1, 2, 3]));
      await writeVerified(store, "rec/0002", new Uint8Array([4]));
      await writeVerified(store, "other/0001", new Uint8Array([4]));
      expect(await store.list("rec/")).toEqual(["rec/0001", "rec/0002"]);
      await store.deletePrefix("rec/");
      expect(await store.read("rec/0001")).toBeNull();
      expect(await store.read("other/0001")).not.toBeNull();
    }
  });
});
