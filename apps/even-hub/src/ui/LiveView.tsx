import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, For, Show } from "solid-js";
import { activeAttributions, describeDataFlow, SERVICE_NAMES, formatClock, policyFor, speakerLabel, type ClusterId, type MatchDecision, type Person, type SpeakerAttribution } from "@irl/domain";
import { embeddingSpaceOf } from "@irl/provider-local";
import { app, Button, go, speakerColor, SpeakerName, useData, useSettings } from "./lib";
import { liveSnapshot, warmupStatus } from "./model";
import { SpeakerSheet } from "./SpeakerSheet";

export function LiveView() {
  const live = liveSnapshot();
  const warmup = warmupStatus();
  // Cloud captions don't wait on local models.
  const modelsLoading = () => warmup().loading.length > 0 && live().provider === "local";
  const [sheet, setSheet] = createSignal<ClusterId | null>(null);
  const idle = () => live().state === "idle";
  const [settings] = useSettings();

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
              {describeDataFlow(settings().models)}{" "}
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
              {live().sourceLabel} · {live().provider === "local" ? "On this phone" : SERVICE_NAMES[live().provider as "soniox"]} · {live().persistAudio ? "saving audio" : "audio not saved"}
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

        <Show when={settings().showMatchDetails}>
          <MatchDetails
            matches={live().matches}
            label={(id) => <SpeakerName label={label(id)} ordinal={clusters().get(id)?.ordinal} onOpen={setSheet} />}
            name={(personId) => names.value()?.people.get(personId)?.fullName ?? "Unknown person"}
          />
        </Show>

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

/**
 * Match tuning readout (irl-subt-kdl.18): each speaker's latest live match, with the scores and the criteria that
 * withheld a name, next to the thresholds they were judged against.
 */
function MatchDetails(props: { matches: MatchDecision[]; label: (id: ClusterId) => JSX.Element; name: (personId: string) => string }) {
  const [s] = useSettings();
  const policy = () => policyFor(embeddingSpaceOf(s().models.speakerEmbedding), s().matchPolicies);
  const outcome = (d: MatchDecision) => (d.status === "accepted" ? "recognized" : d.status === "candidate" ? "possibly" : "no name");
  return (
    <section class="panel" aria-label="Match details">
      <div class="row" style={{ "justify-content": "space-between" }}>
        <h2>Match details</h2>
        <a class="small" href="#/evaluation">
          Tune
        </a>
      </div>
      <p class="small muted num">
        Recognize ≥ {policy().minScore.toFixed(2)} · possibly ≥ {policy().candidateScore.toFixed(2)} · lead {policy().minMargin.toFixed(2)} · speech {(policy().minEvidenceMs / 1000).toFixed(0)} s ·
        agreement {Math.round(policy().minWindowAgreement * 100)}%
      </p>
      <Show when={props.matches.length} fallback={<p class="small muted">Scores appear once someone speaks.</p>}>
        <For each={props.matches}>
          {(d) => (
            <div class="stack" style={{ gap: "2px" }}>
              <div class="row">
                {props.label(d.clusterId)}
                <span class="small muted">{outcome(d)}</span>
              </div>
              <span class="small num">
                {d.best ? `${props.name(d.best.personId)} ${d.best.score.toFixed(3)}` : "No saved voices to compare"}
                {d.second ? ` · next ${props.name(d.second.personId)} ${d.second.score.toFixed(3)}` : ""} · {(d.evidenceMs / 1000).toFixed(1)} s · agreement {Math.round(d.agreement * 100)}%
              </span>
              <Show when={d.status !== "accepted"}>
                <span class="small muted">{d.reason}</span>
              </Show>
            </div>
          )}
        </For>
      </Show>
    </section>
  );
}
