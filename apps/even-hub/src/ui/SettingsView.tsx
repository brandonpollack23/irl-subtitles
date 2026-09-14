import { createSignal, For, onSettled, Show } from "solid-js";
import { errorMessage, LANGUAGES, parseWav, resampleLinear, tierForSelection, type ModelCatalogEntry, type ModelRole, type ModelSelection, type Settings } from "@irl/domain";
import { availabilityOnDevice, catalogEntry, clearModelCache, embeddingSpaceOf, entriesForRole, firstRunBenchmark, ROLE_KEYS, supportsLanguage, type LoadProgress } from "@irl/provider-local";
import { testSonioxKey } from "@irl/provider-soniox";
import { app, bumpData, Button, bytes, toast, useData } from "./lib";

function useSettings() {
  const [s, setS] = createSignal<Settings>(app().settings.get(), { ownedWrite: true });
  onSettled(() => app().settings.changes.on((next) => setS(() => next)));
  const update = async (patch: Partial<Settings>) => {
    await app().settings.update(patch);
  };
  return [s, update] as const;
}

const ROLE_TITLES: Record<ModelRole, { title: string; hint: string }> = {
  vad: { title: "Speech detection", hint: "Finds speech so silence isn't transcribed." },
  "stt-live": { title: "Live captions", hint: "Captions while you record. Off saves battery; the transcript is made after you stop." },
  "stt-final": { title: "Final transcript", hint: "Re-transcribes after you stop, with word timing." },
  "speaker-embedding": { title: "Voice model", hint: "Tells speakers apart and recognizes saved voices. Changing it re-enrolls saved voices." },
  summary: { title: "Summary", hint: "Writes the summary after you stop." },
};

export function SettingsView() {
  const [s, update] = useSettings();
  return (
    <>
      <h1>Settings</h1>
      <RecordingSection s={s()} update={update} />
      <ProviderSection s={s()} update={update} />
      <ModelsSection s={s()} update={update} />
      <PrivacySection s={s()} update={update} />
      <div class="panel">
        <h2>Diagnostics</h2>
        <p class="small muted">Device capabilities, storage, logs, and the speaker recognition calibration tool.</p>
        <div class="row">
          <a class="btn" href="#/diagnostics">
            Diagnostics
          </a>
          <a class="btn" href="#/evaluation">
            Calibrate voice recognition
          </a>
        </div>
      </div>
      <p class="small muted">
        IRL Subtitles {__APP_VERSION__} ({__BUILD_ID__.slice(0, 16)})
      </p>
    </>
  );
}

type SectionProps = { s: Settings; update: (p: Partial<Settings>) => Promise<void> };

function RecordingSection(props: SectionProps) {
  const [wavName, setWavName] = createSignal(app().devWav?.name ?? null);
  return (
    <section class="panel">
      <h2>Recording</h2>
      <p class="small muted">Changes apply to your next recording.</p>
      <label class="field">
        Language
        <select value={props.s.language} onChange={(e) => void changeLanguage(props, e.currentTarget.value)}>
          <For each={LANGUAGES}>{(l) => <option value={l.code}>{l.name}</option>}</For>
        </select>
      </label>
      <label class="check">
        <input type="checkbox" checked={props.s.persistAudio} onChange={(e) => void props.update({ persistAudio: e.currentTarget.checked })} />
        <span>
          Save audio
          <span class="small muted" style={{ display: "block" }}>
            Off: audio is only kept, encrypted with a key that never leaves memory, until processing finishes. You can also switch this from the glasses menu.
          </span>
        </span>
      </label>
      <label class="check">
        <input type="checkbox" checked={props.s.showCaptionsOnGlasses} onChange={(e) => void props.update({ showCaptionsOnGlasses: e.currentTarget.checked })} />
        <span>Show captions on the glasses</span>
      </label>
      <label class="field">
        Microphone
        <select value={props.s.captureSource} onChange={(e) => void props.update({ captureSource: e.currentTarget.value as Settings["captureSource"] })}>
          <option value="glasses">Glasses (G2 microphones)</option>
          <option value="phone-mic">Phone microphone</option>
          <option value="wav-file">Audio file (testing)</option>
        </select>
      </label>
      <Show when={props.s.captureSource === "wav-file"}>
        <label class="field">
          Test audio file <span class="hint">A WAV file played as if it were live. Without one, a short sample clip is used.</span>
          <input
            type="file"
            accept="audio/wav,.wav"
            onChange={async (e) => {
              const f = e.currentTarget.files?.[0];
              if (!f) return;
              const data = new Uint8Array(await f.arrayBuffer());
              try {
                parseWav(data);
                app().setDevWav({ name: f.name, bytes: data });
                setWavName(f.name);
              } catch (err) {
                toast(`That file can't be used: ${errorMessage(err)}`);
              }
            }}
          />
          <Show when={wavName()}>
            <span class="hint">Using {wavName()} (kept until the app closes).</span>
          </Show>
        </label>
      </Show>
    </section>
  );
}

