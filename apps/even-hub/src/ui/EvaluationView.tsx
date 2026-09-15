import { createSignal, For, Show } from "solid-js";
import { activeAttributions, cosine, isVoiceIdOption, DEFAULT_POLICIES, equalErrorRate, meanVector, policyFor, rates, resolveCluster, type MatchPolicy } from "@irl/domain";
import { embeddingSpaceOf } from "@irl/provider-local";
import { app, Button, toast, useSettings } from "./lib";

interface Evaluation {
  space: string;
  clusters: number;
  people: number;
  same: number[];
  different: number[];
  eer: number;
  threshold: number;
  current: { minScore: number; far: number; frr: number };
}

/**
 * Speaker-ID evaluation harness (irl-subt-f9n.9): uses conversations where you confirmed names, i.e. real
 * G2 audio, to score same-person and different-person speaker pairs in the current voice model, report
 * the equal error rate, and calibrate the acceptance threshold.
 */
export function EvaluationView() {
  const [result, setResult] = createSignal<Evaluation | null>(null);

  const run = async () => {
    const { repo } = app().storage;
    const space = embeddingSpaceOf(app().settings.get().models.speakerEmbedding);
    const groups: { personId: string; vector: Float32Array }[] = [];
    for (const rec of await repo.listRecordings()) {
      const clusters = new Map((await repo.listClusters(rec.id)).map((c) => [c.clusterId, c]));
      const attrs = activeAttributions(await repo.listAttributions(rec.id));
      const windows = (await repo.listWindows(rec.id)).filter((w) => w.embeddingSpace === space);
      for (const [clusterId, a] of attrs) {
        if (a.source !== "manual" || !a.personId) continue;
        const mine = windows.filter((w) => resolveCluster(clusters, w.clusterId) === clusterId);
        // Split long speakers into ~5-window chunks so one conversation yields several samples.
        for (let i = 0; i + 3 <= mine.length; i += 5) {
          const vectors = await Promise.all(mine.slice(i, i + 5).map((w) => app().identity.openVector(w.sealedVector)));
          groups.push({ personId: a.personId, vector: meanVector(vectors) });
        }
      }
    }
    const same: number[] = [];
    const different: number[] = [];
    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) (groups[i]!.personId === groups[j]!.personId ? same : different).push(cosine(groups[i]!.vector, groups[j]!.vector));
    }
    if (!same.length || !different.length) {
      toast("Name at least two different people across conversations, with enough speech each, then try again.");
      return;
    }
    const { eer, threshold } = equalErrorRate(same, different);
    const policy = policyFor(space, app().settings.get().matchPolicies);
    setResult({ space, clusters: groups.length, people: new Set(groups.map((g) => g.personId)).size, same, different, eer, threshold, current: { minScore: policy.minScore, ...rates(same, different, policy.minScore) } });
  };

  return (
    <>
      <a href="#/settings" class="small">
        Settings
      </a>
      <h1>Calibrate voice recognition</h1>
      <p class="muted">
        Uses conversations where you named speakers yourself to check how well the current voice model separates people, and suggests the score a voice needs before it's recognized
        automatically.
      </p>
      <Button label="Run calibration" busyLabel="Comparing voices…" kind="primary" onClick={run} />
      <Show when={result()}>
        {(r) => (
          <div class="panel">
            <h2>Results</h2>
            <table class="kv">
              <tbody>
                <tr><th>Voice model</th><td>{r().space}</td></tr>
                <tr><th>Samples</th><td>{r().clusters} from {r().people} people ({r().same.length} same-person pairs, {r().different.length} different-person pairs)</td></tr>
                <tr><th>Equal error rate</th><td>{(r().eer * 100).toFixed(1)}% at score {r().threshold.toFixed(3)}</td></tr>
                <tr><th>Current threshold</th><td>{r().current.minScore.toFixed(3)}: wrongly accepts {(r().current.far * 100).toFixed(1)}%, misses {(r().current.frr * 100).toFixed(1)}%</td></tr>
              </tbody>
            </table>
            <p class="small muted">A wrong name is worse than no name, so the suggested threshold sits a little above the equal-error point.</p>
            <Button
              label={`Use threshold ${(r().threshold + 0.05).toFixed(3)}`}
              onClick={async () => {
                const s = app().settings.get();
                const base = policyFor(r().space, s.matchPolicies);
                await app().settings.update({ matchPolicies: { ...s.matchPolicies, [r().space]: { ...base, minScore: r().threshold + 0.05, candidateScore: Math.max(0, r().threshold - 0.1) } } });
                toast("Threshold saved for this voice model");
              }}
            />
          </div>
        )}
      </Show>
      <MatchTuning />
    </>
  );
}

interface PolicyControl {
  key: keyof MatchPolicy;
  label: string;
  hint: string;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
}

