import { describe, expect, it } from "vitest";
import { float32ToPcm, SAMPLE_RATE, sleep, type AudioFrame, type SpeechEvent, type TranscriptToken } from "@irl/domain";
import { mintRealtimeKey, testSpeechmaticsKey } from "../src/auth";
import { SpeechmaticsNormalizer, toTokens, type SpeechmaticsResult } from "../src/normalizer";
import { SpeechmaticsSpeechProvider, type SocketLike } from "../src/provider";

const word = (content: string, start: number, end: number, speaker = "S1", extra: Partial<SpeechmaticsResult> = {}): SpeechmaticsResult => ({
  type: "word", start_time: start, end_time: end, alternatives: [{ content, confidence: 0.9, speaker }], ...extra,
});
const punct = (content: string, at: number, speaker = "S1"): SpeechmaticsResult => ({ type: "punctuation", start_time: at, end_time: at, attaches_to: "previous", is_eos: true, alternatives: [{ content, confidence: 1, speaker }] });
const finals = (evs: SpeechEvent[]) => evs.flatMap((e) => (e.type === "tokens" ? e.tokens.filter((t) => t.final) : [])) as TranscriptToken[];

describe("SpeechmaticsNormalizer", () => {
  it("joins words and punctuation the way the reconciler renders them", () => {
    const tokens = toTokens([word("Hello", 0, 0.4), punct(",", 0.4), word("world", 0.5, 0.9), { type: "punctuation", start_time: 1, end_time: 1, attaches_to: "next", alternatives: [{ content: "\"" }] }, word("hi", 1, 1.2), punct(".", 1.2)], 0, "r", "run", true);
    expect(tokens.map((t) => t.token.text).join("")).toBe(" Hello, world \"hi.");
  });

  it("maps seconds to the sample clock, scopes generic speakers per connection, and builds final turns", () => {
    const n = new SpeechmaticsNormalizer("r", "run");
    const p = n.partial(0, 0, [word("Hel", 0, 0.3)]);
    expect(p).toContainEqual({ type: "speech", active: true, sample: 0 });
    expect(p.find((e) => e.type === "tokens")).toMatchObject({ replaceProvisional: true, tokens: [{ final: false, text: " Hel" }] });
    expect(p.find((e) => e.type === "cluster")).toMatchObject({ clusterId: "S0-S1", ordinal: 1, providerLabel: "S1" });
    const a = n.final(0, 16000, [word("Hello", 0, 0.4), word("there", 0.4, 0.8), punct(".", 0.8)]);
    expect(finals(a).map((t) => [t.text, t.startSample, t.endSample])).toEqual([[" Hello", 16000, 22400], [" there", 22400, 28800], [".", 28800, 28801]]);
    const b = n.final(0, 16000, [word("Hi", 1, 1.4, "S2")]);
    const turns = b.find((e) => e.type === "turns");
    expect(turns?.type === "turns" && turns.turns[0]).toMatchObject({ clusterId: "S0-S1", startSample: 16000, endSample: 28801 });
    expect(n.endOfUtterance(16000, 1.4)).toEqual([{ type: "speech", active: false, sample: 38400 }]);
    expect(n.flush()[0]).toMatchObject({ type: "turns" });
  });

  it("de-duplicates the overlap after a reconnect, keeps enrolled labels across connections, and ignores UU", () => {
    const n = new SpeechmaticsNormalizer("r", "run", new Set(["p_alice"]));
    n.final(0, 0, [word("one", 0, 0.5, "p_alice"), word("two", 0.5, 1, "p_alice")]);
    // The new connection starts 1 s before the last final end; its times restart at 0.
    const evs = n.final(1, 0, [word("two", 0.5, 1, "p_alice"), word("three", 1, 1.5, "p_alice"), word("um", 1.5, 1.6, "UU")]);
    expect(finals(evs).map((t) => t.text)).toEqual([" three", " um"]);
    expect(evs.filter((e) => e.type === "cluster")).toEqual([]);
    expect(n.clusterIdFor(1, "p_alice")).toBe("SM-p_alice");
  });
});

