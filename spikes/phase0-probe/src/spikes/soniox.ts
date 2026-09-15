import { AudioInputSource } from "@evenrealities/even_hub_sdk";
import { SonioxClient, type AudioSource, type AudioSourceHandlers, type Recording } from "@soniox/client";
import { getBridge, hud, onHubEvent } from "../bridge";
import { onLifecycle } from "../lifecycle";
import { SAMPLE_RATE } from "../util/pcm";
import { summarize } from "../util/stats";

type Log = (...p: unknown[]) => void;

/**
 * Minting a temporary key is deliberately absent from the client SDK (it belongs on a
 * credential broker, plan.md §6.2). This single call exists to probe the Even network
 * whitelist + CORS path for api.soniox.com from inside the WebView.
 */
export async function mintTemporaryKey(apiKey: string, log: Log) {
  log("POST https://api.soniox.com/v1/auth/temporary-api-key…");
  const t0 = performance.now();
  try {
    const r = await fetch("https://api.soniox.com/v1/auth/temporary-api-key", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ usage_type: "transcribe_websocket", expires_in_seconds: 300 }),
    });
    const body = r.ok ? ((await r.json()) as { api_key?: string; expires_at?: string }) : null;
    return { report: { ok: r.ok, status: r.status, ms: Math.round(performance.now() - t0), expiresAt: body?.expires_at ?? null }, temporaryKey: body?.api_key };
  } catch (e) {
    // fetch() reports a whitelist block and a CORS failure identically; elapsed time helps tell them apart.
    return { report: { ok: false, ms: Math.round(performance.now() - t0), error: String(e) }, temporaryKey: undefined };
  }
}

export type SonioxAudio = "glasses" | "phone" | "silence";

/** Feeds Even bridge PCM (or silence) into the SDK's pluggable audio source interface. */
export class EvenAudioSource implements AudioSource {
  sentBytes = 0;
  private dispose: (() => void) | null = null;
  private silence: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly kind: SonioxAudio, private readonly mark: (event: string, detail?: unknown) => void) {}

  async start(handlers: AudioSourceHandlers): Promise<void> {
    const deliver = (pcm: Uint8Array) => {
      this.sentBytes += pcm.byteLength;
      handlers.onData(pcm.slice().buffer);
    };
    if (this.kind === "silence") {
      this.silence = setInterval(() => deliver(new Uint8Array(3200)), 100);
      return;
    }
    this.dispose = onHubEvent((e) => e.audioEvent && deliver(e.audioEvent.audioPcm));
    await hud.ensurePage();
    const ok = await (await getBridge())?.audioControl(true, this.kind === "phone" ? AudioInputSource.Phone : AudioInputSource.Glasses);
    this.mark("audioControl(true)", ok);
    if (!ok) throw new Error("audioControl(true) failed (Even bridge connected? glasses page created?)");
  }

  stop(): void {
    if (this.silence) clearInterval(this.silence);
    this.silence = null;
    this.dispose?.();
    this.dispose = null;
    if (this.kind !== "silence") void getBridge().then((b) => b?.audioControl(false));
  }
}

export interface StreamOptions {
  apiKey: string;
  audio: SonioxAudio;
  languageHints: string[];
  includeTranscript: boolean;
  /** Call recording.reconnect() when the WebView returns to the foreground. */
  reconnectOnForeground: boolean;
}

export interface StreamLive {
  state: string;
  sentSeconds: number;
  finalText: string;
  provisionalText: string;
  speakers: string[];
}

export class SonioxStream {
  private recording: Recording | null = null;
  private source: EvenAudioSource | null = null;
  private opts: StreamOptions | null = null;
  private t0 = 0;
  private firstResultMs: number | null = null;
  private firstTextMs: number | null = null;
  private finalTokens = 0;
  private provisionalTokens = 0;
  private finalLagMs: number[] = [];
  private speakers = new Set<string>();
  private languages = new Set<string>();
  private finalText = "";
  private errors: unknown[] = [];
  private events: { tMs: number; event: string; detail?: unknown }[] = [];
  private state = "idle";
  private disposeLifecycle: (() => void) | null = null;

