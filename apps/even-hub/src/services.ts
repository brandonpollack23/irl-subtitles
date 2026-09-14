import { G2AudioSource, getBridge, PhoneMicSource, RecordingAudio, WavFileSource, type AudioSource } from "@irl/capture";
import {
  activeAttributions,
  defaultSettings,
  Emitter,
  errorMessage,
  G2_SPEAKER_NAME_MAX_BYTES,
  speakerLabel,
  type BenchmarkResult,
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
  availabilityOnDevice,
  catalogEntry,
  defaultSelection,
  defaultWorkers,
  entriesForRole,
  LocalEngines,
  LocalToolkit,
  ModelWarmup,
  ROLE_KEYS,
  supportsLanguage,
  type DeviceCapabilities,
} from "@irl/provider-local";
import { SonioxSpeechProvider } from "@irl/provider-soniox";
import { openStorage, SettingsStore, type StorageHandles } from "@irl/storage";
import workletUrl from "@irl/capture/worklet?worker&url";
import { GlassesController } from "./glasses";
import { installConsoleCapture, logger, setLogContent } from "./log";
import { platformReport } from "./platform";

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
  sourceNote: string | null;
  saveBenchmarks(results: BenchmarkResult[]): Promise<void>;
}

const BENCH_KEY = "benchmarks.v1";

export async function boot(onStep: (step: string) => void = () => undefined): Promise<AppServices> {
  installConsoleCapture();
  onStep("Connecting to the Even app");
  const inEvenApp = (await getBridge(2500)) !== null;
  const preferTurso = localStorage.getItem("irl.storage.preferTurso") !== "0";
  const storage = await openStorage({ preferTurso, onStep });
  log.info("storage", storage.diagnostics);
  const settings = await SettingsStore.open(storage.repo, defaultSettings(defaultSelection("en")));
  setLogContent(settings.get().diagnosticsIncludeContent);

  onStep("Checking this device");
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
    const models = { ...current.models };
    let changed = false;
    for (const role of ["vad", "stt-live", "stt-final", "speaker-embedding", "summary"] as const) {
      const key = ROLE_KEYS[role];
      const entry = catalogEntry(models[key]);
      if (!entry || availabilityOnDevice(entry, caps).status === "available") continue;
      const options = entriesForRole(role).filter((e) => availabilityOnDevice(e, caps).status === "available" && supportsLanguage(e, current.language));
      const next = options.find((e) => e.planDefault) ?? options[0];
      (models as Record<string, string>)[key] = next?.id ?? (role === "stt-live" || role === "summary" ? "off" : role === "stt-final" ? "same-as-live" : models[key]);
      log.warn(`${entry.displayName} can't run here; using ${next?.displayName ?? (models as Record<string, string>)[key]}`);
      changed = true;
    }
    if (changed) await settings.update({ models });
  }

  const ephemeral = new EphemeralKeys();
  const audio = new RecordingAudio(storage.repo, storage.blobs, (kind, id) => (kind === "durable" ? storage.durable : ephemeral.get(id)));
  const toolkit = new LocalToolkit(engines, () => settings.get());
  const identity = new IdentityService(storage.repo, storage.blobs, storage.durable, audio, () => settings.get(), (m, w) => toolkit.embed(m, w));
  const dataChanged = new Emitter<{ recordingId?: string }>();
  identity.changes.on((c) => dataChanged.emit({ recordingId: c.recordingId }));

  const soniox = new SonioxSpeechProvider({
    apiKey: () => storage.secrets.get("soniox_api_key"),
    model: () => settings.get().sonioxModel,
    replay: (id, s, e) => audio.readRange(id, { startSample: s, endSample: e }),
  });

  let controller!: RecordingController;
  const post = new PostProcessor({
    repo: storage.repo, blobs: storage.blobs, audio, toolkit, identity, settings, ephemeral, durable: storage.durable,
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
    if (kind === "glasses") services.sourceNote = "Glasses aren't available outside the Even app, so the phone microphone is recording.";
    return new PhoneMicSource(workletUrl);
  };

  controller = new RecordingController({
    repo: storage.repo, blobs: storage.blobs, durable: storage.durable, ephemeral, settings, identity,
    providers: async (kind) => (kind === "soniox" ? soniox : toolkit.liveProvider()),
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
  let lastState = controller.current.state;
  controller.live.on((s) => {
    if (s.state === lastState) return;
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
    return speakerLabel(clusterId, clusterMap, activeAttributions(attrs), new Map<string, Person>(people.map((p) => [p.id, p])), { maxBytes: G2_SPEAKER_NAME_MAX_BYTES }).text;
  };
  const glasses = new GlassesController(controller, settings, names);
  glassesRef.current = glasses;

  // Live models load at launch rather than when a recording starts; Start never waits on them.
  const warmup = new ModelWarmup(engines, { settings: () => settings.get(), recording: () => controller.activeRecordingId !== null, processing: () => post.busy });
  warmup.status.on((s) => glasses.setModelsLoading(s.loading.length > 0));
  settings.changes.on(() => void warmup.selectionChanged());
  // Post-processing loads the final STT model over the live one, so the next conversation would start cold.
  post.idle.on(() => void warmup.warm());
  void warmup.warm();

  // After Stop the idle glasses page says what the phone is doing with the last conversation.
  post.events.on((e) => {
    if (e.stage === "finalStt" && e.status === "running" && e.progress === undefined && !e.note) glasses.showNotice("Processing your last conversation on the phone…");
    if (e.stage === "done") {
      void storage.repo.getRecording(e.recordingId).then((r) => glasses.showNotice(r?.title ? `Ready on your phone: ${r.title}` : "Ready on your phone."));
    }
  });
  onStep("Setting up the glasses");
  if (inEvenApp) await glasses.init().catch((e) => log.error("glasses init failed", errorMessage(e)));
  onStep("Checking for interrupted recordings");

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
    async saveBenchmarks(results: BenchmarkResult[]) {
      const merged = [...engines.benchmarks.filter((b) => !results.some((r) => r.modelId === b.modelId && r.target === b.target)), ...results];
      engines.benchmarks = merged;
      await storage.repo.putSetting(BENCH_KEY, merged);
    },
  } satisfies Partial<AppServices>);
  return services;
}
