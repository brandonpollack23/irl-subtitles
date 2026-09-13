import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import {
  AsyncQueue,
  defaultSettings,
  float32ToPcm,
  l2normalize,
  newId,
  SAMPLE_RATE,
  sleep,
  type AudioFrame,
  type ConversationSummary,
  type LiveSpeechProvider,
  type LiveSpeechRun,
  type SpeechEvent,
  type TimeRange,
  type VoiceEmbedding,
} from "@irl/domain";
import { RecordingAudio, type AudioSource, type PcmSink } from "@irl/capture";
import { KeyVault, MemoryBlobStore, Repository, SettingsStore, SqlTableStore } from "@irl/storage";
import { nodeSqliteDriver } from "../../storage/test/node-sqlite-driver";
import {
  EphemeralKeys,
  IdentityService,
  PostProcessor,
  RecordingController,
  deleteRecording,
  exportRecording,
  loadTranscript,
  recoverInterrupted,
  type ProcessingToolkit,
} from "../src";

const SPACE = "fake-space";
/** Speaker identity is encoded in the audio amplitude so fakes can "hear" who is talking. */
const voiceOf = (samples: Float32Array) => (Math.abs(samples[Math.floor(samples.length / 2)] ?? 0) > 0.3 ? "B" : "A");
const vectorFor = (voice: string) => l2normalize(voice === "A" ? new Float32Array([1, 0.05, 0]) : new Float32Array([0.05, 1, 0]));

class ManualSource implements AudioSource {
  readonly kind = "wav-file" as const;
  readonly label = "manual";
  sink: PcmSink | null = null;
  async start(sink: PcmSink) {
    this.sink = sink;
  }
  async stop() {
    this.sink = null;
  }
  feed(seconds: number, voice: "A" | "B") {
    for (let i = 0; i < seconds * 10; i++) this.sink?.(float32ToPcm(new Float32Array(1600).fill(voice === "A" ? 0.1 : 0.5)));
  }
}

class FakeLiveProvider implements LiveSpeechProvider {
  readonly id = "fake-live";
  readonly capabilities = { transcription: "streaming", diarization: "streaming", persistentIdentity: true, languages: ["en"], execution: "local" } as const;
  async start(config: { recordingId: string; providerRunId: string }): Promise<LiveSpeechRun> {
    const events = new AsyncQueue<SpeechEvent>();
    let acc = 0;
    let n = 0;
    const clusters = new Map<string, number>();
    return {
      providerRunId: config.providerRunId,
      events,
      push: (frame: AudioFrame) => {
        acc += frame.pcm.byteLength / 2;
        if (acc < SAMPLE_RATE * 2) return;
        acc = 0;
        const end = frame.startSample + frame.pcm.byteLength / 2;
        const start = end - SAMPLE_RATE * 2;
        const view = new DataView(frame.pcm.buffer, frame.pcm.byteOffset);
        const voice = Math.abs(view.getInt16(0, true) / 32768) > 0.3 ? "B" : "A";
        const clusterId = `L${voice === "A" ? 1 : 2}`;
        if (!clusters.has(clusterId)) {
          clusters.set(clusterId, clusters.size + 1);
          events.push({ type: "cluster", clusterId, ordinal: clusters.get(clusterId)! });
        }
        events.push({ type: "tokens", replaceProvisional: true, tokens: [{ id: newId("t"), recordingId: config.recordingId, providerRunId: config.providerRunId, startSample: start, endSample: end, text: ` live${n++}`, final: true, timing: "segment-interpolated" }] });
        events.push({ type: "turns", turns: [{ id: newId("turn"), recordingId: config.recordingId, providerRunId: config.providerRunId, clusterId, startSample: start, endSample: end, final: true }] });
        events.push({ type: "window", clusterId, embedding: { startSample: start, endSample: end, vector: vectorFor(voice), embeddingSpace: SPACE, quality: 0.9 } });
      },
      finish: async () => events.close(),
      abort: async () => events.close(),
    };
  }
}

