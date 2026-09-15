import { describe, expect, it } from "vitest";
import type { SpeechEvent, TranscriptToken } from "@irl/domain";
import { SonioxNormalizer } from "../src/normalizer";
import { testSonioxKey } from "../src/provider";
import { SonioxAsyncProvider } from "../src/async";

const tok = (text: string, start: number, end: number, final: boolean, speaker = "1") => ({ text, start_ms: start, end_ms: end, confidence: 0.9, is_final: final, speaker });
const finals = (evs: SpeechEvent[]) => evs.flatMap((e) => (e.type === "tokens" ? e.tokens.filter((t) => t.final) : [])) as TranscriptToken[];

describe("SonioxNormalizer", () => {
  it("maps times to the canonical sample clock, clusters per connection, and builds final turns", () => {
    const n = new SonioxNormalizer("r", "run");
    const a = n.result(0, 0, [tok(" Hello", 0, 400, true), tok(" there", 400, 800, true), tok(" maybe", 800, 1000, false)]);
    expect(a.find((e) => e.type === "cluster")).toMatchObject({ clusterId: "S0-1", ordinal: 1 });
    expect(finals(a).map((t) => [t.text, t.startSample, t.endSample])).toEqual([[" Hello", 0, 6400], [" there", 6400, 12800]]);
    const b = n.result(0, 0, [tok(" Hi", 1000, 1400, true, "2")]);
    const turns = b.find((e) => e.type === "turns");
    expect(turns && turns.type === "turns" && turns.turns[0]).toMatchObject({ clusterId: "S0-1", startSample: 0, endSample: 12800, final: true });
    expect(n.flush()[0]).toMatchObject({ type: "turns" });
  });

  it("de-duplicates the overlap resent after a reconnect", () => {
    const n = new SonioxNormalizer("r", "run");
    n.result(0, 0, [tok(" one", 0, 500, true), tok(" two", 500, 1000, true)]);
    // New connection starts 1 s earlier than the last final end; its times restart at 0.
    const evs = n.result(1, 0, [tok(" two", 500, 1000, true), tok(" three", 1000, 1500, true)]);
    expect(finals(evs).map((t) => t.text)).toEqual([" three"]);
    expect(evs.find((e) => e.type === "cluster")).toMatchObject({ clusterId: "S1-1", ordinal: 2 });
  });
});

describe("testSonioxKey", () => {
  it("sanitizes results", async () => {
    const ok = await testSonioxKey("k", (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch);
    const bad = await testSonioxKey("k", (async () => new Response("secret detail", { status: 401 })) as unknown as typeof fetch);
    const net = await testSonioxKey("k", (async () => { throw new TypeError("Failed to fetch sk-abc"); }) as unknown as typeof fetch);
    expect(ok.ok).toBe(true);
    expect(bad).toEqual({ ok: false, code: "rejected", message: "Soniox rejected the key" });
    expect(net.message).not.toContain("sk-abc");
  });
});

describe("SonioxAsyncProvider", () => {
  const job = (signal = new AbortController().signal) => ({ recordingId: "rec", providerRunId: "final1", optionId: "soniox-async:stt-async-v5", language: "en", wav: new Uint8Array(44), signal });

  function fakeApi(statuses: string[]) {
    const calls: { method: string; url: string; body?: unknown }[] = [];
    const impl = (async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      calls.push({ method, url, body: init.body });
      if (method === "DELETE") return new Response("", { status: 204 });
      if (url.endsWith("/v1/files")) return new Response(JSON.stringify({ id: "file1" }), { status: 201 });
      if (url.endsWith("/v1/transcriptions")) return new Response(JSON.stringify({ id: "tr1", status: "queued" }), { status: 201 });
      if (url.endsWith("/transcript")) {
        return new Response(JSON.stringify({ tokens: [tok(" Hi", 0, 300, true, "1"), tok(" there", 300, 700, true, "1"), tok(" Yo", 1000, 1300, true, "2")] }), { status: 200 });
      }
      const status = statuses.shift() ?? "completed";
      return new Response(JSON.stringify({ status, error_message: "bad file" }), { status: 200 });
    }) as unknown as typeof fetch;
    return { calls, impl };
  }

  it("uploads, transcribes with diarization, normalizes, and deletes the transcription then the file", async () => {
    const api = fakeApi(["processing", "completed"]);
    const out = await new SonioxAsyncProvider({ apiKey: async () => "k", fetch: api.impl, pollDelayMs: () => 0 }).transcribe(job());
    const create = api.calls.find((c) => c.url.endsWith("/v1/transcriptions"))!;
    expect(JSON.parse(String(create.body))).toEqual({ model: "stt-async-v5", file_id: "file1", enable_speaker_diarization: true, enable_language_identification: true, language_hints: ["en"] });
    expect(out.tokens.map((t) => [t.text, t.startSample, t.providerRunId])).toEqual([[" Hi", 0, "final1"], [" there", 4800, "final1"], [" Yo", 16000, "final1"]]);
    expect(out.clusters.map((c) => c.clusterId)).toEqual(["B-1", "B-2"]);
    expect(out.turns.map((t) => [t.clusterId, t.startSample, t.endSample])).toEqual([["B-1", 0, 11200], ["B-2", 16000, 20800]]);
    expect(api.calls.filter((c) => c.method === "DELETE").map((c) => c.url)).toEqual(["https://api.soniox.com/v1/transcriptions/tr1", "https://api.soniox.com/v1/files/file1"]);
  });

  it("fails visibly on a transcription error and still cleans up", async () => {
    const api = fakeApi(["error"]);
    await expect(new SonioxAsyncProvider({ apiKey: async () => "k", fetch: api.impl, pollDelayMs: () => 0 }).transcribe(job())).rejects.toThrow("Soniox transcription failed: bad file");
    expect(api.calls.filter((c) => c.method === "DELETE")).toHaveLength(2);
  });
});
