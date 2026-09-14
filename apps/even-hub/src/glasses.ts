import { OsEventTypeList, StartUpPageCreateResult, type EvenAppBridge, type EvenHubEvent } from "@evenrealities/even_hub_sdk";
import { getBridge, onHubEvent } from "@irl/capture";
import { formatClock, G2_MENU_LABEL_MAX_BYTES, truncateUtf8, utf8ByteLength, errorMessage } from "@irl/domain";
import type { LiveSnapshot, RecordingController } from "@irl/pipeline";
import type { SettingsStore } from "@irl/storage";
import { logger } from "./log";

const log = logger("glasses");

const MENU = { start: 1, stop: 2, pause: 3, resume: 4, marker: 5, toggleAudio: 6 } as const;
const STATUS = { id: 1, name: "status" };
const BODY = { id: 2, name: "body" };
const TEXT_LIMIT = 900;
/**
 * A single tap waits this long before acting, so the second tap of a double tap (or the OS's
 * tap-then-hold menu gesture) can cancel it instead of starting or pausing first.
 */
const TAP_SETTLE_MS = 500;

type Mode = "idle" | "recording" | "paused" | "finalizing";

function modeOf(s: LiveSnapshot): Mode {
  if (s.state === "recording" || s.state === "starting") return "recording";
  if (s.state === "paused") return "paused";
  if (s.state === "finalizing") return "finalizing";
  return "idle";
}

function label(text: string) {
  return utf8ByteLength(text) <= G2_MENU_LABEL_MAX_BYTES ? text : truncateUtf8(text, G2_MENU_LABEL_MAX_BYTES);
}

/**
 * The constrained G2 surface (plan.md §10): idle start page, and while recording a persistent REC
 * indicator with elapsed time, the current speaker, the last caption lines, and degraded-state text.
 * Touchpad gestures mirror Even's Conversate: tap to start, tap to pause or resume, double tap to end
 * (stop and summarize). Double tap on the idle root page opens the system exit dialog, as Even Hub
 * app review requires. The contextual menu adds marker and the "Save audio" toggle.
 * Text updates use textContainerUpgrade and are coalesced so a slow BLE link never builds a backlog.
 */
export class GlassesController {
  private bridge: EvenAppBridge | null = null;
  private created: Promise<boolean> | null = null;
  private mode: Mode | null = null;
  private notice: string | null = null;
  private lastSnapshot: LiveSnapshot | null = null;
  private nameCache = new Map<string, string>();
  private nameVersion = -1;
  failures = 0;

  constructor(
    private readonly controller: RecordingController,
    private readonly settings: SettingsStore,
    private readonly names: (recordingId: string, clusterId: string) => Promise<string>,
  ) {}

  async init(): Promise<boolean> {
    this.bridge = await getBridge();
    if (!this.bridge) return false;
    onHubEvent((e) => this.onEvent(e));
    this.controller.live.on((s) => this.onSnapshot(s));
    this.settings.changes.on(() => this.lastSnapshot && this.mode === "idle" && void this.render(this.lastSnapshot, true));
    await this.ensurePage();
    this.onSnapshot(this.controller.current);
    return true;
  }

  get available(): boolean {
    return this.bridge !== null;
  }

  /** The SDK requires the startup page before glasses audio can open (plan.md §9 step 2). */
  ensurePage(): Promise<boolean> {
    this.created ??= (async () => {
      const bridge = this.bridge ?? (await getBridge());
      if (!bridge) return false;
      const result = await bridge.createStartUpPageContainer(this.page("idle", this.controller.current) as never);
      const ok = result === StartUpPageCreateResult.success;
      if (!ok) log.error("createStartUpPageContainer failed", result);
      this.mode = "idle";
      return ok;
    })();
    return this.created;
  }

  showNotice(text: string | null): void {
    this.notice = text;
    if (this.lastSnapshot) void this.render(this.lastSnapshot, false);
  }

  private menu(mode: Mode): { itemName: string; itemID: number }[] {
    const persist = this.settings.get().persistAudio;
    switch (mode) {
      case "idle":
        return [
          { itemName: label("Start recording"), itemID: MENU.start },
          { itemName: label(persist ? "Save audio: on" : "Save audio: off"), itemID: MENU.toggleAudio },
        ];
      case "recording":
        return [
          { itemName: "Add marker", itemID: MENU.marker },
          { itemName: "Pause", itemID: MENU.pause },
          { itemName: "Stop and summarize", itemID: MENU.stop },
        ];
      case "paused":
        return [
          { itemName: "Resume", itemID: MENU.resume },
          { itemName: "Stop and summarize", itemID: MENU.stop },
        ];
      case "finalizing":
        return [];
    }
  }