function fakeToolkit(): ProcessingToolkit {
  return {
    catalog: () => [],
    embeddingSpace: () => SPACE,
    detectSpeech: async (_m, samples, start) => [{ startSample: start, endSample: start + samples.length }],
    transcribe: async (_m, samples, start) => {
      const words = [];
      for (let s = 0; s + SAMPLE_RATE <= samples.length; s += SAMPLE_RATE) words.push({ text: ` ${voiceOf(samples.subarray(s, s + SAMPLE_RATE)) === "A" ? "alpha" : "bravo"}`, startSample: start + s, endSample: start + s + SAMPLE_RATE });
      return { words, language: "en", timing: "word" };
    },
    embed: async (_m, windows) => windows.map((w): VoiceEmbedding => ({ ...w.range, vector: vectorFor(voiceOf(w.samples)), embeddingSpace: SPACE, quality: 0.9 })),
    windowGrid: (regions) => regions.flatMap((r) => {
      const out: TimeRange[] = [];
      for (let s = r.startSample; s + 2 * SAMPLE_RATE <= r.endSample; s += SAMPLE_RATE) out.push({ startSample: s, endSample: s + 2 * SAMPLE_RATE });
      return out;
    }),
    cluster: (vectors, initial) => {
      const labels = vectors.map((v, i) => initial[i] ?? (v[0]! > v[1]! ? 0 : 1));
      return { labels, merges: [] };
    },
    mergeThreshold: () => 0.8,
    liveProvider: () => new FakeLiveProvider(),
    summaryProvider: () => ({
      id: "fake-summary",
      summarize: async (input): Promise<ConversationSummary> => ({
        title: "Fake meeting", overview: `[[${input.segments[0]?.clusterId}]] talked`, keyPoints: [{ text: "k", sourceSegmentIds: [input.segments[0]!.id] }], decisions: [], actionItems: [], openQuestions: [],
        generatedAt: new Date().toISOString(), providerId: "fake-summary", sourceTranscriptRevision: input.transcriptRevision,
      }),
    }),
    release: async () => undefined,
  };
}

async function setup() {
  const repo = new Repository(await SqlTableStore.open(nodeSqliteDriver()));
  const blobs = new MemoryBlobStore();
  const vault = await KeyVault.open(new IDBFactory());
  const durable = await vault.durableSealer();
  const ephemeral = new EphemeralKeys();
  const settings = await SettingsStore.open(repo, defaultSettings({ vad: "vad", sttLive: "stt", sttFinal: "stt-final", speakerEmbedding: "emb", summary: "llm" }));
  const audio = new RecordingAudio(repo, blobs, (kind, id) => (kind === "durable" ? durable : ephemeral.get(id)));
  const toolkit = fakeToolkit();
  const identity = new IdentityService(repo, blobs, durable, audio, () => settings.get(), toolkit.embed);
  const captured: string[] = [];
  let controller!: RecordingController;
  const post = new PostProcessor({ repo, blobs, audio, toolkit, identity, settings, ephemeral, durable, isCapturing: () => controller.activeRecordingId !== null });
  controller = new RecordingController({
    repo, blobs, durable, ephemeral, settings, identity,
    providers: async () => new FakeLiveProvider(),
    createSource: async () => new ManualSource(),
    onCaptured: (id) => {
      captured.push(id);
      post.enqueue(id);
    },
  });
  const waitDone = (id: string) => new Promise<void>((ok) => post.events.on((e) => e.recordingId === id && e.stage === "done" && ok()));
  return { repo, blobs, durable, ephemeral, settings, audio, identity, post, controller, captured, waitDone };
}

async function record(env: Awaited<ReturnType<typeof setup>>, script: ["A" | "B", number][], persistAudio = true) {
  const source = new ManualSource();
  const id = await env.controller.start({ source, persistAudio });
  for (const [voice, seconds] of script) source.feed(seconds, voice);
  await sleep(1200);
  const done = env.waitDone(id);
  await env.controller.stop();
  await done;
  return id;
}

