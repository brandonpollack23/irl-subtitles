import { OsEventTypeList, StartUpPageCreateResult, type EvenAppBridge, type EvenHubEvent } from "@evenrealities/even_hub_sdk";
import { getBridge, onHubEvent } from "@irl/capture";
import { activeProfile, G2_MENU_LABEL_MAX_BYTES, MAX_CONFIG_PROFILES, truncateUtf8, utf8ByteLength, errorMessage, SERVICE_NAMES } from "@irl/domain";
import { describe, fmt, localeChanges, t } from "@irl/i18n";
import type { LiveSnapshot, RecordingController } from "@irl/pipeline";
import type { SettingsStore } from "@irl/storage";
import { logger } from "./log";
import type { ProfileSwitch } from "./profiles";

const log = logger("glasses");

const MENU = { start: 1, stop: 2, pause: 3, resume: 4, marker: 5, toggleAudio: 6, firstProfile: 100 } as const;
const STATUS = { id: 1, name: "status" };
const BODY = { id: 2, name: "body" };
const DOT = { id: 3, name: "rec-dot" };
const CONTAINERS = [STATUS, BODY, DOT] as const;
const REC_DOT = "•";
/** The recording dot is on screen almost all the time and blinks off briefly, so it reads as live without nagging. */
const DOT_ON_MS = 5000;
const DOT_OFF_MS = 400;
const TEXT_LIMIT = 900;
/** Loads shorter than this (a model that was already in memory) don't flash a loading line. */
const LOADING_SHOW_AFTER_MS = 400;
const READY_NOTICE_MS = 4000;

/** What the app knows about the selected live models (ModelWarmup's status, by display name). */
export interface ModelStatus {
  loading: string[];
  failed: string[];
  missing: string[];
}
/**
 * A single tap waits this long before acting, so the second tap of a double tap (or the OS's
 * tap-then-hold menu gesture) can cancel it instead of starting or pausing first.
 */
const TAP_SETTLE_MS = 500;

type Mode = "idle" | "recording" | "paused" | "finalizing";

/** A live speaker as the glasses show it: the caption-line name, and the person it's attributed to (not a mere candidate). */
export interface GlassesSpeaker {
  name: string;
  personId: string | null;
}

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
 * The constrained G2 surface (plan.md §10): idle start page, and while recording a small dot blinking now and then in the
 * top-right corner (the recording indicator), the current speaker, the last caption lines, and degraded-state text.
 * Touchpad gestures mirror Even's Conversate: tap to start, tap to pause or resume, double tap to end
 * (stop and summarize). Double tap on the idle root page opens the system exit dialog, as Even Hub
 * app review requires. The contextual menu adds marker and the "Save audio" toggle, and on the idle page one item per
 * configuration profile (irl-subt-r4t), the active one marked, to switch before starting.
 * Text updates use textContainerUpgrade and are coalesced so a slow BLE link never builds a backlog.
 */
export class GlassesController {
  private bridge: EvenAppBridge | null = null;
  private created: Promise<boolean> | null = null;
  private mode: Mode | null = null;
  private notice: string | null = null;
  private models: ModelStatus = { loading: [], failed: [], missing: [] };
  /** The loading line is on screen (after LOADING_SHOW_AFTER_MS), then "Captions ready." for READY_NOTICE_MS. */
  private modelsLine: "loading" | "ready" | null = null;
  private modelsTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSnapshot: LiveSnapshot | null = null;
  private nameCache = new Map<string, GlassesSpeaker>();
  private nameVersion = "";
  /** Profile ids behind the menu items on the glasses now, so a click acts on what was shown. */
  private menuProfiles: string[] = [];
  private dotOn = true;
  private blinkTimer: ReturnType<typeof setTimeout> | null = null;
  failures = 0;

  constructor(
    private readonly controller: RecordingController,
    private readonly settings: SettingsStore,
    private readonly names: (recordingId: string, clusterId: string) => Promise<GlassesSpeaker>,
    private readonly switchProfile: (id: string) => Promise<ProfileSwitch | null> = async () => null,
  ) {}

