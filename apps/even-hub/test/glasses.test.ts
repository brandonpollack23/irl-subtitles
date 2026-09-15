import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OsEventTypeList, type EvenHubEvent } from "@evenrealities/even_hub_sdk";
import { defaultSettings, newConfigProfile, type ModelSelection, type Settings } from "@irl/domain";
import { setLocale } from "@irl/i18n";
import type { LiveSnapshot, RecordingController } from "@irl/pipeline";
import type { SettingsStore } from "@irl/storage";
import { GlassesController, gestureOf } from "../src/glasses";
import type { ProfileSwitch } from "../src/profiles";

const tap = { textEvent: { containerID: 2, containerName: "body" } } as EvenHubEvent;
const doubleTap = { textEvent: { containerID: 2, containerName: "body", eventType: OsEventTypeList.DOUBLE_CLICK_EVENT } } as EvenHubEvent;
const menuOpened = { sysEvent: { eventType: OsEventTypeList.FOREGROUND_ENTER_EVENT } } as EvenHubEvent;

function setup(state: LiveSnapshot["state"]) {
  const controller = {
    current: { state } as LiveSnapshot,
    start: vi.fn(async () => "rec"),
    pause: vi.fn(async () => undefined),
    resume: vi.fn(async () => undefined),
    stop: vi.fn(async () => "rec"),
    addMarker: vi.fn(async () => undefined),
  };
  const bridge = { shutDownPageContainer: vi.fn(async () => true) };
  const glasses = new GlassesController(controller as unknown as RecordingController, {} as SettingsStore, async () => ({ name: "Speaker", personId: null }));
  Object.assign(glasses, { bridge });
  const send = (e: EvenHubEvent) => (glasses as unknown as { onEvent(e: EvenHubEvent): void }).onEvent(e);
  return { controller, bridge, send };
}

describe("glasses gestures (Conversate model)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("tap starts once the double-tap window passes", async () => {
    const { controller, send } = setup("idle");
    send(tap);
    await vi.advanceTimersByTimeAsync(200);
    expect(controller.start).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(400);
    expect(controller.start).toHaveBeenCalledOnce();
  });

  it("tap pauses while recording and resumes while paused", async () => {
    const rec = setup("recording");
    rec.send(tap);
    await vi.advanceTimersByTimeAsync(600);
    expect(rec.controller.pause).toHaveBeenCalledOnce();

    const paused = setup("paused");
    paused.send(tap);
    await vi.advanceTimersByTimeAsync(600);
    expect(paused.controller.resume).toHaveBeenCalledOnce();
  });

  it("double tap ends a recording without also pausing it", async () => {
    const { controller, send } = setup("recording");
    send(tap);
    send(doubleTap);
    await vi.advanceTimersByTimeAsync(600);
    expect(controller.stop).toHaveBeenCalledOnce();
    expect(controller.pause).not.toHaveBeenCalled();
  });

  it("double tap on the idle page asks the system to confirm exit", async () => {
    const { controller, bridge, send } = setup("idle");
    send(doubleTap);
    await vi.advanceTimersByTimeAsync(600);
    expect(bridge.shutDownPageContainer).toHaveBeenCalledWith(1);
    expect(controller.start).not.toHaveBeenCalled();
  });

  it("the tap that opens the OS menu does nothing", async () => {
    const { controller, send } = setup("recording");
    send(tap);
    send(menuOpened);
    await vi.advanceTimersByTimeAsync(600);
    expect(controller.pause).not.toHaveBeenCalled();
  });

  it("recognizes taps from the text container and from sysEvent", () => {
    expect(gestureOf(tap)).toBe("tap");
    expect(gestureOf({ textEvent: { eventType: OsEventTypeList.CLICK_EVENT } } as EvenHubEvent)).toBe("tap");
    expect(gestureOf(doubleTap)).toBe("double");
    expect(gestureOf({ sysEvent: { eventType: OsEventTypeList.DOUBLE_CLICK_EVENT } } as EvenHubEvent)).toBe("double");
    expect(gestureOf({ textEvent: { eventType: OsEventTypeList.SCROLL_TOP_EVENT } } as EvenHubEvent)).toBeNull();
    expect(gestureOf({ sysEvent: { eventType: OsEventTypeList.IMU_DATA_REPORT } } as EvenHubEvent)).toBeNull();
    expect(gestureOf(menuOpened)).toBeNull();
  });
});

