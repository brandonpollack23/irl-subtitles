import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";
import {
  activeAttributions,
  AsyncQueue,
  defaultSettings,
  float32ToPcm,
  l2normalize,
  newId,
  SAMPLE_RATE,
  sleep,
  parseWav,
  type AudioFrame,
  type CloudFinalProvider,
  type FinalTranscriptJob,
  type ModelSelection,
  type ServiceSpeaker,
  type SpeakerTurn,
  type TranscriptToken,
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
  readonly id: string = "fake-live";
  readonly capabilities = { transcription: "streaming", diarization: "streaming", persistentIdentity: true, languages: ["en"], execution: "local" } as const;
  /** A cloud stream: service speaker labels ("S0-1"), no local voice windows. */
  constructor(private readonly cloud = false) {
    if (cloud) this.id = "fake-cloud-live";
  }
  async start(config: { recordingId: string; providerRunId: string }): Promise<LiveSpeechRun> {
    const cloud = this.cloud;
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
        const clusterId = `${cloud ? "S0-" : "L"}${voice === "A" ? 1 : 2}`;
        if (!clusters.has(clusterId)) {
          clusters.set(clusterId, clusters.size + 1);
          events.push({ type: "cluster", clusterId, ordinal: clusters.get(clusterId)! });
        }
        events.push({ type: "tokens", replaceProvisional: true, tokens: [{ id: newId("t"), recordingId: config.recordingId, providerRunId: config.providerRunId, startSample: start, endSample: end, text: ` live${n++}`, final: true, timing: "segment-interpolated" }] });
        events.push({ type: "turns", turns: [{ id: newId("turn"), recordingId: config.recordingId, providerRunId: config.providerRunId, clusterId, startSample: start, endSample: end, final: true }] });
        if (!cloud) events.push({ type: "window", clusterId, embedding: { startSample: start, endSample: end, vector: vectorFor(voice), embeddingSpace: SPACE, quality: 0.9 } });
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

/** A batch service that "hears" voices like the fakes and labels them S1/S2. */
function fakeCloudFinal(opts: { fail?: boolean; jobs?: FinalTranscriptJob[] } = {}): CloudFinalProvider {
  return {
    id: "fake-batch",
    transcribe: async (job) => {
      opts.jobs?.push(job);
      if (opts.fail) throw new Error("service unavailable");
      const { samples } = parseWav(job.wav);
      const tokens: TranscriptToken[] = [];
      const turns: SpeakerTurn[] = [];
      for (let s = 0; s + SAMPLE_RATE <= samples.length; s += SAMPLE_RATE) {
        const voice = voiceOf(samples.subarray(s, s + SAMPLE_RATE));
        tokens.push({ id: newId("tok"), recordingId: job.recordingId, providerRunId: job.providerRunId, startSample: s, endSample: s + SAMPLE_RATE, text: ` cloud-${voice}`, final: true, timing: "word" });
        const clusterId = `B-S${voice === "A" ? 1 : 2}`;
        const last = turns.at(-1);
        if (last?.clusterId === clusterId) last.endSample = s + SAMPLE_RATE;
        else turns.push({ id: newId("turn"), recordingId: job.recordingId, providerRunId: job.providerRunId, clusterId, startSample: s, endSample: s + SAMPLE_RATE, final: true });
      }
      const ids = [...new Set(turns.map((t) => t.clusterId))];
      return { tokens, turns, clusters: ids.map((clusterId, i) => ({ clusterId, ordinal: i + 1, providerLabel: clusterId.slice(2) })), language: "en" };
    },
  };
}

/**
 * Speechmatics voice ID stand-in: labels a voice with a saved person's token when the session sent identifiers for
 * that voice ("id-A"), otherwise S1/S2, and returns identifiers for every speaker at the end.
 */
class FakeVoiceIdProvider implements LiveSpeechProvider {
  readonly id = "fake-speechmatics";
  readonly capabilities = { transcription: "streaming", diarization: "fused-with-stt", persistentIdentity: true, languages: ["en"], execution: "cloud" } as const;
  sessions: ServiceSpeaker[][] = [];
  constructor(private readonly identity: IdentityService) {}
  async start(config: { recordingId: string; providerRunId: string }): Promise<LiveSpeechRun> {
    const speakers = await this.identity.serviceSpeakers();
    this.sessions.push(speakers);
    const events = new AsyncQueue<SpeechEvent>();
    const seen = new Map<string, string>();
    let acc = 0;
    return {
      providerRunId: config.providerRunId,
      events,
      push: (frame: AudioFrame) => {
        acc += frame.pcm.byteLength / 2;
        if (acc < SAMPLE_RATE * 2) return;
        acc = 0;
        const end = frame.startSample + frame.pcm.byteLength / 2;
        const start = end - SAMPLE_RATE * 2;
        const voice = Math.abs(new DataView(frame.pcm.buffer, frame.pcm.byteOffset).getInt16(0, true) / 32768) > 0.3 ? "B" : "A";
        const enrolled = speakers.find((s) => s.identifiers.includes(`id-${voice}`));
        const label = enrolled?.label ?? (voice === "A" ? "S1" : "S2");
        const clusterId = enrolled ? `SM-${label}` : `S0-${label}`;
        if (!seen.has(clusterId)) {
          seen.set(clusterId, voice);
          events.push({ type: "cluster", clusterId, ordinal: seen.size, providerLabel: label });
        }
        events.push({ type: "tokens", replaceProvisional: true, tokens: [{ id: newId("t"), recordingId: config.recordingId, providerRunId: config.providerRunId, startSample: start, endSample: end, text: ` ${voice}`, final: true, timing: "word" }] });
        events.push({ type: "turns", turns: [{ id: newId("turn"), recordingId: config.recordingId, providerRunId: config.providerRunId, clusterId, startSample: start, endSample: end, final: true }] });
      },
      finish: async () => {
        events.push({ type: "speakers", speakers: [...seen].map(([clusterId, voice]) => ({ clusterId, identifiers: [`id-${voice}`] })) });
        events.close();
      },
      abort: async () => events.close(),
    };
  }
}

/** A cloud live stream whose speaker labels come from a script: (voice, second of audio) → cluster id. */
class ScriptedCloudLive implements LiveSpeechProvider {
  readonly id = "fake-speechmatics-live";
  readonly capabilities = { transcription: "streaming", diarization: "fused-with-stt", persistentIdentity: true, languages: ["en"], execution: "cloud" } as const;
  constructor(private readonly label: (voice: "A" | "B", second: number) => string) {}
  async start(config: { recordingId: string; providerRunId: string }): Promise<LiveSpeechRun> {
    const events = new AsyncQueue<SpeechEvent>();
    const seen = new Set<string>();
    return {
      providerRunId: config.providerRunId,
      events,
      push: (frame: AudioFrame) => {
        const n = frame.pcm.byteLength / 2;
        // A 2 s turn per 2 s of audio, long enough for a voice window.
        if ((frame.startSample + n) % (2 * SAMPLE_RATE) !== 0) return;
        const end = frame.startSample + n;
        const start = end - 2 * SAMPLE_RATE;
        const voice = Math.abs(new DataView(frame.pcm.buffer, frame.pcm.byteOffset).getInt16(0, true) / 32768) > 0.3 ? "B" : "A";
        const clusterId = this.label(voice, start / SAMPLE_RATE);
        if (!seen.has(clusterId)) {
          seen.add(clusterId);
          events.push({ type: "cluster", clusterId, ordinal: seen.size, providerLabel: clusterId.split("-")[1] });
        }
        events.push({ type: "tokens", replaceProvisional: true, tokens: [{ id: newId("t"), recordingId: config.recordingId, providerRunId: config.providerRunId, startSample: start, endSample: end, text: ` ${voice}`, final: true, timing: "word" }] });
        events.push({ type: "turns", turns: [{ id: newId("turn"), recordingId: config.recordingId, providerRunId: config.providerRunId, clusterId, startSample: start, endSample: end, final: true }] });
      },
      finish: async () => events.close(),
      abort: async () => events.close(),
    };
  }
}

async function setup(wrapToolkit: (t: ProcessingToolkit) => ProcessingToolkit = (t) => t, opts: { models?: Partial<ModelSelection>; cloudFinal?: CloudFinalProvider; liveRequests?: string[]; live?: (identity: IdentityService) => LiveSpeechProvider; serviceEnroll?: (wav: Uint8Array) => Promise<string[] | null> } = {}) {
  const repo = new Repository(await SqlTableStore.open(nodeSqliteDriver()));
  const blobs = new MemoryBlobStore();
  const vault = await KeyVault.open(new IDBFactory());
  const durable = await vault.durableSealer();
  const ephemeral = new EphemeralKeys();
  const settings = await SettingsStore.open(repo, defaultSettings({ vad: "vad", sttLive: "stt", sttFinal: "stt-final", speakerEmbedding: "emb", summary: "llm", ...opts.models }));
  const audio = new RecordingAudio(repo, blobs, (kind, id) => (kind === "durable" ? durable : ephemeral.get(id)));
  const toolkit = wrapToolkit(fakeToolkit());
  const identity = new IdentityService(repo, blobs, durable, audio, () => settings.get(), toolkit.embed, opts.serviceEnroll);
  const live = opts.live?.(identity);
  const captured: string[] = [];
  let controller!: RecordingController;
  const post = new PostProcessor({ repo, blobs, audio, toolkit, identity, settings, ephemeral, durable, isCapturing: () => controller.activeRecordingId !== null, cloudFinal: () => opts.cloudFinal ?? null });
  controller = new RecordingController({
    repo, blobs, durable, ephemeral, settings, identity,
    providers: async (optionId) => {
      opts.liveRequests?.push(optionId);
      // A custom provider stands in for the cloud option; "local" keeps the on-device fake.
      return optionId !== "local" && live ? live : new FakeLiveProvider(optionId !== "local");
    },
    createSource: async () => new ManualSource(),
    onCaptured: (id) => {
      captured.push(id);
      post.enqueue(id);
    },
  });
  const waitDone = (id: string) => new Promise<void>((ok) => post.events.on((e) => e.recordingId === id && e.stage === "done" && ok()));
  return { repo, blobs, durable, ephemeral, settings, audio, identity, post, controller, captured, waitDone, live };
}

async function record(env: Awaited<ReturnType<typeof setup>>, script: ["A" | "B", number][], persistAudio = true, opts: { liveReady?: boolean } = {}) {
  const source = new ManualSource();
  const id = await env.controller.start({ source, persistAudio });
  // Frames pushed before the live provider started only reach storage, not live captions.
  if (opts.liveReady) await sleep(100);
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
    // Markdown follows the UI language; the JSON's keys and kinds don't.
    const ja = await exportRecording(env.repo, id, "ja");
    expect(ja.markdown).toContain("Alice Liddell — 確認済み");
    expect(ja.markdown).toContain("## 文字起こし");
    expect(ja.json.speakers).toEqual(exported.json.speakers.map((s) => (s.kind === "anonymous" ? { ...s, label: s.label.replace("Speaker ", "話者") } : s)));
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

  it("pauses a post-processing job while the next recording captures, then finishes it", async () => {
    const calls: { method: string; capturing: boolean }[] = [];
    let second: string | null = null;
    let secondSource: ManualSource | null = null;
    const env: Awaited<ReturnType<typeof setup>> = await setup((t) => {
      const log = (method: string) => calls.push({ method, capturing: env.controller.activeRecordingId !== null });
      return {
        ...t,
        detectSpeech: async (...a) => (log("detectSpeech"), t.detectSpeech(...a)),
        embed: async (...a) => (log("embed"), t.embed(...a)),
        transcribe: async (...a) => {
          log("transcribe");
          if (!second) {
            // The next conversation starts while the first chunk is being transcribed.
            secondSource = new ManualSource();
            second = await env.controller.start({ source: secondSource, persistAudio: false });
          }
          return t.transcribe(...a);
        },
      };
    });
    const source = new ManualSource();
    const id = await env.controller.start({ source, persistAudio: true });
    source.feed(40, "A");
    await sleep(1200);
    const done = env.waitDone(id);
    await env.controller.stop();
    for (let i = 0; i < 100 && !second; i++) await sleep(20);
    expect(second).not.toBeNull();
    const before = calls.length;
    await sleep(1500);
    // The 40 s recording has two transcription chunks; the second waits for capture to end.
    expect(calls.length).toBe(before);
    expect((await env.repo.getRecording(id))!.state).toBe("finalizing");
    secondSource!.feed(3, "B");
    await env.controller.stop();
    await done;
    expect(calls.filter((c) => c.method === "transcribe").length).toBeGreaterThanOrEqual(2);
    // Only the call that started the second recording ran before it; nothing ran during capture.
    expect(calls.filter((c) => c.capturing)).toEqual([]);
    const rec = (await env.repo.getRecording(id))!;
    expect(rec.processing.finalStt.status).toBe("done");
    expect(rec.state).toBe("ready");
  }, 30_000);

  it("shows a live candidate below acceptance as Possibly X, and flushes keep it (irl-subt-kdl.16)", async () => {
    const env = await setup();
    const id = await record(env, [["A", 12]]);
    const speakerA = (await loadTranscript(env.repo, id)).segments[0]!.clusterId!;
    const { personId } = await env.identity.assign({ recordingId: id, clusterId: speakerA, person: { fullName: "Alice Liddell" }, learnVoice: true });
    // Score and agreement pass; evidence can't, so the live decision is a candidate, not an attribution.
    await env.settings.update({ matchPolicies: { [SPACE]: { minEvidenceMs: 600_000, minScore: 0.62, minMargin: 0.1, minWindowAgreement: 0.6, candidateScore: 0.5 } } });

    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const source = new ManualSource();
      const id2 = await env.controller.start({ source, persistAudio: false });
      await sleep(200); // the live coordinator attaches after start returns
      source.feed(8, "A");
      await sleep(300);
      await vi.advanceTimersByTimeAsync(10_000); // live identification tick
      await sleep(300);
      await vi.advanceTimersByTimeAsync(3_000); // flushes after it
      await sleep(300);
      const live = env.controller.current.clusters.find((c) => c.clusterId === "L1");
      expect(live?.candidatePersonId).toBe(personId);
      expect((await env.repo.listClusters(id2)).find((c) => c.clusterId === "L1")?.candidatePersonId).toBe(personId);
      expect(await env.repo.listAttributions(id2)).toEqual([]);
      await env.controller.stop();
    } finally {
      vi.useRealTimers();
    }
  }, 30_000);

  it("identifies a short utterance live, before the first identification tick (irl-subt-kdl.17)", async () => {
    const env = await setup();
    const id = await record(env, [["A", 12]]);
    const speakerA = (await loadTranscript(env.repo, id)).segments[0]!.clusterId!;
    const { personId } = await env.identity.assign({ recordingId: id, clusterId: speakerA, person: { fullName: "Alice Liddell" }, learnVoice: true });
    await env.settings.update({ matchPolicies: { [SPACE]: { minEvidenceMs: 8_000, minScore: 0.62, minMargin: 0.1, minWindowAgreement: 0.6, candidateScore: 0.5 } } });

    // The 10 s tick never fires: only the windows as they arrive can name the speaker.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const source = new ManualSource();
      const id2 = await env.controller.start({ source, persistAudio: false });
      await sleep(200);
      source.feed(4, "A"); // two 2 s windows: a candidate, short of the evidence to accept
      await sleep(600);
      const live = env.controller.current.clusters.find((c) => c.clusterId === "L1");
      expect(live?.candidatePersonId).toBe(personId);
      // The match readout carries the scores and why the name was withheld (irl-subt-kdl.18).
      const match = env.controller.current.matches.find((m) => m.clusterId === "L1");
      expect(match).toMatchObject({ status: "candidate", best: { personId } });
      expect(match!.reason).toMatch(/^evidence \d+ms < 8000ms$/);
      expect(await env.repo.listAttributions(id2)).toEqual([]);
      await env.controller.stop();
    } finally {
      vi.useRealTimers();
    }
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

describe("cloud options (irl-subt-3xb.3)", () => {
  it("dispatches a live stream by option id, skips final STT it provides, and links its speakers with local embeddings", async () => {
    const liveRequests: string[] = [];
    const env = await setup(undefined, { models: { sttLive: "soniox:stt-rt-v5" }, liveRequests });
    const id = await record(env, [["A", 8], ["B", 8]], true, { liveReady: true });
    expect(liveRequests).toEqual(["soniox:stt-rt-v5"]);
    const rec = (await env.repo.getRecording(id))!;
    expect(rec.provider).toBe("soniox");
    expect(rec.selection?.locks).toMatchObject({ vad: "soniox:stt-rt-v5", "stt-final": "soniox:stt-rt-v5" });
    expect(rec.processing.finalStt).toMatchObject({ status: "skipped", note: { code: "final-tokens", service: "soniox" } });
    expect(rec.processing.diarization.status).toBe("done");
    const t = await loadTranscript(env.repo, id);
    expect(t.segments[0]!.text).toMatch(/^live/);
    expect(new Set(t.segments.map((s) => s.clusterId))).toEqual(new Set(["S0-1", "S0-2"]));
    // Local windows were embedded over the service's turns.
    expect((await env.repo.listWindows(id)).every((w) => w.clusterId.startsWith("S0-"))).toBe(true);
  }, 20_000);

  it("gets the final transcript from a cloud batch provider and keeps live speaker ids", async () => {
    const jobs: FinalTranscriptJob[] = [];
    const liveRequests: string[] = [];
    const env = await setup(undefined, { models: { sttFinal: "speechmatics-batch:enhanced" }, cloudFinal: fakeCloudFinal({ jobs }), liveRequests });
    const id = await record(env, [["A", 8], ["B", 8]], true, { liveReady: true });
    expect(liveRequests).toEqual(["local"]);
    const rec = (await env.repo.getRecording(id))!;
    expect(rec.processing.finalStt.status).toBe("done");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.optionId).toBe("speechmatics-batch:enhanced");
    expect(parseWav(jobs[0]!.wav).samples.length).toBe(16 * SAMPLE_RATE);
    expect(rec.modelVersions["stt-final"]).toBe("speechmatics-batch:enhanced");
    const t = await loadTranscript(env.repo, id);
    expect(t.segments.map((s) => s.text.split(" ")[0])).toEqual(["cloud-A", "cloud-B"]);
    // Service speakers took over the live clusters they overlap, so names given live stay attached.
    expect(t.segments.map((s) => s.clusterId)).toEqual(["L1", "L2"]);
    expect((await env.repo.listTokens(id)).every((tok) => tok.text.startsWith(" cloud-"))).toBe(true);
    expect(rec.processing.diarization.status).toBe("done");
  }, 20_000);

  it("leaves the live transcript intact when the cloud final transcript fails", async () => {
    const env = await setup(undefined, { models: { sttFinal: "speechmatics-batch:enhanced" }, cloudFinal: fakeCloudFinal({ fail: true }) });
    const id = await record(env, [["A", 6]], true, { liveReady: true });
    const rec = (await env.repo.getRecording(id))!;
    expect(rec.processing.finalStt).toMatchObject({ status: "failed", error: "service unavailable" });
    expect(rec.state).toBe("ready");
    const t = await loadTranscript(env.repo, id);
    expect(t.segments[0]!.text).toMatch(/^live/);
    expect((await env.repo.listRuns(id)).find((r) => r.kind === "final-stt")?.state).toBe("failed");
  }, 20_000);

  it("reprocesses a Soniox recording made before selection snapshots with the Soniox rules", async () => {
    const env = await setup(undefined, { models: { sttFinal: "same-as-live" } });
    const id = await record(env, [["A", 6]], true, { liveReady: true });
    expect((await loadTranscript(env.repo, id)).segments[0]!.text).toMatch(/^live/);
    // What an older Soniox recording looks like: provider soniox, local model ids, no snapshot.
    const { selection: _s, ...old } = (await env.repo.getRecording(id))!;
    await env.repo.putRecording({ ...old, provider: "soniox", models: { ...old.models, sttFinal: "stt-final" } });
    const done = env.waitDone(id);
    env.post.enqueue(id, ["finalStt", "diarization", "identity"]);
    await done;
    const rec = (await env.repo.getRecording(id))!;
    expect(rec.processing.finalStt).toMatchObject({ status: "skipped" });
    const t = await loadTranscript(env.repo, id);
    expect(t.segments[0]!.text).toMatch(/^live/);
  }, 20_000);
});

describe("Speechmatics voice identification (irl-subt-3xb.7)", () => {
  it("enrolls service identifiers when a speaker is named, names them live next time, and stops sending them after Forget voice", async () => {
    const env = await setup(undefined, { models: { sttLive: "speechmatics:enhanced", speakerEmbedding: "speechmatics:voice-id" }, live: (identity) => new FakeVoiceIdProvider(identity) });
    const provider = env.live as FakeVoiceIdProvider;
    const first = await record(env, [["A", 6], ["B", 6]], true, { liveReady: true });
    const rec = (await env.repo.getRecording(first))!;
    expect(rec.processing.finalStt.status).toBe("skipped");
    expect(rec.processing.diarization).toMatchObject({ status: "skipped", note: { code: "service-speakers", service: "speechmatics" } });
    // Identifiers are kept sealed per speaker, outside the local voice windows.
    const idWindows = (await env.repo.listWindows(first)).filter((w) => w.embeddingSpace === "speechmatics-id@1");
    expect(idWindows.map((w) => w.clusterId).sort()).toEqual(["S0-S1", "S0-S2"]);
    expect(new TextDecoder().decode(idWindows[0]!.sealedVector)).not.toContain("id-");

    const { personId } = await env.identity.assign({ recordingId: first, clusterId: "S0-S1", person: { fullName: "Alice Liddell" }, learnVoice: true });
    const summary = await env.identity.profileSummary(personId!);
    expect(summary.profiles).toHaveLength(1);
    expect(summary.profiles[0]).toMatchObject({ prototypes: 1, profile: { embeddingSpace: "speechmatics-id@1" } });
    // Clips of her turns are kept so she can be re-enrolled after a model change.
    expect(summary.profiles[0]!.clips).toBeGreaterThan(0);
    const label = `P_${personId!.replace(/[^A-Za-z0-9]/g, "")}`;
    expect(await env.identity.serviceSpeakers()).toEqual([{ label, identifiers: ["id-A"] }]);

    const second = await record(env, [["A", 6], ["B", 4]], true, { liveReady: true });
    expect(provider.sessions.at(-1)).toEqual([{ label, identifiers: ["id-A"] }]);
    const attrs = activeAttributions(await env.repo.listAttributions(second));
    expect(attrs.get(`SM-${label}`)).toMatchObject({ personId, source: "auto" });
    expect([...attrs.keys()]).toEqual([`SM-${label}`]);
    const exported = await exportRecording(env.repo, second);
    expect(exported.json.speakers.find((s) => s.clusterId === `SM-${label}`)).toMatchObject({ label: "Alice Liddell", kind: "auto" });

    await env.identity.forgetVoice(personId!, { keepLabels: true });
    expect(await env.identity.serviceSpeakers()).toEqual([]);
    await record(env, [["A", 4]], true, { liveReady: true });
    expect(provider.sessions.at(-1)).toEqual([]);
  }, 30_000);

  it("keeps the identifier budget at 50 and re-enrolls stale profiles from kept clips", async () => {
    const enrolled: Uint8Array[] = [];
    const env = await setup(undefined, {
      models: { sttLive: "speechmatics:enhanced", speakerEmbedding: "speechmatics:voice-id" },
      live: (identity) => new FakeVoiceIdProvider(identity),
      serviceEnroll: async (wav) => (enrolled.push(wav), ["id-new"]),
    });
    const id = await record(env, [["A", 6]], true, { liveReady: true });
    const { personId } = await env.identity.assign({ recordingId: id, clusterId: "S0-S1", person: { fullName: "Alice" }, learnVoice: true });
    // Many more people than identifiers allowed: everyone gets one before anyone gets a second.
    for (let i = 0; i < 60; i++) {
      const p = await env.identity.createPerson(`Person ${i}`);
      const now = new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString();
      await env.repo.putProfile({ id: `prof${i}`, personId: p.id, embeddingSpace: "speechmatics-id@1", needsReenrollment: false, createdAt: now, updatedAt: now });
      await env.repo.putPrototype({ id: `proto${i}`, profileId: `prof${i}`, sealedVector: await env.durable.seal(new TextEncoder().encode(JSON.stringify([`x${i}a`, `x${i}b`]))), quality: 1, evidenceMs: 1, sourceRecordingId: id, operationId: "op", createdAt: now });
    }
    const speakers = await env.identity.serviceSpeakers();
    expect(speakers.reduce((n, s) => n + s.identifiers.length, 0)).toBe(50);
    expect(speakers.every((s) => s.identifiers.length === 1)).toBe(true);

    expect(await env.identity.markServiceProfilesStale()).toBe(61);
    expect(await env.identity.serviceSpeakers()).toEqual([]);
    const r = await env.identity.migrateEmbeddingSpace("speechmatics:voice-id", "speechmatics-id@1");
    // Only Alice has clips; the rest need naming again.
    expect(r).toEqual({ reembedded: 1, needsReenrollment: 60 });
    expect(parseWav(enrolled[0]!).samples.length).toBeGreaterThan(SAMPLE_RATE);
    const label = `P_${personId!.replace(/[^A-Za-z0-9]/g, "")}`;
    expect(await env.identity.serviceSpeakers()).toEqual([{ label, identifiers: ["id-new"] }]);
  }, 30_000);

  it("sends saved voices with a batch job and names the live cluster the service labeled", async () => {
    const jobs: FinalTranscriptJob[] = [];
    const batch: CloudFinalProvider = {
      id: "fake-speechmatics-batch",
      transcribe: async (job) => {
        jobs.push(job);
        const base = await fakeCloudFinal().transcribe(job);
        const alice = job.speakers?.find((sp) => sp.identifiers.includes("id-A"));
        const rename = (id: string) => (alice && id === "B-S1" ? `SM-${alice.label}` : id);
        const clusters = base.clusters.map((c) => ({ ...c, clusterId: rename(c.clusterId), providerLabel: alice && c.clusterId === "B-S1" ? alice.label : c.providerLabel }));
        return { ...base, clusters, turns: base.turns.map((t) => ({ ...t, clusterId: rename(t.clusterId) })), speakers: clusters.map((c) => ({ clusterId: c.clusterId, identifiers: [`id-${c.clusterId}`] })) };
      },
    };
    const env = await setup(undefined, { models: { sttFinal: "speechmatics-batch:enhanced", speakerEmbedding: "speechmatics:voice-id" }, cloudFinal: batch });
    const alice = await env.identity.createPerson("Alice");
    await env.repo.putProfile({ id: "prof-a", personId: alice.id, embeddingSpace: "speechmatics-id@1", needsReenrollment: false, createdAt: "2026-09-15T00:00:00Z", updatedAt: "2026-09-15T00:00:00Z" });
    await env.repo.putPrototype({ id: "proto-a", profileId: "prof-a", sealedVector: await env.durable.seal(new TextEncoder().encode(JSON.stringify(["id-A"]))), quality: 1, evidenceMs: 1, sourceRecordingId: "x", operationId: "op", createdAt: "2026-09-15T00:00:00Z" });
    await env.settings.update({ speechmaticsSpeakersSensitivity: 0.7 });

    const id = await record(env, [["A", 8], ["B", 8]], true, { liveReady: true });
    const label = `P_${alice.id.replace(/[^A-Za-z0-9]/g, "")}`;
    expect(jobs[0]).toMatchObject({ speakers: [{ label, identifiers: ["id-A"] }], getSpeakers: true, speakersSensitivity: 0.7 });
    const rec = (await env.repo.getRecording(id))!;
    expect(rec.processing.identity).toMatchObject({ status: "done", note: { code: "recognized", recognized: 1, service: "speechmatics" } });
    const attrs = activeAttributions(await env.repo.listAttributions(id));
    expect(attrs.get("L1")).toMatchObject({ personId: alice.id, source: "auto" });
    expect(attrs.has("L2")).toBe(false);
    // Identifiers follow the live cluster ids the service speakers were mapped onto.
    expect((await env.repo.listWindows(id)).filter((w) => w.embeddingSpace === "speechmatics-id@1").map((w) => w.clusterId).sort()).toEqual(["L1", "L2"]);
  }, 20_000);
});

describe("Speechmatics speakers stay authoritative (diarization and attribution)", () => {
  it("live Speechmatics with the phone's voice model: service turns kept, only reconnect labels linked, saved voices matched locally", async () => {
    // Alice is enrolled on the phone first, from a local recording.
    const env = await setup(undefined, {
      live: () =>
        // 0-10 s Alice as S1, 10-14 s Alice again but Speechmatics split her off as S2 (same connection),
        // 14-20 s Bob as S3, 20-26 s Bob after a reconnect as S3 on connection 1.
        new ScriptedCloudLive((_voice, sec) => (sec < 10 ? "S0-S1" : sec < 14 ? "S0-S2" : sec < 20 ? "S0-S3" : "S1-S3")),
    });
    const enrollRec = await record(env, [["A", 12], ["B", 4]]);
    const alice = await env.identity.assign({ recordingId: enrollRec, clusterId: (await loadTranscript(env.repo, enrollRec)).segments[0]!.clusterId!, person: { fullName: "Alice" }, learnVoice: true });

    await env.settings.update({ models: { ...env.settings.get().models, sttLive: "speechmatics:enhanced" } });
    const id = await record(env, [["A", 14], ["B", 12]], true, { liveReady: true });
    const rec = (await env.repo.getRecording(id))!;
    expect(rec.provider).toBe("speechmatics");
    expect(rec.processing.finalStt).toMatchObject({ status: "skipped", note: { code: "final-tokens", service: "speechmatics" } });
    expect(rec.processing.diarization, JSON.stringify(rec.processing.diarization)).toMatchObject({ status: "done" });

    const clusters = new Map((await env.repo.listClusters(id)).map((c) => [c.clusterId, c]));
    // Turns are Speechmatics' own; nothing re-clustered them locally.
    expect(new Set((await env.repo.listTurns(id)).map((t) => t.clusterId))).toEqual(new Set(["S0-S1", "S0-S2", "S0-S3", "S1-S3"]));
    expect(clusters.get("S1-S3")?.mergedInto).toBe("S0-S3");
    // Speechmatics separated S1 and S2 within one connection: local embeddings don't overrule that.
    expect(clusters.get("S0-S2")?.mergedInto).toBeUndefined();
    // Attribution: the phone's voice model matched Alice on Speechmatics' speaker.
    expect(activeAttributions(await env.repo.listAttributions(id)).get("S0-S1")).toMatchObject({ personId: alice.personId, source: "auto" });
  }, 40_000);

  it("Speechmatics batch final: its speakers replace local clustering, and nothing merges them", async () => {
    const batch: CloudFinalProvider = {
      id: "speechmatics-batch",
      // Splits voice A into two batch speakers by time, which local clustering would have joined.
      transcribe: async (job) => {
        const base = await fakeCloudFinal().transcribe(job);
        const turns = base.turns.flatMap((t) => (t.clusterId === "B-S1" ? [{ ...t, endSample: 4 * SAMPLE_RATE }, { ...t, id: newId("turn"), clusterId: "B-S3", startSample: 4 * SAMPLE_RATE }] : [t]));
        return { ...base, turns, clusters: [...base.clusters, { clusterId: "B-S3", ordinal: 3, providerLabel: "S3" }] };
      },
    };
    const env = await setup(undefined, { models: { sttFinal: "speechmatics-batch:enhanced" }, cloudFinal: batch });
    const id = await record(env, [["A", 8], ["B", 8]], true, { liveReady: true });
    const rec = (await env.repo.getRecording(id))!;
    expect(rec.processing.finalStt.status).toBe("done");
    expect(rec.processing.diarization).toMatchObject({ status: "done" });
    expect(rec.processing.diarization.note).toMatchObject({ code: "labels-linked" });
    const runs = await env.repo.listRuns(id);
    expect(runs.some((r) => r.kind === "diarization-refine")).toBe(false);
    const turns = await env.repo.listTurns(id);
    expect(new Set(turns.map((t) => t.providerRunId))).toEqual(new Set([runs.find((r) => r.kind === "final-stt" && r.state === "finished")!.id]));
    const t = await loadTranscript(env.repo, id);
    expect(new Set(t.segments.map((s) => s.clusterId)).size, JSON.stringify(await env.repo.listClusters(id))).toBe(3);
    expect((await env.repo.listClusters(id)).filter((c) => c.mergedInto && turns.some((x) => x.clusterId === c.clusterId))).toEqual([]);
  }, 20_000);
});
