import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { RecordingAudio, WavFileSource } from "@irl/capture";
import { activeAttributions, defaultSettings, glassesSpeakerName, type ModelSelection, type Person } from "@irl/domain";
import { EphemeralKeys, IdentityService, RecordingController, type LiveSnapshot } from "@irl/pipeline";
import { defaultSelection, liveMetrics, LocalEngines, LocalToolkit, ModelWarmup, summarizeLiveMetrics, type LiveMetric, type LiveMetricsSummary } from "@irl/provider-local";
import { KeyVault, MemoryBlobStore, Repository, SettingsStore, SqlTableStore } from "@irl/storage";
import { nodeSqliteDriver } from "../../../../packages/storage/test/node-sqlite-driver";
import { nodeWorkers } from "../../../../packages/provider-local/test/harness/node-workers";
// @ts-expect-error plain JS test support
import { defaultCacheDir, installWebEnv } from "../../../../packages/provider-local/test/harness/web-env.mjs";
import { GlassesController } from "../../src/glasses";

export interface TimelineEntry {
  /** Seconds since the recording started (wall clock). */
  t: number;
  /** Seconds of audio captured by then. */
  audio: number;
  kind: "glasses" | "engine" | "state" | "degraded" | "speech" | "provisional" | "segments" | "console";
  text: string;
}

export interface RecordingReport {
  recordingId: string;
  timeline: TimelineEntry[];
  /** Body texts the glasses showed while recording, in order, deduplicated. */
  glassesBodies: string[];
  /** Caption lines that reached the glasses (body minus status/hint/audio lines). */
  captionLines: string[];
  firstCaptionAt: TimelineEntry | null;
  finalSegments: string[];
  /** Live-path timings (irl-subt-kdl.1). */
  metrics: LiveMetricsSummary;
}

/** Lines the glasses body adds around captions; everything else in the body is caption text. */
const NON_CAPTION = [/^\((audio not saved|saving audio)\)$/, /^Tap to resume/, /processing later/i, /loading/i, /^Captions ready\.$/, /^Restarting/, /slowed/i, /^Soniox/];

/**
 * The app's live path as services.ts wires it, in Node with real models: RecordingController →
 * ProviderCoordinator → LocalLiveSpeechProvider → LocalEngines → the app's worker modules (worker threads),
 * and GlassesController rendering into a recording fake Even bridge. Only storage backends, the worker
 * transport, Cache Storage, and the bridge differ from the WebView.
 */
export interface LiveAppOptions {
  models?: Partial<ModelSelection>;
  cacheDir?: string;
  /** Start ModelWarmup at creation, as services.ts does at launch (default true). */
  warmAtLaunch?: boolean;
  /** Extra delay before each live STT load, to stand in for slow engines (Moonshine Base takes ~35 s in WebKitGTK). */
  asrLoadDelayMs?: number;
}

