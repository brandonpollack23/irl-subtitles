import { errorMessage, Emitter, type Settings } from "@irl/domain";
import { catalogEntry } from "./catalog";
import type { EngineKind, LocalEngines } from "./engines";

export interface WarmupStatus {
  /** Display names of selected live models that are downloaded and still loading, by warmup or by a recording. */
  loading: string[];
  failed: string[];
  /** Selected live models that aren't downloaded, so won't load until they are. */
  missing: string[];
  /** Every selected live model is loaded. */
  ready: boolean;
}

type ModelState = "loading" | "ready" | "failed" | "missing" | "cold";

interface WarmTarget {
  id: string;
  engine: Extract<EngineKind, "audio" | "asr">;
  load: () => Promise<unknown>;
}

export interface WarmupDeps {
  settings: () => Pick<Settings, "provider" | "models" | "powerPolicy">;
  /** A recording is capturing: its live run is loading the same models, so a new pass would only compete. */
  recording: () => boolean;
  /** Post-processing owns the workers and loads other models into them. */
  processing: () => boolean;
}

/**
 * Loads the selected live models (VAD, speaker embedding, live STT) in the background so the first
 * recording doesn't wait on them (plan.md §6.1: the recording path must not wait on model setup). Only
 * downloaded models load; nothing downloads here. One lane per worker, so VAD and embedding load in turn
 * on the audio worker while STT loads on the asr worker. A recording that starts mid-pass shares the
 * in-flight loads through LocalEngines' per-model load promises.
 */
export class ModelWarmup {
  readonly status = new Emitter<WarmupStatus>();
  private state: WarmupStatus = { loading: [], failed: [], missing: [], ready: false };
  private passStates = new Map<string, ModelState>();
  /** Selected live models some other caller (a recording's live run) is loading right now. */
  private external = new Set<string>();
  private generation = 0;
  private key: string | null = null;
  // Passes queue per worker: two loads racing inside one worker could leave the wrong model loaded.
  private lanes: Record<WarmTarget["engine"], Promise<void>> = { audio: Promise.resolve(), asr: Promise.resolve() };

  constructor(
    private readonly engines: Pick<LocalEngines, "isDownloaded" | "ensureVad" | "ensureEmbedding" | "ensureAsr"> & Partial<Pick<LocalEngines, "progress">>,
    private readonly deps: WarmupDeps,
  ) {
    // A recording that starts while warmup is idle (e.g. right after post-processing evicted the caption model)
    // loads the models itself; the glasses should still say so.
    engines.progress?.on((p) => {
      if (!liveIds(this.deps.settings()).includes(p.modelId) || p.status === "downloading") return;
      const had = this.external.has(p.modelId);
      if (p.status === "loading") this.external.add(p.modelId);
      else this.external.delete(p.modelId);
      if (had !== this.external.has(p.modelId)) this.publish();
    });
  }

  get current(): WarmupStatus {
    return this.state;
  }

  /** Warms again only if the live selection changed since the last pass. */
  selectionChanged(): Promise<void> {
    return keyOf(this.deps.settings()) === this.key ? Promise.resolve() : this.warm();
  }

  /** Loads the current selection; call after anything that may have evicted it (post-processing, benchmarks). */
  async warm(): Promise<void> {
    if (this.deps.recording() || this.deps.processing()) return;
    const gen = ++this.generation;
    const s = this.deps.settings();
    this.key = keyOf(s);
    const m = s.models;
    const targets: WarmTarget[] = [
      { id: m.vad, engine: "audio", load: () => this.engines.ensureVad(m.vad) },
      { id: m.speakerEmbedding, engine: "audio", load: () => this.engines.ensureEmbedding(m.speakerEmbedding) },
    ];
    if (s.provider === "local" && m.sttLive !== "off") targets.push({ id: m.sttLive, engine: "asr", load: () => this.engines.ensureAsr(m.sttLive) });

    const downloaded = await Promise.all(targets.map((t) => this.engines.isDownloaded(t.id).catch(() => false)));
    if (gen !== this.generation) return;
    const states = new Map<string, ModelState>(targets.map((t, i) => [t.id, downloaded[i] ? "loading" : "missing"]));
    this.passStates = states;
    this.publish();

    const step = (t: WarmTarget) => async () => {
      // A newer pass owns the status; this one just stops starting loads.
      if (gen !== this.generation || states.get(t.id) !== "loading") return;
      if (this.deps.processing()) states.set(t.id, "cold");
      else {
        try {
          await t.load();
          states.set(t.id, "ready");
        } catch (e) {
          console.warn(`[warmup] ${t.id}: ${errorMessage(e)}`);
          states.set(t.id, "failed");
        }
      }
      if (gen === this.generation) this.publish();
    };
    await Promise.all(
      (["audio", "asr"] as const).map((engine) => {
        const tail = targets.filter((t) => t.engine === engine).reduce((prev, t) => prev.then(step(t)), this.lanes[engine]);
        this.lanes[engine] = tail;
        return tail;
      }),
    );
  }

  private publish(): void {
    const name = (id: string) => catalogEntry(id)?.displayName ?? id;
    const ids = (want: ModelState) => [...this.passStates].filter(([, st]) => st === want).map(([id]) => id);
    const loading = [...new Set([...ids("loading"), ...this.external])];
    const ready = [...this.passStates.values()].every((st) => st === "ready") && this.external.size === 0;
    this.state = { loading: loading.map(name), failed: ids("failed").map(name), missing: ids("missing").map(name), ready };
    this.status.emit(this.state);
  }
}

function liveIds(s: Pick<Settings, "provider" | "models">): string[] {
  const m = s.models;
  return [m.vad, m.speakerEmbedding, ...(s.provider === "local" && m.sttLive !== "off" ? [m.sttLive] : [])];
}

function keyOf(s: Pick<Settings, "provider" | "models" | "powerPolicy">): string {
  // Power policy picks the execution target, and a different target is a different load.
  return JSON.stringify([s.provider, s.powerPolicy, s.models.vad, s.models.speakerEmbedding, s.models.sttLive]);
}
