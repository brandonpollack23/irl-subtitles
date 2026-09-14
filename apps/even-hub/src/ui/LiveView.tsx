import { createMemo, createSignal, For, Show } from "solid-js";
import { activeAttributions, formatClock, speakerLabel, type ClusterId, type Person, type SpeakerAttribution } from "@irl/domain";
import { app, Button, go, speakerColor, SpeakerName, useData } from "./lib";
import { liveSnapshot, warmupStatus } from "./model";
import { SpeakerSheet } from "./SpeakerSheet";

export function LiveView() {
  const live = liveSnapshot();
  const warmup = warmupStatus();
  // Soniox captions don't wait on local models.
  const modelsLoading = () => warmup().loading.length > 0 && live().provider !== "soniox";
  const [sheet, setSheet] = createSignal<ClusterId | null>(null);
  const idle = () => live().state === "idle";
  const settings = () => app().settings.get();

  // Names attached during the recording (live matches or manual naming) re-resolve on labelsVersion.
  const names = useData(
    () => [live().recordingId, live().labelsVersion] as const,
    async ([id]) => {
      if (!id) return { attrs: new Map<ClusterId, SpeakerAttribution>(), people: new Map<string, Person>() };
      const [attrs, people] = await Promise.all([app().storage.repo.listAttributions(id), app().storage.repo.listPeople()]);
      return { attrs: activeAttributions(attrs), people: new Map(people.map((p) => [p.id, p])) };
    },
  );
  const clusters = createMemo(() => new Map(live().clusters.map((c) => [c.clusterId, c])));
  const label = (id: ClusterId) =>
    speakerLabel(id, clusters(), names.value()?.attrs ?? new Map(), names.value()?.people ?? new Map(), {
      candidate: clusters().get(id)?.candidatePersonId ? { personId: clusters().get(id)!.candidatePersonId! } : null,
    });
  const level = () => Math.max(0, Math.min(100, ((live().levelDbfs + 60) / 60) * 100));

  return (
    <>
      <Show
        when={!idle()}
        fallback={
          <div class="stack">
            <h1>Record a conversation</h1>
            <p class="muted">
              {settings().provider === "soniox" ? "Soniox transcribes in the cloud: audio is sent to Soniox while recording." : "Everything is processed on this phone."}{" "}
              {settings().persistAudio ? "Audio will be saved." : "Audio won't be saved after processing."}
            </p>
            <Show when={modelsLoading()}>
              <p class="small muted" role="status">
                Loading {warmup().loading.join(", ")}. You can start now; captions follow once they're ready.
              </p>
            </Show>
            <Button label="Start recording" busyLabel="Starting…" kind="record" onClick={() => app().controller.start()} />
            <Show when={live().error}>
              <p class="error">{live().error}</p>
            </Show>
          </div>
        }
      >
        <div class="stack">
          <div class="row">
            <span class="rec-dot" aria-hidden="true" />
            <span class="rec-label">{live().state === "paused" ? "Paused" : live().state === "finalizing" ? "Saving" : live().state === "starting" ? "Starting" : "Recording"}</span>
            <span class="muted small">
              {live().sourceLabel} · {live().provider === "soniox" ? "Soniox" : "On this phone"} · {live().persistAudio ? "saving audio" : "audio not saved"}
            </span>
          </div>
          <div class="clock" aria-live="off">
            {formatClock(live().capturedSamples)}
          </div>
          <div class="meter" aria-hidden="true">
            <div style={{ width: `${level()}%` }} />
          </div>
          <Show when={app().sourceNote}>
            <p class="small warn">{app().sourceNote}</p>
          </Show>
          <Show when={modelsLoading()}>
            <p class="small muted" role="status">
              Captions loading, they'll start shortly.
            </p>
          </Show>
          <Show when={live().degraded}>
            <p class="warn" role="status">
              {live().degraded}
            </p>
          </Show>
          <Show when={live().gaps > 0}>
            <p class="small muted">
              {live().gaps} audio gap{live().gaps === 1 ? "" : "s"} from the glasses connection
            </p>
          </Show>
          <Show when={live().error}>
            <p class="small error">{live().error}</p>
          </Show>
          <div class="row">
            <Show when={live().state === "recording"}>
              <Button label="Pause" onClick={() => app().controller.pause()} />
            </Show>
            <Show when={live().state === "paused"}>
              <Button label="Resume" kind="primary" onClick={() => app().controller.resume()} />
            </Show>
            <Button label={`Add marker${live().markers ? ` (${live().markers})` : ""}`} disabled={live().state !== "recording"} onClick={() => app().controller.addMarker("Marker")} />
            <Button
              label="Stop and summarize"
              busyLabel="Saving…"
              kind="danger"
              disabled={live().state === "finalizing"}
              onClick={async () => {
                const id = await app().controller.stop();
                if (id) go(`#/rec/${id}`);
              }}
            />
          </div>
        </div>

        <section class="stack" aria-label="Live captions">
          <h2>Captions</h2>
          <Show when={live().segments.length === 0 && !live().provisionalText}>
            <p class="muted">{live().speechActive ? "Listening…" : "Captions appear when someone speaks."}</p>
          </Show>
          <div>
            <For each={live().segments}>
              {(seg) => (
                <div class="turn" style={{ "--spk-color": seg.clusterId ? speakerColor(clusters().get(seg.clusterId)?.ordinal) : "var(--line)" }}>
                  <div>
                    <div class="meta">
                      <Show when={seg.clusterId} fallback={<span class="muted small">Speaker</span>}>
                        {(cid) => <SpeakerName label={label(cid())} ordinal={clusters().get(cid())?.ordinal} onOpen={setSheet} />}
                      </Show>
                      <span class="small muted num">{formatClock(seg.startSample)}</span>
                    </div>
                    <p>{seg.text}</p>
                  </div>
                </div>
              )}
            </For>
            <Show when={live().provisionalText}>
              <div class="turn provisional">
                <div>
                  <p>{live().provisionalText}</p>
                </div>
              </div>
            </Show>
          </div>
        </section>
      </Show>
      <Show when={sheet() && live().recordingId}>
        <SpeakerSheet recordingId={live().recordingId!} clusterId={sheet()!} onClose={() => setSheet(null)} />
      </Show>
    </>
  );
}
