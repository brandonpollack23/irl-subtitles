import { createSignal, For, Match, Show, Switch } from "solid-js";
import { formatClock, nowIso } from "@irl/domain";
import { t } from "@irl/i18n";
import { deleteRecording } from "@irl/pipeline";
import { DevPlatformMarker } from "./DevPlatformMarker";
import { DiagnosticsView } from "./DiagnosticsView";
import { EvaluationView } from "./EvaluationView";
import { HistoryView } from "./HistoryView";
import { app, bumpData, Button, go, Rich, route, ToastHost, useData } from "./lib";
import { LiveView } from "./LiveView";
import { liveSnapshot } from "./model";
import { PeopleView, PersonView } from "./PeopleView";
import { RecordingView } from "./RecordingView";
import { SettingsView } from "./SettingsView";

function Nav() {
  const current = () => {
    const r = route().name;
    return r === "people" || r === "person" ? "people" : r === "settings" || r === "diagnostics" || r === "evaluation" ? "settings" : "history";
  };
  return (
    <nav class="nav" aria-label={t().nav.label}>
      <a href="#/" aria-current={current() === "history" ? "page" : undefined}>
        {t().nav.conversations}
      </a>
      <a href="#/people" aria-current={current() === "people" ? "page" : undefined}>
        {t().nav.people}
      </a>
      <a href="#/settings" aria-current={current() === "settings" ? "page" : undefined}>
        {t().nav.settings}
      </a>
    </nav>
  );
}

/** Persistent phone-side recording indicator (plan.md §11), visible on every screen while capturing. */
function LiveBanner() {
  const live = liveSnapshot();
  const active = () => live().state !== "idle";
  return (
    <Show when={active() && route().name !== "live"}>
      <div class="banner live" role="status">
        <div class="row">
          <span class="rec-dot" aria-hidden="true" />
          <span class="rec-label">{live().state === "paused" ? t().states.paused : live().state === "finalizing" ? t().states.saving : t().states.recording}</span>
          <span class="num">{formatClock(live().capturedSamples)}</span>
        </div>
        <a class="btn" href="#/live">
          {t().common.open}
        </a>
      </div>
    </Show>
  );
}

function RecoveryBanner() {
  const { value, reload } = useData(
    () => 0,
    async () => app().storage.repo.recordingsInStates(["interrupted"]),
  );
  return (
    <For each={value() ?? []}>
      {(rec) => (
        <div class="banner notice" role="alert">
          <div class="stack" style={{ gap: "2px" }}>
            <strong>{t().app.recoveredTitle}</strong>
            <span class="small muted">
              {t().app.recoveredDetail(new Date(rec.createdAt).toLocaleString(), formatClock(rec.recoveryCursor))}
              {rec.error ? `. ${rec.error}` : ""}
            </span>
          </div>
          <div class="row">
            <Button
              label={t().app.finishProcessing}
              kind="primary"
              onClick={async () => {
                app().post.enqueue(rec.id);
                reload();
                go(`#/rec/${rec.id}`);
              }}
            />
            <Button
              label={t().app.discard}
              kind="danger"
              onClick={async () => {
                if (!confirm(t().app.discardConfirm)) return;
                await deleteRecording(app().storage.repo, app().storage.blobs, rec.id, { removeVoiceSamples: false });
                bumpData();
              }}
            />
          </div>
        </div>
      )}
    </For>
  );
}

/** Recording-consent notice (plan.md §11), shown once before the first recording. */
function ConsentNotice() {
  const [accepted, setAccepted] = createSignal(app().settings.get().consentNoticeAcceptedAt !== null);
  return (
    <Show when={!accepted()}>
      <div class="sheet-backdrop">
        <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="consent-title">
          <h2 id="consent-title">{t().app.consentTitle}</h2>
          <p>{t().app.consentLaws}</p>
          <p>
            <Rich text={t().app.consentIndicators} />
          </p>
          <p>{t().app.consentVoices}</p>
          <Button
            label={t().app.consentAccept}
            kind="primary"
            onClick={async () => {
              await app().settings.update({ consentNoticeAcceptedAt: nowIso() });
              setAccepted(true);
            }}
          />
        </div>
      </div>
    </Show>
  );
}

export function App() {
  const r = route;
  return (
    <div class="shell">
      <a class="skip-link" href="#main">
        {t().nav.skip}
      </a>
      <main class="content" id="main">
        <LiveBanner />
        <RecoveryBanner />
        <Switch>
          <Match when={r().name === "history"}>
            <HistoryView />
          </Match>
          <Match when={r().name === "live"}>
            <LiveView />
          </Match>
          <Match when={r().name === "recording" && r()}>
            {(rt) => <RecordingView id={(rt() as { id: string }).id} focus={(rt() as { focus?: string }).focus} />}
          </Match>
          <Match when={r().name === "people"}>
            <PeopleView />
          </Match>
          <Match when={r().name === "person" && r()}>
            {(rt) => <PersonView id={(rt() as { id: string }).id} />}
          </Match>
          <Match when={r().name === "settings"}>
            <SettingsView />
          </Match>
          <Match when={r().name === "diagnostics"}>
            <DiagnosticsView />
          </Match>
          <Match when={r().name === "evaluation"}>
            <EvaluationView />
          </Match>
        </Switch>
      </main>
      <Nav />
      <ToastHost />
      <ConsentNotice />
      <Show when={import.meta.env.DEV}>
        <DevPlatformMarker />
      </Show>
    </div>
  );
}