describe("Speechmatics keys", () => {
  it("mints a realtime key and sanitizes failures", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const ok = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ key_value: "jwt-1" }), { status: 201 });
    }) as unknown as typeof fetch;
    expect(await mintRealtimeKey("sk", 7200, ok)).toBe("jwt-1");
    expect(calls[0]!.url).toBe("https://mp.speechmatics.com/v1/api_keys?type=rt");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ ttl: 7200 });
    await expect(mintRealtimeKey("sk", 60, (async () => new Response("no", { status: 401 })) as unknown as typeof fetch)).rejects.toThrow("Speechmatics rejected the key");
    await expect(mintRealtimeKey("sk", 60, (async () => { throw new TypeError("Failed to fetch sk-secret"); }) as unknown as typeof fetch)).rejects.not.toThrow("sk-secret");
  });

  it("tests a key against the batch API", async () => {
    const urls: string[] = [];
    expect((await testSpeechmaticsKey("k", "au", (async (url: string) => (urls.push(url), new Response("{}", { status: 200 }))) as unknown as typeof fetch)).ok).toBe(true);
    expect(urls).toEqual(["https://au1.asr.api.speechmatics.com/v2/jobs?limit=1"]);
    expect(await testSpeechmaticsKey("k", "eu", (async () => new Response("detail", { status: 401 })) as unknown as typeof fetch)).toEqual({ ok: false, code: "rejected", message: "Speechmatics rejected the key (keys only work in the region they were created in)" });
  });
});

class FakeSocket implements SocketLike {
  readyState = 0;
  binaryType = "blob";
  sent: (string | ArrayBuffer)[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(readonly url: string) {
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.({});
    });
  }
  send(data: string | ArrayBufferLike | ArrayBufferView) {
    this.sent.push(typeof data === "string" ? data : (data as ArrayBuffer));
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code: 1000, reason: "" });
  }
  server(msg: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  drop() {
    this.readyState = 3;
    this.onclose?.({ code: 1006, reason: "network" });
  }
  get json() {
    return this.sent.filter((d): d is string => typeof d === "string").map((d) => JSON.parse(d) as Record<string, unknown>);
  }
  get audioSamples() {
    return this.sent.filter((d) => typeof d !== "string").reduce((n, d) => n + (d as ArrayBuffer).byteLength / 2, 0);
  }
}

function frame(startSample: number, seconds: number): AudioFrame {
  return { recordingId: "r", sequence: 0, startSample, pcm: float32ToPcm(new Float32Array(seconds * SAMPLE_RATE).fill(0.1)), capturedAt: 0 } as unknown as AudioFrame;
}

