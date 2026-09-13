import { createSignal, Show } from "solid-js";
import { ActionButton, Card, createLog, createReporter, Field, KeyValue, LogView, ReportCard } from "../components";
import { mintTemporaryKey, SonioxStream, type SonioxAudio, type StreamLive } from "../spikes/soniox";

export function SonioxPanel() {
  const log = createLog();
  const reporter = createReporter("soniox");
  // The key lives only in memory for this launch; it is never persisted or reported.
  const [apiKey, setApiKey] = createSignal("");
  const [tempKey, setTempKey] = createSignal<string | null>(null);
  const [useTemp, setUseTemp] = createSignal(true);
  const [audio, setAudio] = createSignal<SonioxAudio>("glasses");
  const [reconnectOnForeground, setReconnectOnForeground] = createSignal(true);
  const [hints, setHints] = createSignal("en");
  const [includeTranscript, setIncludeTranscript] = createSignal(false);
  const [live, setLive] = createSignal<StreamLive | null>(null);
  const [stream, setStream] = createSignal<SonioxStream | null>(null);

  const rest = async () => {
    const { report, temporaryKey } = await mintTemporaryKey(apiKey(), log.log);
    setTempKey(temporaryKey ?? null);
    await reporter.publish({ kind: "rest", ...report });
  };
  const start = () => {
    const usedTemporaryKey = useTemp() && !!tempKey();
    const s = new SonioxStream(setLive);
    s.start({
      apiKey: usedTemporaryKey ? tempKey()! : apiKey(),
      audio: audio(),
      languageHints: hints().split(",").map((h) => h.trim()).filter(Boolean),
      includeTranscript: includeTranscript(),
      reconnectOnForeground: reconnectOnForeground(),
    });
    setStream(s);
    log.log(`recording started (${usedTemporaryKey ? "temporary" : "primary"} key)`);
  };
  const stop = async () => {
    const s = stream();
    if (!s) return;
    const usedTemporaryKey = useTemp() && !!tempKey();
    setStream(null);
    await reporter.publish({ kind: "stream", usedTemporaryKey, ...(await s.stop()) });
  };

  return (
    <>
      <Card title="Spike irl-subt-0i6.5 — Soniox (@soniox/client) through Even whitelist/CORS">
        <Field label="Soniox API key (memory only, never saved or reported)">
          <input type="password" autocomplete="off" value={apiKey()} onInput={(e) => setApiKey(e.currentTarget.value.trim())} />
        </Field>
        <div class="row">
          <ActionButton label="1. Mint temporary key (whitelist/CORS probe)" onRun={rest} disabled={!apiKey()} />
          <span class="muted">{tempKey() ? "temporary key ready" : ""}</span>
        </div>
        <div class="row">
          <Field label="Audio">
            <select value={audio()} onChange={(e) => setAudio(e.currentTarget.value as SonioxAudio)}>
              <option value="glasses">G2 glasses mic</option>
              <option value="phone">Phone mic (via Even app)</option>
              <option value="silence">Silence (handshake only)</option>
            </select>
          </Field>
          <Field label="Language hints">
            <input value={hints()} onChange={(e) => setHints(e.currentTarget.value)} />
          </Field>
        </div>
        <div class="row">
          <label>
            <input type="checkbox" checked={useTemp()} onChange={(e) => setUseTemp(e.currentTarget.checked)} /> use temporary key
          </label>
          <label>
            <input type="checkbox" checked={reconnectOnForeground()} onChange={(e) => setReconnectOnForeground(e.currentTarget.checked)} /> reconnect on foreground
          </label>
          <label>
            <input type="checkbox" checked={includeTranscript()} onChange={(e) => setIncludeTranscript(e.currentTarget.checked)} /> include transcript in report
          </label>
        </div>
        <div class="row">
          <ActionButton label="2. Start streaming" onRun={start} disabled={!apiKey() || !!stream()} />
          <ActionButton label="Stop & report" onRun={stop} disabled={!stream()} />
        </div>
        <Show when={live()}>
          {(l) => (
            <>
              <KeyValue data={{ state: l().state, sentSeconds: l().sentSeconds, speakers: l().speakers.join(", ") }} />
              <p>
                {l().finalText}
                <span class="muted">{l().provisionalText}</span>
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
