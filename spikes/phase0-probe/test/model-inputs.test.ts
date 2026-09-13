import { describe, expect, it } from "vitest";
import { compare, decodeTensor, float16Bits, float16Value, freeDimensionOverrides, makeInput, resolveShape } from "../src/spikes/model-inputs";

describe("model input helpers", () => {
  const meta = {
    inputs: [
      { name: "input_values", dtype: "float32", shape: ["batch_size", "samples"] },
      { name: "attention_mask", dtype: "int64", shape: ["batch_size", "samples"] },
    ],
    outputs: [],
    opCounts: {},
    fileBytes: 0,
  };

  it("pins every symbolic dim, translating per-input shape overrides", () => {
    const graph = { name: "g", file: "g.onnx", shapes: { input_values: [1, 3200] } };
    expect(freeDimensionOverrides(graph, meta)).toEqual({ batch_size: 1, samples: 3200 });
  });

  it("resolves shapes from dims and defaults unknown symbols to 1", () => {
    expect(resolveShape({ name: "x", dtype: "float32", shape: ["T", 80, "N"] }, { name: "g", file: "f", dims: { T: 300 } })).toEqual([300, 80, 1]);
  });

  it("generates ones for masks and fixed values from the registry", () => {
    const mask = makeInput(meta.inputs[1]!, { name: "g", file: "f", dims: { batch_size: 1, samples: 4 } }, 1);
    expect([...(mask.data as BigInt64Array)]).toEqual([1n, 1n, 1n, 1n]);
    const sr = makeInput({ name: "sr", dtype: "int64", shape: [] }, { name: "g", file: "f", values: { sr: 16000 } }, 1);
    expect([...(sr.data as BigInt64Array)]).toEqual([16000n]);
  });

  it("round-trips float16 bits", () => {
    for (const v of [0, 1, -2.5, 0.333251953125, 65504]) expect(float16Value(float16Bits(v))).toBeCloseTo(v, 3);
  });

  it("decodes base64 fixtures and measures drift", () => {
    const t = decodeTensor({ dtype: "float32", shape: [2], b64: Buffer.from(new Float32Array([1, 2]).buffer).toString("base64") });
    expect([...(t.data as Float32Array)]).toEqual([1, 2]);
    const d = compare(new Float64Array([1, 2, 3]), new Float64Array([1, 2, 3.001]));
    expect(d.maxAbsDiff).toBeCloseTo(0.001, 6);
    expect(d.cosine).toBeCloseTo(1, 5);
  });
});
