import {
  errorMessage,
  serviceOption,
  sleep,
  SPEECHMATICS_LANGUAGES,
  type CloudFinalProvider,
  type FinalTranscriptJob,
  type FinalTranscriptResult,
  type SpeakerTurn,
  type TranscriptToken,
} from "@irl/domain";
import { SPEECHMATICS_ENDPOINTS } from "./auth";
import { SpeechmaticsNormalizer, type SpeechmaticsResult } from "./normalizer";

export interface SpeechmaticsBatchOptions {
  apiKey: () => Promise<string | null>;
  fetch?: typeof fetch;
  /** Delay before the n-th status poll. */
  pollDelayMs?: (attempt: number) => number;
  /** Give up on a job that hasn't finished after this long. */
  timeoutMs?: number;
}

interface JobStatus {
  job?: { id: string; status: "running" | "done" | "rejected" | "deleted" | "expired"; errors?: { message?: string }[] };
}

interface JsonV2 {
  results?: SpeechmaticsResult[];
  speakers?: { label: string; speaker_identifiers?: string[] }[];
  metadata?: { language_identification?: { results?: { alternatives?: { language: string }[] }[] } };
}

/**
 * Speechmatics batch final transcript (irl-subt-3xb.6): after Stop the recording's WAV becomes a job; the json-v2
 * result becomes final tokens and speaker turns, and the job is deleted from Speechmatics once fetched.
 */
export class SpeechmaticsBatchProvider implements CloudFinalProvider {
  readonly id = "speechmatics-batch";

  constructor(private readonly opts: SpeechmaticsBatchOptions) {}

  private get fetch(): typeof fetch {
    return this.opts.fetch ?? fetch;
  }

  async transcribe(job: FinalTranscriptJob): Promise<FinalTranscriptResult> {
    const key = await this.opts.apiKey();
    if (!key) throw new Error("No Speechmatics API key saved");
    const auth = { Authorization: `Bearer ${key}` };
    const language = job.language === "auto" ? "auto" : (SPEECHMATICS_LANGUAGES[job.language] ?? job.language);
    const diarization: Record<string, unknown> = {};
    if (job.speakers?.length) diarization.speakers = job.speakers.map((s) => ({ label: s.label, speaker_identifiers: s.identifiers }));
    if (job.getSpeakers) diarization.get_speakers = true;
    const config = {
      type: "transcription",
      transcription_config: { language, model: serviceOption(job.optionId)?.model ?? "enhanced", diarization: "speaker", ...(Object.keys(diarization).length ? { speaker_diarization_config: diarization } : {}) },
    };
    const form = new FormData();
    form.append("config", JSON.stringify(config));
    form.append("data_file", new Blob([job.wav as BlobPart], { type: "audio/wav" }), `${job.recordingId}.wav`);

    job.onProgress?.("uploading audio to Speechmatics");
    const created = await this.request(`${SPEECHMATICS_ENDPOINTS.batch}/v2/jobs`, { method: "POST", headers: auth, body: form, signal: job.signal });
    const { id } = (await created.json()) as { id: string };
    try {
      await this.waitForJob(id, auth, job);
      job.onProgress?.("fetching the transcript");
      const transcript = (await (await this.request(`${SPEECHMATICS_ENDPOINTS.batch}/v2/jobs/${id}/transcript?format=json-v2`, { headers: auth, signal: job.signal })).json()) as JsonV2;
      return normalizeBatch(job, transcript);
    } finally {
      // Speechmatics keeps job audio and results until deleted; nothing is left behind, even after a failure.
      await this.fetch(`${SPEECHMATICS_ENDPOINTS.batch}/v2/jobs/${id}?force=true`, { method: "DELETE", headers: auth }).catch(() => undefined);
    }
  }

  private async waitForJob(id: string, auth: Record<string, string>, job: FinalTranscriptJob): Promise<void> {
    const started = Date.now();
    const delay = this.opts.pollDelayMs ?? ((n: number) => Math.min(10_000, 2000 + n * 1000));
    for (let attempt = 0; ; attempt++) {
      await sleep(delay(attempt));
      if (job.signal.aborted) throw new Error("cancelled");
      const status = ((await (await this.request(`${SPEECHMATICS_ENDPOINTS.batch}/v2/jobs/${id}`, { headers: auth, signal: job.signal })).json()) as JobStatus).job;
      if (status?.status === "done") return;
      if (status?.status && status.status !== "running") {
        throw new Error(`Speechmatics job ${status.status}${status.errors?.[0]?.message ? `: ${status.errors[0].message}` : ""}`);
      }
      job.onProgress?.("waiting for Speechmatics");
      if (Date.now() - started > (this.opts.timeoutMs ?? 30 * 60_000)) throw new Error("Speechmatics took too long");
    }
  }

  /** fetch with sanitized errors: never echoes response bodies that could quote the key. */
  private async request(url: string, init: RequestInit): Promise<Response> {
    let r: Response;
    try {
      r = await this.fetch(url, init);
    } catch (e) {
      if (init.signal?.aborted) throw new Error("cancelled");
      throw new Error(`Could not reach Speechmatics (${e instanceof TypeError ? "offline, blocked by the network allowlist, or CORS" : errorMessage(e)})`);
    }
    if (r.status === 401 || r.status === 403) throw new Error("Speechmatics rejected the key");
    if (!r.ok) throw new Error(`Speechmatics returned HTTP ${r.status}`);
    return r;
  }
}

export function normalizeBatch(job: Pick<FinalTranscriptJob, "recordingId" | "providerRunId" | "speakers">, transcript: JsonV2): FinalTranscriptResult {
  const normalizer = new SpeechmaticsNormalizer(job.recordingId, job.providerRunId, new Set(job.speakers?.map((s) => s.label) ?? []));
  const events = [...normalizer.final("batch", 0, transcript.results ?? []), ...normalizer.flush()];
  const tokens: TranscriptToken[] = [];
  const turns: SpeakerTurn[] = [];
  const clusters: FinalTranscriptResult["clusters"] = [];
  for (const e of events) {
    if (e.type === "tokens") tokens.push(...e.tokens);
    else if (e.type === "turns") turns.push(...e.turns);
    else if (e.type === "cluster") clusters.push({ clusterId: e.clusterId, ordinal: e.ordinal, providerLabel: e.providerLabel ?? e.clusterId });
  }
  const speakers = (transcript.speakers ?? [])
    .map((s) => ({ clusterId: normalizer.clusterIdFor("batch", s.label), identifiers: s.speaker_identifiers ?? [] }))
    .filter((s): s is { clusterId: string; identifiers: string[] } => !!s.clusterId && s.identifiers.length > 0);
  const language = transcript.metadata?.language_identification?.results?.[0]?.alternatives?.[0]?.language ?? tokens.find((t) => t.language)?.language;
  return { tokens, turns, clusters, ...(speakers.length ? { speakers } : {}), ...(language ? { language } : {}) };
}
