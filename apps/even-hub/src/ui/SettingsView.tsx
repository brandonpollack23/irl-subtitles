import { createMemo, createSignal, For, onSettled, Show } from "solid-js";
import {
  describeDataFlow,
  errorMessage,
  LANGUAGES,
  parseWav,
  repairSelection,
  resampleLinear,
  resolveSelection,
  SERVICE_NAMES,
  SERVICE_SECRETS,
  serviceOption,
  tierForSelection,
  type CloudConsentKey,
  type ModelCatalogEntry,
  type ModelRole,
  type ModelSelection,
  type RoleOption,
  type RoleResolution,
  type SecretName,
  type Settings,
} from "@irl/domain";
import { availabilityOnDevice, catalogEntry, clearModelCache, defaultSelection, embeddingSpaceOf, entriesForRole, firstRunBenchmark, ROLE_KEYS, supportsLanguage, type LoadProgress } from "@irl/provider-local";
import { testSonioxKey } from "@irl/provider-soniox";
import { testSpeechmaticsKey } from "@irl/provider-speechmatics";
import { LOCALE_NAMES, resolveLocale, t } from "@irl/i18n";
import { app, bumpData, Button, bytes, toast, useData, useSettings } from "./lib";

const ROLE_TITLES: Record<ModelRole, { title: string; hint: string }> = {
  vad: { title: "Speech detection", hint: "Finds speech so silence isn't transcribed." },
  "stt-live": { title: "Live captions", hint: "Captions while you record. Off saves battery; the transcript is made after you stop." },
  "stt-final": { title: "Final transcript", hint: "Transcribes again after you stop, with word timing and speakers." },
  "speaker-embedding": { title: "Voice model", hint: "Recognizes saved voices (and tells speakers apart on this phone). Changing it re-enrolls saved voices." },
  summary: { title: "Summary", hint: "Writes the summary after you stop." },
};

