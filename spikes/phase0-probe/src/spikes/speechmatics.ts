import { SAMPLE_RATE, wavHeader } from "../util/pcm";
import { EvenAudioSource, type SonioxAudio } from "./soniox";

type Log = (...p: unknown[]) => void;

export type Region = "eu" | "us";

/**
 * Spike irl-subt-3xb.4: Speechmatics realtime, batch, and speaker identification from the Even WebView. Browsers must
 * not send the long-lived key to the realtime host, so realtime uses a temporary key (JWT) minted here; the batch API
 * takes the key as a Bearer header.
 */
export async function mintTemporaryKey(apiKey: string, type: "rt" | "batch", log: Log, ttl = 600) {
  const url = `https://mp.speechmatics.com/v1/api_keys?type=${type}`;
  log(`POST ${url}…`);
  const t0 = performance.now();
  try {
    const r = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ ttl }) });
    const body = r.ok ? ((await r.json()) as { key_value?: string }) : null;
    return { report: { kind: `temp-key-${type}`, ok: r.ok, status: r.status, ms: Math.round(performance.now() - t0) }, key: body?.key_value };
  } catch (e) {
    // A whitelist block, a CORS failure, and (desk probe 2026-09-15) a 401 from mp.speechmatics.com, which has no
    // Access-Control-Allow-Origin header, all surface as the same TypeError.
    return { report: { kind: `temp-key-${type}`, ok: false, ms: Math.round(performance.now() - t0), error: String(e) }, key: undefined };
  }
}

export interface EnrolledSpeaker {
  label: string;
  speaker_identifiers: string[];
}

export interface RtOptions {
  jwt: string;
  region: Region;
  model: "enhanced" | "standard";
  language: string;
  audio: SonioxAudio;
  maxDelay: number;
  /** Enrollment session: ask for identifiers at the end. */
  getSpeakers: boolean;
  /** Identification session: voices to label. */
  speakers: EnrolledSpeaker[];
  speakersSensitivity: number | null;
  includeTranscript: boolean;
}

export interface RtLive {
  state: string;
  sentSeconds: number;
  finalText: string;
  partialText: string;
  labels: string[];
}

interface SmResult {
  type: string;
  start_time: number;
  end_time: number;
  attaches_to?: string;
  alternatives?: { content: string; confidence: number; speaker?: string }[];
}

export class SpeechmaticsRtSession {
  private ws: WebSocket | null = null;
  private source: EvenAudioSource | null = null;
  private opts: RtOptions | null = null;
  private t0 = 0;
  private seq = 0;
  private state = "idle";
  private recognitionStartedMs: number | null = null;
  private firstPartialMs: number | null = null;
  private firstFinalMs: number | null = null;
  private finalLagS: number[] = [];
  private labelFirstSeen = new Map<string, { atAudioS: number; wallMs: number; partial: boolean }>();
  private finalText = "";
  private finals = 0;
  private partials = 0;
  private endOfUtterances = 0;
  private errors: unknown[] = [];
  private warnings: unknown[] = [];
  private events: { tMs: number; event: string; detail?: unknown }[] = [];
  private speakersResult: EnrolledSpeaker[] | null = null;
  private done: (() => void) | null = null;

  constructor(private readonly onLive: (l: RtLive) => void) {}

  private mark = (event: string, detail?: unknown) => {
    if (this.events.length < 500) this.events.push({ tMs: Math.round(performance.now() - this.t0), event, detail });
  };

  private get sentSeconds(): number {
    return (this.source?.sentBytes ?? 0) / 2 / SAMPLE_RATE;
  }

  start(opts: RtOptions): void {
    this.opts = opts;
    this.t0 = performance.now();
    const ws = new WebSocket(`wss://${opts.region}.rt.speechmatics.com/v2?jwt=${encodeURIComponent(opts.jwt)}`);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    this.state = "connecting";
    ws.onopen = () => {
      this.mark("open");
      const diar: Record<string, unknown> = {};
      if (opts.getSpeakers) diar.get_speakers = true;
      if (opts.speakers.length) diar.speakers = opts.speakers;
      if (opts.speakersSensitivity !== null) diar.speakers_sensitivity = opts.speakersSensitivity;
      ws.send(
        JSON.stringify({
          message: "StartRecognition",
          audio_format: { type: "raw", encoding: "pcm_s16le", sample_rate: SAMPLE_RATE },
          transcription_config: {
            language: opts.language, model: opts.model, diarization: "speaker", enable_partials: true, max_delay: opts.maxDelay,
            conversation_config: { end_of_utterance_silence_trigger: 0.8 },
            ...(Object.keys(diar).length ? { speaker_diarization_config: diar } : {}),
          },
        }),
      );
    };
    ws.onmessage = (e) => this.onMessage(JSON.parse(String(e.data)) as Record<string, unknown>);
    ws.onerror = () => this.mark("ws-error");
    ws.onclose = (e) => {
      this.state = "closed";
      this.mark("close", { code: e.code, reason: e.reason });
      this.done?.();
      this.emit();
    };
  }

