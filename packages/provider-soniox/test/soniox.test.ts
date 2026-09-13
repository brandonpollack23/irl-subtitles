import { describe, expect, it } from "vitest";
import type { SpeechEvent, TranscriptToken } from "@irl/domain";
import { SonioxNormalizer } from "../src/normalizer";
import { testSonioxKey } from "../src/provider";

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
    expect(bad).toEqual({ ok: false, message: "Soniox rejected the key" });
    expect(net.message).not.toContain("sk-abc");
  });
});