async function changeLanguage(props: SectionProps, language: string) {
  const patch: Partial<Settings> = { language };
  // Monolingual live models follow the language; pick the preferred one that supports it.
  const live = catalogEntry(props.s.models.sttLive);
  if (live && !supportsLanguage(live, language)) {
    const next = entriesForRole("stt-live").find((e) => e.availability.status === "available" && supportsLanguage(e, language));
    patch.models = { ...props.s.models, sttLive: next?.id ?? "off" };
    toast(next ? `Live captions switched to ${next.displayName}` : "No live caption model for that language; captions will be made after you stop");
  }
  await props.update(patch);
}

function ProviderSection(props: SectionProps) {
  const [key, setKey] = createSignal("");
  const status = useData(
    () => 0,
    () => app().storage.secrets.has("soniox_api_key"),
  );
  return (
    <section class="panel">
      <h2>Transcription service</h2>
      <label class="check">
        <input type="radio" name="provider" checked={props.s.provider === "local"} onChange={() => void props.update({ provider: "local" })} />
        <span>
          On this phone
          <span class="small muted" style={{ display: "block" }}>
            Audio, transcripts, and voices never leave the phone.
          </span>
        </span>
      </label>
      <label class="check">
        <input
          type="radio"
          name="provider"
          checked={props.s.provider === "soniox"}
          disabled={!status.value()}
          onChange={() => void props.update({ provider: "soniox" })}
        />
        <span>
          Soniox
          <span class="small muted" style={{ display: "block" }}>
            Audio is streamed to Soniox for transcription and speaker separation while recording. Voice profiles and voice matching stay on this phone. {status.value() ? "" : "Save a Soniox key to use it."}
          </span>
        </span>
      </label>

      <h3>Soniox API key</h3>
      <Show when={status.value()} fallback={<p class="small muted">No key saved.</p>}>
        <p class="small">A key is saved. It's encrypted on this phone and never shown again.</p>
      </Show>
      <label class="field">
        {status.value() ? "Replace key" : "Key"}
        <input type="password" autocomplete="off" spellcheck={false} value={key()} onInput={(e) => setKey(e.currentTarget.value)} />
      </label>
      <div class="row">
        <Button
          label={status.value() ? "Replace" : "Save"}
          kind="primary"
          disabled={!key().trim()}
          onClick={async () => {
            await app().storage.secrets.put("soniox_api_key", key().trim());
            setKey("");
            status.reload();
            toast("Soniox key saved");
          }}
        />
        <Button
          label="Test"
          busyLabel="Testing…"
          disabled={!key().trim() && !status.value()}
          onClick={async () => {
            const k = key().trim() || (await app().storage.secrets.get("soniox_api_key"));
            if (!k) return;
            const r = await testSonioxKey(k);
            toast(r.message);
          }}
        />
        <Show when={status.value()}>
          <Button
            label="Remove"
            kind="danger"
            onClick={async () => {
              await app().storage.secrets.delete("soniox_api_key");
              if (props.s.provider === "soniox") await props.update({ provider: "local" });
              status.reload();
              toast("Soniox key removed. Existing transcripts are unchanged.");
            }}
          />
        </Show>
      </div>
    </section>
  );
}

