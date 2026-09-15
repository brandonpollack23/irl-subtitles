import { describe, expect, it } from "vitest";
import { wavHeader, type FinalTranscriptJob, stageNoteText } from "@irl/domain";
import { SpeechmaticsBatchProvider } from "../src/batch";

type Call = { method: string; url: string; body?: unknown };

function fakeApi(statuses: string[], opts: { transcript?: unknown; createStatus?: number } = {}) {
  const calls: Call[] = [];
  const impl = (async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    calls.push({ method, url, body: init.body });
    if (method === "POST") return opts.createStatus ? new Response("nope", { status: opts.createStatus }) : new Response(JSON.stringify({ id: "job1" }), { status: 201 });
    if (method === "DELETE") return new Response("{}", { status: 200 });
    if (url.includes("/transcript")) return new Response(JSON.stringify(opts.transcript ?? {}), { status: 200 });
    return new Response(JSON.stringify({ job: { id: "job1", status: statuses.shift() ?? "done", errors: [{ message: "bad audio" }] } }), { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, impl };
}

const job = (patch: Partial<FinalTranscriptJob> = {}): FinalTranscriptJob => ({
  recordingId: "rec", providerRunId: "final1", optionId: "speechmatics-batch:enhanced", language: "zh", wav: wavHeader(0), signal: new AbortController().signal, ...patch,
});

const w = (content: string, start: number, end: number, speaker: string) => ({ type: "word", start_time: start, end_time: end, alternatives: [{ content, confidence: 0.8, speaker }] });

describe("SpeechmaticsBatchProvider", () => {
  it("submits a diarized job, polls, normalizes json-v2 with identifiers, and deletes the job", async () => {
    const api = fakeApi(["running", "done"], {
      transcript: {
        results: [w("你好", 0, 0.5, "S1"), w("早", 1, 1.5, "S2"), w("嗯", 2, 2.2, "p_bob")],
        speakers: [{ label: "S1", speaker_identifiers: ["id1"] }, { label: "p_bob", speaker_identifiers: ["id-bob"] }, { label: "S9", speaker_identifiers: ["unused"] }],
      },
    });
    const notes: string[] = [];
    const provider = new SpeechmaticsBatchProvider({ apiKey: async () => "sk", region: () => "au", fetch: api.impl, pollDelayMs: () => 0 });
    const out = await provider.transcribe(job({ speakers: [{ label: "p_bob", identifiers: ["id-bob"] }], getSpeakers: true, onProgress: (n) => void notes.push(stageNoteText(n)) }));

    const post = api.calls[0]!;
    expect(post.url).toBe("https://au1.asr.api.speechmatics.com/v2/jobs");
    const form = post.body as FormData;
    expect(JSON.parse(String(form.get("config")))).toEqual({
      type: "transcription",
      transcription_config: { language: "cmn", model: "enhanced", diarization: "speaker", speaker_diarization_config: { speakers: [{ label: "p_bob", speaker_identifiers: ["id-bob"] }], get_speakers: true } },
    });
    expect(form.get("data_file")).toBeInstanceOf(Blob);
    expect(api.calls.map((c) => c.method)).toEqual(["POST", "GET", "GET", "GET", "DELETE"]);
    expect(api.calls.at(-1)!.url).toBe("https://au1.asr.api.speechmatics.com/v2/jobs/job1?force=true");

    expect(out.tokens.map((t) => [t.text, t.startSample, t.final, t.providerRunId])).toEqual([[" 你好", 0, true, "final1"], [" 早", 16000, true, "final1"], [" 嗯", 32000, true, "final1"]]);
    expect(out.clusters.map((c) => c.clusterId)).toEqual(["B-S1", "B-S2", "SM-p_bob"]);
    expect(out.turns.map((t) => [t.clusterId, t.startSample, t.endSample])).toEqual([["B-S1", 0, 8000], ["B-S2", 16000, 24000], ["SM-p_bob", 32000, 35200]]);
    expect(out.speakers).toEqual([{ clusterId: "B-S1", identifiers: ["id1"] }, { clusterId: "SM-p_bob", identifiers: ["id-bob"] }]);
    expect(notes).toContain("waiting for Speechmatics");
  });

  it("fails visibly on a rejected job and still deletes it", async () => {
    const api = fakeApi(["rejected"]);
    const provider = new SpeechmaticsBatchProvider({ apiKey: async () => "sk", fetch: api.impl, pollDelayMs: () => 0 });
    await expect(provider.transcribe(job())).rejects.toThrow("Speechmatics job rejected: bad audio");
    expect(api.calls.at(-1)!.method).toBe("DELETE");
  });

  it("sanitizes a rejected key and stops when cancelled", async () => {
    const provider = new SpeechmaticsBatchProvider({ apiKey: async () => "sk", fetch: fakeApi([], { createStatus: 401 }).impl, pollDelayMs: () => 0 });
    await expect(provider.transcribe(job())).rejects.toThrow("Speechmatics rejected the key");
    const abort = new AbortController();
    const api = fakeApi(["running", "running"]);
    const slow = new SpeechmaticsBatchProvider({ apiKey: async () => "sk", fetch: api.impl, pollDelayMs: () => 5 });
    const pending = slow.transcribe(job({ signal: abort.signal }));
    abort.abort();
    await expect(pending).rejects.toThrow("cancelled");
    expect(api.calls.at(-1)!.method).toBe("DELETE");
  });
});
