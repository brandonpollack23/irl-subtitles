import { For, Show } from "solid-js";
import { app, Button, duration, go, useData, when } from "./lib";
import { liveSnapshot, loadHistory, stateLabel } from "./model";

export function HistoryView() {
  const live = liveSnapshot();
  const history = useData(() => 0, loadHistory);
  const start = async () => {
    await app().controller.start();
    go("#/live");
  };
  return (
    <>
      <div class="spread">
        <h1>Conversations</h1>
        <Show when={live().state === "idle"} fallback={<a class="btn" href="#/live">Current recording</a>}>
          <Button label="Start recording" busyLabel="Starting…" kind="record" onClick={start} />
        </Show>
      </div>
      <Show when={history.error()}>
        <p class="error">Couldn't load conversations: {history.error()}</p>
      </Show>
      <Show
        when={(history.value() ?? []).length > 0}
        fallback={
          <Show when={!history.loading()}>
            <div class="panel">
              <h2>No conversations yet</h2>
              <p class="muted">Start recording from the glasses menu or the button above. Transcripts, speakers, and summaries will show up here.</p>
            </div>
          </Show>
        }
      >
        <div class="list">
          <For each={history.value() ?? []}>
            {(row) => {
              const badge = () => stateLabel(row.recording);
              return (
                <a href={`#/rec/${row.recording.id}`}>
                  <div class="spread">
                    <strong>{row.recording.title ?? "Untitled conversation"}</strong>
                    <span class={["badge", { busy: badge().kind === "busy", bad: badge().kind === "bad" }]}>{badge().text}</span>
                  </div>
                  <span class="small muted num">
                    {when(row.recording.startedAt ?? row.recording.createdAt)} · {duration(row.recording.totalSamples)}
                    {row.people.length ? ` · ${row.people.join(", ")}` : ""}
                  </span>
                </a>
              );
            }}
          </For>
        </div>
      </Show>
    </>
  );
}
