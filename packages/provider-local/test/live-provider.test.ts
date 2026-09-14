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
function fakeEngines() {
  const newWorker = () => new VadStream(() => undefined);
  let vad = newWorker();
  const sttLoudness: number[] = [];
  const engines = {
    isDownloaded: async () => true,
    ensureVad: async () => undefined,
    ensureEmbedding: async () => undefined,
    ensureAsr: async () => "wasm",
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

afterEach(() => {
  vi.useRealTimers();
});

describe("local live provider", () => {
  it("keeps speech on the recording's sample clock when it attaches mid-recording", async () => {
    vi.useFakeTimers();
    const { engines, sttLoudness, recreateWorker } = fakeEngines();
    const run = await new LocalLiveSpeechProvider(engines).start({
      recordingId: "rec", providerRunId: "run", language: "en", modelId: "moonshine-base-en",
      sttModelId: "moonshine-base-en", embeddingModelId: "campplus-voxceleb", vadModelId: "silero-vad-v6",
    });
    // Models are warm: boot finishes before the first frame arrives.
    await vi.advanceTimersByTimeAsync(0);

    // The recording started 2.5 s before the run attached.
    const first = Math.round(2.5 * SAMPLE_RATE);
    const at = (s: number) => first + Math.round(s * SAMPLE_RATE);
    const speech = [{ startSample: at(0), endSample: at(1.5) }, { startSample: at(4), endSample: at(6) }, { startSample: at(9), endSample: at(11) }];
    for (let t = first; t < at(13); t += FRAME) {
      // The audio worker crashes and comes back between utterances with a fresh stream.
      if (t === at(7.5)) recreateWorker();
      const samples = new Float32Array(FRAME).map((_, i) => (speech.some((r) => t + i >= r.startSample && t + i < r.endSample) ? (i % 2 ? 0.5 : -0.5) : 0));
      run.push({ sessionId: "rec", sequence: 0, startSample: t, sampleRateHz: SAMPLE_RATE, channels: 1, encoding: "pcm_s16le", pcm: float32ToPcm(samples) });
      await vi.advanceTimersByTimeAsync(FRAME / 16);
    }
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
});
