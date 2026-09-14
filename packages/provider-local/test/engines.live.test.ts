import fs from "node:fs";
import { expect, it } from "vitest";
import { parseWav, resampleLinear } from "@irl/domain";
import { LocalEngines } from "../src/engines";
import { nodeWorkers } from "./harness/node-workers";
// @ts-expect-error plain JS test support
import { defaultCacheDir, installWebEnv } from "./harness/web-env.mjs";

it("runs the app's audio and ASR workers with real models", async () => {
  const cacheDir = defaultCacheDir();
  installWebEnv(cacheDir);
  const engines = new LocalEngines(nodeWorkers(cacheDir));
  for (const id of ["silero-vad-v6", "moonshine-base-en"]) if (!(await engines.isDownloaded(id))) await engines.download(id);
  const wav = parseWav(new Uint8Array(fs.readFileSync(new URL("../../../apps/even-hub/public/fixtures/jfk.wav", import.meta.url))));
  const clip = resampleLinear(wav.samples, wav.sampleRate);
  await engines.ensureVad("silero-vad-v6");
  const { probs } = await engines.vadPush(clip.slice(0, 16000 * 4), 0);
  expect(Math.max(...probs)).toBeGreaterThan(0.5);
  await engines.ensureAsr("moonshine-base-en");
  const out = await engines.transcribe(clip.slice(), "en", false);
  expect(out.text).toMatch(/ask not what your country/i);
  await engines.release(["audio", "asr", "llm"]);
});
