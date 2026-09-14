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

  it("tells the idle page models are loading while keeping the gestures, then clears it", async () => {
    const { glasses, body } = page("idle");
    expect(await body()).toBe("Ready. Audio won't be saved.\nTap to start. Double tap to exit.");
    glasses.setModelsLoading(true);
    expect(await body()).toBe("Audio won't be saved.\nCaption models are loading. You can start now; captions follow once they're ready.\nTap to start. Double tap to exit.");
    glasses.showNotice("Ready on your phone.");
    expect(await body()).toContain("Ready on your phone.\nCaption models are loading.");
    glasses.showNotice(null);
    glasses.setModelsLoading(false);
    expect(await body()).toBe("Ready. Audio won't be saved.\nTap to start. Double tap to exit.");
  });

  it("adds a short line while recording and removes it once ready", async () => {
    const { glasses, body } = page("recording");
    glasses.setModelsLoading(true);
    expect(await body()).toBe("Captions loading, they'll start shortly.\n(audio not saved)");
    glasses.setModelsLoading(false);
    expect(await body()).toBe("(audio not saved)");
  });
});
