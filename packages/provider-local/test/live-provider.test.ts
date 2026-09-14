import { afterEach, describe, expect, it, vi } from "vitest";
import { float32ToPcm, SAMPLE_RATE, type SpeechEvent, type TimeRange, type TranscriptToken } from "@irl/domain";
import type { LocalEngines } from "../src/engines";
import { LocalLiveSpeechProvider } from "../src/live-provider";
import { DEFAULT_VAD, VadStream } from "../src/vad-segmenter";

const FRAME = SAMPLE_RATE / 10;
const WIN = DEFAULT_VAD.windowSamples;
const PAD = (DEFAULT_VAD.speechPadMs * SAMPLE_RATE) / 1000;
const loudShare = (x: Float32Array) => x.filter((v) => Math.abs(v) > 0.1).length / Math.max(1, x.length);

/** LocalEngines with instant models: the VAD calls loud windows speech, STT reports how loud its input was. */
function fakeEngines(asrLoadMs = 0) {
  const newWorker = () => new VadStream(() => undefined);
  let vad = newWorker();
  const sttLoudness: number[] = [];
  const engines = {
    isDownloaded: async () => true,
    ensureVad: async () => undefined,
    ensureEmbedding: async () => undefined,
    ensureLiveStt: () => new Promise((ok) => setTimeout(() => ok(undefined), asrLoadMs)),
    call: async () => undefined,
    vadPush: (samples: Float32Array, startSample: number) => vad.push(samples, startSample, async (w) => (loudShare(w) > 0.5 ? 0.9 : 0.05)),
    transcribe: async (samples: Float32Array) => {
      sttLoudness.push(loudShare(samples));
      return { text: "one two three four", words: null, language: null, ms: 1 };
    },
    embed: async (windows: TimeRange[]) => windows.map((w) => ({ vector: new Float32Array([1, 0, 0, 0]), startSample: w.startSample, endSample: w.endSample, quality: 1, ms: 1 })),
  };
  return { engines: engines as unknown as LocalEngines, sttLoudness, recreateWorker: () => (vad = newWorker()) };
}

const config = {
  recordingId: "rec", providerRunId: "run", language: "en", modelId: "moonshine-base-en",
  sttModelId: "moonshine-base-en", embeddingModelId: "campplus-voxceleb", vadModelId: "silero-vad-v6",
};

