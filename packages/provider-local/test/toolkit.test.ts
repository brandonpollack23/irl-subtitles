import { defaultSettings } from "@irl/domain";
import { expect, it, vi } from "vitest";
import { defaultSelection } from "../src/catalog";
import type { LocalEngines } from "../src/engines";
import { LocalToolkit } from "../src/toolkit";

function toolkit(platform: "ios" | "android") {
  const engines = {
    capabilities: async () => ({ platform }),
    reset: vi.fn(),
    release: vi.fn(async () => undefined),
    ensureLlm: vi.fn(async () => undefined),
    call: vi.fn(async () => 3),
  };
  const t = new LocalToolkit(engines as unknown as LocalEngines, () => defaultSettings(defaultSelection("en")));
  return { t, engines };
}

it("keeps the live caption model loaded when post-processing releases its workers", async () => {
  const { t, engines } = toolkit("android");
  await t.release();
  expect(engines.release).toHaveBeenCalledWith(["asr", "llm"]);
  await (t.summaryProvider("gemma-4-e2b-qat-mobile") as unknown as { model: { countTokens(s: string): Promise<number> } }).model.countTokens("hello");
  expect(engines.reset).not.toHaveBeenCalled();
});

it("drops the live caption model before a summary model loads on iOS", async () => {
  const { t, engines } = toolkit("ios");
  // ChunkedSummaryProvider keeps the chat model it was given.
  const model = (t.summaryProvider("gemma-4-e2b-qat-mobile") as unknown as { model: { countTokens(s: string): Promise<number> } }).model;
  await model.countTokens("hello");
  expect(engines.reset).toHaveBeenCalledWith("stream");
  expect(engines.ensureLlm).toHaveBeenCalled();
});
