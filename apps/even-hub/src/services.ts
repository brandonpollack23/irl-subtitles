import { t } from "@irl/i18n";
import { G2AudioSource, getBridge, PhoneMicSource, RecordingAudio, WavFileSource, type AudioSource } from "@irl/capture";
import {
  activeAttributions,
  defaultSettings,
  Emitter,
  errorMessage,
  glassesSpeakerName,
  isVoiceIdOption,
  newId,
  serviceOption,
  SPEECHMATICS_VOICE_ID,
  SPEECHMATICS_VOICE_SPACE,
  type BenchmarkResult,
  type CloudFinalProvider,
  type LiveSpeechProvider,
  type Person,
  type Settings,
} from "@irl/domain";
import {
  EphemeralKeys,
  IdentityService,
  PostProcessor,
  RecordingController,
  recoverInterrupted,
  type RecoveredRecording,
} from "@irl/pipeline";
import {
  catalogEntry,
  defaultSelection,
  defaultWorkers,
  embeddingSpaceOf,
  liveMetrics,
  LocalEngines,
  LocalToolkit,
  ModelWarmup,
  summarizeLiveMetrics,
  type LiveMetric,
  type DeviceCapabilities,
} from "@irl/provider-local";
import { SonioxAsyncProvider, SonioxSpeechProvider } from "@irl/provider-soniox";
import { SpeechmaticsBatchProvider, SpeechmaticsSpeechProvider } from "@irl/provider-speechmatics";
import { openStorage, SettingsStore, type StorageHandles, type StorageStep } from "@irl/storage";
import workletUrl from "@irl/capture/worklet?worker&url";
import { GlassesController } from "./glasses";
import { installConsoleCapture, logger, setLogContent } from "./log";
import { platformReport } from "./platform";
import { fitDevice, switchProfile, type ProfileSwitch } from "./profiles";

const log = logger("boot");

export interface AppServices {
  storage: StorageHandles;
  settings: SettingsStore;
  engines: LocalEngines;
  toolkit: LocalToolkit;
  audio: RecordingAudio;
  identity: IdentityService;
  controller: RecordingController;
  post: PostProcessor;
  glasses: GlassesController;
  /** Background loading of the selected live models; call warm() after anything that evicts them. */
  warmup: ModelWarmup;
  ephemeral: EphemeralKeys;
  caps: DeviceCapabilities;
  inEvenApp: boolean;
  recovered: RecoveredRecording[];
  /** Bumped whenever stored data changes so views reload. */
  dataChanged: Emitter<{ recordingId?: string }>;
  devWav: { name: string; bytes: Uint8Array } | null;
  setDevWav(file: { name: string; bytes: Uint8Array } | null): void;
  /** Why the recording isn't using the chosen microphone. */
  sourceNote: "glasses-fallback" | null;
  saveBenchmarks(results: BenchmarkResult[]): Promise<void>;
  /** Switches to a saved configuration profile (irl-subt-r4t); null when it no longer exists. */
  switchProfile(id: string): Promise<ProfileSwitch | null>;
}

const BENCH_KEY = "benchmarks.v1";

export type BootStep = StorageStep | "bridge" | "device" | "glasses" | "recovery";