  private page(mode: Mode, s: LiveSnapshot) {
    const texts = this.texts(mode, s);
    const menu = this.menu(mode);
    return {
      containerTotalNum: 2,
      textObject: [
        { xPosition: 0, yPosition: 0, width: 576, height: 48, containerID: STATUS.id, containerName: STATUS.name, content: texts.status, isEventCapture: 0 },
        { xPosition: 0, yPosition: 52, width: 576, height: 236, containerID: BODY.id, containerName: BODY.name, content: texts.body, isEventCapture: 1 },
      ],
      ...(menu.length ? { menuObject: { menuItems: menu } } : {}),
    };
  }

  private texts(mode: Mode, s: LiveSnapshot): { status: string; body: string } {
    const provider = s.provider === "soniox" ? "Soniox" : "Local";
    const audio = s.persistAudio ? "saving audio" : "audio not saved";
    if (mode === "idle") {
      const ready = `Ready. ${s.persistAudio ? "Audio will be saved." : "Audio won't be saved."}`;
      return { status: `IRL Subtitles  ${provider}`, body: truncateUtf8(`${this.notice ?? ready}\nTap to start. Double tap to exit.`, TEXT_LIMIT) };
    }
    if (mode === "finalizing") return { status: "Stopped", body: "Saved. Processing on your phone…" };
    // The recording indicator is always the first thing on the status line (plan.md §11: never covert).
    const indicator = mode === "paused" ? "PAUSED" : "REC";
    const speaker = s.currentClusterId && s.recordingId ? this.nameCache.get(`${s.recordingId}:${s.currentClusterId}`) : null;
    const status = `${indicator} ${formatClock(s.capturedSamples)}  ${speaker ?? ""}`.trim();
    let body: string;
    if (s.degraded && !this.settings.get().showCaptionsOnGlasses) body = s.degraded;
    else {
      const last = s.segments.slice(-2).map((seg) => {
        const name = seg.clusterId && s.recordingId ? this.nameCache.get(`${s.recordingId}:${seg.clusterId}`) : null;
        return name ? `${name}: ${seg.text}` : seg.text;
      });
      const caption = [...last, s.provisionalText].filter(Boolean).join("\n");
      const tail = caption.length > 220 ? `…${caption.slice(-220)}` : caption;
      const hint = mode === "paused" ? "Tap to resume. Double tap to end." : "";
      body = [this.settings.get().showCaptionsOnGlasses ? tail : "", s.degraded ?? "", hint, `(${audio})`].filter(Boolean).join("\n");
    }
    return { status: truncateUtf8(status, 120), body: truncateUtf8(body || " ", TEXT_LIMIT) };
  }

  private onSnapshot(s: LiveSnapshot): void {
    this.lastSnapshot = s;
    const mode = modeOf(s);
    if (mode === "recording") this.notice = null;
    void this.refreshNames(s);
    void this.render(s, mode !== this.mode);
  }

  private async refreshNames(s: LiveSnapshot): Promise<void> {
    if (!s.recordingId) return;
    const ids = new Set([s.currentClusterId, ...s.segments.slice(-2).map((x) => x.clusterId)].filter((x): x is string => !!x));
    if (s.labelsVersion !== this.nameVersion) {
      this.nameCache.clear();
      this.nameVersion = s.labelsVersion;
    }
    let changed = false;
    for (const id of ids) {
      const key = `${s.recordingId}:${id}`;
      if (this.nameCache.has(key)) continue;
      this.nameCache.set(key, await this.names(s.recordingId, id).catch(() => "Speaker"));
      changed = true;
    }
    if (changed && this.lastSnapshot) void this.render(this.lastSnapshot, false);
  }

  private renderTail: Promise<void> = Promise.resolve();

  /** Page rebuilds and text upgrades must not interleave, or a stale page can land after a newer one. */
  private renderQueued = false;
  private rebuildQueued = false;

  private render(s: LiveSnapshot, rebuild: boolean): Promise<void> {
    this.lastSnapshot ??= s;
    this.rebuildQueued ||= rebuild;
    // Coalesce: one queued render always draws the latest snapshot, so a slow BLE link never builds a backlog.
    if (this.renderQueued) return this.renderTail;
    this.renderQueued = true;
    const next = this.renderTail.then(() => {
      this.renderQueued = false;
      const snap = this.lastSnapshot!;
      const doRebuild = this.rebuildQueued || modeOf(snap) !== this.mode;
      this.rebuildQueued = false;
      return this.renderNow(snap, doRebuild);
    });
    this.renderTail = next.catch(() => undefined);
    return next;
  }

