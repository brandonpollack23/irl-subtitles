import fs from "node:fs";
import { afterAll, afterEach, expect, it } from "vitest";
import { createLiveApp, type LiveAppOptions, type RecordingReport } from "./harness/live-app";

/**
 * Real models, real app wiring: does speech in a WAV become captions on the glasses? Defaults to the bundled JFK
 * clip; IRL_LIVE_WAV plays another WAV (the text assertions then only check that captions appeared),
 * IRL_LIVE_REPORT writes every timeline as JSON, IRL_LIVE_TRACE=1 adds each VAD and STT call.
 */
const custom = process.env.IRL_LIVE_WAV;
const wavPath = custom ?? new URL("../public/fixtures/jfk.wav", import.meta.url).pathname;
const wav = new Uint8Array(fs.readFileSync(wavPath));
const reports: Record<string, RecordingReport> = {};
const apps: Awaited<ReturnType<typeof createLiveApp>>[] = [];

async function app(opts: LiveAppOptions = {}) {
  const a = await createLiveApp(opts);
  apps.push(a);
  await a.launch();
  return a;
}

afterEach(async () => {
  for (const a of apps.splice(0)) await a.dispose();
});

afterAll(() => {
  if (process.env.IRL_LIVE_REPORT) fs.writeFileSync(process.env.IRL_LIVE_REPORT, JSON.stringify({ wav: wavPath, reports }, null, 2));
});

const words = (r: RecordingReport) => r.captionLines.join(" ");

/** The glasses said captions were loading, then that they're ready, and the loading line came before any caption. */
function announcedLoading(r: RecordingReport) {
  const loadingAt = r.glassesBodies.findIndex((b) => b.includes("Captions loading, they'll start shortly."));
  const readyAt = r.glassesBodies.findIndex((b) => b.includes("Captions ready."));
  const firstCaption = r.glassesBodies.findIndex((b) => r.captionLines.some((l) => b.includes(l)));
  expect(loadingAt, "loading line shown").toBeGreaterThanOrEqual(0);
  expect(readyAt, "ready line shown after loading").toBeGreaterThan(loadingAt);
  expect(loadingAt).toBeLessThan(firstCaption);
}

it("captions speech on the next recording once models are loaded", async () => {
  const a = await app();
  await a.warmup.warm();
  const r = (reports["warm"] = await a.record(wav));
  expect(words(r).split(/\s+/).length).toBeGreaterThan(3);
  if (!custom) expect(words(r)).toMatch(/fellow Americans/i);
});

it("captions speech said while the caption model is still loading at launch", async () => {
  // Start talking right after the app opens: warmup is still loading the models the recording needs.
  const a = await app();
  const r = (reports["during launch warmup"] = await a.record(wav));
  expect(words(r).split(/\s+/).length).toBeGreaterThan(3);
  announcedLoading(r);
  if (!custom) expect(words(r)).toMatch(/fellow Americans/i);
});

it("captions everything once a slow caption model finishes loading", async () => {
  // Stand-in for WebKitGTK, where Moonshine Base takes ~35 s to load: speech ends before captions can start.
  const a = await app({ asrLoadDelayMs: 15_000 });
  const r = (reports["slow caption model"] = await a.record(wav, 12_000));
  announcedLoading(r);
  if (!custom) {
    expect(words(r)).toMatch(/fellow Americans/i);
    expect(words(r)).toMatch(/for your country/i);
  } else expect(words(r).split(/\s+/).length).toBeGreaterThan(3);
});