function ModelsSection(props: SectionProps) {
  const [progress, setProgress] = createSignal<Record<string, LoadProgress>>({}, { ownedWrite: true });
  const [benchNote, setBenchNote] = createSignal<string | null>(null, { ownedWrite: true });
  const [version, setVersion] = createSignal(0, { ownedWrite: true });
  const [download, setDownload] = createSignal<DownloadRun | null>(null, { ownedWrite: true });
  onSettled(() => app().engines.progress.on((p) => setProgress((cur) => ({ ...cur, [p.modelId]: p }))));

  const downloaded = useData(
    () => version(),
    async () => {
      const out: Record<string, boolean> = {};
      for (const role of Object.keys(ROLE_TITLES) as ModelRole[]) for (const e of entriesForRole(role)) out[e.id] = await app().engines.isDownloaded(e.id);
      return out;
    },
  );

  const selected = (role: ModelRole) => props.s.models[ROLE_KEYS[role]];

  const setModel = async (role: ModelRole, id: string) => {
    const key = ROLE_KEYS[role];
    if (role === "speaker-embedding" && id !== props.s.models.speakerEmbedding) {
      const profiles = await app().storage.repo.listProfiles();
      if (profiles.length && !confirm("Switching the voice model changes how voices are compared. Saved voices are re-enrolled from their kept audio clips; people without clips need to be named again before they're recognized. Continue?")) {
        bumpData();
        return;
      }
      await props.update({ models: { ...props.s.models, [key]: id } as ModelSelection });
      if (profiles.length) {
        toast("Re-enrolling saved voices…");
        const r = await app().identity.migrateEmbeddingSpace(id, embeddingSpaceOf(id));
        toast(`${r.reembedded} voice${r.reembedded === 1 ? "" : "s"} re-enrolled, ${r.needsReenrollment} need${r.needsReenrollment === 1 ? "s" : ""} naming again`);
      }
      return;
    }
    await props.update({ models: { ...props.s.models, [key]: id } as ModelSelection });
    if (role === "stt-final" || role === "summary") toast("Applies to new recordings. Open a conversation to reprocess it.");
  };

  const downloadSelected = async () => {
    const e = app().engines;
    const m = props.s.models;
    // Download only: loading models here held several copies of each one's weights in memory at once.
    const selectedIds = [...new Set([m.vad, m.speakerEmbedding, m.sttLive, m.sttFinal, m.summary])].filter((id) => catalogEntry(id));
    const ids: string[] = [];
    for (const id of selectedIds) if (!(await e.isDownloaded(id))) ids.push(id);
    if (!ids.length) {
      toast("Selected models are already downloaded");
      return;
    }
    setDownload({ ids, index: 0, percent: 0, current: null });
    const off = e.progress.on((p) => setDownload((d) => (d && p.modelId === d.ids[d.index] ? advance(d, p) : d)));
    const failures: string[] = [];
    try {
      for (const [i, id] of ids.entries()) {
        setDownload((d) => d && { ...d, index: i, current: null, percent: Math.max(d.percent, overallPercent(ids, i, 0)) });
        try {
          await e.download(id);
        } catch (err) {
          failures.push(`${catalogEntry(id)?.displayName ?? id}: ${errorMessage(err)}`);
        }
      }
    } finally {
      off();
      setDownload(null);
    }
    setVersion((v) => v + 1);
    toast(failures.length ? `Some models failed: ${failures.join("; ")}` : "Models downloaded and verified");
  };

  const clearCache = async () => {
    if (!confirm("Delete all downloaded models? They download again when you tap Download or record.")) return;
    await app().engines.release(["audio", "asr", "llm", "stream"]);
    await clearModelCache();
    app().engines.forgetDownloads();
    setProgress({});
    setVersion((v) => v + 1);
    toast("Model cache cleared");
  };

  const benchmark = async () => {
    const bytesWav = new Uint8Array(await (await fetch("/fixtures/jfk.wav")).arrayBuffer());
    const wav = parseWav(bytesWav);
    const clip = resampleLinear(wav.samples, wav.sampleRate);
    const report = await firstRunBenchmark(app().engines, clip, props.s.language, (note) => setBenchNote(`Measuring ${note}…`));
    await app().saveBenchmarks(report.results);
    setBenchNote(null);
    const models = { ...props.s.models, ...report.selection } as ModelSelection;
    await props.update({ models, firstRunBenchmarkAt: new Date().toISOString() });
    setVersion((v) => v + 1);
    toast(`Measured ${report.results.length} model runs. Best options selected.`);
  };

  const tier = () => tierForSelection(props.s.models);

  return (
    <section class="panel">
      <h2>On-device models</h2>
      <p class="small muted">
        Performance: {tier() === "battery-saver" ? "Battery saver (no live captions)" : "Live captions"}. Models download once, are checked against pinned fingerprints, and stay on the phone.
        Recording never waits for a download: anything missing is processed after you stop.
      </p>
      <label class="field">
        Power
        <select value={props.s.powerPolicy} onChange={(e) => void props.update({ powerPolicy: e.currentTarget.value as Settings["powerPolicy"] })}>
          <option value="low-power">Save battery</option>
          <option value="balanced">Balanced</option>
          <option value="fast">Fastest</option>
        </select>
      </label>
      <For each={Object.keys(ROLE_TITLES) as ModelRole[]}>
        {(role) => (
          <ModelPicker
            role={role}
            s={props.s}
            value={selected(role)}
            downloaded={downloaded.value() ?? {}}
            progress={progress()}
            onChange={(id) => void setModel(role, id)}
          />
        )}
      </For>
      <div class="row">
        <Button label="Download selected models" busyLabel="Downloading…" kind="primary" onClick={downloadSelected} />
        <Button label={props.s.firstRunBenchmarkAt ? "Measure again" : "Measure this phone"} busyLabel="Measuring…" onClick={benchmark} />
        <Button label="Clear model cache" busyLabel="Clearing…" kind="danger" onClick={clearCache} />
      </div>
      <Show when={download()}>{(d) => <DownloadProgress run={d()} />}</Show>
      <Show when={benchNote()}>
        <p class="small muted">{benchNote()}</p>
      </Show>
    </section>
  );
}

