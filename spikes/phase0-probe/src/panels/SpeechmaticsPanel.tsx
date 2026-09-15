import { createSignal, Show } from "solid-js";
import { ActionButton, Card, createLog, createReporter, Field, KeyValue, LogView, ReportCard } from "../components";
import type { SonioxAudio } from "../spikes/soniox";
import { batchJob, captureWav, mintTemporaryKey, SpeechmaticsRtSession, type EnrolledSpeaker, type Region, type RtLive } from "../spikes/speechmatics";

export function SpeechmaticsPanel() {
  const log = createLog();
  const reporter = createReporter("speechmatics");
  // Key, JWT, and identifiers live only in memory for this launch; reports count identifiers, never include them.
  const [apiKey, setApiKey] = createSignal("");
  const [jwt, setJwt] = createSignal<string | null>(null);
  const [region, setRegion] = createSignal<Region>("eu");
  const [model, setModel] = createSignal<"enhanced" | "standard">("enhanced");
  const [language, setLanguage] = createSignal("en");
  const [audio, setAudio] = createSignal<SonioxAudio>("glasses");
  const [maxDelay, setMaxDelay] = createSignal(1);
  const [sensitivity, setSensitivity] = createSignal("");
  const [includeTranscript, setIncludeTranscript] = createSignal(false);
  const [enrolled, setEnrolled] = createSignal<EnrolledSpeaker[]>([]);
  const [live, setLive] = createSignal<RtLive | null>(null);
  const [session, setSession] = createSignal<{ s: SpeechmaticsRtSession; mode: "enroll" | "identify" | "plain" } | null>(null);

  const mint = async (type: "rt" | "batch") => {
    const { report, key } = await mintTemporaryKey(apiKey(), type, log.log);
    if (type === "rt") setJwt(key ?? null);
    await reporter.publish(report);
  };
  const start = (mode: "enroll" | "identify" | "plain") => {
    const s = new SpeechmaticsRtSession(setLive);
    s.start({
      jwt: jwt()!, region: region(), model: model(), language: language(), audio: audio(), maxDelay: maxDelay(), includeTranscript: includeTranscript(),
      getSpeakers: mode === "enroll", speakers: mode === "identify" ? enrolled() : [], speakersSensitivity: sensitivity() ? Number(sensitivity()) : null,
    });
    setSession({ s, mode });
    log.log(`realtime ${mode} session started`);
  };
  const stop = async () => {
    const cur = session();
    if (!cur) return;
    setSession(null);
    const report = await cur.s.stop();
    if (cur.mode === "enroll") {
      // Opaque labels, as the app will send person tokens rather than names.
      setEnrolled(cur.s.identifiers.map((sp, i) => ({ label: `P${i + 1}`, speaker_identifiers: sp.speaker_identifiers })));
      log.log(`enrolled ${cur.s.identifiers.length} speaker(s) as P1..`);
    }
    await reporter.publish({ kind: `realtime-${cur.mode}`, region: region(), ...report });
  };
  const batch = async (mode: "enroll" | "identify", seconds: number) => {
    log.log(`capturing ${seconds} s…`);
    const wav = await captureWav(audio(), seconds, log.log);
    const { report, speakers } = await batchJob(wav, { apiKey: apiKey(), language: language(), getSpeakers: mode === "enroll", speakers: mode === "identify" ? enrolled() : [] }, log.log);
    if (mode === "enroll" && speakers.length) setEnrolled(speakers.map((sp, i) => ({ label: `P${i + 1}`, speaker_identifiers: sp.speaker_identifiers })));
    await reporter.publish({ kind: `batch-${mode}`, clipSeconds: seconds, ...report });
  };

  return (
    <>
      <Card title="Spike irl-subt-3xb.4 — Speechmatics realtime, batch and speaker ID through Even whitelist/CORS">
        <Field label="Speechmatics API key (memory only, never saved or reported)">
          <input type="password" autocomplete="off" value={apiKey()} onInput={(e) => setApiKey(e.currentTarget.value.trim())} />
        </Field>
        <div class="row">
          <ActionButton label="1. Mint realtime JWT (whitelist/CORS probe)" onRun={() => mint("rt")} disabled={!apiKey()} />
          <ActionButton label="Mint batch temp key" onRun={() => mint("batch")} disabled={!apiKey()} />
          <span class="muted">{jwt() ? "JWT ready" : ""}</span>
        </div>
        <div class="row">
          <Field label="Region">
            <select value={region()} onChange={(e) => setRegion(e.currentTarget.value as Region)}>
              <option value="eu">eu.rt.speechmatics.com</option>
              <option value="us">us.rt.speechmatics.com</option>
            </select>
          </Field>
          <Field label="Model">
            <select value={model()} onChange={(e) => setModel(e.currentTarget.value as "enhanced" | "standard")}>
              <option value="enhanced">enhanced</option>
              <option value="standard">standard</option>
            </select>
          </Field>
          <Field label="Language">
            <input value={language()} onChange={(e) => setLanguage(e.currentTarget.value.trim())} />
          </Field>
        </div>
        <div class="row">
          <Field label="Audio">
            <select value={audio()} onChange={(e) => setAudio(e.currentTarget.value as SonioxAudio)}>
              <option value="glasses">G2 glasses mic</option>
              <option value="phone">Phone mic (via Even app)</option>
              <option value="silence">Silence (handshake only)</option>
            </select>
          </Field>
          <Field label="max_delay (s)">
            <input type="number" min="0.7" max="4" step="0.1" value={maxDelay()} onChange={(e) => setMaxDelay(Number(e.currentTarget.value))} />
          </Field>
          <Field label="speakers_sensitivity (blank = default)">
            <input value={sensitivity()} onChange={(e) => setSensitivity(e.currentTarget.value.trim())} />
          </Field>
          <label>
            <input type="checkbox" checked={includeTranscript()} onChange={(e) => setIncludeTranscript(e.currentTarget.checked)} /> include transcript in report
          </label>
        </div>
        <div class="row">
          <ActionButton label="2. Realtime stream (latency)" onRun={() => start("plain")} disabled={!jwt() || !!session()} />
          <ActionButton label="3a. Realtime enroll (get_speakers)" onRun={() => start("enroll")} disabled={!jwt() || !!session()} />
          <ActionButton label="3b. Realtime identify (enrolled)" onRun={() => start("identify")} disabled={!jwt() || !!session() || !enrolled().length} />
          <ActionButton label="Stop & report" onRun={stop} disabled={!session()} />
        </div>
        <div class="row">
          <ActionButton label="4a. Batch 20 s with get_speakers" onRun={() => batch("enroll", 20)} disabled={!apiKey() || !!session()} />
          <ActionButton label="4b. Batch 20 s identify (enrolled)" onRun={() => batch("identify", 20)} disabled={!apiKey() || !!session() || !enrolled().length} />
          <ActionButton label="5. Enroll from a 6 s clip (batch)" onRun={() => batch("enroll", 6)} disabled={!apiKey() || !!session()} />
          <span class="muted">{enrolled().length ? `${enrolled().length} enrolled (${enrolled().map((e) => `${e.label}: ${e.speaker_identifiers.length} id`).join(", ")})` : "none enrolled"}</span>
        </div>
        <Show when={live()}>
          {(l) => (
            <>
              <KeyValue data={{ state: l().state, sentSeconds: l().sentSeconds, labels: l().labels.join(", ") }} />
              <p>
                {l().finalText}
                <span class="muted">{l().partialText}</span>
              </p>
            </>
          )}
        </Show>
        <LogView lines={log.lines()} />
      </Card>
      <ReportCard status={reporter.status()} json={reporter.json()} />
    </>
  );
}
