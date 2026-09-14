import { createSignal, For, Match, Show, Switch } from "solid-js";
import { formatClock, nowIso } from "@irl/domain";
import { deleteRecording } from "@irl/pipeline";
import { DevPlatformMarker } from "./DevPlatformMarker";
import { DiagnosticsView } from "./DiagnosticsView";
import { EvaluationView } from "./EvaluationView";
import { HistoryView } from "./HistoryView";
import { app, bumpData, Button, go, route, ToastHost, useData } from "./lib";
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
    <nav class="nav" aria-label="Main">
      <a href="#/" aria-current={current() === "history" ? "page" : undefined}>
        Conversations
      </a>
      <a href="#/people" aria-current={current() === "people" ? "page" : undefined}>
        People
      </a>
      <a href="#/settings" aria-current={current() === "settings" ? "page" : undefined}>
        Settings
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
          <span class="rec-label">{live().state === "paused" ? "Paused" : live().state === "finalizing" ? "Saving" : "Recording"}</span>
          <span class="num">{formatClock(live().capturedSamples)}</span>
        </div>
        <a class="btn" href="#/live">
          Open
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
            <strong>Recovered recording</strong>
            <span class="small muted">
              {new Date(rec.createdAt).toLocaleString()} · {formatClock(rec.recoveryCursor)} saved{rec.error ? `. ${rec.error}` : ""}
            </span>
          </div>
          <div class="row">
            <Button
              label="Finish processing"
              kind="primary"
              onClick={async () => {
                app().post.enqueue(rec.id);
                reload();
                go(`#/rec/${rec.id}`);
              }}
            />
            <Button
              label="Discard"
              kind="danger"
              onClick={async () => {
                if (!confirm("Discard this recovered recording and its audio?")) return;
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
          <h2 id="consent-title">Before you record</h2>
          <p>Recording laws differ by place. Many require everyone in a conversation to agree to being recorded. You're responsible for getting that consent.</p>
          <p>
            While recording, the glasses show <strong>REC</strong> and this phone shows a red recording banner. By default, processing stays on this phone. Audio is only
            saved if you turn on <em>Save audio</em>.
          </p>
          <p>Voice profiles are biometric data. They stay on this phone, encrypted, and you can forget any voice at any time.</p>
          <Button
            label="I understand"
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
        Skip to content
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