const CONTROLS: readonly PolicyControl[] = [
  { key: "minScore", label: "Recognize at score", hint: "A voice at or above this score gets the person's name.", min: 0.2, max: 0.9, step: 0.01, format: (v) => v.toFixed(2) },
  { key: "candidateScore", label: "“Possibly” at score", hint: "Below the recognize score but at or above this, the speaker shows as “Possibly X”.", min: 0.1, max: 0.9, step: 0.01, format: (v) => v.toFixed(2) },
  { key: "minMargin", label: "Lead over the next person", hint: "How far the best person must score above the runner-up.", min: 0, max: 0.3, step: 0.01, format: (v) => v.toFixed(2) },
  { key: "minEvidenceMs", label: "Speech needed", hint: "Clean, non-overlapping speech before a name is given.", min: 0, max: 20_000, step: 1_000, format: (v) => `${(v / 1000).toFixed(0)} s` },
  { key: "minWindowAgreement", label: "Window agreement", hint: "Share of 2 s windows whose best match is the same person.", min: 0, max: 1, step: 0.05, format: (v) => `${Math.round(v * 100)}%` },
];

/**
 * Manual match tuning (irl-subt-kdl.18): the match policy for the current voice model as sliders. Saved settings are
 * read at every match, so moving a slider during a recording applies to the next live check.
 */
function MatchTuning() {
  const [s] = useSettings();
  return (
    <Show when={!isVoiceIdOption(s().models.speakerEmbedding)} fallback={<ServiceMatchTuning />}>
      <LocalMatchTuning />
    </Show>
  );
}

/** With Speechmatics voice ID the service decides; its one knob is speakers_sensitivity. */
function ServiceMatchTuning() {
  const [s, update] = useSettings();
  const [draft, setDraft] = createSignal<number | null>(null);
  const value = () => draft() ?? s().speechmaticsSpeakersSensitivity ?? 0.5;
  return (
    <section class="panel">
      <h2>Tune matching</h2>
      <p class="small muted">
        Speechmatics recognizes saved voices itself, so the score thresholds don't apply. Sensitivity sets how readily it assigns speech to a saved voice instead of a new speaker; it
        applies from the next recording. {s().speechmaticsSpeakersSensitivity === null ? "Using the service default." : "Using your value."}
      </p>
      <label class="check">
        <input type="checkbox" checked={s().showMatchDetails} onChange={(e) => void update({ showMatchDetails: e.currentTarget.checked })} />
        <span>Show match details while recording</span>
      </label>
      <label class="field">
        <span class="row" style={{ "justify-content": "space-between" }}>
          Sensitivity to saved voices
          <span class="num">{value().toFixed(2)}</span>
        </span>
        <span class="hint">Higher names saved people more often, and more often wrongly.</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={value()}
          onInput={(e) => setDraft(Number(e.currentTarget.value))}
          onChange={async (e) => {
            await update({ speechmaticsSpeakersSensitivity: Number(e.currentTarget.value) });
            setDraft(null);
          }}
        />
      </label>
      <div class="row">
        <Button label="Use the service default" disabled={s().speechmaticsSpeakersSensitivity === null} onClick={() => update({ speechmaticsSpeakersSensitivity: null })} />
      </div>
    </section>
  );
}

function LocalMatchTuning() {
  const [s, update] = useSettings();
  // The value being dragged, saved when the slider is released.
  const [draft, setDraft] = createSignal<Partial<MatchPolicy>>({});
  const space = () => embeddingSpaceOf(s().models.speakerEmbedding);
  const saved = () => policyFor(space(), s().matchPolicies);
  const value = (k: keyof MatchPolicy) => draft()[k] ?? saved()[k];
  const custom = () => space() in s().matchPolicies;
  const defaults = () => DEFAULT_POLICIES[space()] ?? DEFAULT_POLICIES.default!;

  const commit = async (k: keyof MatchPolicy, v: number) => {
    await update({ matchPolicies: { ...s().matchPolicies, [space()]: { ...saved(), [k]: v } } });
    setDraft(({ [k]: _, ...rest }) => rest);
  };

  return (
    <section class="panel">
      <h2>Tune matching</h2>
      <p class="small muted">
        For {space()}. {custom() ? "Using your values." : "Using the defaults."} Turn on match details to see each speaker's scores on the recording screen while you adjust.
      </p>
      <label class="check">
        <input type="checkbox" checked={s().showMatchDetails} onChange={(e) => void update({ showMatchDetails: e.currentTarget.checked })} />
        <span>Show match details while recording</span>
      </label>
      <For each={CONTROLS}>
        {(c) => (
          <label class="field">
            <span class="row" style={{ "justify-content": "space-between" }}>
              {c.label}
              <span class="num">{c.format(value(c.key))}</span>
            </span>
            <span class="hint">
              {c.hint} Default {c.format(defaults()[c.key])}.
            </span>
            <input
              type="range"
              min={c.min}
              max={c.max}
              step={c.step}
              value={value(c.key)}
              onInput={(e) => setDraft((d) => ({ ...d, [c.key]: Number(e.currentTarget.value) }))}
              onChange={(e) => void commit(c.key, Number(e.currentTarget.value))}
            />
          </label>
        )}
      </For>
      <Show when={value("candidateScore") > value("minScore")}>
        <p class="small warn">The “Possibly” score is above the recognize score, so no speaker will show as “Possibly X”.</p>
      </Show>
      <div class="row">
        <Button
          label="Reset to defaults"
          disabled={!custom()}
          onClick={async () => {
            const { [space()]: _, ...rest } = s().matchPolicies;
            await update({ matchPolicies: rest });
            setDraft({});
          }}
        />
      </div>
    </section>
  );
}
