import { WavFileSource } from "@irl/capture";
import { errorMessage, isCloudOption } from "@irl/domain";
import { catalogEntry, defaultSelection, liveMetrics, summarizeLiveMetrics, type LiveMetric } from "@irl/provider-local";
import { platformReport } from "./platform";
import type { AppServices } from "./services";

/**
 * Dev-only live-path bench (irl-subt-kdl.1), for engines we can only reach through a URL, like the Even
 * simulator: `?bench=live[&wav=/fixtures/dev/x.wav][&stt=<model id>][&final=<model id>][&tail=3000][&runs=1][&wait=1][&nowarm=1][&source=glasses&secs=15]`. Downloads missing live
 * models, waits for warmup, plays the WAV through a real local recording, and logs one `[bench] {json}`
 * line per run with load times, live metrics, and when captions appeared. With runs > 1, each later run starts once
 * post-processing of the previous one is idle, which shows whether the live models had to load again; wait=0 starts it
 * right after the previous Stop, while that recording is still processing. nowarm=1 starts
 * the first recording without waiting for warmup, like talking the moment the app opens. source=glasses records `secs`
 * seconds from the simulator's bridge microphone (pick its input with `--aid`) instead of the WAV. Read it with the simulator's
 * `GET /api/console`.
 */
export async function runBench(services: AppServices, params: URLSearchParams): Promise<void> {
  const out = (stage: string, data: unknown) => console.info(`[bench] ${JSON.stringify({ stage, ...(data as object) })}`);
  const pageMs = () => Math.round(performance.now());
  try {
    const { settings, engines, warmup, controller, caps, storage, inEvenApp, post } = services;
    let events: LiveMetric[] = [];
    const timeline: unknown[] = [];
    liveMetrics.on((m) => {
      events.push(m);
      if (m.kind === "stt" || m.kind === "load") timeline.push({ t: Math.round(performance.now()), ...m });
    });
    post.events.on((ev) => ev.progress === undefined && out("post", { t: pageMs(), ...ev }));
    const bootedAtMs = pageMs();
    // Benchmarks measure the phone: any cloud option falls back to the local default for its role.
    const local = defaultSelection(settings.get().language);
    const current = settings.get().models;
    const models = { ...current, ...(isCloudOption(current.sttLive) ? { sttLive: local.sttLive } : {}), ...(isCloudOption(current.sttFinal) ? { sttFinal: local.sttFinal } : {}), ...(isCloudOption(current.speakerEmbedding) ? { speakerEmbedding: local.speakerEmbedding } : {}), summary: "off", ...(params.get("stt") ? { sttLive: params.get("stt")! } : {}), ...(params.get("final") ? { sttFinal: params.get("final")! } : {}) };
    const bridgeMic = params.get("source") === "glasses";
    await settings.update({ captureSource: bridgeMic ? "glasses" : "wav-file", models });
    const live = [models.vad, models.speakerEmbedding, models.sttLive].filter((id) => id !== "off");
    const downloadStart = pageMs();
    // The final-pass model too, so post-processing between runs does real work.
    for (const id of [...live, ...(catalogEntry(models.sttFinal) ? [models.sttFinal] : [])]) {
      if (await engines.isDownloaded(id)) continue;
      out("downloading", { modelId: id });
      await engines.download(id);
    }
    const downloadMs = pageMs() - downloadStart;

    const loadStart = pageMs();
    if (params.get("nowarm") !== "1") await warmup.warm();
    const status = warmup.current;
    const warmMs = pageMs() - loadStart;
    out("warm", { status, warmMs, downloadMs, bootedAtMs });

    const wavUrl = params.get("wav") ?? "/fixtures/jfk.wav";
    const bytes = new Uint8Array(await (await fetch(wavUrl)).arrayBuffer());
    for (let run = 1; run <= Number(params.get("runs") ?? 1); run++) {
    if (run > 1) {
      // Let the previous recording's post-processing finish, as a user starting the next conversation would (unless wait=0).
      for (let i = 0; params.get("wait") !== "0" && i < 600 && (post.busy || controller.activeRecordingId !== null); i++) await new Promise((ok) => setTimeout(ok, 500));
      events = [];
      timeline.length = 0;
    }
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
    if (bridgeMic) {
      await controller.start();
      await new Promise((ok) => setTimeout(ok, Number(params.get("secs") ?? 15) * 1000));
    } else {
      await controller.start({ source });
      await source.finished;
    }
    await new Promise((ok) => setTimeout(ok, Number(params.get("tail") ?? 3000)));
    const segments = controller.current.segments.map((s) => s.text);
    const sourceLabel = controller.current.sourceLabel;
    await controller.stop();
    off();
    const platform = platformReport(caps, storage.diagnostics, inEvenApp);
    out("done", {
      run, pageMsAtStart: Math.round(t0), host: platform.host, engine: platform.engine, userAgent: caps.userAgent, webgpu: caps.webgpu.available, crossOriginIsolated: caps.crossOriginIsolated, threads: caps.wasmThreads,
      models: live.map((id) => `${id}@${catalogEntry(id)?.manifest.version.slice(0, 8)}`), sttFinal: models.sttFinal, wav: bridgeMic ? "bridge mic" : wavUrl, source: sourceLabel, warmMs,
      metrics: summarizeLiveMetrics(events), firstCaption: captions[0] ?? null, captionUpdates: captions.length, captions: captions.slice(0, 40), segments, startedAtMs: Math.round(t0), timeline: timeline.slice(0, 12),
    });
    }
    for (let i = 0; i < 600 && post.busy; i++) await new Promise((ok) => setTimeout(ok, 500));
    out("post-idle", { t: pageMs() });
  } catch (e) {
    out("failed", { error: errorMessage(e) });
  }
}

