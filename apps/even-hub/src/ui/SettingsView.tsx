import { createMemo, createSignal, For, onSettled, Show } from "solid-js";
import {
  dataFlow,
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
  type KeyTestResult,
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
import { describe, fmt, LOCALE_NAMES, resolveLocale, t } from "@irl/i18n";
import { app, bumpData, Button, bytes, toast, useData, useSettings } from "./lib";

const ROLES: readonly ModelRole[] = ["vad", "stt-live", "stt-final", "speaker-embedding", "summary"];
const roleTitles = (roles: readonly ModelRole[]) => fmt().list(roles.map((r) => t().settings.roles[r].title));

export function SettingsView() {
  const [s, update] = useSettings();
  const keys = useKeys();
  return (
    <>
      <h1>{t().settings.title}</h1>
      <DisplaySection s={s()} update={update} />
      <RecordingSection s={s()} update={update} keys={keys.value() ?? {}} />
      <ServicesSection s={s()} update={update} keys={keys.value() ?? {}} />
      <ModelsSection s={s()} update={update} keys={keys.value() ?? {}} />
      <PrivacySection s={s()} update={update} />
      <div class="panel">
        <h2>{t().settings.diagnosticsTitle}</h2>
        <p class="small muted">{t().settings.diagnosticsIntro}</p>
        <div class="row">
          <a class="btn" href="#/diagnostics">
            {t().settings.diagnosticsTitle}
          </a>
          <a class="btn" href="#/evaluation">
            {t().settings.tuneVoices}
          </a>
        </div>
      </div>
      <p class="small muted">
        {t().settings.version(__APP_VERSION__, __BUILD_ID__.slice(0, 16))}
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
      <h2>{t().settings.recordingTitle}</h2>
      <p class="small muted">{t().settings.appliesNext}</p>
      <label class="field">
        {t().settings.language}
        <select value={props.s.language} onChange={(e) => void changeLanguage(props, e.currentTarget.value, props.keys)}>
          <For each={LANGUAGES}>{(l) => <option value={l.code}>{l.code === "auto" ? t().languages.auto : fmt().language(l.code)}</option>}</For>
        </select>
      </label>
      <label class="check">
        <input type="checkbox" checked={props.s.persistAudio} onChange={(e) => void props.update({ persistAudio: e.currentTarget.checked })} />
        <span>
          {t().settings.saveAudio}
          <span class="small muted" style={{ display: "block" }}>
            {t().settings.saveAudioHint}
          </span>
        </span>
      </label>
      <label class="check">
        <input type="checkbox" checked={props.s.showCaptionsOnGlasses} onChange={(e) => void props.update({ showCaptionsOnGlasses: e.currentTarget.checked })} />
        <span>{t().settings.showCaptions}</span>
      </label>
      <HideOwnSpeech s={props.s} update={props.update} />
      <label class="field">
        {t().settings.microphone}
        <select value={props.s.captureSource} onChange={(e) => void props.update({ captureSource: e.currentTarget.value as Settings["captureSource"] })}>
          <option value="glasses">{t().settings.micGlasses}</option>
          <option value="phone-mic">{t().settings.micPhone}</option>
          <option value="wav-file">{t().settings.micFile}</option>
        </select>
      </label>
      <Show when={props.s.captureSource === "wav-file"}>
        <label class="field">
          {t().settings.testFile} <span class="hint">{t().settings.testFileHint}</span>
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
                toast(t().settings.fileUnusable(errorMessage(err)));
              }
            }}
          />
          <Show when={wavName()}>
            <span class="hint">{t().settings.usingFile(wavName()!)}</span>
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
        {t().settings.hideOwn}
        <span class="small muted" style={{ display: "block" }}>
          {me.value() ? t().settings.hideOwnMe(me.value()!.fullName) : me.loading() ? "" : t().settings.hideOwnNone}
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
    toast(next ? t().settings.liveSwitched(next.displayName) : t().settings.noLiveModel);
  }
  // Cloud options that support the language stay; the rest fall back to this phone.
  const repaired = repairSelection(models, { language, hasSecret: (n) => !!keys[n] }, localFallback(language));
  if (repaired.reset.length) toast(t().settings.languageToPhone(roleTitles(repaired.reset)));
  if (repaired.reset.length || models !== props.s.models) patch.models = repaired.models;
  await props.update(patch);
}

interface ServiceInfo {
  service: "soniox" | "speechmatics";
  privacy: () => string;
  test: ((key: string, s: Settings) => Promise<KeyTestResult>) | null;
}

const SERVICES: readonly ServiceInfo[] = [
  {
    service: "soniox",
    privacy: () => t().settings.privacySoniox,
    test: (k) => testSonioxKey(k),
  },
  {
    service: "speechmatics",
    privacy: () => t().settings.privacySpeechmatics,
    test: (k, s) => testSpeechmaticsKey(k, s.speechmaticsRegion),
  },
];

