import { SonioxClient, type AudioSource, type AudioSourceHandlers, type Recording } from "@soniox/client";
import {
  AsyncQueue,
  errorMessage,
  RECONNECT_OVERLAP_SAMPLES,
  reconnectDelayMs,
  ReplayRing,
  serviceOption,
  SAMPLE_RATE,
  sleep,
  type AudioFrame,
  type LiveSpeechProvider,
  type LiveSpeechRun,
  type ProviderCapabilities,
  type SpeechEvent,
  type TranscriptionConfig,
} from "@irl/domain";
import { SonioxNormalizer } from "./normalizer";

export const SONIOX_ENDPOINTS = ["https://api.soniox.com", "wss://stt-rt.soniox.com"] as const;


/** Smallest authenticated request; returns only success or a sanitized error (plan.md §10). */
export async function testSonioxKey(apiKey: string, fetchImpl: typeof fetch = fetch): Promise<{ ok: boolean; message: string }> {
  try {
    const r = await fetchImpl("https://api.soniox.com/v1/models", { headers: { Authorization: `Bearer ${apiKey}` } });
    if (r.ok) return { ok: true, message: "Key works" };
    if (r.status === 401 || r.status === 403) return { ok: false, message: "Soniox rejected the key" };
    return { ok: false, message: `Soniox returned HTTP ${r.status}` };
  } catch {
    // fetch reports a network whitelist block and a CORS failure identically.
    return { ok: false, message: "Could not reach Soniox (offline, blocked by the network allowlist, or CORS)" };
  }
}

class PushSource implements AudioSource {
  private handlers: AudioSourceHandlers | null = null;
  private backlog: ArrayBuffer[] = [];

  async start(handlers: AudioSourceHandlers): Promise<void> {
    this.handlers = handlers;
    for (const b of this.backlog.splice(0)) handlers.onData(b);
  }

  push(pcm: Uint8Array): void {
    const buf = pcm.slice().buffer;
    if (this.handlers) this.handlers.onData(buf);
    else this.backlog.push(buf);
  }

  stop(): void {
    this.handlers = null;
  }
}

interface Connection {
  index: number;
  startSample: number;
  source: PushSource;
  recording: Recording;
  failed: boolean;
  /** Resending [startSample, now) from the ring or storage; live frames wait so audio stays in order. */
  resending: boolean;
}

export interface SonioxProviderOptions {
  apiKey: () => Promise<string | null>;
  /** Model when the live option doesn't name one. */
  model?: () => string;
  /** Reads older audio from storage when a reconnect needs more than the in-memory ring holds. */
  replay?: (recordingId: string, startSample: number, endSample: number) => Promise<Float32Array | null>;
}

/**
 * plan.md §6.2 SonioxSpeechProvider: one fused STT + diarization stream. Audio still goes to local storage
 * first (the controller persists before any provider sees frames). Reconnects close the run and start a
 * new connection from the last finalized sample minus a short overlap.
 */
export class SonioxSpeechProvider implements LiveSpeechProvider {
  readonly id = "soniox";
  readonly capabilities: ProviderCapabilities = { transcription: "streaming", diarization: "fused-with-stt", persistentIdentity: true, languages: "auto", execution: "cloud" };

  constructor(private readonly opts: SonioxProviderOptions) {}

  async start(config: TranscriptionConfig): Promise<LiveSpeechRun> {
    const key = await this.opts.apiKey();
    if (!key) throw new Error("No Soniox API key saved");
    const run = new SonioxRun(config, key, this.opts);
    run.connect(0);
    return run;
  }
}

class SonioxRun implements LiveSpeechRun {
  readonly providerRunId: string;
  readonly events = new AsyncQueue<SpeechEvent>();
  private normalizer: SonioxNormalizer;
  private conn: Connection | null = null;
  private connections = 0;
  private ring = new ReplayRing();
  private closed = false;
  private reconnecting = false;
  private attempts = 0;

