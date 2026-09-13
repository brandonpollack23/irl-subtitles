import { createSignal, Show } from "solid-js";
import { activeAttributions, cosine, equalErrorRate, meanVector, policyFor, rates, resolveCluster } from "@irl/domain";
import { embeddingSpaceOf } from "@irl/provider-local";
import { app, Button, toast } from "./lib";

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
    </>
  );
}