/** Pushes 100 ms frames from `first` to `until`, loud inside `speech`, advancing fake time in real time. */
async function play(run: { push(f: never): void }, first: number, until: number, speech: TimeRange[], each?: (t: number) => void) {
  for (let t = first; t < until; t += FRAME) {
    each?.(t);
    const samples = new Float32Array(FRAME).map((_, i) => (speech.some((r) => t + i >= r.startSample && t + i < r.endSample) ? (i % 2 ? 0.5 : -0.5) : 0));
    run.push({ sessionId: "rec", sequence: 0, startSample: t, sampleRateHz: SAMPLE_RATE, channels: 1, encoding: "pcm_s16le", pcm: float32ToPcm(samples) } as never);
    await vi.advanceTimersByTimeAsync(FRAME / 16);
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("local live provider", () => {
  it("keeps speech on the recording's sample clock when it attaches mid-recording", async () => {
    vi.useFakeTimers();
    const { engines, sttLoudness, recreateWorker } = fakeEngines();
    const run = await new LocalLiveSpeechProvider(engines).start(config);
    // Models are warm: boot finishes before the first frame arrives.
    await vi.advanceTimersByTimeAsync(0);

    // The recording started 2.5 s before the run attached.
    const first = Math.round(2.5 * SAMPLE_RATE);
    const at = (s: number) => first + Math.round(s * SAMPLE_RATE);
    const speech = [{ startSample: at(0), endSample: at(1.5) }, { startSample: at(4), endSample: at(6) }, { startSample: at(9), endSample: at(11) }];
    // The audio worker crashes and comes back between utterances with a fresh stream.
    await play(run, first, at(13), speech, (t) => t === at(7.5) && recreateWorker());
    const finished = run.finish();
    await vi.advanceTimersByTimeAsync(1000);
    await finished;
    const events: SpeechEvent[] = [];
    for await (const ev of run.events) events.push(ev);

    // Padded utterance bounds, clipped to the run's first audio; the VAD resolves them to one window.
    const expected = speech.map((r) => ({ startSample: Math.max(first, r.startSample - PAD), endSample: r.endSample + PAD }));
    const near = (actual: number | undefined, want: number) => expect(Math.abs(actual! - want), `${actual} vs ${want}`).toBeLessThanOrEqual(WIN);
    const starts = events.flatMap((e) => (e.type === "speech" && e.active ? [e.sample] : []));
    const ends = events.flatMap((e) => (e.type === "speech" && !e.active ? [e.sample] : []));
    expect(starts).toHaveLength(3);
    expect(ends).toHaveLength(3);
    const finals = events.flatMap((e) => (e.type === "tokens" ? e.tokens : [])).filter((t) => t.final);
    expected.forEach((r, i) => {
      near(starts[i], r.startSample);
      near(ends[i], r.endSample);
      const inside = finals.filter((t: TranscriptToken) => t.endSample > speech[i]!.startSample && t.startSample < speech[i]!.endSample);
      expect(inside.length).toBeGreaterThan(0);
      near(Math.min(...inside.map((t) => t.startSample)), r.startSample);
      near(Math.max(...inside.map((t) => t.endSample)), r.endSample);
    });
    // Interims and finals for every utterance, each decoding mostly speech.
    expect(sttLoudness.length).toBeGreaterThanOrEqual(6);
    for (const share of sttLoudness) expect(share).toBeGreaterThan(0.7);
    expect(events.some((e) => e.type === "degraded" && e.reason?.startsWith("Saving"))).toBe(false);
  });

  it("captions speech that ended while the caption model was still loading", async () => {
    vi.useFakeTimers();
    // Speech detection and speaker models are ready at once; captions take 8 s, speech ends at 5 s.
    const { engines } = fakeEngines(8_000);
    const run = await new LocalLiveSpeechProvider(engines).start(config);
    const at = (s: number) => Math.round(s * SAMPLE_RATE);
    const speech = [{ startSample: at(1), endSample: at(2.5) }, { startSample: at(3.5), endSample: at(5) }];
    const events: SpeechEvent[] = [];
    void (async () => {
      for await (const ev of run.events) events.push(ev);
    })();
    await play(run, 0, at(11), speech);
    const finals = () => events.flatMap((e) => (e.type === "tokens" ? e.tokens : [])).filter((t) => t.final);
    // Both utterances are captioned once the model is ready, before Stop.
    for (const r of speech) expect(finals().some((t) => t.endSample > r.startSample && t.startSample < r.endSample), `${r.startSample}`).toBe(true);
    // Their speaker turns waited for the text rather than going out empty.
    const firstTurn = events.findIndex((e) => e.type === "turns");
    const firstFinal = events.findIndex((e) => e.type === "tokens" && e.tokens.some((t) => t.final));
    expect(firstFinal).toBeGreaterThanOrEqual(0);
    if (firstTurn >= 0) expect(firstTurn).toBeGreaterThan(firstFinal);
    expect(events.some((e) => e.type === "degraded" && e.reason !== null)).toBe(false);
    const finished = run.finish();
    await vi.advanceTimersByTimeAsync(1000);
    await finished;
  });

  it("leaves speech older than the catch-up window to the final pass", async () => {
    vi.useFakeTimers();
    const { engines, sttLoudness } = fakeEngines(30_000);
    const run = await new LocalLiveSpeechProvider(engines).start(config);
    const at = (s: number) => Math.round(s * SAMPLE_RATE);
    const early = { startSample: at(1), endSample: at(3) };
    const late = { startSample: at(22), endSample: at(24) };
    const events: SpeechEvent[] = [];
    void (async () => {
      for await (const ev of run.events) events.push(ev);
    })();
    await play(run, 0, at(33), [early, late]);
    const finals = events.flatMap((e) => (e.type === "tokens" ? e.tokens : [])).filter((t) => t.final);
    expect(finals.some((t) => t.startSample < early.endSample)).toBe(false);
    expect(finals.some((t) => t.endSample > late.startSample && t.startSample < late.endSample)).toBe(true);
    // The catch-up decode isn't mistaken for live STT falling behind.
    expect(sttLoudness.length).toBeGreaterThan(0);
    expect(events.some((e) => e.type === "degraded" && e.reason !== null)).toBe(false);
    const finished = run.finish();
    await vi.advanceTimersByTimeAsync(1000);
    await finished;
  });
});

describe("local live provider with streaming STT", () => {
  it("streams audio from where captions start, open lines provisional and completed lines final on the recording clock", async () => {
    vi.useFakeTimers();
    const { engines } = fakeEngines();
    const pushed: number[] = [];
    let origin = -1;
    const fake = engines as unknown as Record<string, unknown>;
    fake.streamStart = async () => undefined;
    // A stream that completes "hello there" once 2 s have arrived and keeps an open line after that.
    fake.streamPush = async (samples: Float32Array) => {
      pushed.push(samples.length);
      const heard = pushed.reduce((a, b) => a + b, 0) / SAMPLE_RATE;
      if (origin < 0) origin = heard;
      const lines = heard >= 2 ? [{ id: "1", text: "hello there", startTime: 0.5, duration: 1, isComplete: true }, { id: "2", text: "and", startTime: 1.8, duration: heard - 1.8, isComplete: false }] : [{ id: "1", text: "hello", startTime: 0.5, duration: heard - 0.5, isComplete: false }];
      return { lines, computeMs: 5 };
    };
    fake.streamStop = async () => ({ lines: [{ id: "2", text: "and goodbye", startTime: 1.8, duration: 0.7, isComplete: true }], computeMs: 5 });
    const run = await new LocalLiveSpeechProvider(engines).start({ ...config, modelId: "moonshine-streaming-small-en", sttModelId: "moonshine-streaming-small-en" });
    await vi.advanceTimersByTimeAsync(0);
    const events: SpeechEvent[] = [];
    void (async () => {
      for await (const ev of run.events) events.push(ev);
    })();
    // The recording started 1 s before the run attached.
    const first = SAMPLE_RATE;
    await play(run, first, first + 3 * SAMPLE_RATE, []);
    const finished = run.finish();
    await vi.advanceTimersByTimeAsync(1000);
    await finished;

    const tokens = events.flatMap((e) => (e.type === "tokens" ? e.tokens : []));
    const finals = tokens.filter((t) => t.final);
    expect(finals.map((t) => t.text.trim())).toEqual(["hello", "there", "and", "goodbye"]);
    // Line times count from the first streamed sample, the run's first audio.
    expect(finals[0]!.startSample).toBe(first + SAMPLE_RATE / 2);
    expect(finals.at(-1)!.endSample).toBeLessThanOrEqual(first + 3 * SAMPLE_RATE);
    expect(tokens.some((t) => !t.final && t.text.trim() === "hello")).toBe(true);
    // Every received sample was streamed once.
    expect(pushed.reduce((a, b) => a + b, 0)).toBe(3 * SAMPLE_RATE);
  });
});