describe("recording pipeline", () => {
  it("captures, post-processes, names a speaker, recognizes them later, undoes, exports, and deletes", async () => {
    const env = await setup();
    const id = await record(env, [["A", 12], ["B", 12]]);
    const rec = (await env.repo.getRecording(id))!;
    expect(rec.state).toBe("ready");
    expect(rec.audioRetention).toBe("persisted");
    expect(rec.totalSamples).toBe(24 * SAMPLE_RATE);
    expect(rec.recoveryCursor).toBe(24 * SAMPLE_RATE);
    expect(rec.processing.finalStt.status).toBe("done");
    expect(rec.processing.diarization.status).toBe("done");
    expect(rec.title).toBe("Fake meeting");

    const t = await loadTranscript(env.repo, id);
    expect(t.segments.length).toBeGreaterThanOrEqual(2);
    expect(t.segments[0]!.text).toMatch(/^alpha/);
    expect(t.segments.at(-1)!.text).toMatch(/bravo$/);
    const speakerA = t.segments[0]!.clusterId!;
    expect(t.segments.at(-1)!.clusterId).not.toBe(speakerA);
    expect((await env.repo.getSummary(id))?.status).toBe("ready");

    // Name Speaker A and learn the voice.
    const { operationId, personId } = await env.identity.assign({ recordingId: id, clusterId: speakerA, person: { fullName: "Alice Liddell", shortName: "Alice" }, learnVoice: true });
    const summary = await env.identity.profileSummary(personId!);
    expect(summary.profiles[0]?.prototypes).toBe(1);
    expect(summary.profiles[0]?.clips).toBeGreaterThan(0);
    const exported = await exportRecording(env.repo, id);
    expect(exported.markdown).toContain("Alice Liddell — confirmed by you");
    expect(exported.json.speakers.find((s) => s.clusterId === speakerA)?.kind).toBe("confirmed");

    // A later recording with Alice speaking enough is recognized automatically; Bob stays unknown.
    const id2 = await record(env, [["A", 12], ["B", 4]], false);
    const rec2 = (await env.repo.getRecording(id2))!;
    expect(rec2.audioRetention).toBe("deleted");
    expect(await env.repo.listChunks(id2)).toEqual([]);
    const exported2 = await exportRecording(env.repo, id2);
    const alice = exported2.json.speakers.find((s) => s.label === "Alice Liddell");
    expect(alice?.kind).toBe("auto");
    expect(exported2.json.speakers.filter((s) => s.kind === "anonymous").length).toBe(1);

    // Undo the enrollment: attribution and profile samples are removed, the created person too.
    await env.identity.undo(operationId);
    expect(await env.repo.getPerson(personId!)).toBeUndefined();
    expect((await env.identity.profileSummary(personId!)).profiles.every((p) => p.prototypes === 0)).toBe(true);

    // Deleting the first recording keeps people; audio blobs are gone.
    await deleteRecording(env.repo, env.blobs, id, { removeVoiceSamples: false });
    expect(await env.repo.getRecording(id)).toBeUndefined();
    expect(await env.blobs.list(`rec/${id}/`)).toEqual([]);
  }, 30_000);

  it("recovers an interrupted recording and never resumes capture", async () => {
    const env = await setup();
    const source = new ManualSource();
    const id = await env.controller.start({ source, persistAudio: true });
    source.feed(11, "A");
    await sleep(800);
    // Simulate process death: a fresh launch sees the recording row still in "recording".
    const relaunchAudio = new RecordingAudio(env.repo, env.blobs, (kind) => (kind === "durable" ? env.durable : null));
    const recovered = await recoverInterrupted(env.repo, env.blobs, relaunchAudio, null);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]!.recording.state).toBe("interrupted");
    expect(recovered[0]!.recoveredSamples).toBe(10 * SAMPLE_RATE);
    expect(recovered[0]!.audioLost).toBe(false);
    expect(source.sink).not.toBeNull(); // the old controller's source; the relaunch never touched capture
    void id;
  });
});
