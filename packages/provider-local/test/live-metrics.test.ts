import { expect, it } from "vitest";
import { stats, summarizeLiveMetrics, type LiveMetric } from "../src/live-metrics";

it("summarizes lag, compute per new audio, and loads", () => {
  const events: LiveMetric[] = [
    { kind: "load", modelId: "m", engine: "asr", ms: 1234.4, ok: true },
    { kind: "stt", runId: "r", final: false, audioS: 1.2, newAudioS: 1.2, computeMs: 300, lagS: 0.4 },
    { kind: "stt", runId: "r", final: false, audioS: 2.4, newAudioS: 1.2, computeMs: 500, lagS: 0.6 },
    { kind: "stt", runId: "r", final: true, audioS: 3, newAudioS: 0.6, computeMs: 600, lagS: 0.9 },
    { kind: "vad", runId: "r", audioS: 3, computeMs: 30 },
    { kind: "degraded", runId: "r", level: 1, reason: "x" },
  ];
  const s = summarizeLiveMetrics(events);
  expect(s.sttCalls).toBe(3);
  expect(s.interimLagS).toEqual({ p50: 0.6, p95: 0.6, max: 0.6, n: 2 });
  expect(s.finalLagS?.max).toBe(0.9);
  expect(s.sttComputePerNewAudio).toBeCloseTo(1.4 / 3);
  expect(s.vadRtf).toBeCloseTo(0.01);
  expect(s.loads).toEqual([{ modelId: "m", ms: 1234, ok: true }]);
  expect(s.maxDegradedLevel).toBe(1);
});

it("stats of nothing is null", () => {
  expect(stats([])).toBeNull();
});