function ServicesSection(props: SectionProps & { keys: Partial<Record<SecretName, boolean>> }) {
  return (
    <section class="panel">
      <h2>{t().settings.servicesTitle}</h2>
      <p class="small muted">{t().settings.servicesIntro}</p>
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
      <p class="small muted">{props.info.privacy()}</p>
      <Show when={props.saved} fallback={<p class="small muted">{t().settings.noKey}</p>}>
        <p class="small">{t().settings.keySaved}</p>
      </Show>
      <Show when={props.info.service === "speechmatics"}>
        <label class="field">
          {t().settings.region}
          <span class="hint">{t().settings.regionHint}</span>
          <select value={props.s.speechmaticsRegion} onChange={(e) => void props.update({ speechmaticsRegion: e.currentTarget.value as Settings["speechmaticsRegion"] })}>
            <option value="eu">{t().settings.regions.eu}</option>
            <option value="us">{t().settings.regions.us}</option>
            <option value="au">{t().settings.regions.au}</option>
          </select>
        </label>
      </Show>
      <label class="field">
        {props.saved ? t().settings.replaceKey : t().settings.key}
        <input type="password" autocomplete="off" spellcheck={false} value={key()} onInput={(e) => setKey(e.currentTarget.value)} />
      </label>
      <div class="row">
        <Button
          label={props.saved ? t().settings.replace : t().common.save}
          kind="primary"
          disabled={!key().trim()}
          onClick={async () => {
            await app().storage.secrets.put(secret(), key().trim());
            setKey("");
            setKeysVersion((v) => v + 1);
            toast(t().settings.keySavedToast(name()));
          }}
        />
        <Show when={props.info.test}>
          {(test) => (
            <Button
              label={t().settings.test}
              busyLabel={t().settings.testing}
              disabled={!key().trim() && !props.saved}
              onClick={async () => {
                const k = key().trim() || (await app().storage.secrets.get(secret()));
                if (!k) return;
                toast(describe().keyTest(await test()(k, props.s), props.info.service));
              }}
            />
          )}
        </Show>
        <Show when={props.saved}>
          <Button
            label={t().settings.remove}
            kind="danger"
            onClick={async () => {
              await app().storage.secrets.delete(secret());
              setKeysVersion((v) => v + 1);
              const repaired = repairSelection(props.s.models, { language: props.s.language, hasSecret: (n) => n !== secret() && !!props.keys[n] }, localFallback(props.s.language));
              if (repaired.reset.length) await props.update({ models: repaired.models });
              toast(`${t().settings.keyRemoved(name())}${repaired.reset.length ? t().settings.movedToPhone(roleTitles(repaired.reset)) : ""}${t().settings.transcriptsUnchanged}`);
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
    out.push({ key: o.service as CloudConsentKey, text: t().settings.consentAudio(SERVICE_NAMES[o.service]) });
  }
  if (o.sends === "audio-and-voiceprints" && !s.cloudConsent["speechmatics-voiceprints"]) {
    out.push({ key: "speechmatics-voiceprints", text: t().settings.consentVoiceprints });
  }
  if (o.sends === "transcript" && !s.cloudConsent["summary-endpoint"]) {
    out.push({ key: "summary-endpoint", text: t().settings.consentSummary });
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
      for (const role of ROLES) for (const e of entriesForRole(role)) out[e.id] = await app().engines.isDownloaded(e.id);
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
          return { id: e.id, label: describeEntry(e, props.s.language, downloaded.value() ?? {}), disabled: a.status === "unavailable" ? { code: "device", detail: a.reason } : !supportsLanguage(e, props.s.language) ? { code: "other-language" } : null };
        }),
    }),
  );

  const setModel = async (role: ModelRole, id: string) => {
    const key = ROLE_KEYS[role];
    const asks = consentFor(props.s, id);
    if (asks.length) {
      if (!confirm(`${asks.map((a) => a.text).join("\n\n")}\n\n${t().settings.consentContinue}`)) {
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
      toast(t().settings.strandedToPhone(roleTitles(stranded)));
    }
    if (role === "speaker-embedding" && id !== props.s.models.speakerEmbedding) {
      const profiles = await app().storage.repo.listProfiles();
      const toService = !!serviceOption(id);
      const question = toService ? t().settings.voiceToService : t().settings.voiceSwitch;
      if (profiles.length && !confirm(question)) {
        bumpData();
        return;
      }
      await props.update({ models });
      if (profiles.length) {
        toast(toService ? t().settings.enrollingService : t().settings.reenrolling);
        const r = await app().identity.migrateEmbeddingSpace(id, embeddingSpaceOf(id));
        toast(t().settings.reenrolled(r.reembedded, r.needsReenrollment));
      }
      return;
    }
    await props.update({ models });
    if (role === "stt-final" || role === "summary") toast(t().settings.appliesToNew);
  };

  /** Local models the selection runs: cloud options and roles they provide need no download. */
  const localIds = () => [...new Set(Object.values(resolved()).map((r) => r.effective))].filter((id) => catalogEntry(id));

  const downloadSelected = async () => {
    const e = app().engines;
    // Download only: loading models here held several copies of each one's weights in memory at once.
    const ids: string[] = [];
    for (const id of localIds()) if (!(await e.isDownloaded(id))) ids.push(id);
    if (!ids.length) {
      toast(t().settings.alreadyDownloaded);
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
    toast(failures.length ? t().settings.downloadFailed(failures.join("; ")) : t().settings.downloadDone);
  };

  const clearCache = async () => {
    if (!confirm(t().settings.clearConfirm)) return;
    await app().engines.release(["audio", "asr", "llm", "stream"]);
    await clearModelCache();
    app().engines.forgetDownloads();
    setProgress({});
    setVersion((v) => v + 1);
    toast(t().settings.cacheCleared);
  };

  const benchmark = async () => {
    const bytesWav = new Uint8Array(await (await fetch("/fixtures/jfk.wav")).arrayBuffer());
    const wav = parseWav(bytesWav);
    const clip = resampleLinear(wav.samples, wav.sampleRate);
    const report = await firstRunBenchmark(app().engines, clip, props.s.language, (note) => setBenchNote(t().settings.measuringModel(note)));
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
    toast(t().settings.measured(report.results.length));
  };

  const tier = () => tierForSelection(props.s.models);

  return (
    <section class="panel">
      <h2>{t().settings.modelsTitle}</h2>
      <p class="small" role="status">
        <strong>{describe().dataFlow(dataFlow(props.s.models))}</strong>
      </p>
      <p class="small muted">
        {t().settings.performance(tier() === "battery-saver" ? t().settings.batterySaver : t().settings.liveCaptions)} {t().settings.modelsIntro}
      </p>
      <label class="field">
        {t().settings.power}
        <select value={props.s.powerPolicy} onChange={(e) => void props.update({ powerPolicy: e.currentTarget.value as Settings["powerPolicy"] })}>
          <option value="low-power">{t().settings.powerLow}</option>
          <option value="balanced">{t().settings.powerBalanced}</option>
          <option value="fast">{t().settings.powerFast}</option>
        </select>
      </label>
      <For each={ROLES}>
        {(role) => <ModelPicker role={role} resolution={resolved()[role]} progress={progress()} onChange={(id) => void setModel(role, id)} />}
      </For>
      <div class="row">
        <Button label={t().settings.download} busyLabel={t().settings.downloading} kind="primary" onClick={downloadSelected} />
        <Button label={props.s.firstRunBenchmarkAt ? t().settings.measureAgain : t().settings.measure} busyLabel={t().settings.measuring} onClick={benchmark} />
        <Button label={t().settings.clearCache} busyLabel={t().settings.clearing} kind="danger" onClick={clearCache} />
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
    if (p?.status === "downloading" && p.loaded !== undefined) return t().settings.bytesOf(bytes(p.loaded), bytes(expectedBytes(p)));
    return p?.status === "ready" ? t().settings.verified : t().settings.checking;
  };
  return (
    <div class="stack" style={{ gap: "6px" }}>
      <div
        class="progress large"
        role="progressbar"
        aria-label={t().settings.downloadLabel}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(props.run.percent)}
      >
        <div style={{ width: `${props.run.percent}%` }} />
      </div>
      <div class="spread small">
        <span>
          {name()} <span class="muted">{t().settings.downloadCount(props.run.index + 1, props.run.ids.length)} · {detail()}</span>
        </span>
        <span class="num">{fmt().percent(props.run.percent / 100)}</span>
      </div>
    </div>
  );
}