describe("glasses model loading notice", () => {
  function page(state: LiveSnapshot["state"]) {
    const snapshot = { state, provider: "local", persistAudio: false, capturedSamples: 0, segments: [], provisionalText: "", recordingId: null, currentClusterId: null, labelsVersion: 0 } as unknown as LiveSnapshot;
    const settings = { get: () => ({ showCaptionsOnGlasses: true, persistAudio: false, configProfiles: [] }), changes: { on: () => () => undefined } };
    const glasses = new GlassesController({ current: snapshot } as unknown as RecordingController, settings as unknown as SettingsStore, async () => ({ name: "Speaker", personId: null }));
    const bridge = {
      rebuildPageContainer: vi.fn(async (_page: { textObject: { content: string }[] }) => true),
      textContainerUpgrade: vi.fn(async (_update: { containerID: number; content: string }) => true),
    };
    Object.assign(glasses, { bridge, created: Promise.resolve(true) });
    const internals = glasses as unknown as { onSnapshot(s: LiveSnapshot): void; renderTail: Promise<void> };
    internals.onSnapshot(snapshot);
    const body = async () => {
      await internals.renderTail;
      const upgrades = bridge.textContainerUpgrade.mock.calls.filter(([u]) => u.containerID === 2);
      return upgrades.length ? upgrades.at(-1)![0].content : bridge.rebuildPageContainer.mock.calls.at(-1)![0].textObject[1]!.content;
    };
    return { glasses, bridge, body };
  }

  const loading = { loading: ["Moonshine Base (en)"], failed: [], missing: [] };
  const done = { loading: [], failed: [], missing: [] };

  it("says models are loading on the idle page, then that captions are ready, then clears it", async () => {
    vi.useFakeTimers();
    const { glasses, body } = page("idle");
    expect(await body()).toBe("Ready. Audio won't be saved.\nTap to start. Double tap to exit.");
    glasses.setModelStatus(loading);
    await vi.advanceTimersByTimeAsync(500);
    expect(await body()).toBe("Audio won't be saved.\nCaption models are loading. You can start now; captions follow once they're ready.\nTap to start. Double tap to exit.");
    glasses.showNotice("Ready on your phone.");
    expect(await body()).toContain("Ready on your phone.\nCaption models are loading.");
    glasses.showNotice(null);
    glasses.setModelStatus(done);
    expect(await body()).toBe("Ready. Audio won't be saved.\nCaptions ready.\nTap to start. Double tap to exit.");
    await vi.advanceTimersByTimeAsync(4000);
    expect(await body()).toBe("Ready. Audio won't be saved.\nTap to start. Double tap to exit.");
    vi.useRealTimers();
  });

  it("doesn't flash a loading line for models that were already in memory", async () => {
    vi.useFakeTimers();
    const { glasses, bridge, body } = page("idle");
    glasses.setModelStatus(loading);
    await vi.advanceTimersByTimeAsync(50);
    glasses.setModelStatus(done);
    await vi.advanceTimersByTimeAsync(5000);
    expect(bridge.textContainerUpgrade.mock.calls.some(([u]) => /loading|ready/i.test(u.content))).toBe(false);
    expect(await body()).toBe("Ready. Audio won't be saved.\nTap to start. Double tap to exit.");
    vi.useRealTimers();
  });

  it("adds a short line while recording, then 'Captions ready.' briefly", async () => {
    vi.useFakeTimers();
    const { glasses, body } = page("recording");
    glasses.setModelStatus(loading);
    await vi.advanceTimersByTimeAsync(500);
    expect(await body()).toBe("Captions loading, they'll start shortly.\n(audio not saved)");
    glasses.setModelStatus(done);
    expect(await body()).toBe("Captions ready.\n(audio not saved)");
    await vi.advanceTimersByTimeAsync(4000);
    expect(await body()).toBe("(audio not saved)");
    vi.useRealTimers();
  });

  it("never shows 'slowed to keep up' on the glasses, but still shows other degraded notices", async () => {
    const { glasses, body } = page("recording");
    const internals = glasses as unknown as { onSnapshot(s: LiveSnapshot): void };
    const base = { state: "recording", provider: "local", persistAudio: false, capturedSamples: 0, segments: [], provisionalText: "", recordingId: null, currentClusterId: null, labelsVersion: 0 };
    internals.onSnapshot({ ...base, degraded: { code: "slowed" } } as unknown as LiveSnapshot);
    expect(await body()).toBe("(audio not saved)");
    internals.onSnapshot({ ...base, degraded: { code: "captions-paused" } } as unknown as LiveSnapshot);
    expect(await body()).toContain("Captions paused");
  });

  it("re-resolves the speaker name when a live candidate lands after the label change (irl-subt-kdl.16)", async () => {
    const snapshot = (candidate?: string) =>
      ({
        state: "recording", provider: "local", persistAudio: false, capturedSamples: 0, segments: [], provisionalText: "", recordingId: "rec", currentClusterId: "L1", labelsVersion: 1,
        clusters: [{ recordingId: "rec", clusterId: "L1", ordinal: 1, evidenceMs: 0, ...(candidate ? { candidatePersonId: candidate } : {}) }],
      }) as unknown as LiveSnapshot;
    const settings = { get: () => ({ showCaptionsOnGlasses: true, persistAudio: false, configProfiles: [] }), changes: { on: () => () => undefined } };
    let current = snapshot();
    const names = vi.fn(async () => ({ name: current.clusters[0]!.candidatePersonId ? "Alice?" : "Speaker 1", personId: null }));
    const glasses = new GlassesController({ current } as unknown as RecordingController, settings as unknown as SettingsStore, names);
    const bridge = { rebuildPageContainer: vi.fn(async (_page: { textObject: { content: string }[] }) => true), textContainerUpgrade: vi.fn(async (_u: { containerID: number; content: string }) => true) };
    Object.assign(glasses, { bridge, created: Promise.resolve(true) });
    const internals = glasses as unknown as { onSnapshot(s: LiveSnapshot): void; refreshNames(s: LiveSnapshot): Promise<void>; nameCache: Map<string, { name: string }> };
    await internals.refreshNames(current);
    expect(internals.nameCache.get("rec:L1")?.name).toBe("Speaker 1");
    // Same labelsVersion: the identity change was already counted before the coordinator attached the candidate.
    current = snapshot("person_alice");
    await internals.refreshNames(current);
    expect(internals.nameCache.get("rec:L1")?.name).toBe("Alice?");
  });

  it("leaves the wearer's own speech off the captions when asked (irl-subt-kdl.19)", async () => {
    const seg = (id: string, clusterId: string, text: string) => ({ id, clusterId, text });
    const snapshot = {
      state: "recording", provider: "local", persistAudio: false, capturedSamples: 0, recordingId: "rec", currentClusterId: "L1", labelsVersion: 1, clusters: [],
      segments: [seg("s1", "L2", "Nice to meet you."), seg("s2", "L1", "Likewise."), seg("s3", "L2", "Where are you from?"), seg("s4", "L1", "Seattle.")],
      provisionalText: "And you",
    } as unknown as LiveSnapshot;
    const speakers: Record<string, { name: string; personId: string | null }> = { L1: { name: "Brandon", personId: "person_me" }, L2: { name: "Alice", personId: "person_alice" } };
    const render = async (patch: Record<string, unknown>) => {
      const settings = { get: () => ({ showCaptionsOnGlasses: true, persistAudio: false, selfPersonId: "person_me", hideOwnSpeechOnGlasses: false, ...patch }), changes: { on: () => () => undefined } };
      const glasses = new GlassesController({ current: snapshot } as unknown as RecordingController, settings as unknown as SettingsStore, async (_r, c) => speakers[c]!);
      const internals = glasses as unknown as { refreshNames(s: LiveSnapshot): Promise<void>; texts(mode: string, s: LiveSnapshot): { body: string } };
      await internals.refreshNames(snapshot);
      return internals.texts("recording", snapshot).body;
    };
    expect(await render({})).toBe("Alice: Where are you from?\nBrandon: Seattle.\nAnd you\n(audio not saved)");
    expect(await render({ hideOwnSpeechOnGlasses: true })).toBe("Alice: Nice to meet you.\nAlice: Where are you from?\n(audio not saved)");
    // Nobody marked as me: nothing is hidden.
    expect(await render({ hideOwnSpeechOnGlasses: true, selfPersonId: null })).toBe("Alice: Where are you from?\nBrandon: Seattle.\nAnd you\n(audio not saved)");
    // A "Name?" candidate isn't an attribution, so it's still shown.
    speakers.L1 = { name: "Brandon?", personId: null };
    expect(await render({ hideOwnSpeechOnGlasses: true })).toBe("Alice: Where are you from?\nBrandon?: Seattle.\nAnd you\n(audio not saved)");
  });

  it("says on the idle page when a model failed to load or isn't downloaded", async () => {
    vi.useFakeTimers();
    const { glasses, body } = page("idle");
    glasses.setModelStatus(loading);
    await vi.advanceTimersByTimeAsync(500);
    glasses.setModelStatus({ loading: [], failed: ["Moonshine Base (en)"], missing: ["CAM++ (WeSpeaker, VoxCeleb)"] });
    expect(await body()).toBe(
      "Ready. Audio won't be saved.\nCaptions unavailable: Moonshine Base (en) didn't load. Recording still works.\nNot downloaded: CAM++ (WeSpeaker, VoxCeleb). Download on your phone for live captions.\nTap to start. Double tap to exit.",
    );
    vi.useRealTimers();
  });

  it("speaks the UI language, menu included", async () => {
    setLocale("ja");
    try {
      const { bridge, body } = page("idle");
      expect(await body()).toBe("準備完了。音声は保存されません。\nタップで開始、ダブルタップで終了。");
      const pageArg = bridge.rebuildPageContainer.mock.calls.at(-1)![0] as unknown as { textObject: { content: string }[]; menuObject: { menuItems: { itemName: string }[] } };
      expect(pageArg.menuObject.menuItems.map((i) => i.itemName)).toEqual(["録音を開始", "音声保存: オフ"]);
      expect(pageArg.textObject[0]!.content).toBe("IRL Subtitles  端末内");
    } finally {
      setLocale("en");
    }
  });
});