  constructor(private readonly config: TranscriptionConfig, private readonly apiKey: string, private readonly opts: SonioxProviderOptions) {
    this.providerRunId = config.providerRunId;
    this.normalizer = new SonioxNormalizer(config.recordingId, config.providerRunId);
  }

  private emitAll(evs: SpeechEvent[]) {
    for (const e of evs) this.events.push(e);
  }

  connect(fromSample: number): void {
    const index = this.connections++;
    const client = new SonioxClient({ config: async () => ({ api_key: this.apiKey }) });
    const source = new PushSource();
    const recording = client.realtime.record({
      model: serviceOption(this.config.modelId)?.model ?? this.opts.model?.() ?? "stt-rt-v5",
      audio_format: "pcm_s16le",
      sample_rate: SAMPLE_RATE,
      num_channels: 1,
      enable_speaker_diarization: true,
      enable_language_identification: true,
      enable_endpoint_detection: true,
      ...(this.config.language !== "auto" ? { language_hints: [this.config.language] } : {}),
      source,
      auto_reconnect: false,
    } as never) as Recording;
    const conn: Connection = { index, startSample: fromSample, source, recording, failed: false, resending: true };
    this.conn = conn;
    recording.on("result", (r) => {
      if (this.conn !== conn) return;
      this.attempts = 0;
      this.emitAll(this.normalizer.result(conn.index, conn.startSample, r.tokens));
    });
    recording.on("error", (e) => this.onConnectionError(conn, errorMessage(e)));
    recording.on("state_change", ({ new_state }) => {
      if (new_state === "error") this.onConnectionError(conn, "connection error");
      if (new_state === "recording" && this.conn === conn) this.events.push({ type: "degraded", reason: null });
    });
    void this.resend(conn, fromSample);
  }

  /** Sends [fromSample, end) from the ring (or storage) into a new connection; later frames follow from push(). */
  private async resend(conn: Connection, fromSample: number): Promise<void> {
    const replay = this.opts.replay;
    const chunks = await this.ring.since(fromSample, replay && ((s, e) => replay(this.config.recordingId, s, e)));
    if (this.conn !== conn) return;
    for (const c of chunks) conn.source.push(c);
    conn.resending = false;
  }

  private onConnectionError(conn: Connection, message: string): void {
    if (conn.failed || this.closed || this.conn !== conn) return;
    conn.failed = true;
    this.events.push({ type: "error", message: `Soniox: ${message}`, fatal: false });
    this.events.push({ type: "degraded", reason: "Soniox reconnecting — audio is still saving" });
    void this.reconnect();
  }

  private async reconnect(): Promise<void> {
    if (this.reconnecting || this.closed) return;
    this.reconnecting = true;
    try {
      this.conn?.recording.cancel();
      this.emitAll(this.normalizer.flush());
      const delay = reconnectDelayMs(this.attempts++);
      await sleep(delay);
      if (this.closed) return;
      this.connect(Math.max(0, this.normalizer.finalizedUntil - RECONNECT_OVERLAP_SAMPLES));
    } finally {
      this.reconnecting = false;
    }
  }

  push(frame: AudioFrame): void {
    if (this.closed) return;
    this.ring.push(frame);
    const conn = this.conn;
    if (conn && !conn.failed && !conn.resending) conn.source.push(frame.pcm);
  }

  async finish(): Promise<void> {
    const conn = this.conn;
    if (conn && !conn.failed) {
      await Promise.race([conn.recording.stop().catch(() => undefined), sleep(20_000)]);
    }
    this.closed = true;
    this.emitAll(this.normalizer.flush());
    this.events.close();
  }

  async abort(reason: string): Promise<void> {
    this.closed = true;
    this.conn?.recording.cancel();
    this.events.push({ type: "error", message: `aborted: ${reason}`, fatal: false });
    this.events.close();
  }
}