  constructor(private readonly onLive: (l: StreamLive) => void) {}

  private mark = (event: string, detail?: unknown) => {
    if (this.events.length < 500) this.events.push({ tMs: Math.round(performance.now() - this.t0), event, detail });
  };

  start(opts: StreamOptions): void {
    this.opts = opts;
    this.t0 = performance.now();
    this.source = new EvenAudioSource(opts.audio, this.mark);
    const client = new SonioxClient({ config: async () => ({ api_key: opts.apiKey }) });
    const recording = client.realtime.record({
      model: "stt-rt-v5",
      audio_format: "pcm_s16le",
      sample_rate: SAMPLE_RATE,
      num_channels: 1,
      enable_speaker_diarization: true,
      enable_language_identification: true,
      enable_endpoint_detection: true,
      ...(opts.languageHints.length ? { language_hints: opts.languageHints } : {}),
      source: this.source,
      auto_reconnect: true,
    });
    this.recording = recording;

    recording.on("state_change", ({ old_state, new_state, reason }) => {
      this.state = new_state;
      this.mark("state", { from: old_state, to: new_state, reason });
      this.emit();
    });
    recording.on("connected", () => this.mark("connected"));
    recording.on("reconnecting", (e) => this.mark("reconnecting", { attempt: e.attempt, delayMs: e.delay_ms }));
    recording.on("reconnected", (e) => this.mark("reconnected", e));
    recording.on("error", (e) => {
      const detail = { name: e.name, message: e.message, code: (e as { code?: string }).code };
      if (this.errors.length < 50) this.errors.push(detail);
      this.mark("error", detail);
    });
    recording.on("finished", () => this.mark("finished"));
    recording.on("result", (r) => {
      const now = Math.round(performance.now() - this.t0);
      this.firstResultMs ??= now;
      const sentMs = (this.source!.sentBytes / 2 / SAMPLE_RATE) * 1000;
      this.finalLagMs.push(sentMs - r.final_audio_proc_ms);
      let provisional = "";
      for (const t of r.tokens) {
        if (t.text.trim() && this.firstTextMs === null) this.firstTextMs = now;
        if (t.speaker) this.speakers.add(t.speaker);
        if (t.language) this.languages.add(t.language);
        if (t.is_final) {
          this.finalTokens++;
          this.finalText += t.text;
        } else {
          this.provisionalTokens++;
          provisional += t.text;
        }
      }
      this.emit(provisional);
      if (this.finalText) void hud.setText(this.finalText.slice(-180)).catch(() => undefined);
    });

    this.disposeLifecycle = onLifecycle((ev, vis) => {
      this.mark(ev, vis);
      if (ev === "visibilitychange" && vis === "visible" && opts.reconnectOnForeground) {
        this.mark("reconnect() on foreground");
        recording.reconnect();
      }
    });
  }

  private emit(provisional = ""): void {
    this.onLive({
      state: this.state,
      sentSeconds: Math.round((this.source?.sentBytes ?? 0) / 2 / SAMPLE_RATE),
      finalText: this.finalText.slice(-600),
      provisionalText: provisional,
      speakers: [...this.speakers],
    });
  }

  async stop(): Promise<Record<string, unknown>> {
    this.disposeLifecycle?.();
    try {
      await Promise.race([this.recording?.stop(), new Promise((ok) => setTimeout(ok, 15_000))]);
    } catch (e) {
      this.mark("stop-error", String(e));
    }
    return {
      sdk: "@soniox/client",
      options: { ...this.opts, apiKey: undefined },
      finalState: this.state,
      sentAudioSeconds: Math.round(((this.source?.sentBytes ?? 0) / 2 / SAMPLE_RATE) * 10) / 10,
      firstResultMs: this.firstResultMs,
      firstTextTokenMs: this.firstTextMs,
      finalTokens: this.finalTokens,
      provisionalTokens: this.provisionalTokens,
      finalizationLagMs: summarize(this.finalLagMs),
      speakers: [...this.speakers],
      languages: [...this.languages],
      errors: this.errors,
      events: this.events,
      transcript: this.opts?.includeTranscript ? this.finalText : `(${this.finalText.length} chars, redacted)`,
    };
  }
}