function describeEntry(e: ModelCatalogEntry, language: string, downloaded: Record<string, boolean>): string {
  const a = availabilityOnDevice(e, app().caps);
  const parts = [e.displayName, bytes(e.downloadBytes)];
  if (a.status === "unavailable") parts.push(t().settings.entryUnavailable);
  else if (!supportsLanguage(e, language)) parts.push(t().settings.entryOtherLanguage);
  else if (downloaded[e.id]) parts.push(t().settings.entryDownloaded);
  const b = app().engines.benchmarks.filter((x) => x.modelId === e.id && x.ok);
  if (b.length) parts.push(b.map((x) => (x.realTimeFactor !== undefined ? t().settings.realTime(x.target, fmt().number(x.realTimeFactor, 2)) : t().settings.tokensPerSecond(fmt().number(x.tokensPerSecond ?? 0)))).join(", "));
  return parts.join(" · ");
}

function ModelPicker(props: { role: ModelRole; resolution: RoleResolution; progress: Record<string, LoadProgress>; onChange: (id: string) => void }) {
  const r = () => props.resolution;
  const group = (g: RoleOption["group"]) => r().options.filter((o) => o.group === g);
  const label = (o: RoleOption) => {
    const name = describe().optionName(o, props.role);
    return o.disabled && o.group === "cloud" ? `${name} — ${describe().blocker(o.disabled)}` : name;
  };
  const note = () => {
    const cloud = serviceOption(r().selected);
    return cloud ? describe().serviceOptionNote(cloud) : catalogEntry(r().selected)?.notes;
  };
  const p = () => props.progress[r().selected];
  return (
    <div class="stack" style={{ gap: "4px" }}>
      <label class="field">
        {t().settings.roles[props.role].title}
        <span class="hint">{t().settings.roles[props.role].hint}</span>
        <Show
          when={r().locked}
          fallback={
            <select value={r().selected} onChange={(e) => props.onChange(e.currentTarget.value)}>
              <optgroup label={t().settings.groupPhone}>
                <For each={[...group("local"), ...group("special")]}>
                  {(o) => (
                    <option value={o.id} disabled={!!o.disabled && o.id !== r().selected}>
                      {label(o)}
                    </option>
                  )}
                </For>
              </optgroup>
              <Show when={group("cloud").length}>
                <optgroup label={t().settings.groupCloud}>
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
              <option>{describe().lock(lock(), props.role).label}</option>
            </select>
          )}
        </Show>
      </label>
      <Show when={r().locked}>{(lock) => <span class="small muted" id={`lock-${props.role}`}>{describe().lock(lock(), props.role).reason}</span>}</Show>
      <Show when={!r().locked && r().invalid}>
        <span class="small warn">{t().settings.cantUse(describe().blocker(r().invalid!))}</span>
      </Show>
      <Show when={!r().locked}>
        <For each={group("local").filter((o) => o.disabled && o.disabled.code !== "other-language")}>
          {(o) => (
            <span class="small muted">
              {catalogEntry(o.id)?.displayName ?? o.label}: {describe().blocker(o.disabled!)}
            </span>
          )}
        </For>
        <Show when={note()}>
          <span class="small muted">{note()}</span>
        </Show>
      </Show>
      <Show when={!r().locked && p() && p()!.status !== "ready"}>
        <span class={["small", { error: p()!.status === "failed" }]}>
          {p()!.status === "downloading" && p()!.total
            ? t().settings.downloadingPercent(fmt().percent((p()!.loaded ?? 0) / p()!.total!))
            : p()!.status === "failed"
              ? t().settings.loadFailed(p()!.error ?? "")
              : t().settings.loadingModel}
        </span>
      </Show>
    </div>
  );
}