  private onMessage(m: Record<string, unknown>): void {
    const now = Math.round(performance.now() - this.t0);
    switch (m.message) {
      case "RecognitionStarted":
        this.recognitionStartedMs = now;
        this.state = "recognizing";
        this.mark("RecognitionStarted", { id: m.id });
        this.source = new EvenAudioSource(this.opts!.audio, this.mark);
        void this.source
          .start({
            onData: (chunk: ArrayBuffer) => {
              if (this.ws?.readyState === WebSocket.OPEN) {
                this.ws.send(chunk);
                this.seq++;
              }
            },
            onError: (err: unknown) => this.mark("audio-error", String(err)),
          } as never)
          .catch((err) => this.mark("audio-start-failed", String(err)));
        break;
      case "AddPartialTranscript":
      case "AddTranscript": {
        const partial = m.message === "AddPartialTranscript";
        const results = (m.results as SmResult[]) ?? [];
        if (partial) {
          this.partials++;
          this.firstPartialMs ??= results.length ? now : null;
        } else {
          this.finals++;
          if (results.length) this.firstFinalMs ??= now;
          const end = (m.metadata as { end_time?: number } | undefined)?.end_time;
          if (end !== undefined) this.finalLagS.push(this.sentSeconds - end);
        }
        let text = "";
        for (const r of results) {
          const alt = r.alternatives?.[0];
          if (!alt) continue;
          text += (r.type === "punctuation" || r.attaches_to === "previous" ? "" : " ") + alt.content;
          if (alt.speaker && !this.labelFirstSeen.has(alt.speaker)) this.labelFirstSeen.set(alt.speaker, { atAudioS: r.start_time, wallMs: now, partial });
        }
        if (!partial) this.finalText += text;
        this.emit(partial ? text : "");
        break;
      }
      case "EndOfUtterance":
        this.endOfUtterances++;
        break;
      case "SpeakersResult":
        this.speakersResult = (m.speakers as EnrolledSpeaker[]) ?? [];
        this.mark("SpeakersResult", this.speakersResult.map((s) => ({ label: s.label, identifiers: s.speaker_identifiers.length, identifierChars: s.speaker_identifiers[0]?.length ?? 0 })));
        break;
      case "EndOfTranscript":
        this.mark("EndOfTranscript");
        this.ws?.close();
        break;
      case "Warning":
        if (this.warnings.length < 50) this.warnings.push(m);
        this.mark("Warning", m);
        break;
      case "Error":
        if (this.errors.length < 50) this.errors.push(m);
        this.mark("Error", m);
        break;
      case "AudioAdded":
      case "Info":
        break;
      default:
        this.mark(String(m.message));
    }
  }

  private emit(partial = ""): void {
    this.onLive({ state: this.state, sentSeconds: Math.round(this.sentSeconds), finalText: this.finalText.slice(-600), partialText: partial, labels: [...this.labelFirstSeen.keys()] });
  }

  /** Enrolled identifiers from this session (kept in memory only, never reported). */
  get identifiers(): EnrolledSpeaker[] {
    return this.speakersResult ?? [];
  }

  async stop(): Promise<Record<string, unknown>> {
    this.source?.stop();
    const closed = new Promise<void>((ok) => (this.done = ok));
    if (this.ws?.readyState === WebSocket.OPEN) {
      if (this.opts?.getSpeakers) this.ws.send(JSON.stringify({ message: "GetSpeakers", final: true }));
      this.ws.send(JSON.stringify({ message: "EndOfStream", last_seq_no: this.seq }));
    }
    await Promise.race([closed, new Promise((ok) => setTimeout(ok, 20_000))]);
    const lag = [...this.finalLagS].sort((a, b) => a - b);
    return {
      api: "speechmatics realtime v2 (raw WebSocket)",
      options: { ...this.opts, jwt: undefined, speakers: this.opts?.speakers.map((s) => ({ label: s.label, identifiers: s.speaker_identifiers.length })) },
      finalState: this.state,
      sentAudioSeconds: Math.round(this.sentSeconds * 10) / 10,
      recognitionStartedMs: this.recognitionStartedMs,
      firstPartialMs: this.firstPartialMs,
      firstFinalMs: this.firstFinalMs,
      finalLagSeconds: lag.length ? { p50: lag[Math.floor(lag.length / 2)], max: lag.at(-1) } : null,
      partials: this.partials,
      finals: this.finals,
      endOfUtterances: this.endOfUtterances,
      labelsFirstSeen: Object.fromEntries(this.labelFirstSeen),
      speakersResult: this.speakersResult?.map((s) => ({ label: s.label, identifiers: s.speaker_identifiers.length })) ?? null,
      errors: this.errors,
      warnings: this.warnings,
      events: this.events,
      transcript: this.opts?.includeTranscript ? this.finalText : `(${this.finalText.length} chars, redacted)`,
    };
  }
}