export async function boot(onStep: (step: BootStep) => void = () => undefined): Promise<AppServices> {
  installConsoleCapture();
  onStep("bridge");
  const inEvenApp = (await getBridge(2500)) !== null;
  const preferTurso = localStorage.getItem("irl.storage.preferTurso") !== "0";
  const storage = await openStorage({ preferTurso, onStep });
  log.info("storage", storage.diagnostics);
  const settings = await SettingsStore.open(storage.repo, defaultSettings(defaultSelection("en")));
  setLogContent(settings.get().diagnosticsIncludeContent);

  onStep("device");
  const engines = new LocalEngines(defaultWorkers());
  engines.policy = settings.get().powerPolicy;
  engines.benchmarks = (await storage.repo.getSetting<BenchmarkResult[]>(BENCH_KEY)) ?? [];
  const caps = await engines.capabilities();
  log.info("capabilities", caps);
  const platform = platformReport(caps, storage.diagnostics, inEvenApp);
  log.info("platform", platform);
  if (import.meta.env.DEV) {
    console.info(`[dev] ${platform.host} (${platform.engine}) · database ${platform.database} · audio ${platform.audio}`);
    console.table(Object.fromEntries(platform.features.map((f) => [f.name, { available: f.ok, detail: f.detail ?? "" }])));
  }
  engines.events.on((e) => log.warn("engine", e));

  // Selections that can't run on this device (e.g. a model needing shader-f16) fall back to the most
  // preferred option that can, so a fresh install never starts with an unusable model.
  {
    const current = settings.get();
    const fitted = fitDevice(current.models, current.language, caps);
    for (const r of fitted.replaced) log.warn(`${r.from} can't run here; using ${r.to}`);
    if (fitted.replaced.length) await settings.update({ models: fitted.models });
  }

  const ephemeral = new EphemeralKeys();
  const audio = new RecordingAudio(storage.repo, storage.blobs, (kind, id) => (kind === "durable" ? storage.durable : ephemeral.get(id)));
  const toolkit = new LocalToolkit(engines, () => settings.get());
  // Saved identifiers refused (e.g. Speechmatics changed model version): stop sending them and re-enroll from clips.
  function onIdentifiersRejected(reason: string): void {
    log.warn("Speechmatics rejected saved voice identifiers", reason);
    void identity.markServiceProfilesStale().then(() => identity.migrateEmbeddingSpace(SPEECHMATICS_VOICE_ID, SPEECHMATICS_VOICE_SPACE)).catch((e) => log.error("re-enrolling voices failed", errorMessage(e)));
  }
  const speechmaticsBatch = new SpeechmaticsBatchProvider({ apiKey: () => storage.secrets.get("speechmatics_api_key"), region: () => settings.get().speechmaticsRegion, onIdentifiersRejected });
  // Enrolls one person's kept clips with Speechmatics: the speaker with the most speech in the job is them.
  const enrollWithSpeechmatics = async (wav: Uint8Array, language: string) => {
    const r = await speechmaticsBatch.transcribe({ recordingId: "enroll", providerRunId: newId("enroll"), optionId: "speechmatics-batch:enhanced", language, wav, signal: new AbortController().signal, getSpeakers: true });
    const span = (id: string) => r.turns.filter((t) => t.clusterId === id).reduce((n, t) => n + t.endSample - t.startSample, 0);
    return [...(r.speakers ?? [])].sort((a, b) => span(b.clusterId) - span(a.clusterId))[0]?.identifiers ?? null;
  };
  const identity = new IdentityService(storage.repo, storage.blobs, storage.durable, audio, () => settings.get(), (m, w) => toolkit.embed(m, w), enrollWithSpeechmatics);
  const dataChanged = new Emitter<{ recordingId?: string }>();
  identity.changes.on((c) => dataChanged.emit({ recordingId: c.recordingId }));

  const soniox = new SonioxSpeechProvider({
    apiKey: () => storage.secrets.get("soniox_api_key"),
    replay: (id, s, e) => audio.readRange(id, { startSample: s, endSample: e }),
  });
  const speechmatics = new SpeechmaticsSpeechProvider({
    apiKey: () => storage.secrets.get("speechmatics_api_key"),
    region: () => settings.get().speechmaticsRegion,
    replay: (id, s, e) => audio.readRange(id, { startSample: s, endSample: e }),
    speakerSession: async (config) => {
      if (!isVoiceIdOption(config.embeddingModelId)) return { speakers: [], getSpeakers: false };
      const sensitivity = settings.get().speechmaticsSpeakersSensitivity;
      return { speakers: await identity.serviceSpeakers(), getSpeakers: true, ...(sensitivity !== null ? { sensitivity } : {}) };
    },
    onIdentifiersRejected,
  });
  const liveProviders: Record<string, LiveSpeechProvider> = { soniox, speechmatics };
  const sonioxAsync = new SonioxAsyncProvider({ apiKey: () => storage.secrets.get("soniox_api_key") });
  const finalProviders: Record<string, CloudFinalProvider> = { speechmatics: speechmaticsBatch, soniox: sonioxAsync };
  const cloudFinal = (optionId: string): CloudFinalProvider | null => {
    const o = serviceOption(optionId);
    return o?.kind === "batch-final" ? (finalProviders[o.service] ?? null) : null;
  };

  // With Speechmatics voice ID the phone still separates speakers live with its default voice model.
  const local = toolkit.liveProvider();
  const localLive: LiveSpeechProvider = {
    id: local.id,
    capabilities: local.capabilities,
    start: (config) => local.start(isVoiceIdOption(config.embeddingModelId) ? { ...config, embeddingModelId: defaultSelection(config.language).speakerEmbedding } : config),
  };

  let controller!: RecordingController;
  const post = new PostProcessor({
    repo: storage.repo, blobs: storage.blobs, audio, toolkit, identity, settings, ephemeral, durable: storage.durable, cloudFinal,
    isCapturing: () => controller.activeRecordingId !== null,
  });
  post.events.on((e) => {
    log.info("post", e.recordingId, e.stage, e.status, e.note ?? "");
    if (e.status !== "running" || e.progress === undefined) dataChanged.emit({ recordingId: e.recordingId });
  });

  const services = {} as AppServices;
  const glassesRef: { current: GlassesController | null } = { current: null };

  const createSource = async (): Promise<AudioSource> => {
    const kind = settings.get().captureSource;
    services.sourceNote = null;
    if (kind === "wav-file") {
      const wav = services.devWav;
      const bytes = wav?.bytes ?? new Uint8Array(await (await fetch("/fixtures/jfk.wav")).arrayBuffer());
      return new WavFileSource(async () => bytes, wav ? `WAV: ${wav.name}` : "WAV: sample clip");
    }
    if (kind === "glasses" && inEvenApp) return new G2AudioSource(() => glassesRef.current!.ensurePage());
    if (kind === "glasses") services.sourceNote = "glasses-fallback";
    return new PhoneMicSource(workletUrl);
  };

  controller = new RecordingController({
    repo: storage.repo, blobs: storage.blobs, durable: storage.durable, ephemeral, settings, identity,
    providers: async (optionId) => {
      if (optionId === "local") return localLive;
      const provider = liveProviders[serviceOption(optionId)?.service ?? ""];
      if (!provider) throw new Error(`No live provider for ${optionId}`);
      return provider;
    },
    createSource,
    onCaptured: (id) => {
      post.enqueue(id);
      dataChanged.emit({ recordingId: id });
    },
    modelVersions: () => {
      const m = settings.get().models;
      const out: Record<string, string> = {};
      for (const [role, id] of Object.entries(m)) {
        const e = catalogEntry(id);
        if (e) out[role] = `${id}@${e.manifest.version}`;
      }
      return out;
    },
  });
  // Live-path timings per recording go to diagnostics when capture ends (irl-subt-kdl.1).
  let metricEvents: LiveMetric[] = [];
  liveMetrics.on((m) => (m.kind === "load" || controller.activeRecordingId !== null) && metricEvents.push(m));
  let lastState = controller.current.state;
  controller.live.on((s) => {
    if (s.state === lastState) return;
    if (s.state === "starting") metricEvents = metricEvents.filter((m) => m.kind === "load");
    if ((lastState === "recording" || lastState === "paused") && s.state !== "recording" && s.state !== "paused" && metricEvents.some((m) => m.kind !== "load")) {
      log.info("live-metrics", summarizeLiveMetrics(metricEvents));
      metricEvents = [];
    }
    lastState = s.state;
    dataChanged.emit({ recordingId: s.recordingId ?? undefined });
  });
  settings.changes.on((s: Settings) => {
    engines.policy = s.powerPolicy;
    setLogContent(s.diagnosticsIncludeContent);
  });

  const names = async (recordingId: string, clusterId: string) => {
    const [clusters, attrs, people] = await Promise.all([storage.repo.listClusters(recordingId), storage.repo.listAttributions(recordingId), storage.repo.listPeople()]);
    const live = controller.current.clusters;
    const clusterMap = new Map([...clusters, ...live].map((c) => [c.clusterId, c]));
    const active = activeAttributions(attrs);
    const name = glassesSpeakerName(clusterId, clusterMap, active, new Map<string, Person>(people.map((p) => [p.id, p])), t().speakers);
    return { name, personId: active.get(clusterId)?.personId ?? null };
  };
  const glasses = new GlassesController(controller, settings, names);
  glassesRef.current = glasses;

  // Live models load at launch rather than when a recording starts; Start never waits on them.
  const warmup = new ModelWarmup(engines, { settings: () => settings.get(), recording: () => controller.activeRecordingId !== null, processing: () => post.busy });
  warmup.status.on((s) => glasses.setModelStatus(s));
  settings.changes.on(() => void warmup.selectionChanged());
  // Post-processing loads the final STT model over the live one, so the next conversation would start cold.
  post.idle.on(() => void warmup.warm());
  void warmup.warm();

  // After Stop the idle glasses page says what the phone is doing with the last conversation.
  post.events.on((e) => {
    if (e.stage === "finalStt" && e.status === "running" && e.progress === undefined && !e.note) glasses.showNotice(t().glasses.processingLast);
    if (e.stage === "done") {
      void storage.repo.getRecording(e.recordingId).then((r) => glasses.showNotice(r?.title ? t().glasses.readyOnPhoneTitle(r.title) : t().glasses.readyOnPhone));
    }
  });
  onStep("glasses");
  if (inEvenApp) await glasses.init().catch((e) => log.error("glasses init failed", errorMessage(e)));
  onStep("recovery");

  // Every launch is crash recovery (plan.md §9); capture never resumes on its own.
  const recovered = await recoverInterrupted(storage.repo, storage.blobs, audio, null).catch((e) => {
    log.error("recovery failed", errorMessage(e));
    return [];
  });
  if (recovered.length) log.warn("recovered recordings", recovered.map((r) => ({ id: r.recording.id, chunks: r.readableChunks, lost: r.audioLost })));

  Object.assign(services, {
    storage, settings, engines, toolkit, audio, identity, controller, post, glasses, warmup, ephemeral, caps, inEvenApp, recovered, dataChanged,
    devWav: null, sourceNote: null,
    setDevWav(file: { name: string; bytes: Uint8Array } | null) {
      services.devWav = file;
    },
    switchProfile(id: string) {
      return switchProfile(
        {
          settings, caps,
          hasSecret: (name) => storage.secrets.has(name),
          migrateVoices: async (modelId) => ((await storage.repo.listProfiles()).length ? identity.migrateEmbeddingSpace(modelId, embeddingSpaceOf(modelId)) : null),
        },
        id,
      );
    },
    async saveBenchmarks(results: BenchmarkResult[]) {
      const merged = [...engines.benchmarks.filter((b) => !results.some((r) => r.modelId === b.modelId && r.target === b.target)), ...results];
      engines.benchmarks = merged;
      await storage.repo.putSetting(BENCH_KEY, merged);
    },
  } satisfies Partial<AppServices>);
  return services;
}