function PrivacySection(props: SectionProps) {
  return (
    <section class="panel">
      <h2>{t().settings.privacyTitle}</h2>
      <label class="check">
        <input
          type="checkbox"
          checked={!props.s.persistAudio || props.s.deleteAudioAfterProcessing}
          disabled={!props.s.persistAudio}
          onChange={(e) => void props.update({ deleteAudioAfterProcessing: e.currentTarget.checked })}
        />
        <span>
          {t().settings.deleteAfter}
          <span class="small muted" style={{ display: "block" }}>
            {props.s.persistAudio ? t().settings.deleteAfterHint : t().settings.deleteAfterForced}
          </span>
        </span>
      </label>
      <label class="check">
        <input type="checkbox" checked={props.s.learnVoiceDefault} onChange={(e) => void props.update({ learnVoiceDefault: e.currentTarget.checked })} />
        <span>{t().settings.learnDefault}</span>
      </label>
      <label class="check">
        <input type="checkbox" checked={props.s.keepVoiceClips} onChange={(e) => void props.update({ keepVoiceClips: e.currentTarget.checked })} />
        <span>
          {t().settings.keepClips}
          <span class="small muted" style={{ display: "block" }}>
            {t().settings.keepClipsHint}
          </span>
        </span>
      </label>
      <label class="field">
        {t().settings.summaryAddress}
        <span class="hint">{t().settings.summaryAddressHint}</span>
        <input type="url" placeholder="https://" value={props.s.cloudSummaryEndpoint} onChange={(e) => void props.update({ cloudSummaryEndpoint: e.currentTarget.value.trim() })} />
      </label>
      <label class="check">
        <input type="checkbox" checked={props.s.diagnosticsIncludeContent} onChange={(e) => void props.update({ diagnosticsIncludeContent: e.currentTarget.checked })} />
        <span>{t().settings.includeTranscript}</span>
      </label>
    </section>
  );
}
