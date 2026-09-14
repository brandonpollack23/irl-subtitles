import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { l2normalize, SAMPLE_RATE } from "@irl/domain";
import { catalogEntry, defaultSelection, CATALOG, LOCK } from "../src/catalog";
import { filesForTargets } from "../src/model-files";
import { refineClusters, OnlineClusterer, windowGrid, clusterParams } from "../src/clustering";
import { ComputeScheduler, interpolateWords } from "../src/scheduler";
import { Sha256 } from "../src/sha256";
import { regionsFromProbabilities, VadSegmenter } from "../src/vad-segmenter";

function noisy(base: number[], seed: number) {
  let x = seed;
  const r = () => ((x = (x * 1103515245 + 12345) % 2 ** 31) / 2 ** 31 - 0.5) * 0.3;
  return l2normalize(new Float32Array(base.map((v) => v + r())));
}

describe("sha256", () => {
  it("matches node crypto across chunk boundaries", () => {
    for (const len of [0, 1, 55, 56, 63, 64, 65, 1000, 4097]) {
      const data = new Uint8Array(len).map((_, i) => (i * 31) & 0xff);
      const h = new Sha256();
      for (let off = 0; off < len; off += 17) h.update(data.subarray(off, off + 17));
      expect(h.hex()).toBe(createHash("sha256").update(data).digest("hex"));
    }
  });
});

describe("catalog", () => {
  it("pins every available Hugging Face entry and picks available defaults", () => {
    for (const e of CATALOG.filter((x) => x.availability.status === "available")) {
      expect(e.manifest.source.type === "hf" && LOCK.repos[e.manifest.source.repo], e.id).toBeTruthy();
      expect(e.manifest.version).not.toBe("unpinned");
    }
    const sel = defaultSelection("en");
    expect(sel).toEqual({ vad: "silero-vad-v6", sttLive: "moonshine-base-en", sttFinal: "whisper-large-v3-turbo-ts", speakerEmbedding: "campplus-voxceleb", summary: "gemma-4-e2b-qat-mobile" });
    expect(defaultSelection("ja").sttLive).toBe("moonshine-base-ja");
    expect(defaultSelection("auto").sttLive).toBe("whisper-small");
  });
});

describe("download file selection", () => {
  const graphs = (id: string, targets: ("webgpu" | "wasm")[]) => filesForTargets(catalogEntry(id)!, targets).map((f) => f.path).filter((p) => p.startsWith("onnx/"));

  it("keeps only the graphs transformers.js loads for each target", () => {
    expect(graphs("moonshine-base-en", ["webgpu", "wasm"])).toEqual(["onnx/encoder_model.onnx", "onnx/decoder_model_merged_q4.onnx"]);
    expect(graphs("whisper-small", ["webgpu"])).toEqual(["onnx/encoder_model.onnx", "onnx/decoder_model_merged_q4.onnx"]);
    expect(graphs("whisper-small", ["wasm"])).toEqual(["onnx/encoder_model_quantized.onnx", "onnx/decoder_model_merged_quantized.onnx"]);
    expect(graphs("gemma-4-e2b-qat-mobile", ["webgpu"])).toHaveLength(4);
  });

  it("keeps configs and every file of ORT-direct entries", () => {
    const whisper = filesForTargets(catalogEntry("whisper-base")!, ["wasm"]).map((f) => f.path);
    expect(whisper).toContain("tokenizer.json");
    expect(filesForTargets(catalogEntry("silero-vad-v6")!, ["wasm"])).toEqual(catalogEntry("silero-vad-v6")!.manifest.files);
  });

  it("selects at least one graph for every available transformers.js entry", () => {
    for (const e of CATALOG.filter((x) => x.availability.status === "available" && x.manifest.adapter.startsWith("tjs-"))) {
      const targets = e.manifest.params?.requiresWebGpu ? (["webgpu"] as const) : (["webgpu", "wasm"] as const);
      expect(filesForTargets(e, targets).some((f) => f.path.endsWith(".onnx")), e.id).toBe(true);
    }
  });
});