describe("glasses profile menu (irl-subt-r4t)", () => {
  const LOCAL: ModelSelection = { vad: "silero", sttLive: "moonshine", sttFinal: "whisper", speakerEmbedding: "campplus", summary: "gemma" };
  const local = newConfigProfile("Local", { language: "en", powerPolicy: "balanced", models: LOCAL });
  const cloud = newConfigProfile("Cloud", { language: "en", powerPolicy: "fast", models: { ...LOCAL, sttLive: "soniox:stt-rt-v5" } });

  function setupMenu(state: LiveSnapshot["state"], profiles = [local, cloud]) {
    const snapshot = { state, provider: "local", persistAudio: false, capturedSamples: 0, segments: [], provisionalText: "", recordingId: null, currentClusterId: null, labelsVersion: 0 } as unknown as LiveSnapshot;
    let settings: Settings = { ...defaultSettings(LOCAL), configProfiles: profiles, activeConfigProfileId: local.id };
    const store = { get: () => settings, changes: { on: () => () => undefined } };
    const switchProfile = vi.fn(async (id: string): Promise<ProfileSwitch | null> => {
      const p = settings.configProfiles.find((x) => x.id === id)!;
      settings = { ...settings, ...p, name: undefined, id: undefined, activeConfigProfileId: id } as unknown as Settings;
      return { profile: p, reset: p === cloud ? ["stt-live"] : [], voices: null };
    });
    const glasses = new GlassesController({ current: snapshot } as unknown as RecordingController, store as unknown as SettingsStore, async () => ({ name: "Speaker", personId: null }), switchProfile);
    const bridge = {
      rebuildPageContainer: vi.fn(async (_page: { textObject: { content: string }[]; menuObject?: { menuItems: { itemName: string; itemID: number }[] } }) => true),
      textContainerUpgrade: vi.fn(async (_update: { containerID: number; content: string }) => true),
    };
    Object.assign(glasses, { bridge, created: Promise.resolve(true) });
    const internals = glasses as unknown as { onSnapshot(s: LiveSnapshot): void; onEvent(e: EvenHubEvent): void; render(s: LiveSnapshot, rebuild: boolean): Promise<void>; renderTail: Promise<void> };
    internals.onSnapshot(snapshot);
    const menu = async () => {
      await internals.renderTail;
      return bridge.rebuildPageContainer.mock.calls.at(-1)![0].menuObject?.menuItems ?? [];
    };
    const click = async (itemName: string) => {
      const item = (await menu()).find((i) => i.itemName === itemName)!;
      internals.onEvent({ menuItemClickEvent: { itemID: item.itemID } } as unknown as EvenHubEvent);
      await vi.waitFor(() => expect(switchProfile).toHaveBeenCalled());
      await new Promise((ok) => setTimeout(ok, 0));
      // What init()'s settings listener does on the idle page.
      await internals.render(snapshot, true);
    };
    return { glasses, bridge, menu, click, switchProfile, internals };
  }

  it("lists each profile after Start and Save audio, marking the one in use", async () => {
    const { menu } = setupMenu("idle");
    expect((await menu()).map((i) => i.itemName)).toEqual(["Start recording", "Save audio: off", "* Local", "Cloud"]);
  });

  it("switches profile from the menu, moves the marker and says so on the idle page", async () => {
    const { menu, click, switchProfile, bridge } = setupMenu("idle");
    await click("Cloud");
    expect(switchProfile).toHaveBeenCalledWith(cloud.id);
    expect((await menu()).map((i) => i.itemName)).toEqual(["Start recording", "Save audio: off", "Local", "* Cloud"]);
    const bodies = [...bridge.rebuildPageContainer.mock.calls.map(([p]) => p.textObject[1]!.content), ...bridge.textContainerUpgrade.mock.calls.filter(([u]) => u.containerID === 2).map(([u]) => u.content)];
    expect(bodies.some((b) => b.startsWith("Profile: Cloud\nCan't run as saved; using this phone's default for: Live captions."))).toBe(true);
  });

  it("offers no profiles while recording, and ignores a stale profile click", async () => {
    const { menu, switchProfile, internals } = setupMenu("recording");
    expect((await menu()).map((i) => i.itemName)).toEqual(["Add marker", "Pause", "Stop and summarize"]);
    internals.onEvent({ menuItemClickEvent: { itemID: 100 } } as unknown as EvenHubEvent);
    await new Promise((ok) => setTimeout(ok, 0));
    expect(switchProfile).not.toHaveBeenCalled();
  });

  it("keeps the menu within the firmware's 10 items", async () => {
    const many = Array.from({ length: 12 }, (_, i) => newConfigProfile(`P${i}`, { language: "en", powerPolicy: "balanced", models: LOCAL }));
    const { menu } = setupMenu("idle", many);
    expect(await menu()).toHaveLength(10);
  });
});
