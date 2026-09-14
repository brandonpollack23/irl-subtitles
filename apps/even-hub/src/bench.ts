import { WavFileSource } from "@irl/capture";
import { errorMessage } from "@irl/domain";
import { catalogEntry, liveMetrics, summarizeLiveMetrics, type LiveMetric } from "@irl/provider-local";
import { platformReport } from "./platform";
import type { AppServices } from "./services";

/**
 * Dev-only live-path bench (irl-subt-kdl.1), for engines we can only reach through a URL, like the Even
 * simulator: `?bench=live[&wav=/fixtures/dev/x.wav][&stt=<model id>][&tail=3000]`. Downloads missing live
 * models, waits for warmup, plays the WAV through a real local recording, and logs one `[bench] {json}`
 * line with load times, live metrics, and when captions appeared. Read it with the simulator's
 * `GET /api/console`.
 */
export async function runBench(services: AppServices, params: URLSearchParams): Promise<void> {
  const out = (stage: string, data: unknown) => console.info(`[bench] ${JSON.stringify({ stage, ...(data as object) })}`);
  const pageMs = () => Math.round(performance.now());
  try {
    const { settings, engines, warmup, controller, caps, storage, inEvenApp } = services;
    const events: LiveMetric[] = [];
    liveMetrics.on((m) => events.push(m));
    const bootedAtMs = pageMs();
    const models = { ...settings.get().models, summary: "off", ...(params.get("stt") ? { sttLive: params.get("stt")! } : {}) };
    await settings.update({ provider: "local", captureSource: "wav-file", models });
    const live = [models.vad, models.speakerEmbedding, models.sttLive].filter((id) => id !== "off");
    const downloadStart = pageMs();
    for (const id of live) {
      if (await engines.isDownloaded(id)) continue;
      out("downloading", { modelId: id });
      await engines.download(id);
    }
    const downloadMs = pageMs() - downloadStart;

    const loadStart = pageMs();
    await warmup.warm();
    const status = warmup.current;
    const warmMs = pageMs() - loadStart;
    out("warm", { status, warmMs, downloadMs, bootedAtMs });

    const wavUrl = params.get("wav") ?? "/fixtures/jfk.wav";
    const bytes = new Uint8Array(await (await fetch(wavUrl)).arrayBuffer());
    const source = new WavFileSource(async () => bytes, `WAV: ${wavUrl}`);
    const captions: { t: number; audio: number; text: string }[] = [];
    let t0 = performance.now();
    let last = "";
    const off = controller.live.on((s) => {
      const text = [...s.segments.slice(-2).map((x) => x.text), s.provisionalText].join(" ").trim();
      if (text && text !== last) captions.push({ t: +((performance.now() - t0) / 1000).toFixed(2), audio: +(s.capturedSamples / 16000).toFixed(2), text: text.slice(-80) });
      last = text;
    });
    t0 = performance.now();
    await controller.start({ source });
    await source.finished;
    await new Promise((ok) => setTimeout(ok, Number(params.get("tail") ?? 3000)));
    const segments = controller.current.segments.map((s) => s.text);
    await controller.stop();
    off();
    const platform = platformReport(caps, storage.diagnostics, inEvenApp);
    out("done", {
      host: platform.host, engine: platform.engine, userAgent: caps.userAgent, webgpu: caps.webgpu.available, crossOriginIsolated: caps.crossOriginIsolated, threads: caps.wasmThreads,
      models: live.map((id) => `${id}@${catalogEntry(id)?.manifest.version.slice(0, 8)}`), wav: wavUrl, warmMs,
      metrics: summarizeLiveMetrics(events), firstCaption: captions[0] ?? null, captionUpdates: captions.length, captions: captions.slice(0, 40), segments,
    });
  } catch (e) {
    out("failed", { error: errorMessage(e) });
  }
}

/**
 * Dev-only spike (irl-subt-kdl.7): `?bench=moonshine[&archs=2,4,5][&wav=…]` runs each Moonshine Streaming size over the WAV
 * in a worker from files under /fixtures/dev/moonshine/ (gitignored copies of the CDN models) and logs `[bench-moonshine]`.
 */
export async function runMoonshineSpike(params: URLSearchParams): Promise<void> {
  const names: Record<number, string> = { 2: "tiny-streaming-en", 4: "small-streaming-en", 5: "medium-streaming-en" };
  const files = ["adapter.ort", "cross_kv.ort", "decoder_kv.ort", "encoder.ort", "frontend.model.ort", "frontend.weights.ort", "streaming_config.json", "tokenizer.bin"];
  const wav = new Uint8Array(await (await fetch(params.get("wav") ?? "/fixtures/dev/two_cities_16k.wav")).arrayBuffer());
  const pcm = new Int16Array(wav.buffer, 44, (wav.length - 44) >> 1);
  for (const arch of (params.get("archs") ?? "2,4,5").split(",").map(Number)) {
    const worker = new Worker(new URL("./bench-moonshine.worker.ts", import.meta.url), { type: "module" });
    const result = await new Promise((ok) => {
      worker.onmessage = (e) => ok(e.data);
      worker.onerror = (e) => ok({ arch, error: e.message });
      worker.postMessage({ arch, dir: `/fixtures/dev/moonshine/${names[arch]}`, files, audio: Float32Array.from(pcm, (v) => v / 32768) });
    });
    worker.terminate();
    console.info(`[bench-moonshine] ${JSON.stringify({ ...(result as object), userAgent: navigator.userAgent, crossOriginIsolated })}`);
  }
  console.info("[bench] {\"stage\":\"done\"}");
}
