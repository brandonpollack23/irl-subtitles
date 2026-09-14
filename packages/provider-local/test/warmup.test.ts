import { describe, expect, it, vi } from "vitest";
import { defaultSettings, type Settings } from "@irl/domain";
import { defaultSelection } from "../src/catalog";
import { ModelWarmup, type WarmupStatus } from "../src/warmup";

function deferred() {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

function setup(opts: { missing?: string[] } = {}) {
  let settings: Settings = defaultSettings(defaultSelection("en"));
  const loads = new Map<string, ReturnType<typeof deferred>>();
  const load = (id: string) => {
    let d = loads.get(id);
    if (!d) loads.set(id, (d = deferred()));
    return d.promise;
  };
  const engines = {
    isDownloaded: vi.fn(async (id: string) => !opts.missing?.includes(id)),
    ensureVad: vi.fn(load),
    ensureEmbedding: vi.fn(load),
    ensureAsr: vi.fn(async (id: string) => (await load(id), "wasm" as const)),
  };
  const busy = { recording: false, processing: false };
  const warmup = new ModelWarmup(engines, { settings: () => settings, recording: () => busy.recording, processing: () => busy.processing });
  const seen: WarmupStatus[] = [];
  warmup.status.on((s) => seen.push(s));
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { warmup, engines, loads, busy, seen, flush, update: (patch: Partial<Settings>) => (settings = { ...settings, ...patch }), settings: () => settings };
}

describe("model warmup", () => {
  it("loads VAD then embedding on the audio worker while live STT loads alongside", async () => {
    const t = setup();
    const done = t.warmup.warm();
    await t.flush();
    expect(t.warmup.current).toEqual({ loading: ["Silero VAD v6", "CAM++ (WeSpeaker, VoxCeleb)", "Moonshine Base (en)"], failed: [], ready: false });
    expect(t.engines.ensureVad).toHaveBeenCalledWith("silero-vad-v6");
    expect(t.engines.ensureAsr).toHaveBeenCalledWith("moonshine-base-en");
    expect(t.engines.ensureEmbedding).not.toHaveBeenCalled();

    t.loads.get("silero-vad-v6")!.resolve();
    await t.flush();
    expect(t.engines.ensureEmbedding).toHaveBeenCalledWith("campplus-voxceleb");
    expect(t.warmup.current.loading).toEqual(["CAM++ (WeSpeaker, VoxCeleb)", "Moonshine Base (en)"]);

    t.loads.get("campplus-voxceleb")!.resolve();
    t.loads.get("moonshine-base-en")!.resolve();
    await done;
    expect(t.warmup.current).toEqual({ loading: [], failed: [], ready: true });
  });

  it("never loads a model that isn't downloaded, and a failed load stops counting as loading", async () => {
    const t = setup({ missing: ["campplus-voxceleb"] });
    const done = t.warmup.warm();
    await t.flush();
    expect(t.warmup.current.loading).toEqual(["Silero VAD v6", "Moonshine Base (en)"]);
    t.loads.get("silero-vad-v6")!.resolve();
    t.loads.get("moonshine-base-en")!.reject(new Error("out of memory"));
    await done;
    expect(t.engines.ensureEmbedding).not.toHaveBeenCalled();
    expect(t.warmup.current).toEqual({ loading: [], failed: ["Moonshine Base (en)"], ready: false });
  });

  it("warms nothing new during a recording or post-processing", async () => {
    const t = setup();
    t.busy.recording = true;
    await t.warmup.warm();
    t.busy.recording = false;
    t.busy.processing = true;
    await t.warmup.warm();
    expect(t.engines.isDownloaded).not.toHaveBeenCalled();
    expect(t.seen).toEqual([]);
  });

  it("stops starting loads once post-processing takes the workers", async () => {
    const t = setup();
    const done = t.warmup.warm();
    await t.flush();
    t.busy.processing = true;
    t.loads.get("silero-vad-v6")!.resolve();
    t.loads.get("moonshine-base-en")!.resolve();
    await done;
    expect(t.engines.ensureEmbedding).not.toHaveBeenCalled();
    expect(t.warmup.current).toEqual({ loading: [], failed: [], ready: false });
  });

  it("re-warms on a selection change, skipping live STT for Soniox and ignoring unrelated settings", async () => {
    const t = setup();
    for (const id of ["silero-vad-v6", "campplus-voxceleb", "moonshine-base-en"]) t.loads.set(id, { ...deferred(), promise: Promise.resolve() });
    await t.warmup.warm();
    expect(t.warmup.current.ready).toBe(true);

    t.update({ persistAudio: true });
    await t.warmup.selectionChanged();
    expect(t.engines.isDownloaded).toHaveBeenCalledTimes(3);

    t.update({ models: { ...t.settings().models, sttLive: "moonshine-tiny-en" } });
    const done = t.warmup.selectionChanged();
    await t.flush();
    // The unchanged models are already loaded and settle at once.
    expect(t.warmup.current.loading).toEqual(["Moonshine Tiny (en)"]);

    // A newer selection supersedes the pass still waiting on Moonshine Tiny.
    t.update({ provider: "soniox" });
    const soniox = t.warmup.selectionChanged();
    await t.flush();
    t.loads.get("moonshine-tiny-en")!.resolve();
    await Promise.all([done, soniox]);
    expect(t.engines.ensureAsr).toHaveBeenCalledTimes(2);
    expect(t.warmup.current).toEqual({ loading: [], failed: [], ready: true });
  });
});