async function drain(events: AsyncIterable<SpeechEvent>): Promise<SpeechEvent[]> {
  const out: SpeechEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

describe("SpeechmaticsSpeechProvider", () => {
  const keyFetch = (async () => new Response(JSON.stringify({ key_value: "jwt" }), { status: 201 })) as unknown as typeof fetch;
  const config = { recordingId: "r", providerRunId: "run", language: "ja", modelId: "speechmatics:standard", sttModelId: "speechmatics:standard", embeddingModelId: "campplus", vadModelId: "silero" };

  it("streams, reconnects from the last final minus overlap, and returns speaker identifiers at the end", async () => {
    const sockets: FakeSocket[] = [];
    const provider = new SpeechmaticsSpeechProvider({
      apiKey: async () => "sk", fetch: keyFetch, region: () => "au",
      socket: (url) => {
        const s = new FakeSocket(url);
        sockets.push(s);
        return s;
      },
      speakerSession: async () => ({ speakers: [{ label: "p_alice", identifiers: ["id-a"] }], getSpeakers: true }),
    });
    const run = await provider.start(config);
    const collected = drain(run.events);
    await sleep(0);
    const first = sockets[0]!;
    expect(first.url).toBe("wss://au.rt.speechmatics.com/v2?jwt=jwt");
    expect(first.json[0]).toMatchObject({
      message: "StartRecognition",
      audio_format: { type: "raw", encoding: "pcm_s16le", sample_rate: 16000 },
      transcription_config: { language: "ja", model: "standard", diarization: "speaker", enable_partials: true, speaker_diarization_config: { speakers: [{ label: "p_alice", speaker_identifiers: ["id-a"] }], get_speakers: true } },
    });
    // Audio pushed before recognition started is sent once it has.
    run.push(frame(0, 1));
    expect(first.audioSamples).toBe(0);
    first.server({ message: "RecognitionStarted", id: "x" });
    await sleep(0);
    expect(first.audioSamples).toBe(SAMPLE_RATE);
    run.push(frame(SAMPLE_RATE, 2));
    expect(first.audioSamples).toBe(3 * SAMPLE_RATE);
    first.server({ message: "AddTranscript", results: [word("こんにちは", 0, 2.5, "p_alice")] });

    first.drop();
    await sleep(1100);
    const second = sockets[1]!;
    second.server({ message: "RecognitionStarted", id: "y" });
    await sleep(0);
    // Resent from 2.5 s - 1 s overlap to the end of what was captured.
    expect(second.audioSamples).toBe(3 * SAMPLE_RATE - 1.5 * SAMPLE_RATE);
    second.server({ message: "AddTranscript", results: [word("こんにちは", 0, 1, "p_alice"), word("元気", 1, 1.4, "S1")] });

    const finished = run.finish();
    await sleep(0);
    expect(second.json.at(-1)).toEqual({ message: "EndOfStream", last_seq_no: 1 });
    second.server({ message: "SpeakersResult", speakers: [{ label: "S1", speaker_identifiers: ["id-s1"] }, { label: "p_alice", speaker_identifiers: ["id-a2"] }] });
    second.server({ message: "EndOfTranscript" });
    await finished;
    const events = await collected;
    expect(finals(events).map((t) => t.text)).toEqual([" こんにちは", " 元気"]);
    expect(events).toContainEqual({ type: "degraded", reason: { code: "reconnecting", service: "speechmatics" } });
    expect(events.find((e) => e.type === "speakers")).toEqual({ type: "speakers", speakers: [{ clusterId: "S1-S1", identifiers: ["id-s1"] }, { clusterId: "SM-p_alice", identifiers: ["id-a2"] }] });
    expect(events.filter((e) => e.type === "cluster").map((e) => e.type === "cluster" && e.clusterId)).toEqual(["SM-p_alice", "S1-S1"]);
  });

  it("reports a rejected key as a fatal error instead of reconnecting", async () => {
    const sockets: FakeSocket[] = [];
    const provider = new SpeechmaticsSpeechProvider({ apiKey: async () => "sk", fetch: keyFetch, socket: (url) => (sockets.push(new FakeSocket(url)), sockets.at(-1)!) });
    const run = await provider.start({ ...config, language: "en" });
    const collected = drain(run.events);
    await sleep(0);
    sockets[0]!.server({ message: "Error", type: "not_authorised", reason: "Not Authorized" });
    await run.finish();
    expect(await collected).toContainEqual({ type: "error", message: "Speechmatics: the key was rejected", fatal: true });
    expect(sockets).toHaveLength(1);
  });

  it("sends speakers_sensitivity with enrolled voices and reports identifiers the service refuses", async () => {
    const sockets: FakeSocket[] = [];
    const rejected: string[] = [];
    const provider = new SpeechmaticsSpeechProvider({
      apiKey: async () => "sk", fetch: keyFetch, socket: (url) => (sockets.push(new FakeSocket(url)), sockets.at(-1)!),
      speakerSession: async () => ({ speakers: [{ label: "P_1", identifiers: ["old"] }], getSpeakers: true, sensitivity: 0.3 }),
      onIdentifiersRejected: (r) => rejected.push(r),
    });
    const run = await provider.start({ ...config, language: "en" });
    const collected = drain(run.events);
    await sleep(0);
    expect(sockets[0]!.json[0]).toMatchObject({ transcription_config: { speaker_diarization_config: { speakers_sensitivity: 0.3 } } });
    sockets[0]!.server({ message: "Error", type: "invalid_config", reason: "speaker_identifiers are not valid for this model" });
    await run.finish();
    await collected;
    expect(rejected).toEqual(["speaker_identifiers are not valid for this model"]);
  });

  it("refuses to start without a key or for an unsupported language", async () => {
    await expect(new SpeechmaticsSpeechProvider({ apiKey: async () => null }).start(config)).rejects.toThrow("No Speechmatics API key saved");
    await expect(new SpeechmaticsSpeechProvider({ apiKey: async () => "k", fetch: keyFetch }).start({ ...config, language: "auto" })).rejects.toThrow("don't support auto");
  });
});