type DownloadRun = { ids: string[]; index: number; percent: number; current: LoadProgress | null };

/** Catalog sizes weight each model, so a 2 GB summary model moves the bar more than a 3 MB VAD. */
function overallPercent(ids: string[], index: number, fraction: number): number {
  const weight = (id: string) => catalogEntry(id)?.downloadBytes || 1;
  const total = ids.reduce((sum, id) => sum + weight(id), 0);
  const done = ids.slice(0, index).reduce((sum, id) => sum + weight(id), 0);
  return Math.min(100, ((done + weight(ids[index]!) * fraction) / total) * 100);
}

/** Downloads report the pinned size of every file they cover; the catalog size is only a fallback. */
function expectedBytes(p: LoadProgress): number {
  return p.total || (catalogEntry(p.modelId)?.downloadBytes ?? 0);
}

function advance(d: DownloadRun, p: LoadProgress): DownloadRun {
  const expected = expectedBytes(p);
  const fraction = p.status === "ready" ? 1 : p.status === "downloading" && expected ? Math.min(1, (p.loaded ?? 0) / expected) : 0;
  // Never let the bar move backwards.
  return { ...d, current: p, percent: Math.max(d.percent, overallPercent(d.ids, d.index, fraction)) };
}

function DownloadProgress(props: { run: DownloadRun }) {
  const name = () => catalogEntry(props.run.ids[props.run.index]!)?.displayName ?? props.run.ids[props.run.index];
  const detail = () => {
    const p = props.run.current;
    if (p?.status === "downloading" && p.loaded !== undefined) return `${bytes(p.loaded)} of ${bytes(expectedBytes(p))}`;
    return p?.status === "ready" ? "Verified" : "Checking…";
  };
  return (
    <div class="stack" style={{ gap: "6px" }}>
      <div
        class="progress large"
        role="progressbar"
        aria-label="Model download"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(props.run.percent)}
      >
        <div style={{ width: `${props.run.percent}%` }} />
      </div>
      <div class="spread small">
        <span>
          {name()} <span class="muted">({props.run.index + 1} of {props.run.ids.length}) · {detail()}</span>
        </span>
        <span class="num">{Math.round(props.run.percent)}%</span>
      </div>
    </div>
  );
}

