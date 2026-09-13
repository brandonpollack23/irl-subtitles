import { AudioInputSource, OsEventTypeList } from "@evenrealities/even_hub_sdk";
import { getBridge, hud, MENU, onHubEvent } from "../bridge";
import { launchNumber, onLifecycle } from "../lifecycle";
import { lsGet, lsSet } from "../report";
import { OpfsAppender, opfsFile } from "../util/opfs";
import { rmsDbfs, SAMPLE_RATE, wavHeader } from "../util/pcm";
import { summarize } from "../util/stats";
import { FrameStats, type FrameStatsSummary } from "./capture-stats";

export type CaptureSource = "glasses" | "phone" | "synthetic";

export interface CaptureOptions {
  source: CaptureSource;
  persistPcm: boolean;
  /** Re-issue audioControl(true) when the page returns to the foreground and audio has stalled. */
  autoRearm: boolean;
}

export interface CaptureLive {
  running: boolean;
  sessionId: string | null;
  elapsedS: number;
  audioS: number;
  frames: number;
  gaps: number;
  levelDbfs: number;
  persistedBytes: number;
  lastEvent: string;
}

interface Journal {
  sessionId: string;
  launch: number;
  startedAt: string;
  lastBeatAt: string;
  samples: number;
  gaps: number;
  visibility: string;
  endedAt?: string;
  persistPath?: string;
}

const LS_JOURNAL = "probe.capture.journal";
const TIMELINE_MAX = 2000;

async function batteryLevel(): Promise<number | null> {
  try {
    const b = await (navigator as unknown as { getBattery?: () => Promise<{ level: number }> }).getBattery?.();
    return b ? Math.round(b.level * 100) : null;
  } catch {
    return null;
  }
}

async function glassesBattery(): Promise<number | null> {
  try {
    return (await (await getBridge())?.getDeviceInfo())?.status?.batteryLevel ?? null;
  } catch {
    return null;
  }
}

/**
 * The previous launch's journal, if that launch never reached Stop. Its lastBeatAt
 * brackets when Android reclaimed or killed the WebView.
 */
export function previousUnfinishedSession(): (Journal & { persistedBytes?: number }) | null {
  try {
    const j = JSON.parse(lsGet(LS_JOURNAL) ?? "null") as Journal | null;
    return j && !j.endedAt && j.launch !== launchNumber ? j : null;
  } catch {
    return null;
  }
}

