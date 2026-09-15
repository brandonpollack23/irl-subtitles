import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, For, Show } from "solid-js";
import { describe, fmt, t } from "@irl/i18n";
import { activeAttributions, dataFlow, isVoiceIdOption, SERVICE_NAMES, formatClock, policyFor, speakerLabel, type ClusterId, type MatchDecision, type Person, type SpeakerAttribution } from "@irl/domain";
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
      words: t().speakers,
    });
  const level = () => Math.max(0, Math.min(100, ((live().levelDbfs + 60) / 60) * 100));

  return (
    <>
      <Show
        when={!idle()}
        fallback={
          <div class="stack">
            <h1>{t().live.idleTitle}</h1>
            <p class="muted">
              {describe().dataFlow(dataFlow(settings().models))}{" "}
              {settings().persistAudio ? t().live.audioWillSave : t().live.audioWontSave}
            </p>
            <Show when={modelsLoading()}>
              <p class="small muted" role="status">
                {t().live.loadingModels(warmup().loading.join(", "))}
              </p>
            </Show>
            <Button label={t().history.startRecording} busyLabel={t().history.starting} kind="record" onClick={() => app().controller.start()} />
            <Show when={live().error}>{(e) => <p class="error">{describe().liveProblem(e())}</p>}</Show>
          </div>
        }
      >
        <div class="stack">
          <div class="row">
            <span class="rec-dot" aria-hidden="true" />
            <span class="rec-label">{live().state === "paused" ? t().states.paused : live().state === "finalizing" ? t().states.saving : live().state === "starting" ? t().states.starting : t().states.recording}</span>
            <span class="muted small">
              {live().sourceKind === "glasses" ? t().live.sourceGlasses : live().sourceKind === "phone-mic" ? t().live.sourcePhone : live().sourceLabel} ·{" "}
              {live().provider === "local" ? t().services.onPhone : SERVICE_NAMES[live().provider as "soniox"]} · {live().persistAudio ? t().live.savingAudio : t().live.audioNotSaved}
            </span>
          </div>
          <div class="clock" aria-live="off">
            {formatClock(live().capturedSamples)}
          </div>
          <div class="meter" aria-hidden="true">
            <div style={{ width: `${level()}%` }} />
          </div>
          <Show when={app().sourceNote}>
            <p class="small warn">{t().live.glassesFallback}</p>
          </Show>
          <Show when={modelsLoading()}>
            <p class="small muted" role="status">
              {t().live.captionsLoading}
            </p>
          </Show>
          <Show when={live().degraded}>
            {(r) => (
              <p class="warn" role="status">
                {describe().degraded(r())}
              </p>
            )}
          </Show>
          <Show when={live().gaps > 0}>
            <p class="small muted">
              {t().live.gaps(live().gaps)}
            </p>
          </Show>
          <Show when={live().error}>{(e) => <p class="small error">{describe().liveProblem(e())}</p>}</Show>
          <div class="row">
            <Show when={live().state === "recording"}>
              <Button label={t().live.pause} onClick={() => app().controller.pause()} />
            </Show>
            <Show when={live().state === "paused"}>
              <Button label={t().live.resume} kind="primary" onClick={() => app().controller.resume()} />
            </Show>
            <Button label={live().markers ? t().live.addMarkerCount(live().markers) : t().live.addMarker} disabled={live().state !== "recording"} onClick={() => app().controller.addMarker(t().live.marker)} />
            <Button
              label={t().live.stop}
              busyLabel={t().live.saving}
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
            name={(personId) => names.value()?.people.get(personId)?.fullName ?? t().live.unknownPerson}
          />
        </Show>

        <section class="stack" aria-label={t().live.captionsLabel}>
          <h2>{t().live.captions}</h2>
          <Show when={live().segments.length === 0 && !live().provisionalText}>
            <p class="muted">{live().speechActive ? t().live.listening : t().live.captionsAppear}</p>
          </Show>
          <div>
            <For each={live().segments}>
              {(seg) => (
                <div class="turn" style={{ "--spk-color": seg.clusterId ? speakerColor(clusters().get(seg.clusterId)?.ordinal) : "var(--line)" }}>
                  <div>
                    <div class="meta">
                      <Show when={seg.clusterId} fallback={<span class="muted small">{t().speakers.speaker()}</span>}>
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
  const outcome = (d: MatchDecision) => (d.status === "accepted" ? t().live.outcomeRecognized : d.status === "candidate" ? t().live.outcomePossibly : t().live.outcomeNone);
  const f = fmt();
  return (
    <section class="panel" aria-label={t().live.matchTitle}>
      <div class="row" style={{ "justify-content": "space-between" }}>
        <h2>{t().live.matchTitle}</h2>
        <a class="small" href="#/evaluation">
          {t().live.tune}
        </a>
      </div>
      <Show
        when={!isVoiceIdOption(s().models.speakerEmbedding)}
        fallback={
          <p class="small muted num">
            {t().live.serviceMatching(s().speechmaticsSpeakersSensitivity === null ? t().live.defaultSensitivity : f.number(s().speechmaticsSpeakersSensitivity!, 2))}
          </p>
        }
      >
      <p class="small muted num">
        {t().live.policy(f.number(policy().minScore, 2), f.number(policy().candidateScore, 2), f.number(policy().minMargin, 2), f.seconds(policy().minEvidenceMs / 1000), f.percent(policy().minWindowAgreement))}
      </p>
      </Show>
      <Show when={props.matches.length} fallback={<p class="small muted">{t().live.scoresAppear}</p>}>
        <For each={props.matches}>
          {(d) => (
            <div class="stack" style={{ gap: "2px" }}>
              <div class="row">
                {props.label(d.clusterId)}
                <span class="small muted">{outcome(d)}</span>
              </div>
              <Show when={d.source === "service"}>
                <span class="small num">{t().live.labeledByService(d.best ? props.name(d.best.personId) : "")}</span>
              </Show>
              <Show when={d.source !== "service"}>
              <span class="small num">
                {d.best ? `${props.name(d.best.personId)} ${f.number(d.best.score, 3)}` : t().live.noSavedVoices}
                {d.second ? t().live.next(props.name(d.second.personId), f.number(d.second.score, 3)) : ""}
                {t().live.evidence(f.seconds(d.evidenceMs / 1000, 1), f.percent(d.agreement))}
              </span>
              </Show>
              <Show when={d.status !== "accepted"}>
                <span class="small muted">{describe().matchReason(d)}</span>
              </Show>
            </div>
          )}
        </For>
      </Show>
    </section>
  );
}
