import { describe, expect, it } from "vitest";
import {
  activeAttributions,
  canTransition,
  crc32,
  decideMatch,
  displayName,
  equalErrorRate,
  float32ToPcm,
  formatClock,
  KeyedMutex,
  l2normalize,
  parseWav,
  pcmToFloat32,
  redact,
  resampleLinear,
  speakerLabel,
  glassesSpeakerName,
  splitSpeakerSpans,
  truncateUtf8,
  utf8ByteLength,
  validateSummary,
  wavHeader,
  AsyncQueue,
  type SpeakerAttribution,
  type SpeakerCluster,
  type Person,
} from "../src";

function vec(...xs: number[]) {
  return l2normalize(new Float32Array(xs));
}

describe("audio", () => {
  it("round-trips PCM and WAV", () => {
    const f = new Float32Array([0, 0.5, -0.5, 0.25]);
    const pcm = float32ToPcm(f);
    const wav = new Uint8Array(44 + pcm.byteLength);
    wav.set(wavHeader(pcm.byteLength));
    wav.set(pcm, 44);
    const parsed = parseWav(wav);
    expect(parsed.sampleRate).toBe(16000);
    expect([...parsed.samples].map((v) => Math.round(v * 100) / 100)).toEqual([0, 0.5, -0.5, 0.25]);
    expect([...pcmToFloat32(pcm)].map((v) => Math.round(v * 100) / 100)).toEqual([0, 0.5, -0.5, 0.25]);
  });

  it("resamples 48k to 16k", () => {
    expect(resampleLinear(new Float32Array(48000), 48000).length).toBe(16000);
  });

  it("formats clocks and crc", () => {
    expect(formatClock(16000 * 3725)).toBe("1:02:05");
    expect(formatClock(16000 * 65)).toBe("01:05");
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });
});

describe("names", () => {
  it("prefers a saved short name everywhere", () => {
    const p = { fullName: "Alexandra Konstantinopoulou-Smythe", shortName: "Alex" };
    expect(displayName(p)).toBe("Alex");
    expect(displayName(p, 32)).toBe("Alex");
    expect(displayName({ fullName: "Alice Liddell", shortName: "Alice" }, 32)).toBe("Alice");
    expect(displayName({ fullName: "Alice Liddell", shortName: "" })).toBe("Alice Liddell");
    expect(utf8ByteLength(displayName({ fullName: "山田太郎山田太郎山田太郎山田太郎" }, 32))).toBeLessThanOrEqual(32);
    expect(truncateUtf8("héllo wörld", 8)).toBe("héll…");
    // Never splits a character a reader sees as one: a decomposed ガ (カ + combining dakuten) or an emoji sequence.
    expect(truncateUtf8("\u30ab\u3099".repeat(3), 9)).toBe("\u30ab\u3099…");
    expect(truncateUtf8("👩‍👩‍👧ok", 10)).toBe("…");
  });

  it("labels clusters from active attributions", () => {
    const clusters = new Map<string, SpeakerCluster>([["c1", { recordingId: "r", clusterId: "c1", ordinal: 2, evidenceMs: 0 }]]);
    const people = new Map<string, Person>([["p1", { id: "p1", fullName: "Alice Liddell", shortName: "Alice", createdAt: "", updatedAt: "" }]]);
    const base: SpeakerAttribution = { id: "a1", recordingId: "r", clusterId: "c1", personId: "p1", confidence: 1, source: "manual", revision: 1, operationId: "o1", createdAt: "", undone: false };
    expect(speakerLabel("c1", clusters, new Map(), people).text).toBe("Speaker 2");
    const active = activeAttributions([base, { ...base, id: "a2", personId: null, revision: 2, undone: true }]);
    expect(speakerLabel("c1", clusters, active, people)).toMatchObject({ text: "Alice", kind: "confirmed" });
    expect(speakerLabel("c1", clusters, new Map(), people, { candidate: { personId: "p1" } }).text).toBe("Possibly Alice");
    // irl-subt-kdl.17: the glasses name a live candidate, marked as unsure, instead of "Speaker 2".
    const withCandidate = new Map([["c1", { ...clusters.get("c1")!, candidatePersonId: "p1" }]]);
    expect(glassesSpeakerName("c1", withCandidate, new Map(), people)).toBe("Alice?");
    expect(glassesSpeakerName("c1", withCandidate, active, people)).toBe("Alice");
    expect(glassesSpeakerName("c1", clusters, new Map(), people)).toBe("Speaker 2");
    // The UI language supplies the words around names; budgets account for them.
    const ja = { speaker: (n?: number) => (n ? `話者${n}` : "話者"), possibly: (name: string) => `${name}？`, maybe: (name: string) => `${name}？` };
    expect(speakerLabel("c1", clusters, new Map(), people, { words: ja })).toMatchObject({ text: "話者2", ordinal: 2 });
    expect(glassesSpeakerName("c1", withCandidate, new Map(), people, ja)).toBe("Alice？");
  });
});