/** Captures a fixed number of seconds from the Even bridge (or silence) into a WAV, for batch probes. */
export async function captureWav(audio: SonioxAudio, seconds: number, log: Log): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let bytes = 0;
  const want = seconds * SAMPLE_RATE * 2;
  const source = new EvenAudioSource(audio, (e, d) => log(e, d ?? ""));
  await new Promise<void>((ok, fail) => {
    source
      .start({
        onData: (chunk: ArrayBuffer) => {
          if (bytes >= want) return;
          const u = new Uint8Array(chunk);
          parts.push(u);
          bytes += u.byteLength;
          if (bytes >= want) ok();
        },
        onError: fail,
      } as never)
      .catch(fail);
  });
  source.stop();
  const out = new Uint8Array(44 + bytes);
  out.set(wavHeader(bytes));
  let off = 44;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

export interface BatchOptions {
  apiKey: string;
  language: string;
  getSpeakers: boolean;
  speakers: EnrolledSpeaker[];
}

/** POST a job, poll, fetch json-v2. Identifiers stay in memory; the report only counts them. */
export async function batchJob(wav: Uint8Array, opts: BatchOptions, log: Log): Promise<{ report: Record<string, unknown>; speakers: EnrolledSpeaker[] }> {
  const t0 = performance.now();
  const ms = () => Math.round(performance.now() - t0);
  const auth = { Authorization: `Bearer ${opts.apiKey}` };
  const diar: Record<string, unknown> = {};
  if (opts.getSpeakers) diar.get_speakers = true;
  if (opts.speakers.length) diar.speakers = opts.speakers;
  const config = { type: "transcription", transcription_config: { language: opts.language, model: "enhanced", diarization: "speaker", ...(Object.keys(diar).length ? { speaker_diarization_config: diar } : {}) } };
  const form = new FormData();
  form.append("config", JSON.stringify(config));
  form.append("data_file", new Blob([wav as BlobPart], { type: "audio/wav" }), "probe.wav");
  const report: Record<string, unknown> = { api: "speechmatics batch v2", audioSeconds: (wav.byteLength - 44) / 2 / SAMPLE_RATE, getSpeakers: opts.getSpeakers, enrolled: opts.speakers.length };
  try {
    log("POST https://asr.api.speechmatics.com/v2/jobs…");
    const created = await fetch("https://asr.api.speechmatics.com/v2/jobs", { method: "POST", headers: auth, body: form });
    report.createStatus = created.status;
    report.createdMs = ms();
    if (!created.ok) return { report: { ...report, ok: false, body: (await created.text()).slice(0, 300) }, speakers: [] };
    const { id } = (await created.json()) as { id: string };
    let status = "running";
    let polls = 0;
    while (status === "running" && ms() < 10 * 60_000) {
      await new Promise((ok) => setTimeout(ok, Math.min(5000, 1000 + polls * 500)));
      const r = await fetch(`https://asr.api.speechmatics.com/v2/jobs/${id}`, { headers: auth });
      status = ((await r.json()) as { job?: { status?: string } }).job?.status ?? `http ${r.status}`;
      polls++;
    }
    report.finalStatus = status;
    report.doneMs = ms();
    report.polls = polls;
    if (status !== "done") return { report: { ...report, ok: false }, speakers: [] };
    const t = await fetch(`https://asr.api.speechmatics.com/v2/jobs/${id}/transcript?format=json-v2`, { headers: auth });
    const json = (await t.json()) as { results?: SmResult[]; speakers?: EnrolledSpeaker[] };
    const labels = new Set((json.results ?? []).map((r) => r.alternatives?.[0]?.speaker).filter(Boolean));
    await fetch(`https://asr.api.speechmatics.com/v2/jobs/${id}`, { method: "DELETE", headers: auth }).then((r) => (report.deleteStatus = r.status)).catch((e) => (report.deleteError = String(e)));
    const speakers = json.speakers ?? [];
    return { report: { ...report, ok: true, words: json.results?.length ?? 0, labels: [...labels], speakers: speakers.map((s) => ({ label: s.label, identifiers: s.speaker_identifiers.length })), transcriptMs: ms() }, speakers };
  } catch (e) {
    return { report: { ...report, ok: false, error: String(e), ms: ms() }, speakers: [] };
  }
}