  async init(): Promise<boolean> {
    this.bridge = await getBridge();
    if (!this.bridge) return false;
    onHubEvent((e) => this.onEvent(e));
    this.controller.live.on((s) => this.onSnapshot(s));
    this.settings.changes.on(() => this.lastSnapshot && this.mode === "idle" && void this.render(this.lastSnapshot, true));
    // A new UI language rebuilds the page (menu labels live in the page) and re-resolves speaker words.
    localeChanges.on(() => {
      this.nameCache.clear();
      this.nameVersion = "";
      if (this.lastSnapshot) {
        void this.refreshNames(this.lastSnapshot);
        void this.render(this.lastSnapshot, true);
      }
    });
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

  /** Live models loading, done, or unable to load: say so, but never hold back Start. */
  setModelStatus(status: ModelStatus): void {
    const wasLoading = this.models.loading.length > 0;
    this.models = status;
    const loading = status.loading.length > 0;
    if (loading === wasLoading) return this.rerender();
    if (this.modelsTimer) clearTimeout(this.modelsTimer);
    this.modelsTimer = null;
    if (loading) {
      this.modelsTimer = setTimeout(() => ((this.modelsLine = "loading"), this.rerender()), LOADING_SHOW_AFTER_MS);
    } else if (this.modelsLine === "loading" && !status.failed.length) {
      this.modelsLine = "ready";
      this.modelsTimer = setTimeout(() => ((this.modelsLine = null), this.rerender()), READY_NOTICE_MS);
    } else this.modelsLine = null;
    this.rerender();
  }

  private rerender(): void {
    if (this.lastSnapshot) void this.render(this.lastSnapshot, false);
  }

  private menu(mode: Mode): { itemName: string; itemID: number }[] {
    const settings = this.settings.get();
    const persist = settings.persistAudio;
    const m = t().glasses.menu;
    switch (mode) {
      case "idle": {
        const active = activeProfile(settings);
        const profiles = settings.configProfiles.slice(0, MAX_CONFIG_PROFILES);
        this.menuProfiles = profiles.map((p) => p.id);
        return [
          { itemName: label(m.start), itemID: MENU.start },
          { itemName: label(persist ? m.audioOn : m.audioOff), itemID: MENU.toggleAudio },
          ...profiles.map((p, i) => ({ itemName: label(p.id === active?.id ? t().glasses.profileActive(p.name) : p.name), itemID: MENU.firstProfile + i })),
        ];
      }
      case "recording":
        return [
          { itemName: label(m.marker), itemID: MENU.marker },
          { itemName: label(m.pause), itemID: MENU.pause },
          { itemName: label(m.stop), itemID: MENU.stop },
        ];
      case "paused":
        return [
          { itemName: label(m.resume), itemID: MENU.resume },
          { itemName: label(m.stop), itemID: MENU.stop },
        ];
      case "finalizing":
        return [];
    }
  }

  private page(mode: Mode, s: LiveSnapshot) {
    const texts = this.texts(mode, s);
    const menu = this.menu(mode);
    // While capturing there's no status line: captions take the full height, beside the dot's column.
    const textObject =
      texts.status === null
        ? [{ xPosition: 0, yPosition: 0, width: 528, height: 288, containerID: BODY.id, containerName: BODY.name, content: texts.body, isEventCapture: 1 }]
        : [
            { xPosition: 0, yPosition: 0, width: 528, height: 48, containerID: STATUS.id, containerName: STATUS.name, content: texts.status, isEventCapture: 0 },
            { xPosition: 0, yPosition: 52, width: 576, height: 236, containerID: BODY.id, containerName: BODY.name, content: texts.body, isEventCapture: 1 },
          ];
    textObject.push({ xPosition: 536, yPosition: 0, width: 40, height: 48, containerID: DOT.id, containerName: DOT.name, content: texts.dot, isEventCapture: 0 });
    return {
      containerTotalNum: textObject.length,
      textObject,
      ...(menu.length ? { menuObject: { menuItems: menu } } : {}),
    };
  }

  /** Page text per container; status is null on the recording and paused pages, which have no status line. */
  private texts(mode: Mode, s: LiveSnapshot): { status: string | null; body: string; dot: string } {
    const g = t().glasses;
    const provider = s.provider === "local" ? g.local : SERVICE_NAMES[s.provider];
    const audio = s.persistAudio ? g.savingAudio : g.audioNotSaved;
    // Cloud captions don't wait on local models.
    const line = s.provider !== "local" ? null : this.modelsLine;
    if (mode === "idle") {
      const saving = s.persistAudio ? g.audioWillSave : g.audioWontSave;
      const { failed, missing } = s.provider !== "local" ? { failed: [], missing: [] } : this.models;
      const lines = [
        this.notice ?? (line === "loading" ? saving : g.ready(saving)),
        line === "loading" ? g.loadingIdle : line === "ready" ? g.captionsReady : "",
        failed.length ? g.captionsFailed(failed.join(", ")) : "",
        missing.length ? g.notDownloaded(missing.join(", ")) : "",
        g.idleHint,
      ];
      return { status: `${t().common.appName}  ${provider}`, body: truncateUtf8(lines.filter(Boolean).join("\n"), TEXT_LIMIT), dot: " " };
    }
    if (mode === "finalizing") return { status: g.stopped, body: g.processing, dot: " " };
    // The dot shows for as long as audio is being captured (plan.md §11: never covert); paused says so in words.
    const dot = mode === "recording" && this.dotOn ? REC_DOT : " ";
    const speakerOf = (clusterId: string | null) => (clusterId && s.recordingId ? this.nameCache.get(`${s.recordingId}:${clusterId}`) : undefined);
    const settings = this.settings.get();
    // With "Hide my speech" on, lines from a speaker attributed to the wearer are left off. A "Name?" candidate isn't
    // enough: hiding someone else's words on a weak match is worse than showing the wearer's own.
    const isOwn = (clusterId: string | null) => settings.hideOwnSpeechOnGlasses && !!settings.selfPersonId && speakerOf(clusterId)?.personId === settings.selfPersonId;
    let body: string;
    // "Slowed to keep up" is a phone-only notice: it is transient and the captions still come, so it isn't worth glasses space.
    const degraded = s.degraded && s.degraded.code !== "slowed" ? describe().degraded(s.degraded) : "";
    if (degraded && !settings.showCaptionsOnGlasses) body = degraded;
    else {
      const last = s.segments
        .filter((seg) => !isOwn(seg.clusterId))
        .slice(-2)
        .map((seg) => {
          const name = speakerOf(seg.clusterId)?.name;
          return name ? `${name}: ${seg.text}` : seg.text;
        });
      // Provisional text has no speaker yet; it belongs to the latest turn's speaker.
      const provisional = isOwn(s.currentClusterId) ? "" : s.provisionalText;
      const caption = [...last, provisional].filter(Boolean).join("\n");
      const chars = [...caption];
      const tail = chars.length > 220 ? `…${chars.slice(-220).join("")}` : caption;
      const hint = mode === "paused" ? g.pausedHint : "";
      const captions = settings.showCaptionsOnGlasses;
      const modelsLine = !captions ? "" : line === "loading" ? g.loadingLive : line === "ready" ? g.captionsReady : "";
      body = [mode === "paused" ? g.paused : "", captions ? tail : "", modelsLine, degraded, hint, g.audioTag(audio)].filter(Boolean).join("\n");
    }
    return { status: null, body: truncateUtf8(body || " ", TEXT_LIMIT), dot };
  }

  private onSnapshot(s: LiveSnapshot): void {
    this.lastSnapshot = s;
    const mode = modeOf(s);
    if (mode === "recording") this.notice = null;
    this.syncBlink(mode);
    void this.refreshNames(s);
    void this.render(s, mode !== this.mode);
  }

  /** Blinks the dot while recording; stops (and resets to on) otherwise. Each blink is one 3-byte text upgrade. */
  private syncBlink(mode: Mode): void {
    if (mode !== "recording") {
      if (this.blinkTimer) clearTimeout(this.blinkTimer);
      this.blinkTimer = null;
      this.dotOn = true;
      return;
    }
    if (this.blinkTimer) return;
    const tick = () => {
      this.blinkTimer = setTimeout(() => {
        this.dotOn = !this.dotOn;
        this.rerender();
        tick();
      }, this.dotOn ? DOT_ON_MS : DOT_OFF_MS);
    };
    tick();
  }

  private async refreshNames(s: LiveSnapshot): Promise<void> {
    if (!s.recordingId) return;
    // Every speaker in the recent segments, not just the last two: hiding the wearer's lines reaches further back.
    const ids = new Set([s.currentClusterId, ...s.segments.map((x) => x.clusterId)].filter((x): x is string => !!x));
    // A live candidate ("Possibly X") lands on the clusters after the identity change that bumps labelsVersion.
    const version = `${s.labelsVersion}|${s.clusters.map((c) => `${c.clusterId}=${c.candidatePersonId ?? ""}`).join(",")}`;
    if (version !== this.nameVersion) {
      this.nameCache.clear();
      this.nameVersion = version;
    }
    let changed = false;
    for (const id of ids) {
      const key = `${s.recordingId}:${id}`;
      if (this.nameCache.has(key)) continue;
      this.nameCache.set(key, await this.names(s.recordingId, id).catch(() => ({ name: t().speakers.speaker(), personId: null })));
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
          for (const c of page.textObject) this.shown.set(c.containerID, c.content);
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
    const texts = this.texts(mode, s);
    const contents = { [STATUS.id]: texts.status, [BODY.id]: texts.body, [DOT.id]: texts.dot };
    for (const { id, name } of CONTAINERS) {
      const content = contents[id];
      // Only containers on the current page; the rebuild for a mode change is queued ahead of this.
      if (content === null || content === undefined || this.shown.get(id) === content) continue;
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
    } else if (id >= MENU.firstProfile) await this.onProfile(this.menuProfiles[id - MENU.firstProfile]);
  }

  /** Switching applies to the next recording, so it's only offered (and only acts) while idle. */
  private async onProfile(profileId: string | undefined): Promise<void> {
    if (!profileId || modeOf(this.controller.current) !== "idle") return;
    const r = await this.switchProfile(profileId);
    if (!r) return;
    const g = t().glasses;
    const reset = r.reset.length ? g.profileReset(fmt().list(r.reset.map((role) => t().settings.roles[role].title))) : "";
    // The settings change rebuilds the menu with the new marker; the notice says which profile is now in use.
    this.showNotice([g.profileSwitched(r.profile.name), reset].filter(Boolean).join("\n"));
    void r.voices?.then((v) => v && log.info("voices re-enrolled for the profile's voice model", v)).catch((e) => log.error("re-enrolling voices failed", errorMessage(e)));
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
      this.notice = describe().error(err);
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