describe("recording state machine", () => {
  it("allows documented transitions only", () => {
    expect(canTransition("starting", "recording")).toBe(true);
    expect(canTransition("recording", "ready")).toBe(false);
    expect(canTransition("interrupted", "finalizing")).toBe(true);
  });
});

describe("matching policy", () => {
  const policy = { minEvidenceMs: 5000, minScore: 0.7, minMargin: 0.1, minWindowAgreement: 0.6, candidateScore: 0.5 };
  const alice = { personId: "alice", embeddingSpace: "s1", needsReenrollment: false, prototypes: [vec(1, 0, 0)] };
  const bob = { personId: "bob", embeddingSpace: "s1", needsReenrollment: false, prototypes: [vec(0, 1, 0)] };
  const windows = (n: number, v: Float32Array) => Array.from({ length: n }, () => ({ vector: v, durationMs: 2000, quality: 1 }));

  it("accepts with enough evidence and margin", () => {
    const d = decideMatch({ clusterId: "c", embeddingSpace: "s1", windows: windows(4, vec(0.95, 0.1, 0)) }, [alice, bob], policy);
    expect(d.status).toBe("accepted");
    expect(d.best?.personId).toBe("alice");
  });

  it("keeps a single short window unknown", () => {
    const d = decideMatch({ clusterId: "c", embeddingSpace: "s1", windows: windows(1, vec(1, 0, 0)) }, [alice, bob], policy);
    expect(d.status).toBe("candidate");
    expect(d.reason).toMatch(/evidence/);
    expect(d.failures).toEqual([{ criterion: "evidence", value: 2000, threshold: policy.minEvidenceMs }]);
  });

  it("rejects ambiguous voices and other embedding spaces", () => {
    expect(decideMatch({ clusterId: "c", embeddingSpace: "s1", windows: windows(5, vec(1, 1, 0)) }, [alice, bob], policy).status).not.toBe("accepted");
    expect(decideMatch({ clusterId: "c", embeddingSpace: "s2", windows: windows(5, vec(1, 0, 0)) }, [alice], policy).status).toBe("rejected");
    expect(decideMatch({ clusterId: "c", embeddingSpace: "s1", windows: windows(5, vec(1, 0, 0)) }, [{ ...alice, needsReenrollment: true }], policy).status).toBe("rejected");
  });

  it("computes EER", () => {
    const r = equalErrorRate([0.8, 0.9, 0.7], [0.1, 0.2, 0.75]);
    expect(r.eer).toBeLessThan(0.5);
  });
});

describe("summary schema", () => {
  it("validates and drops unknown segment ids", () => {
    const v = validateSummary(
      { title: "Plan", overview: "[[c1]] proposed it", keyPoints: [{ text: "k", sourceSegmentIds: ["s1", "nope"] }], decisions: [], actionItems: [{ text: "do", ownerClusterId: "c1", sourceSegmentIds: ["s1"] }], openQuestions: [] },
      new Set(["s1"]),
    );
    expect(v.ok).toBe(true);
    expect(v.value?.keyPoints[0]?.sourceSegmentIds).toEqual(["s1"]);
    expect(v.errors.join()).toMatch(/dropped 1/);
    expect(validateSummary({ overview: "x" }, new Set()).ok).toBe(false);
  });

  it("splits speaker spans", () => {
    expect(splitSpeakerSpans("[[c1]] told [[c_2]] ok")).toEqual([
      { type: "speaker", clusterId: "c1" },
      { type: "text", text: " told " },
      { type: "speaker", clusterId: "c_2" },
      { type: "text", text: " ok" },
    ]);
  });
});

describe("redaction and utils", () => {
  it("removes secrets and content", () => {
    const r = redact({ apiKey: "abc", text: "hello there", nested: { note: "Bearer abcdefghijklmnop" } }, { includeContent: false }) as Record<string, unknown>;
    expect(r.apiKey).toBe("[redacted]");
    expect(r.text).toBe("[11 chars]");
    expect(JSON.stringify(r)).not.toContain("abcdefghijklmnop");
  });

  it("serializes keyed updates", async () => {
    const m = new KeyedMutex();
    const order: number[] = [];
    await Promise.all([
      m.run("k", async () => { await new Promise((ok) => setTimeout(ok, 10)); order.push(1); }),
      m.run("k", async () => { order.push(2); }),
    ]);
    expect(order).toEqual([1, 2]);
  });

  it("queues with capacity", async () => {
    const q = new AsyncQueue<number>(1);
    expect(q.push(1)).toBe(true);
    expect(q.push(2)).toBe(false);
    expect((await q.next()).value).toBe(1);
    q.close();
    expect((await q.next()).done).toBe(true);
  });
});