export function SettingsView() {
  const [s, update] = useSettings();
  const keys = useKeys();
  return (
    <>
      <h1>Settings</h1>
      <DisplaySection s={s()} update={update} />
      <RecordingSection s={s()} update={update} keys={keys.value() ?? {}} />
      <ServicesSection s={s()} update={update} keys={keys.value() ?? {}} />
      <ModelsSection s={s()} update={update} keys={keys.value() ?? {}} />
      <PrivacySection s={s()} update={update} />
      <div class="panel">
        <h2>Diagnostics</h2>
        <p class="small muted">Device capabilities, storage, logs, and speaker recognition calibration and tuning.</p>
        <div class="row">
          <a class="btn" href="#/diagnostics">
            Diagnostics
          </a>
          <a class="btn" href="#/evaluation">
            Tune voice recognition
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

function DisplaySection(props: SectionProps) {
  return (
    <section class="panel">
      <label class="field">
        {t().display.title}
        <span class="hint">{t().display.hint}</span>
        <select value={props.s.uiLanguage} onChange={(e) => void props.update({ uiLanguage: e.currentTarget.value as Settings["uiLanguage"] })}>
          <option value="system">{t().display.system(LOCALE_NAMES[resolveLocale("system")])}</option>
          <option value="en" lang="en">{LOCALE_NAMES.en}</option>
          <option value="ja" lang="ja">{LOCALE_NAMES.ja}</option>
        </select>
      </label>
    </section>
  );
}

function RecordingSection(props: SectionProps & { keys: Partial<Record<SecretName, boolean>> }) {
  const [wavName, setWavName] = createSignal(app().devWav?.name ?? null);
  return (
    <section class="panel">
      <h2>Recording</h2>
      <p class="small muted">Changes apply to your next recording.</p>
      <label class="field">
        Language
        <select value={props.s.language} onChange={(e) => void changeLanguage(props, e.currentTarget.value, props.keys)}>
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
      <HideOwnSpeech s={props.s} update={props.update} />
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

function HideOwnSpeech(props: SectionProps) {
  const me = useData(
    () => props.s.selfPersonId,
    async (id) => (id ? await app().storage.repo.getPerson(id) : null),
  );
  return (
    <label class="check">
      <input type="checkbox" checked={props.s.hideOwnSpeechOnGlasses} onChange={(e) => void props.update({ hideOwnSpeechOnGlasses: e.currentTarget.checked })} />
      <span>
        Hide my speech on the glasses
        <span class="small muted" style={{ display: "block" }}>
          {me.value()
            ? `Leaves out what ${me.value()!.fullName} says once their voice is recognized. The phone transcript keeps everything.`
            : me.loading()
              ? ""
              : "Open yourself in People and check \"This is me\" first. The phone transcript keeps everything."}
        </span>
      </span>
    </label>
  );
}

/** Which service keys are saved; reloaded after Save/Remove so the pickers' reasons update. */
const [keysVersion, setKeysVersion] = createSignal(0, { ownedWrite: true });
function useKeys() {
  return useData(
    () => keysVersion(),
    async () => {
      const out: Partial<Record<SecretName, boolean>> = {};
      for (const name of Object.values(SERVICE_SECRETS)) out[name] = await app().storage.secrets.has(name);
      return out;
    },
  );
}

/** A local-only selection for the language: where cloud options fall back when they can't run. */
function localFallback(language: string): ModelSelection {
  return defaultSelection(language);
}

async function changeLanguage(props: SectionProps, language: string, keys: Partial<Record<SecretName, boolean>>) {
  const patch: Partial<Settings> = { language };
  let models = { ...props.s.models };
  // Monolingual live models follow the language; pick the preferred one that supports it.
  const live = catalogEntry(models.sttLive);
  if (live && !supportsLanguage(live, language)) {
    const next = entriesForRole("stt-live").find((e) => e.availability.status === "available" && supportsLanguage(e, language));
    models = { ...models, sttLive: next?.id ?? "off" };
    toast(next ? `Live captions switched to ${next.displayName}` : "No live caption model for that language; captions will be made after you stop");
  }
  // Cloud options that support the language stay; the rest fall back to this phone.
  const repaired = repairSelection(models, { language, hasSecret: (n) => !!keys[n] }, localFallback(language));
  if (repaired.reset.length) toast(`${repaired.reset.map((r) => ROLE_TITLES[r].title).join(", ")} switched to this phone: the cloud option doesn't support that language`);
  if (repaired.reset.length || models !== props.s.models) patch.models = repaired.models;
  await props.update(patch);
}

interface ServiceInfo {
  service: "soniox" | "speechmatics";
  privacy: string;
  test: ((key: string, s: Settings) => Promise<{ ok: boolean; message: string }>) | null;
}

const SERVICES: readonly ServiceInfo[] = [
  {
    service: "soniox",
    privacy: "Receives audio only for the options you pick below (live captions, or the final transcript after you stop). Voice profiles stay on this phone.",
    test: (k) => testSonioxKey(k),
  },
  {
    service: "speechmatics",
    privacy: "Receives audio only for the options you pick below. With voice identification it also keeps voiceprints of the people you name.",
    test: (k, s) => testSpeechmaticsKey(k, s.speechmaticsRegion),
  },
];

function ServicesSection(props: SectionProps & { keys: Partial<Record<SecretName, boolean>> }) {
  return (
    <section class="panel">
      <h2>Services</h2>
      <p class="small muted">
        API keys for cloud services. A saved key only makes its options selectable below; nothing is sent until you pick one. Keys are encrypted on this phone and never shown again.
      </p>
      <For each={SERVICES}>{(info) => <ServiceKey info={info} s={props.s} update={props.update} saved={!!props.keys[SERVICE_SECRETS[info.service]]} keys={props.keys} />}</For>
    </section>
  );
}

function ServiceKey(props: SectionProps & { info: ServiceInfo; saved: boolean; keys: Partial<Record<SecretName, boolean>> }) {
  const [key, setKey] = createSignal("");
  const name = () => SERVICE_NAMES[props.info.service];
  const secret = () => SERVICE_SECRETS[props.info.service];
  return (
    <div class="stack" style={{ gap: "6px" }}>
      <h3>{name()}</h3>
      <p class="small muted">{props.info.privacy}</p>
      <Show when={props.saved} fallback={<p class="small muted">No key saved.</p>}>
        <p class="small">A key is saved.</p>
      </Show>
      <Show when={props.info.service === "speechmatics"}>
        <label class="field">
          Region
          <span class="hint">Where Speechmatics processes audio, live and after you stop. Use the region your key was created in.</span>
          <select value={props.s.speechmaticsRegion} onChange={(e) => void props.update({ speechmaticsRegion: e.currentTarget.value as Settings["speechmaticsRegion"] })}>
            <option value="eu">Europe</option>
            <option value="us">United States</option>
            <option value="au">Australia</option>
          </select>
        </label>
      </Show>
      <label class="field">
        {props.saved ? "Replace key" : "Key"}
        <input type="password" autocomplete="off" spellcheck={false} value={key()} onInput={(e) => setKey(e.currentTarget.value)} />
      </label>
      <div class="row">
        <Button
          label={props.saved ? "Replace" : "Save"}
          kind="primary"
          disabled={!key().trim()}
          onClick={async () => {
            await app().storage.secrets.put(secret(), key().trim());
            setKey("");
            setKeysVersion((v) => v + 1);
            toast(`${name()} key saved`);
          }}
        />
        <Show when={props.info.test}>
          {(test) => (
            <Button
              label="Test"
              busyLabel="Testing…"
              disabled={!key().trim() && !props.saved}
              onClick={async () => {
                const k = key().trim() || (await app().storage.secrets.get(secret()));
                if (!k) return;
                toast((await test()(k, props.s)).message);
              }}
            />
          )}
        </Show>
        <Show when={props.saved}>
          <Button
            label="Remove"
            kind="danger"
            onClick={async () => {
              await app().storage.secrets.delete(secret());
              setKeysVersion((v) => v + 1);
              const repaired = repairSelection(props.s.models, { language: props.s.language, hasSecret: (n) => n !== secret() && !!props.keys[n] }, localFallback(props.s.language));
              if (repaired.reset.length) await props.update({ models: repaired.models });
              const moved = repaired.reset.map((r) => ROLE_TITLES[r].title);
              toast(`${name()} key removed.${moved.length ? ` Switched to this phone: ${moved.join(", ")}.` : ""} Existing transcripts are unchanged.`);
            }}
          />
        </Show>
      </div>
    </div>
  );
}

/** Asks once per service before a cloud option first sends it anything; returns whether to go ahead. */
function consentFor(s: Settings, id: string): { key: CloudConsentKey; text: string }[] {
  const o = serviceOption(id);
  if (!o) return [];
  const out: { key: CloudConsentKey; text: string }[] = [];
  if (o.sends !== "transcript" && !s.cloudConsent[o.service as CloudConsentKey]) {
    out.push({ key: o.service as CloudConsentKey, text: `${SERVICE_NAMES[o.service]} will receive the audio of your conversations for this option (the people around you too). It's sent over an encrypted connection and processed under ${SERVICE_NAMES[o.service]}'s terms.` });
  }
  if (o.sends === "audio-and-voiceprints" && !s.cloudConsent["speechmatics-voiceprints"]) {
    out.push({ key: "speechmatics-voiceprints", text: "Speechmatics will create voiceprints (speaker identifiers) of the people you name and recognize them in later conversations. The identifiers are stored by Speechmatics for your account and on this phone; Forget voice removes them from this phone so they're never sent again. Only ask for this with the consent of the people you name." });
  }
  if (o.sends === "transcript" && !s.cloudConsent["summary-endpoint"]) {
    out.push({ key: "summary-endpoint", text: "Transcript text and speaker names will be sent to your cloud summary service after each conversation. Audio and voice profiles never are." });
  }
  return out;
}

function ModelsSection(props: SectionProps & { keys: Partial<Record<SecretName, boolean>> }) {
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

  const resolved = createMemo(() =>
    resolveSelection(props.s.models, {
      language: props.s.language,
      hasSecret: (n) => !!props.keys[n],
      summaryEndpoint: !!props.s.cloudSummaryEndpoint,
      local: (role) =>
        entriesForRole(role).map((e) => {
          const a = availabilityOnDevice(e, app().caps);
          return { id: e.id, label: describeEntry(e, props.s.language, downloaded.value() ?? {}), disabled: a.status === "unavailable" ? a.reason : !supportsLanguage(e, props.s.language) ? "Other language" : null };
        }),
    }),
  );

  const setModel = async (role: ModelRole, id: string) => {
    const key = ROLE_KEYS[role];
    const asks = consentFor(props.s, id);
    if (asks.length) {
      if (!confirm(`${asks.map((a) => a.text).join("\n\n")}\n\nContinue?`)) {
        bumpData();
        return;
      }
      const now = new Date().toISOString();
      await props.update({ cloudConsent: { ...props.s.cloudConsent, ...Object.fromEntries(asks.map((a) => [a.key, now])) } });
    }
    let models = { ...props.s.models, [key]: id } as ModelSelection;
    // Leaving Speechmatics live captions or final transcript can strand voice ID, which needs one of them.
    const repaired = repairSelection(models, { language: props.s.language, hasSecret: (n) => !!props.keys[n] }, localFallback(props.s.language));
    const stranded = repaired.reset.filter((r) => r !== role);
    if (stranded.length) {
      models = repaired.models;
      toast(`${stranded.map((r) => ROLE_TITLES[r].title).join(", ")} switched to this phone: it needs the option you changed`);
    }
    if (role === "speaker-embedding" && id !== props.s.models.speakerEmbedding) {
      const profiles = await app().storage.repo.listProfiles();
      const toService = !!serviceOption(id);
      const question = toService
        ? "Speechmatics will recognize saved voices instead of this phone. Saved voices are enrolled with Speechmatics by sending their kept audio clips; people without clips need to be named again before they're recognized. Continue?"
        : "Switching the voice model changes how voices are compared. Saved voices are re-enrolled from their kept audio clips; people without clips need to be named again before they're recognized. Continue?";
      if (profiles.length && !confirm(question)) {
        bumpData();
        return;
      }
      await props.update({ models });
      if (profiles.length) {
        toast(toService ? "Enrolling saved voices with Speechmatics…" : "Re-enrolling saved voices…");
        const r = await app().identity.migrateEmbeddingSpace(id, embeddingSpaceOf(id));
        toast(`${r.reembedded} voice${r.reembedded === 1 ? "" : "s"} re-enrolled, ${r.needsReenrollment} need${r.needsReenrollment === 1 ? "s" : ""} naming again`);
      }
      return;
    }
    await props.update({ models });
    if (role === "stt-final" || role === "summary") toast("Applies to new recordings. Open a conversation to reprocess it.");
  };

  /** Local models the selection runs: cloud options and roles they provide need no download. */
  const localIds = () => [...new Set(Object.values(resolved()).map((r) => r.effective))].filter((id) => catalogEntry(id));

  const downloadSelected = async () => {
    const e = app().engines;
    // Download only: loading models here held several copies of each one's weights in memory at once.
    const ids: string[] = [];
    for (const id of localIds()) if (!(await e.isDownloaded(id))) ids.push(id);
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
    // The best local picks only replace local, unlocked roles; cloud choices stay.
    const models = { ...props.s.models };
    for (const [key, id] of Object.entries(report.selection) as [keyof ModelSelection, string][]) {
      const role = (Object.keys(ROLE_KEYS) as ModelRole[]).find((r) => ROLE_KEYS[r] === key)!;
      if (id === undefined || serviceOption(models[key]) || resolved()[role].locked) continue;
      (models as Record<string, string>)[key] = id;
    }
    await props.update({ models, firstRunBenchmarkAt: new Date().toISOString() });
    setVersion((v) => v + 1);
    toast(`Measured ${report.results.length} model runs. Best options selected.`);
  };

  const tier = () => tierForSelection(props.s.models);

  return (
    <section class="panel">
      <h2>Models</h2>
      <p class="small" role="status">
        <strong>{describeDataFlow(props.s.models)}</strong>
      </p>
      <p class="small muted">
        Performance: {tier() === "battery-saver" ? "Battery saver (no live captions)" : "Live captions"}. Models on this phone download once, are checked against pinned fingerprints, and stay on the phone.
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
        {(role) => <ModelPicker role={role} resolution={resolved()[role]} progress={progress()} onChange={(id) => void setModel(role, id)} />}
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

function describeEntry(e: ModelCatalogEntry, language: string, downloaded: Record<string, boolean>): string {
  const a = availabilityOnDevice(e, app().caps);
  const parts = [e.displayName, bytes(e.downloadBytes)];
  if (a.status === "unavailable") parts.push("unavailable");
  else if (!supportsLanguage(e, language)) parts.push("other language");
  else if (downloaded[e.id]) parts.push("downloaded");
  const b = app().engines.benchmarks.filter((x) => x.modelId === e.id && x.ok);
  if (b.length) parts.push(b.map((x) => (x.realTimeFactor !== undefined ? `${x.target} ${x.realTimeFactor.toFixed(2)}× real time` : `${Math.round(x.tokensPerSecond ?? 0)} tok/s`)).join(", "));
  return parts.join(" · ");
}

function ModelPicker(props: { role: ModelRole; resolution: RoleResolution; progress: Record<string, LoadProgress>; onChange: (id: string) => void }) {
  const r = () => props.resolution;
  const group = (g: RoleOption["group"]) => r().options.filter((o) => o.group === g);
  const label = (o: RoleOption) => (o.disabled && o.group === "cloud" ? `${o.label} — ${o.disabled}` : o.label);
  const note = () => serviceOption(r().selected)?.notes ?? catalogEntry(r().selected)?.notes;
  const p = () => props.progress[r().selected];
  return (
    <div class="stack" style={{ gap: "4px" }}>
      <label class="field">
        {ROLE_TITLES[props.role].title}
        <span class="hint">{ROLE_TITLES[props.role].hint}</span>
        <Show
          when={r().locked}
          fallback={
            <select value={r().selected} onChange={(e) => props.onChange(e.currentTarget.value)}>
              <optgroup label="On this phone">
                <For each={[...group("local"), ...group("special")]}>
                  {(o) => (
                    <option value={o.id} disabled={!!o.disabled && o.id !== r().selected}>
                      {label(o)}
                    </option>
                  )}
                </For>
              </optgroup>
              <Show when={group("cloud").length}>
                <optgroup label="Cloud">
                  <For each={group("cloud")}>
                    {(o) => (
                      <option value={o.id} disabled={!!o.disabled && o.id !== r().selected}>
                        {label(o)}
                      </option>
                    )}
                  </For>
                </optgroup>
              </Show>
            </select>
          }
        >
          {(lock) => (
            <select disabled aria-describedby={`lock-${props.role}`}>
              <option>{lock().label}</option>
            </select>
          )}
        </Show>
      </label>
      <Show when={r().locked}>{(lock) => <span class="small muted" id={`lock-${props.role}`}>{lock().reason}</span>}</Show>
      <Show when={!r().locked && r().invalid}>
        <span class="small warn">Can't use the selected option: {r().invalid}.</span>
      </Show>
      <Show when={!r().locked}>
        <For each={group("local").filter((o) => o.disabled && o.disabled !== "Other language")}>
          {(o) => (
            <span class="small muted">
              {catalogEntry(o.id)?.displayName ?? o.label}: {o.disabled}
            </span>
          )}
        </For>
        <Show when={note()}>
          <span class="small muted">{note()}</span>
        </Show>
      </Show>
      <Show when={!r().locked && p() && p()!.status !== "ready"}>
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
