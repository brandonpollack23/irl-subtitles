import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OsEventTypeList, type EvenHubEvent } from "@evenrealities/even_hub_sdk";
import type { LiveSnapshot, RecordingController } from "@irl/pipeline";
import type { SettingsStore } from "@irl/storage";
import { GlassesController, gestureOf } from "../src/glasses";

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
  const glasses = new GlassesController(controller as unknown as RecordingController, {} as SettingsStore, async () => "Speaker");
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
    const settings = { get: () => ({ showCaptionsOnGlasses: true, persistAudio: false }), changes: { on: () => () => undefined } };
    const glasses = new GlassesController({ current: snapshot } as unknown as RecordingController, settings as unknown as SettingsStore, async () => "Speaker");
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

  it("re-resolves the speaker name when a live candidate lands after the label change (irl-subt-kdl.16)", async () => {
    const snapshot = (candidate?: string) =>
      ({
        state: "recording", provider: "local", persistAudio: false, capturedSamples: 0, segments: [], provisionalText: "", recordingId: "rec", currentClusterId: "L1", labelsVersion: 1,
        clusters: [{ recordingId: "rec", clusterId: "L1", ordinal: 1, evidenceMs: 0, ...(candidate ? { candidatePersonId: candidate } : {}) }],
      }) as unknown as LiveSnapshot;
    const settings = { get: () => ({ showCaptionsOnGlasses: true, persistAudio: false }), changes: { on: () => () => undefined } };
    let current = snapshot();
    const names = vi.fn(async () => (current.clusters[0]!.candidatePersonId ? "Alice?" : "Speaker 1"));
    const glasses = new GlassesController({ current } as unknown as RecordingController, settings as unknown as SettingsStore, names);
    const bridge = { rebuildPageContainer: vi.fn(async (_page: { textObject: { content: string }[] }) => true), textContainerUpgrade: vi.fn(async (_u: { containerID: number; content: string }) => true) };
    Object.assign(glasses, { bridge, created: Promise.resolve(true) });
    const internals = glasses as unknown as { onSnapshot(s: LiveSnapshot): void; refreshNames(s: LiveSnapshot): Promise<void>; nameCache: Map<string, string> };
    await internals.refreshNames(current);
    expect(internals.nameCache.get("rec:L1")).toBe("Speaker 1");
    // Same labelsVersion: the identity change was already counted before the coordinator attached the candidate.
    current = snapshot("person_alice");
    await internals.refreshNames(current);
    expect(internals.nameCache.get("rec:L1")).toBe("Alice?");
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
});
