import { describe, expect, it } from "vitest";
import { splitSpeakerSpans, type TranscriptSegment } from "@irl/domain";
import { ChunkedSummaryProvider, CloudSummaryProvider, extractJson, type ChatModel } from "../src";

const segs: TranscriptSegment[] = Array.from({ length: 40 }, (_, i) => ({
  id: `seg_${i * 16000}`, startSample: i * 16000, endSample: i * 16000 + 12000, clusterId: i % 2 ? "L2" : "L1", text: `line ${i} about the launch plan and budget details`, final: true, tokenIds: [],
}));

function fakeModel(contextTokens: number, outputs: string[]): ChatModel & { calls: string[] } {
  const calls: string[] = [];
  return {
    id: "fake", contextTokens, maxNewTokens: 100, calls,
    countTokens: async (t) => Math.ceil(t.length / 4),
    generate: async (messages) => {
      calls.push(messages.at(-1)!.content);
      return outputs.shift() ?? outputs.at(-1) ?? "{}";
    },
  };
}

const good = JSON.stringify({ title: "Launch", overview: "{S1} and {S2} planned the launch.", keyPoints: [{ text: "Budget agreed", refs: [2, 3] }], decisions: [], actionItems: [{ text: "Send deck", owner: "S2", due: "Friday", refs: [4] }], openQuestions: [] });

describe("summary provider", () => {
  it("summarizes in one pass and maps tags/refs back to ids", async () => {
    const model = fakeModel(100_000, [`Sure! \`\`\`json\n${good}\n\`\`\``]);
    const s = await new ChunkedSummaryProvider("local:fake", model).summarize({ recordingId: "r", language: "en", transcriptRevision: 3, segments: segs, speakerNames: new Map([["L1", "Alice"]]) });
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]).not.toContain("Alice");
    expect(splitSpeakerSpans(s.overview)[0]).toEqual({ type: "speaker", clusterId: "L1" });
    expect(s.keyPoints[0]!.sourceSegmentIds).toEqual(["seg_16000", "seg_32000"]);
    expect(s.actionItems[0]).toMatchObject({ ownerClusterId: "L2", dueText: "Friday", sourceSegmentIds: ["seg_48000"] });
    expect(s.sourceTranscriptRevision).toBe(3);
  });

  it("chunks long transcripts, reduces, and repairs invalid JSON once", async () => {
    const model = fakeModel(1100, ["not json at all", good, good, good, good, good, good, good]);
    const s = await new ChunkedSummaryProvider("local:fake", model).summarize({ recordingId: "r", language: "en", transcriptRevision: 1, segments: segs, speakerNames: new Map() });
    expect(model.calls.length).toBeGreaterThan(3);
    expect(model.calls.some((c) => c.startsWith("These are summaries"))).toBe(true);
    expect(model.calls[1]).toMatch(/not valid JSON/);
    expect(s.title).toBe("Launch");
  });

  it("sends only transcript lines and names to the cloud endpoint", async () => {
    let sent: Record<string, unknown> = {};
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ summary: JSON.parse(good) }), { status: 200 });
    }) as unknown as typeof fetch;
    const s = await new CloudSummaryProvider("https://example.test/summarize", fetchImpl).summarize({ recordingId: "r", language: "en", transcriptRevision: 1, segments: segs, speakerNames: new Map([["L1", "Alice"]]) });
    expect(Object.keys(sent).sort()).toEqual(["language", "lines", "speakers", "version"]);
    expect(JSON.stringify(sent)).toContain("Alice");
    expect(s.providerId).toBe("cloud");
  });

  it("extracts JSON with trailing commas", () => {
    expect(extractJson('text {"a": [1, 2,],} tail')).toEqual({ a: [1, 2] });
  });
});
