import { describe, expect, it } from "vitest";
import { FrameStats } from "../src/spikes/capture-stats";

describe("FrameStats", () => {
  it("reports full coverage for an uninterrupted 100 ms frame cadence", () => {
    const s = new FrameStats();
    for (let i = 0; i <= 600; i++) s.push(i * 100, 3200); // 60 s of 1600-sample frames
    const sum = s.summary(60_100);
    expect(sum.samples).toBe(601 * 1600);
    expect(sum.gapCount).toBe(0);
    expect(sum.effectiveSampleRate).toBeGreaterThan(15_900);
    expect(sum.frameSizes).toEqual({ 3200: 601 });
  });

  it("records a suspension as a gap and a coverage deficit", () => {
    const s = new FrameStats(500);
    let t = 0;
    for (let i = 0; i < 100; i++) s.push((t += 100), 3200);
    t += 30_000; // WebView suspended for 30 s
    const gap = s.push(t, 3200, "hidden");
    for (let i = 0; i < 100; i++) s.push((t += 100), 3200);
    expect(gap).toMatchObject({ gapMs: 30_000, atSample: 100 * 1600, visibility: "hidden" });
    const sum = s.summary();
    expect(sum.gapCount).toBe(1);
    expect(sum.coveragePct).toBeLessThan(50);
  });

  it("flags frames with an odd byte count", () => {
    const s = new FrameStats();
    s.push(0, 3201);
    expect(s.summary().oddByteFrames).toBe(1);
  });
});
