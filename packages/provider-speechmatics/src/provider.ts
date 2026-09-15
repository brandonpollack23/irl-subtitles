import {
  AsyncQueue,
  errorMessage,
  RECONNECT_OVERLAP_SAMPLES,
  reconnectDelayMs,
  ReplayRing,
  SAMPLE_RATE,
  serviceOption,
  sleep,
  SPEECHMATICS_LANGUAGES,
  type AudioFrame,
  type LiveSpeechProvider,
  type LiveSpeechRun,
  type ProviderCapabilities,
  type ServiceSpeaker,
  type SpeechEvent,
  type TranscriptionConfig,
} from "@irl/domain";
import { mintRealtimeKey, SPEECHMATICS_ENDPOINTS, SpeechmaticsAuthError, type SpeechmaticsRegion } from "./auth";
import { SpeechmaticsNormalizer, type SpeechmaticsResult } from "./normalizer";

/** The subset of the browser WebSocket the run uses, so tests can drive it. */
export interface SocketLike {
  readonly readyState: number;
  binaryType: string;
  send(data: string | ArrayBufferLike | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

const OPEN = 1;

/** Errors a reconnect won't fix; the coordinator decides whether to restart the run. */
const FATAL_ERRORS = new Set(["not_authorised", "invalid_model", "invalid_language", "invalid_config", "invalid_audio_type", "not_allowed", "insufficient_funds"]);

/** Start of a run's voice identification: voices to label, and whether to ask for identifiers at the end. */
export interface SpeakerSession {
  speakers: readonly ServiceSpeaker[];
  getSpeakers: boolean;
  sensitivity?: number;
}

export interface SpeechmaticsProviderOptions {
  apiKey: () => Promise<string | null>;
  region?: () => SpeechmaticsRegion;
  /** Reads older audio from storage when a reconnect needs more than the in-memory ring holds. */
  replay?: (recordingId: string, startSample: number, endSample: number) => Promise<Float32Array | null>;
  /** The service refused saved identifiers (e.g. after a model change): profiles need re-enrolling. */
  onIdentifiersRejected?: (reason: string) => void;
  /** Speechmatics voice identification (irl-subt-3xb.7); absent: plain diarization. */
  speakerSession?: (config: TranscriptionConfig & { embeddingModelId: string }) => Promise<SpeakerSession>;
  socket?: (url: string) => SocketLike;
  fetch?: typeof fetch;
  /** Seconds of silence before EndOfUtterance. */
  endOfUtteranceSeconds?: number;
  maxDelaySeconds?: number;
}

/**
 * Speechmatics realtime (irl-subt-3xb.5): one fused STT + diarization stream over a raw WebSocket, authorized by a
 * temporary key. Like SonioxSpeechProvider, audio is persisted before any provider sees it, and a reconnect starts a
 * new connection from the last finalized sample minus a short overlap.
 */
export class SpeechmaticsSpeechProvider implements LiveSpeechProvider {
  readonly id = "speechmatics";
  readonly capabilities: ProviderCapabilities = { transcription: "streaming", diarization: "fused-with-stt", persistentIdentity: true, languages: Object.keys(SPEECHMATICS_LANGUAGES), execution: "cloud" };

  constructor(private readonly opts: SpeechmaticsProviderOptions) {}

  async start(config: TranscriptionConfig & { embeddingModelId: string; sttModelId: string; vadModelId: string }): Promise<LiveSpeechRun> {
    const key = await this.opts.apiKey();
    if (!key) throw new Error("No Speechmatics API key saved");
    const language = SPEECHMATICS_LANGUAGES[config.language];
    if (!language) throw new Error(`Speechmatics live captions don't support ${config.language}`);
    const session = (await this.opts.speakerSession?.(config)) ?? { speakers: [], getSpeakers: false };
    const run = new SpeechmaticsRun(config, key, language, session, this.opts);
    await run.open(0);
    return run;
  }
}

interface Connection {
  index: number;
  startSample: number;
  socket: SocketLike;
  /** Recognition started and the resend finished: live frames go straight to the socket. */
  ready: boolean;
  failed: boolean;
  seq: number;
  speakers: ServiceSpeaker[] | null;
  ended: Promise<void>;
  end: () => void;
}

class SpeechmaticsRun implements LiveSpeechRun {
  readonly providerRunId: string;
  readonly events = new AsyncQueue<SpeechEvent>();
  private normalizer: SpeechmaticsNormalizer;
  private ring = new ReplayRing();
  private conn: Connection | null = null;
  private connections = 0;
  private closed = false;
  private finishing = false;
  private reconnecting = false;
  private attempts = 0;
  private readonly model: string;

  constructor(
    private readonly config: TranscriptionConfig,
    private readonly apiKey: string,
    private readonly language: string,
    private readonly session: SpeakerSession,
    private readonly opts: SpeechmaticsProviderOptions,
  ) {
    this.providerRunId = config.providerRunId;
    this.model = serviceOption(config.modelId)?.model ?? "enhanced";
    this.normalizer = new SpeechmaticsNormalizer(config.recordingId, config.providerRunId, new Set(session.speakers.map((s) => s.label)));
  }

  private emitAll(evs: SpeechEvent[]): void {
    for (const e of evs) this.events.push(e);
  }

  /** Mints a session key and opens a connection that starts at `fromSample`. Throws only on the key request. */
  async open(fromSample: number): Promise<void> {
    const jwt = await mintRealtimeKey(this.apiKey, 3600, this.opts.fetch);
    if (this.closed) return;
    const index = this.connections++;
    const region = this.opts.region?.() ?? "eu";
    const url = `${SPEECHMATICS_ENDPOINTS.realtime(region)}?jwt=${encodeURIComponent(jwt)}`;
    const socket = this.opts.socket ? this.opts.socket(url) : (new WebSocket(url) as unknown as SocketLike);
    socket.binaryType = "arraybuffer";
    let end!: () => void;
    const conn: Connection = { index, startSample: fromSample, socket, ready: false, failed: false, seq: 0, speakers: null, ended: new Promise<void>((ok) => (end = ok)), end: () => end() };
    this.conn = conn;
    socket.onopen = () => socket.send(JSON.stringify(this.startRecognition()));
    socket.onmessage = (ev) => {
      if (this.conn !== conn) return;
      try {
        this.onMessage(conn, JSON.parse(String(ev.data)) as Record<string, unknown>);
      } catch (e) {
        this.events.push({ type: "error", message: `Speechmatics: unreadable message (${errorMessage(e)})`, fatal: false });
      }
    };
    socket.onerror = () => undefined;
    socket.onclose = (ev) => {
      conn.end();
      if (!this.finishing) this.onConnectionError(conn, `connection closed (${ev.code}${ev.reason ? ` ${ev.reason}` : ""})`);
    };
  }

  private startRecognition(): Record<string, unknown> {
    const diarization: Record<string, unknown> = {};
    if (this.session.speakers.length) diarization.speakers = this.session.speakers.map((s) => ({ label: s.label, speaker_identifiers: s.identifiers }));
    if (this.session.getSpeakers) diarization.get_speakers = true;
    if (this.session.speakers.length && this.session.sensitivity !== undefined) diarization.speakers_sensitivity = this.session.sensitivity;
    return {
      message: "StartRecognition",
      audio_format: { type: "raw", encoding: "pcm_s16le", sample_rate: SAMPLE_RATE },
      transcription_config: {
        language: this.language,
        model: this.model,
        diarization: "speaker",
        enable_partials: true,
        max_delay: this.opts.maxDelaySeconds ?? 1,
        max_delay_mode: "flexible",
        conversation_config: { end_of_utterance_silence_trigger: this.opts.endOfUtteranceSeconds ?? 0.8 },
        ...(Object.keys(diarization).length ? { speaker_diarization_config: diarization } : {}),
      },
    };
  }

  private onMessage(conn: Connection, m: Record<string, unknown>): void {
    switch (m.message) {
      case "RecognitionStarted":
        void this.resend(conn);
        break;
      case "AddPartialTranscript":
        this.emitAll(this.normalizer.partial(conn.index, conn.startSample, (m.results as SpeechmaticsResult[]) ?? []));
        break;
      case "AddTranscript":
        this.attempts = 0;
        this.emitAll(this.normalizer.final(conn.index, conn.startSample, (m.results as SpeechmaticsResult[]) ?? []));
        break;
      case "EndOfUtterance":
        this.emitAll(this.normalizer.endOfUtterance(conn.startSample, (m.metadata as { end_time?: number } | undefined)?.end_time ?? 0));
        break;
      case "SpeakersResult":
        conn.speakers = ((m.speakers as { label: string; speaker_identifiers?: string[] }[]) ?? []).map((s) => ({ label: s.label, identifiers: s.speaker_identifiers ?? [] }));
        break;
      case "EndOfTranscript":
        conn.end();
        break;
      case "Warning":
        if (m.type === "speaker_id") this.events.push({ type: "error", message: `Speechmatics couldn't use saved voices: ${String(m.reason ?? "speaker identification warning")}`, fatal: false });
        break;
      case "Error": {
        const type = String(m.type ?? "error");
        // A session refused over its identifiers restarts without them once the profiles are marked stale.
        if (this.session.speakers.length && /identifier/i.test(String(m.reason ?? ""))) this.opts.onIdentifiersRejected?.(String(m.reason));
        const message = `Speechmatics: ${type === "not_authorised" ? "the key was rejected" : String(m.reason ?? type)}`;
        if (FATAL_ERRORS.has(type)) {
          conn.failed = true;
          this.events.push({ type: "error", message, fatal: true });
          conn.socket.close();
        } else this.onConnectionError(conn, message);
        break;
      }
    }
  }

  /** Sends [startSample, now) from the ring (or storage), then lets live frames through, so audio stays in order. */
  private async resend(conn: Connection): Promise<void> {
    const replay = this.opts.replay;
    const chunks = await this.ring.since(conn.startSample, replay && ((s, e) => replay(this.config.recordingId, s, e)));
    if (this.conn !== conn || conn.failed || conn.socket.readyState !== OPEN) return;
    for (const c of chunks) this.send(conn, c);
    conn.ready = true;
    if (conn.index > 0) this.events.push({ type: "degraded", reason: null });
  }

  private send(conn: Connection, pcm: Uint8Array): void {
    conn.socket.send(pcm.byteOffset === 0 && pcm.byteLength === pcm.buffer.byteLength ? pcm.buffer : pcm.slice().buffer);
    conn.seq++;
  }

  private onConnectionError(conn: Connection, message: string): void {
    if (conn.failed || this.closed || this.conn !== conn) return;
    conn.failed = true;
    this.events.push({ type: "error", message: message.startsWith("Speechmatics") ? message : `Speechmatics: ${message}`, fatal: false });
    this.events.push({ type: "degraded", reason: "Speechmatics reconnecting — audio is still saving" });
    void this.reconnect();
  }

  private async reconnect(): Promise<void> {
    if (this.reconnecting || this.closed) return;
    this.reconnecting = true;
    try {
      this.conn?.socket.close();
      this.emitAll(this.normalizer.flush());
      while (!this.closed) {
        await sleep(reconnectDelayMs(this.attempts++));
        if (this.closed) return;
        try {
          await this.open(Math.max(0, this.normalizer.finalizedUntil - RECONNECT_OVERLAP_SAMPLES));
          return;
        } catch (e) {
          if (e instanceof SpeechmaticsAuthError) {
            this.events.push({ type: "error", message: e.message, fatal: true });
            return;
          }
          this.events.push({ type: "error", message: `Speechmatics: ${errorMessage(e)}`, fatal: false });
        }
      }
    } finally {
      this.reconnecting = false;
    }
  }

  push(frame: AudioFrame): void {
    if (this.closed) return;
    this.ring.push(frame);
    const conn = this.conn;
    if (conn?.ready && !conn.failed && conn.socket.readyState === OPEN) this.send(conn, frame.pcm);
  }

  async finish(): Promise<void> {
    this.finishing = true;
    const conn = this.conn;
    if (conn && conn.ready && !conn.failed && conn.socket.readyState === OPEN) {
      conn.socket.send(JSON.stringify({ message: "EndOfStream", last_seq_no: conn.seq }));
      await Promise.race([conn.ended, sleep(20_000)]);
    }
    this.closed = true;
    conn?.socket.close();
    this.emitAll(this.normalizer.flush());
    if (conn?.speakers?.length) {
      const speakers = conn.speakers
        .map((s) => ({ clusterId: this.normalizer.clusterIdFor(conn.index, s.label), identifiers: s.identifiers }))
        .filter((s): s is { clusterId: string; identifiers: string[] } => !!s.clusterId && s.identifiers.length > 0);
      if (speakers.length) this.events.push({ type: "speakers", speakers });
    }
    this.events.close();
  }

  async abort(reason: string): Promise<void> {
    this.closed = true;
    this.conn?.socket.close();
    this.events.push({ type: "error", message: `aborted: ${reason}`, fatal: false });
    this.events.close();
  }
}
