import { errorMessage, serviceOption, sleep, type CloudFinalProvider, type FinalTranscriptJob, type FinalTranscriptResult, type SpeakerTurn, type TranscriptToken, UserError } from "@irl/domain";
import { SonioxNormalizer, type SonioxTokenLike } from "./normalizer";

const API = "https://api.soniox.com";

export interface SonioxAsyncOptions {
  apiKey: () => Promise<string | null>;
  fetch?: typeof fetch;
  pollDelayMs?: (attempt: number) => number;
  timeoutMs?: number;
}

/**
 * Soniox async final transcript (irl-subt-3xb.8): upload the recording's WAV, transcribe it with speaker diarization,
 * poll, normalize the tokens like the realtime stream, then delete the transcription and the file from Soniox.
 */
export class SonioxAsyncProvider implements CloudFinalProvider {
  readonly id = "soniox-async";

  constructor(private readonly opts: SonioxAsyncOptions) {}

  private get fetch(): typeof fetch {
    return this.opts.fetch ?? fetch;
  }

  async transcribe(job: FinalTranscriptJob): Promise<FinalTranscriptResult> {
    const key = await this.opts.apiKey();
    if (!key) throw new UserError("key-missing", "No Soniox API key saved", { service: "soniox" });
    const auth = { Authorization: `Bearer ${key}` };
    const cleanup: string[] = [];
    try {
      job.onProgress?.({ code: "uploading", service: "soniox" });
      const form = new FormData();
      form.append("file", new Blob([job.wav as BlobPart], { type: "audio/wav" }), `${job.recordingId}.wav`);
      const file = (await (await this.request(`${API}/v1/files`, { method: "POST", headers: auth, body: form, signal: job.signal })).json()) as { id: string };
      cleanup.push(`${API}/v1/files/${file.id}`);
      const body = {
        model: serviceOption(job.optionId)?.model ?? "stt-async-v5",
        file_id: file.id,
        enable_speaker_diarization: true,
        enable_language_identification: true,
        ...(job.language !== "auto" ? { language_hints: [job.language] } : {}),
      };
      const created = (await (await this.request(`${API}/v1/transcriptions`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(body), signal: job.signal })).json()) as { id: string };
      // Delete the transcription before the file it references.
      cleanup.unshift(`${API}/v1/transcriptions/${created.id}`);
      await this.waitFor(created.id, auth, job);
      job.onProgress?.({ code: "fetching" });
      const transcript = (await (await this.request(`${API}/v1/transcriptions/${created.id}/transcript`, { headers: auth, signal: job.signal })).json()) as { tokens?: SonioxTokenLike[] };
      return normalizeSonioxAsync(job, transcript.tokens ?? []);
    } finally {
      for (const url of cleanup) await this.fetch(url, { method: "DELETE", headers: auth }).catch(() => undefined);
    }
  }

  private async waitFor(id: string, auth: Record<string, string>, job: FinalTranscriptJob): Promise<void> {
    const started = Date.now();
    const delay = this.opts.pollDelayMs ?? ((n: number) => Math.min(10_000, 1500 + n * 1000));
    for (let attempt = 0; ; attempt++) {
      await sleep(delay(attempt));
      if (job.signal.aborted) throw new UserError("cancelled", "cancelled");
      const t = (await (await this.request(`${API}/v1/transcriptions/${id}`, { headers: auth, signal: job.signal })).json()) as { status?: string; error_message?: string };
      if (t.status === "completed") return;
      if (t.status === "error") throw new Error(`Soniox transcription failed${t.error_message ? `: ${t.error_message}` : ""}`);
      job.onProgress?.({ code: "waiting", service: "soniox" });
      if (Date.now() - started > (this.opts.timeoutMs ?? 30 * 60_000)) throw new UserError("service-timeout", "Soniox took too long", { service: "soniox" });
    }
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    let r: Response;
    try {
      r = await this.fetch(url, init);
    } catch (e) {
      if (init.signal?.aborted) throw new UserError("cancelled", "cancelled");
      throw new UserError("service-unreachable", `Could not reach Soniox (${e instanceof TypeError ? "offline, blocked by the network allowlist, or CORS" : errorMessage(e)})`, { service: "soniox" });
    }
    if (r.status === 401 || r.status === 403) throw new UserError("key-rejected", "Soniox rejected the key", { service: "soniox" });
    if (!r.ok) throw new Error(`Soniox returned HTTP ${r.status}`);
    return r;
  }
}

export function normalizeSonioxAsync(job: Pick<FinalTranscriptJob, "recordingId" | "providerRunId">, tokens: readonly SonioxTokenLike[]): FinalTranscriptResult {
  const n = new SonioxNormalizer(job.recordingId, job.providerRunId);
  const events = [...n.result("batch", 0, tokens.map((t) => ({ ...t, is_final: true }))), ...n.flush()];
  const out: TranscriptToken[] = [];
  const turns: SpeakerTurn[] = [];
  const clusters: FinalTranscriptResult["clusters"] = [];
  for (const e of events) {
    if (e.type === "tokens") out.push(...e.tokens);
    else if (e.type === "turns") turns.push(...e.turns);
    else if (e.type === "cluster") clusters.push({ clusterId: e.clusterId, ordinal: e.ordinal, providerLabel: e.providerLabel ?? e.clusterId });
  }
  const language = out.find((t) => t.language)?.language;
  return { tokens: out, turns, clusters, ...(language ? { language } : {}) };
}
