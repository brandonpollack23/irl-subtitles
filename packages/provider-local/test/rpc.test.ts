import { describe, expect, it } from "vitest";
import { serialLane } from "../src/rpc";

describe("serialLane", () => {
  it("runs a model load behind in-flight inference, and inference behind the load", async () => {
    const lane = serialLane();
    const order: string[] = [];
    let finishRun!: () => void;
    const run = lane(async () => {
      order.push("run:start");
      await new Promise<void>((ok) => (finishRun = ok));
      order.push("run:end");
    });
    const load = lane(async () => {
      order.push("load");
    });
    const next = lane(async () => {
      order.push("run2");
    });
    await new Promise((ok) => setTimeout(ok, 10));
    expect(order).toEqual(["run:start"]);
    finishRun();
    await Promise.all([run, load, next]);
    expect(order).toEqual(["run:start", "run:end", "load", "run2"]);
  });

  it("keeps going after a failure", async () => {
    const lane = serialLane();
    const failed = lane(async () => {
      throw new Error("boom");
    });
    await expect(failed).rejects.toThrow("boom");
    await expect(lane(async () => 42)).resolves.toBe(42);
  });
});