  private async renderNow(s: LiveSnapshot, rebuild: boolean): Promise<void> {
    if (!this.bridge || !(await this.ensurePage())) return;
    const mode = modeOf(s);
    if (rebuild) {
      this.mode = mode;
      try {
        const page = this.page(mode, s);
        const ok = await this.bridge.rebuildPageContainer(page as never);
        if (ok) {
          this.shown.set(STATUS.id, page.textObject[0]!.content);
          this.shown.set(BODY.id, page.textObject[1]!.content);
        } else {
          this.failures++;
          this.failedRebuild();
        }
      } catch (e) {
        this.failures++;
        this.failedRebuild();
        log.warn("rebuildPageContainer failed", errorMessage(e));
      }
      return;
    }
    const t = this.texts(mode, s);
    for (const [id, content] of [[STATUS.id, t.status], [BODY.id, t.body]] as const) {
      if (this.shown.get(id) === content) continue;
      const name = id === STATUS.id ? STATUS.name : BODY.name;
      const ok = await this.bridge.textContainerUpgrade({ containerID: id, containerName: name, content } as never).catch(() => false);
      if (ok) this.shown.set(id, content);
      else this.failures++;
    }
  }

  /** Last text sent per container, so unchanged text isn't resent over BLE. */
  private shown = new Map<number, string>();

  /** The glasses may still show the previous page: forget what's on it and rebuild on the next snapshot. */
  private failedRebuild(): void {
    this.mode = null;
    this.shown.clear();
  }

  private pendingTap: ReturnType<typeof setTimeout> | null = null;

  private cancelTap(): void {
    if (this.pendingTap) clearTimeout(this.pendingTap);
    this.pendingTap = null;
  }

  private onEvent(e: EvenHubEvent): void {
    const id = e.menuItemClickEvent?.itemID;
    if (id !== undefined) {
      this.cancelTap();
      void this.act(() => this.onMenu(id));
      return;
    }
    const sys = e.sysEvent?.eventType;
    // The OS menu opens on tap-then-hold; that tap must not start or pause anything.
    if (sys === OsEventTypeList.FOREGROUND_ENTER_EVENT || sys === OsEventTypeList.LONG_PRESS_EVENT) return this.cancelTap();
    const gesture = gestureOf(e);
    if (gesture === "tap") {
      this.cancelTap();
      this.pendingTap = setTimeout(() => {
        this.pendingTap = null;
        void this.act(() => this.onTap());
      }, TAP_SETTLE_MS);
    } else if (gesture === "double") {
      this.cancelTap();
      void this.act(() => this.onDoubleTap());
    }
  }

  private async onMenu(id: number): Promise<void> {
    if (id === MENU.start) await this.controller.start();
    else if (id === MENU.stop) await this.controller.stop();
    else if (id === MENU.pause) await this.controller.pause();
    else if (id === MENU.resume) await this.controller.resume();
    else if (id === MENU.marker) await this.controller.addMarker("Marker");
    else if (id === MENU.toggleAudio) {
      await this.controller.setPersistAudio(!this.settings.get().persistAudio);
      if (this.lastSnapshot) await this.render({ ...this.controller.current }, true);
    }
  }

  private async onTap(): Promise<void> {
    const mode = modeOf(this.controller.current);
    if (mode === "idle") await this.controller.start();
    else if (mode === "recording") await this.controller.pause();
    else if (mode === "paused") await this.controller.resume();
  }

  private async onDoubleTap(): Promise<void> {
    const mode = modeOf(this.controller.current);
    if (mode === "recording" || mode === "paused") await this.controller.stop();
    // Root page: the system exit confirmation (mode 1); never a silent or custom exit.
    else if (mode === "idle") await this.bridge?.shutDownPageContainer(1);
  }

  private async act(run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (err) {
      log.error("glasses action failed", errorMessage(err));
      this.notice = errorMessage(err);
      if (this.lastSnapshot) await this.render(this.lastSnapshot, false);
    }
  }
}

/**
 * Taps reach the capturing text container as textEvent, where the SDK can normalize CLICK_EVENT (0)
 * to undefined; ring and frame presses can also arrive as sysEvent.
 */
export function gestureOf(e: EvenHubEvent): "tap" | "double" | null {
  const target = e.textEvent ?? e.listEvent;
  if (target) {
    if (target.eventType === OsEventTypeList.DOUBLE_CLICK_EVENT) return "double";
    return target.eventType === OsEventTypeList.CLICK_EVENT || target.eventType === undefined ? "tap" : null;
  }
  const sys = e.sysEvent;
  if (!sys) return null;
  if (sys.eventType === OsEventTypeList.DOUBLE_CLICK_EVENT) return "double";
  if (sys.eventType === OsEventTypeList.CLICK_EVENT) return "tap";
  return sys.eventType === undefined && sys.eventSource !== undefined && !sys.imuData ? "tap" : null;
}