export async function createLiveApp(opts: LiveAppOptions = {}) {
  const cacheDir = opts.cacheDir ?? defaultCacheDir();
  installWebEnv(cacheDir);
  const repo = new Repository(await SqlTableStore.open(nodeSqliteDriver()));
  const blobs = new MemoryBlobStore();
  const vault = await KeyVault.open(new IDBFactory());
  const durable = await vault.durableSealer();
  const ephemeral = new EphemeralKeys();
  const models: ModelSelection = { ...defaultSelection("en"), vad: "silero-vad-v6", sttLive: "moonshine-base-en", speakerEmbedding: "campplus-voxceleb", summary: "off", ...opts.models };
  const settings = await SettingsStore.open(repo, { ...defaultSettings(models), captureSource: "wav-file", powerPolicy: "fast" });
  const engines = new LocalEngines(nodeWorkers(cacheDir));
  if (opts.asrLoadDelayMs) {
    const ensureLiveStt = engines.ensureLiveStt.bind(engines);
    engines.ensureLiveStt = async (id) => (await new Promise((ok) => setTimeout(ok, opts.asrLoadDelayMs)), ensureLiveStt(id));
  }
  const toolkit = new LocalToolkit(engines, () => settings.get());
  const audio = new RecordingAudio(repo, blobs, (kind, id) => (kind === "durable" ? durable : ephemeral.get(id)));
  const identity = new IdentityService(repo, blobs, durable, audio, () => settings.get(), (m, w) => toolkit.embed(m, w));

  let wav: Uint8Array | null = null;
  let source: WavFileSource | null = null;
  const controller = new RecordingController({
    repo, blobs, durable, ephemeral, settings, identity,
    providers: async () => toolkit.liveProvider(),
    createSource: async () => (source = new WavFileSource(async () => wav!, "WAV")),
    onCaptured: () => undefined,
  });

  const names = async (recordingId: string, clusterId: string) => {
    const [clusters, attrs, people] = await Promise.all([repo.listClusters(recordingId), repo.listAttributions(recordingId), repo.listPeople()]);
    const clusterMap = new Map([...clusters, ...controller.current.clusters].map((c) => [c.clusterId, c]));
    const active = activeAttributions(attrs);
    const name = glassesSpeakerName(clusterId, clusterMap, active, new Map<string, Person>(people.map((p) => [p.id, p])));
    return { name, personId: active.get(clusterId)?.personId ?? null };
  };

  // GlassesController.init() minus the SDK: the same subscriptions, with a bridge that records what it's sent.
  const shown = { status: "", body: "" };
  const onGlasses: ((c: { status: string; body: string }) => void)[] = [];
  const setText = (id: number, content: string) => {
    if (id === 1) shown.status = content;
    else shown.body = content;
    onGlasses.forEach((l) => l({ ...shown }));
  };
  const bridge = {
    createStartUpPageContainer: async (p: { textObject: { content: string }[] }) => (p.textObject.forEach((t, i) => setText(i + 1, t.content)), 0),
    rebuildPageContainer: async (p: { textObject: { content: string }[] }) => (p.textObject.forEach((t, i) => setText(i + 1, t.content)), true),
    textContainerUpgrade: async (p: { containerID: number; content: string }) => (setText(p.containerID, p.content), true),
    audioControl: async () => true,
    shutDownPageContainer: async () => true,
  };
  const glasses = new GlassesController(controller, settings, names);
  const g = glasses as unknown as { bridge: unknown; onSnapshot(s: LiveSnapshot): void; render(s: LiveSnapshot, rebuild: boolean): Promise<void>; mode: string | null; lastSnapshot: LiveSnapshot | null };
  g.bridge = bridge;
  controller.live.on((s) => g.onSnapshot(s));
  settings.changes.on(() => g.lastSnapshot && g.mode === "idle" && void g.render(g.lastSnapshot, true));
  await glasses.ensurePage();

  // services.ts: live models load at launch, and the glasses say so while they do.
  const warmup = new ModelWarmup(engines, { settings: () => settings.get(), recording: () => controller.activeRecordingId !== null, processing: () => false });
  warmup.status.on((s) => glasses.setModelStatus(s));

  async function download(ids = [models.vad, models.sttLive, models.speakerEmbedding]) {
    for (const id of ids) if (id !== "off" && !(await engines.isDownloaded(id))) await engines.download(id);
  }

  /** Plays a WAV through a real recording at real-time speed and reports what the glasses showed. */
  async function record(wavBytes: Uint8Array, tailMs = 3000, trace = !!process.env.IRL_LIVE_TRACE): Promise<RecordingReport> {
    wav = wavBytes;
    const timeline: TimelineEntry[] = [];
    let t0 = performance.now();
    const add = (kind: TimelineEntry["kind"], text: string) =>
      timeline.push({ t: +((performance.now() - t0) / 1000).toFixed(2), audio: +(controller.current.capturedSamples / 16000).toFixed(2), kind, text });
    const offGlasses = (onGlasses.push((c) => add("glasses", c.body)), () => onGlasses.splice(0));
    const metricEvents: LiveMetric[] = [];
    const offMetrics = liveMetrics.on((m) => metricEvents.push(m));
    const offEngine = engines.progress.on((p) => p.status !== "downloading" && add("engine", `${p.modelId} ${p.status}${p.error ? ` ${p.error}` : ""}`));
    let last = { state: "", degraded: null as string | null, speech: false, provisional: "", segments: "" };
    const offLive = controller.live.on((s) => {
      const segments = JSON.stringify(s.segments.map((x) => x.text));
      if (s.state !== last.state) add("state", s.state);
      if (s.degraded !== last.degraded) add("degraded", String(s.degraded));
      if (s.speechActive !== last.speech) add("speech", String(s.speechActive));
      if (s.provisionalText !== last.provisional) add("provisional", s.provisionalText);
      if (segments !== last.segments) add("segments", segments);
      last = { state: s.state, degraded: s.degraded, speech: s.speechActive, provisional: s.provisionalText, segments };
    });
    // The live provider reports model errors and scheduler changes on the console.
    const warn = console.warn;
    console.warn = (...args: unknown[]) => (add("console", args.map(String).join(" ")), warn(...args));
    // Observe (not change) what the live provider asks of the models.
    const rmsDb = (x: Float32Array) => (x.length ? 10 * Math.log10(x.reduce((n, v) => n + v * v, 0) / x.length + 1e-12) : -120).toFixed(0);
    const vadPush = engines.vadPush.bind(engines);
    const transcribe = engines.transcribe.bind(engines);
    engines.vadPush = (async (samples: Float32Array, ...rest: unknown[]) => {
      const n = samples.length;
      const db = rmsDb(samples);
      const out = await (vadPush as (...a: unknown[]) => Promise<{ probs: Float32Array; firstWindowStart: number }>)(samples, ...rest);
      const speechy = Array.from(out.probs).filter((p) => p >= 0.5).length;
      if (trace) add("console", `vad.push n=${n} rms=${db}dB firstWindowStart=${out.firstWindowStart} windows=${out.probs.length} speech=${speechy} max=${Math.max(0, ...out.probs).toFixed(2)}`);
      return out;
    }) as typeof engines.vadPush;
    engines.transcribe = (async (samples: Float32Array, language: string, words: boolean) => {
      const n = samples.length;
      const db = rmsDb(samples);
      const t = performance.now();
      const out = await transcribe(samples, language, words);
      add("console", `transcribe ${(n / 16000).toFixed(2)}s rms=${db}dB took=${((performance.now() - t) / 1000).toFixed(2)}s -> ${JSON.stringify(out.text)}`);
      return out;
    }) as typeof engines.transcribe;
    t0 = performance.now();
    const recordingId = await controller.start();
    await source!.finished;
    await new Promise((ok) => setTimeout(ok, tailMs));
    const finalSegments = controller.current.segments.map((s) => s.text);
    add("state", "stopping");
    await controller.stop();
    offGlasses();
    offMetrics();
    offEngine();
    offLive();
    console.warn = warn;
    engines.vadPush = vadPush;
    engines.transcribe = transcribe;

    // What the glasses showed from the recording page's first draw until Stop: the idle page isn't a caption.
    const stopAt = timeline.findIndex((e) => e.kind === "state" && e.text === "stopping");
    const firstRec = timeline.findIndex((e) => e.kind === "glasses" && e.text.includes("(audio not saved)"));
    const during = firstRec < 0 ? [] : timeline.slice(firstRec, stopAt).filter((e) => e.kind === "glasses");
    const glassesBodies = during.map((e) => e.text).filter((b, i, all) => b !== all[i - 1]);
    const captionOf = (body: string) => body.split("\n").filter((l) => l.trim() && !NON_CAPTION.some((re) => re.test(l.trim())));
    const captionLines = [...new Set(glassesBodies.flatMap(captionOf))];
    return { recordingId, timeline, glassesBodies, captionLines, firstCaptionAt: during.find((e) => captionOf(e.text).length > 0) ?? null, finalSegments, metrics: summarizeLiveMetrics(metricEvents) };
  }

  /** Downloads anything missing (never counted as launch time), then launches warmup like the app. */
  async function launch() {
    await download();
    if (opts.warmAtLaunch !== false) void warmup.warm();
  }

  return { engines, controller, glasses, settings, warmup, models, download, launch, record, dispose: () => engines.release(["audio", "asr", "llm"]) };
}