export class CaptureSoak {
  private stats = new FrameStats();
  private opts: CaptureOptions | null = null;
  private sessionId: string | null = null;
  private startedAt = 0;
  private startedIso = "";
  private disposers: (() => void)[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private synth: ReturnType<typeof setInterval> | null = null;
  private writer: OpfsAppender | null = null;
  private pendingPcm: Uint8Array[] = [];
  private pendingBytes = 0;
  private persistedBytes = 0;
  private writeMs: number[] = [];
  private writeErrors: string[] = [];
  private timeline: { tMs: number; event: string; detail?: unknown }[] = [];
  private levels: number[] = [];
  private lastLevel = -Infinity;
  private directions = new Map<string, number>();
  private speakerRoles = new Map<string, number>();
  private rearms = 0;
  private hudFailures = 0;
  private batteryStart: { phone: number | null; glasses: number | null } = { phone: null, glasses: null };
  private persistError: string | null = null;

  constructor(private readonly onLive: (live: CaptureLive) => void) {}

  get running(): boolean {
    return this.sessionId !== null;
  }

  get persistPath(): string | null {
    return this.sessionId && this.opts?.persistPcm && !this.persistError ? `capture/${this.sessionId}.pcm` : null;
  }

  private mark(event: string, detail?: unknown): void {
    if (this.timeline.length < TIMELINE_MAX) this.timeline.push({ tMs: Math.round(performance.now() - this.startedAt), event, detail });
  }

  async start(opts: CaptureOptions): Promise<void> {
    if (this.running) return;
    this.opts = opts;
    this.stats = new FrameStats();
    this.sessionId = new Date().toISOString().replace(/[:.]/g, "-");
    this.startedAt = performance.now();
    this.startedIso = new Date().toISOString();
    this.persistedBytes = this.pendingBytes = this.rearms = this.hudFailures = 0;
    this.pendingPcm = [];
    this.writeMs = [];
    this.writeErrors = [];
    this.timeline = [];
    this.levels = [];
    this.directions.clear();
    this.speakerRoles.clear();
    this.batteryStart = { phone: await batteryLevel(), glasses: await glassesBattery() };

    this.persistError = null;
    if (opts.persistPcm) {
      // Storage trouble must never prevent capture (plan.md §9): record it and carry on.
      try {
        this.writer = new OpfsAppender();
        await this.writer.open(this.persistPath!);
      } catch (e) {
        this.persistError = String(e);
        this.writer?.dispose();
        this.writer = null;
        this.mark("persistence-unavailable", this.persistError);
      }
    }

    this.disposers.push(
      onHubEvent((e) => {
        if (e.audioEvent) this.onFrame(e.audioEvent.audioPcm, e.audioEvent.direction, e.audioEvent.speakerRole);
        if (e.sysEvent?.eventType !== undefined && e.sysEvent.eventType !== OsEventTypeList.IMU_DATA_REPORT) {
          this.mark("sysEvent", { type: OsEventTypeList[e.sysEvent.eventType] ?? e.sysEvent.eventType, exitReason: e.sysEvent.systemExitReasonCode });
        }
        if (e.menuItemClickEvent?.itemID === MENU.marker) this.mark("marker", "glasses");
      }),
      onLifecycle((ev, vis) => {
        this.mark(ev, vis);
        if (ev === "visibilitychange" && vis === "visible" && this.opts?.autoRearm) void this.rearmIfStalled();
      }),
    );

    if (opts.source === "synthetic") {
      // Browser-only stand-in: 100 ms frames of a quiet tone, for exercising the pipeline.
      let phase = 0;
      this.synth = setInterval(() => {
        const frame = new Int16Array(1600);
        for (let i = 0; i < frame.length; i++) frame[i] = Math.round(3000 * Math.sin((phase++ * 2 * Math.PI * 440) / SAMPLE_RATE));
        this.onFrame(new Uint8Array(frame.buffer), null, "unknown");
      }, 100);
    } else {
      await hud.ensurePage();
      const ok = await (await getBridge())?.audioControl(true, opts.source === "phone" ? AudioInputSource.Phone : AudioInputSource.Glasses);
      this.mark("audioControl(true)", ok);
      if (!ok) {
        await this.stop();
        throw new Error("audioControl(true) returned false (is the Even bridge connected and the glasses page created?)");
      }
    }

    this.timer = setInterval(() => void this.tick(), 1000);
    this.writeJournal();
    this.mark("started", opts);
  }

  private onFrame(pcm: Uint8Array, direction: number | null, role: string): void {
    if (!this.running) return;
    const gap = this.stats.push(performance.now(), pcm.byteLength, document.visibilityState);
    if (gap) this.mark("gap", gap);
    this.lastLevel = rmsDbfs(pcm);
    const d = direction === null ? "null" : String(direction);
    this.directions.set(d, (this.directions.get(d) ?? 0) + 1);
    this.speakerRoles.set(role, (this.speakerRoles.get(role) ?? 0) + 1);
    if (this.writer) {
      this.pendingPcm.push(pcm.slice());
      this.pendingBytes += pcm.byteLength;
      // 5 s chunks, matching the plan's 5–10 s durable chunk cadence.
      if (this.pendingBytes >= 5 * SAMPLE_RATE * 2) void this.flushPcm();
    }
  }

  private async flushPcm(): Promise<void> {
    if (!this.writer || this.pendingBytes === 0) return;
    const chunk = new Uint8Array(this.pendingBytes);
    let off = 0;
    for (const p of this.pendingPcm) {
      chunk.set(p, off);
      off += p.byteLength;
    }
    this.pendingPcm = [];
    this.pendingBytes = 0;
    try {
      const r = await this.writer.append(chunk, true);
      this.persistedBytes = r.size;
      if (r.ms !== undefined) this.writeMs.push(r.ms);
    } catch (e) {
      if (this.writeErrors.length < 50) this.writeErrors.push(String(e));
    }
  }

  private async rearmIfStalled(): Promise<void> {
    await new Promise((ok) => setTimeout(ok, 2000));
    const last = this.stats.lastFrameAt;
    if (!this.running || (last !== null && performance.now() - last < 2000)) return;
    this.rearms++;
    const ok = await (await getBridge())?.audioControl(true, this.opts?.source === "phone" ? AudioInputSource.Phone : AudioInputSource.Glasses);
    this.mark("rearm audioControl(true)", ok);
  }

  private async tick(): Promise<void> {
    const s = this.stats.summary(performance.now());
    if (s.frames > 0 && Math.round(s.wallSeconds) % 10 === 0) this.levels.push(Math.round(this.lastLevel));
    this.writeJournal(s);
    const elapsed = new Date(s.wallSeconds * 1000).toISOString().slice(11, 19);
    const text = `REC ${elapsed}\naudio ${s.audioSeconds.toFixed(0)}s  cover ${s.coveragePct}%\ngaps ${s.gapCount}  level ${Math.round(this.lastLevel)} dBFS\n${this.opts?.persistPcm ? `saved ${(this.persistedBytes / 2 ** 20).toFixed(1)} MiB` : "not persisting"}`;
    if (this.opts?.source !== "synthetic") {
      try {
        await hud.setText(text);
      } catch {
        this.hudFailures++;
      }
    }
    this.onLive(this.live(s));
  }

  private live(s: FrameStatsSummary): CaptureLive {
    return {
      running: this.running,
      sessionId: this.sessionId,
      elapsedS: s.wallSeconds,
      audioS: s.audioSeconds,
      frames: s.frames,
      gaps: s.gapCount,
      levelDbfs: Math.round(this.lastLevel),
      persistedBytes: this.persistedBytes,
      lastEvent: this.timeline[this.timeline.length - 1]?.event ?? "",
    };
  }

  private writeJournal(s = this.stats.summary(performance.now()), endedAt?: string): void {
    if (!this.sessionId) return;
    const j: Journal = {
      sessionId: this.sessionId,
      launch: launchNumber,
      startedAt: this.startedIso,
      lastBeatAt: new Date().toISOString(),
      samples: s.samples,
      gaps: s.gapCount,
      visibility: document.visibilityState,
      endedAt,
      persistPath: this.persistPath ?? undefined,
    };
    lsSet(LS_JOURNAL, JSON.stringify(j));
  }

  addMarker(label: string): void {
    this.mark("marker", label);
  }

  async stop(): Promise<Record<string, unknown> | null> {
    if (!this.running) return null;
    const opts = this.opts!;
    if (this.timer) clearInterval(this.timer);
    if (this.synth) clearInterval(this.synth);
    this.timer = this.synth = null;
    if (opts.source !== "synthetic") this.mark("audioControl(false)", await (await getBridge())?.audioControl(false));
    await this.flushPcm();
    const persistedBytes = this.writer ? await this.writer.close() : 0;
    this.writer?.dispose();
    this.writer = null;
    this.disposers.forEach((d) => d());
    this.disposers = [];

    const summary = this.stats.summary(performance.now());
    this.writeJournal(summary, new Date().toISOString());
    const report = {
      sessionId: this.sessionId,
      options: opts,
      startedAt: this.startedIso,
      endedAt: new Date().toISOString(),
      summary,
      persistence: opts.persistPcm
        ? { path: this.persistPath, error: this.persistError, persistedBytes, expectedBytes: summary.bytes, writeMs: summarize(this.writeMs), writeErrors: this.writeErrors }
        : null,
      frameMeta: { directions: Object.fromEntries(this.directions), speakerRoles: Object.fromEntries(this.speakerRoles) },
      levelsDbfsEvery10s: this.levels,
      rearms: this.rearms,
      hudFailures: this.hudFailures,
      battery: { start: this.batteryStart, end: { phone: await batteryLevel(), glasses: await glassesBattery() } },
      timeline: this.timeline,
    };
    await hud.setText(`Stopped\naudio ${summary.audioSeconds.toFixed(0)}s  gaps ${summary.gapCount}`).catch(() => undefined);
    this.sessionId = null;
    this.onLive(this.live(summary));
    return report;
  }
}

/** Builds a WAV blob from a persisted session without loading it into JS memory. */
export async function persistedWav(path: string): Promise<Blob | null> {
  const file = await opfsFile(path);
  if (!file) return null;
  const even = file.size - (file.size % 2);
  return new Blob([wavHeader(even) as BlobPart, file.slice(0, even)], { type: "audio/wav" });
}