describe("VAD segmenter", () => {
  it("applies hysteresis, padding, minimum durations, and forced cuts", () => {
    const probs = [...Array(10).fill(0.1), ...Array(50).fill(0.9), ...Array(20).fill(0.1), ...Array(3).fill(0.9), ...Array(20).fill(0.1)];
    const regions = regionsFromProbabilities(probs, 0);
    expect(regions).toHaveLength(1);
    expect(regions[0]!.startSample).toBe(10 * 512 - 1920);
    const seg = new VadSegmenter({ maxSpeechMs: 1000 });
    const evs = Array.from({ length: 80 }, (_, i) => seg.push(0.9, i * 512)).flat();
    expect(evs.filter((e) => e.type === "end" && e.forced).length).toBeGreaterThanOrEqual(2);
  });
});

describe("clustering", () => {
  const A = [1, 0, 0, 0], B = [0, 1, 0, 0], C = [0, 0, 1, 0];
  it("online clustering confirms speakers after two windows", () => {
    const c = new OnlineClusterer(clusterParams("x"));
    const a1 = c.assign(noisy(A, 1));
    expect(a1.confirmed).toBe(false);
    const a2 = c.assign(noisy(A, 2));
    expect(a2).toMatchObject({ label: a1.label, newlyConfirmed: true });
    expect(c.assign(noisy(B, 3)).label).not.toBe(a1.label);
  });

  it("refinement merges split speakers and reassigns drifted windows", () => {
    const vectors = [...Array.from({ length: 6 }, (_, i) => noisy(A, i + 1)), ...Array.from({ length: 6 }, (_, i) => noisy(B, i + 10)), ...Array.from({ length: 4 }, (_, i) => noisy(C, i + 20))];
    // Live pass split speaker A into labels 0 and 3, and mislabeled one B window as A.
    const initial = [0, 0, 0, 3, 3, 3, 1, 1, 0, 1, 1, 1, 2, 2, 2, 2];
    const { labels } = refineClusters(vectors, initial, clusterParams("x"));
    expect(new Set(labels.slice(0, 6)).size).toBe(1);
    expect(new Set(labels.slice(6, 12)).size).toBe(1);
    expect(labels[0]).not.toBe(labels[6]);
    expect(new Set(labels).size).toBe(3);
  });

  it("builds a window grid over speech", () => {
    const g = windowGrid([{ startSample: 0, endSample: 5.5 * SAMPLE_RATE }, { startSample: 10 * SAMPLE_RATE, endSample: 10.5 * SAMPLE_RATE }]);
    expect(g[0]).toEqual({ startSample: 0, endSample: 2 * SAMPLE_RATE });
    expect(g.at(-1)!.endSample).toBe(5.5 * SAMPLE_RATE);
    expect(g.every((w) => w.endSample <= 5.5 * SAMPLE_RATE)).toBe(true);
  });
});

describe("scheduler", () => {
  it("degrades under backlog and relaxes one level after sustained headroom", () => {
    let t = 0;
    const s = new ComputeScheduler(() => t, 1000);
    expect(s.update({ sttBacklogS: 0, embedBacklogS: 0, sttRtf: 0.2, failure: false }).level).toBe(0);
    const d = s.update({ sttBacklogS: 30, embedBacklogS: 0, sttRtf: 2, failure: false });
    expect(d).toMatchObject({ level: 2, liveStt: false, embeddings: true });
    t = 500;
    expect(s.update({ sttBacklogS: 0, embedBacklogS: 0, sttRtf: 0.1, failure: false }).level).toBe(2);
    t = 1600;
    expect(s.update({ sttBacklogS: 0, embedBacklogS: 0, sttRtf: 0.1, failure: false }).level).toBe(1);
  });

  it("interpolates word timing across an utterance", () => {
    const w = interpolateWords("hello big world", 0, 16000);
    expect(w.map((x) => x.text)).toEqual([" hello", " big", " world"]);
    expect(w[0]!.startSample).toBe(0);
    expect(w.at(-1)!.endSample).toBe(16000);
  });
});