function ModelPicker(props: { role: ModelRole; s: Settings; value: string; downloaded: Record<string, boolean>; progress: Record<string, LoadProgress>; onChange: (id: string) => void }) {
  const caps = app().caps;
  const entries = () => entriesForRole(props.role);
  const bench = (id: string) => app().engines.benchmarks.filter((b) => b.modelId === id);
  const describe = (e: ModelCatalogEntry) => {
    const a = availabilityOnDevice(e, caps);
    const langOk = supportsLanguage(e, props.s.language);
    const parts = [e.displayName, bytes(e.downloadBytes)];
    if (a.status === "unavailable") parts.push("unavailable");
    else if (!langOk) parts.push("other language");
    else if (props.downloaded[e.id]) parts.push("downloaded");
    const b = bench(e.id).filter((x) => x.ok);
    if (b.length) parts.push(b.map((x) => (x.realTimeFactor !== undefined ? `${x.target} ${x.realTimeFactor.toFixed(2)}× real time` : `${Math.round(x.tokensPerSecond ?? 0)} tok/s`)).join(", "));
    return parts.join(" · ");
  };
  const current = () => catalogEntry(props.value);
  const specials = () => (props.role === "stt-live" ? [["off", "Off (capture now, process later)"]] : props.role === "stt-final" ? [["same-as-live", "Same as live captions"]] : props.role === "summary" ? [["cloud", "Cloud summary service (sends transcript only)"], ["off", "Off"]] : []);
  const p = () => props.progress[props.value];
  return (
    <div class="stack" style={{ gap: "4px" }}>
      <label class="field">
        {ROLE_TITLES[props.role].title}
        <span class="hint">{ROLE_TITLES[props.role].hint}</span>
        <select value={props.value} onChange={(e) => props.onChange(e.currentTarget.value)}>
          <For each={entries()}>
            {(e) => (
              <option value={e.id} disabled={availabilityOnDevice(e, caps).status === "unavailable" || !supportsLanguage(e, props.s.language)}>
                {describe(e)}
              </option>
            )}
          </For>
          <For each={specials()}>{([id, name]) => <option value={id}>{name}</option>}</For>
        </select>
      </label>
      <For each={entries().filter((e) => availabilityOnDevice(e, caps).status === "unavailable")}>
        {(e) => {
          const a = availabilityOnDevice(e, caps);
          return <span class="small muted">{e.displayName}: {a.status === "unavailable" ? a.reason : ""}</span>;
        }}
      </For>
      <Show when={current()?.notes}>
        <span class="small muted">{current()!.notes}</span>
      </Show>
      <Show when={p() && p()!.status !== "ready"}>
        <span class={["small", { error: p()!.status === "failed" }]}>
          {p()!.status === "downloading" && p()!.total ? `Downloading ${Math.round(((p()!.loaded ?? 0) / p()!.total!) * 100)}%` : p()!.status === "failed" ? `Failed: ${p()!.error}` : "Loading…"}
        </span>
      </Show>
    </div>
  );
}

function PrivacySection(props: SectionProps) {
  return (
    <section class="panel">
      <h2>Privacy and storage</h2>
      <label class="check">
        <input
          type="checkbox"
          checked={!props.s.persistAudio || props.s.deleteAudioAfterProcessing}
          disabled={!props.s.persistAudio}
          onChange={(e) => void props.update({ deleteAudioAfterProcessing: e.currentTarget.checked })}
        />
        <span>
          Delete audio after processing
          <span class="small muted" style={{ display: "block" }}>
            {props.s.persistAudio
              ? "Keeps transcripts, summaries, names, and voice profiles."
              : "Always on while Save audio is off. Keeps transcripts, summaries, names, and voice profiles."}
          </span>
        </span>
      </label>
      <label class="check">
        <input type="checkbox" checked={props.s.learnVoiceDefault} onChange={(e) => void props.update({ learnVoiceDefault: e.currentTarget.checked })} />
        <span>Turn on "Learn this voice" by default when naming speakers</span>
      </label>
      <label class="check">
        <input type="checkbox" checked={props.s.keepVoiceClips} onChange={(e) => void props.update({ keepVoiceClips: e.currentTarget.checked })} />
        <span>
          Keep short voice clips with voice profiles
          <span class="small muted" style={{ display: "block" }}>
            Encrypted. Lets saved voices move to a new voice model without naming people again.
          </span>
        </span>
      </label>
      <label class="field">
        Cloud summary service address
        <span class="hint">Only used when Summary is set to the cloud service. It receives transcript text and speaker names, never audio or voice profiles.</span>
        <input type="url" placeholder="https://" value={props.s.cloudSummaryEndpoint} onChange={(e) => void props.update({ cloudSummaryEndpoint: e.currentTarget.value.trim() })} />
      </label>
      <label class="check">
        <input type="checkbox" checked={props.s.diagnosticsIncludeContent} onChange={(e) => void props.update({ diagnosticsIncludeContent: e.currentTarget.checked })} />
        <span>Include transcript text in diagnostics</span>
      </label>
    </section>
  );
}
