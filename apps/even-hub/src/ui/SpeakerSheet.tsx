import { createSignal, For, Show } from "solid-js";
import { activeAttributions, isServiceVoiceSpace, policyFor, resolveCluster, speakerLabel } from "@irl/domain";
import { app, bumpData, Button, Sheet, toast, useData } from "./lib";

/**
 * plan.md §7.2 speaker sheet: likely people first, then everyone, or a new person with an optional short
 * name; "Learn this voice" decides whether clean audio improves the saved profile. Every change can be undone.
 */
export function SpeakerSheet(props: { recordingId: string; clusterId: string; onClose: () => void }) {
  const [learn, setLearn] = createSignal(app().settings.get().learnVoiceDefault);
  const [fullName, setFullName] = createSignal("");
  const [shortName, setShortName] = createSignal("");
  const [filter, setFilter] = createSignal("");

  const data = useData(
    () => [props.recordingId, props.clusterId] as const,
    async ([rid, cid]) => {
      const { repo } = app().storage;
      const [clusters, attrs, people, likely] = await Promise.all([repo.listClusters(rid), repo.listAttributions(rid), repo.listPeople(), app().identity.likelyPeople(rid, cid).catch(() => [])]);
      const clusterMap = new Map(clusters.map((c) => [c.clusterId, c]));
      const resolved = resolveCluster(clusterMap, cid);
      const current = speakerLabel(resolved, clusterMap, activeAttributions(attrs), new Map(people.map((p) => [p.id, p])));
      const windows = (await repo.listWindows(rid)).filter((w) => !isServiceVoiceSpace(w.embeddingSpace) && resolveCluster(clusterMap, w.clusterId) === resolved);
      const space = windows[0]?.embeddingSpace;
      const candidate = space ? policyFor(space, app().settings.get().matchPolicies).candidateScore : 0.5;
      return { resolved, current, likely, candidate, voiceSeconds: windows.reduce((n, w) => n + (w.endSample - w.startSample) / 16000, 0) };
    },
  );

  const finish = async (person: { id: string } | { fullName: string; shortName?: string } | null, what: string) => {
    const d = data.value();
    if (!d) return;
    const { operationId } = await app().identity.assign({ recordingId: props.recordingId, clusterId: d.resolved, person, learnVoice: learn() && person !== null });
    bumpData();
    props.onClose();
    toast(what, { label: "Undo", run: async () => {
      await app().identity.undo(operationId);
      bumpData();
      toast("Undone");
    } });
  };

  const likely = () => (data.value()?.likely ?? []).filter((x) => x.score !== null && x.score >= (data.value()?.candidate ?? 1)).slice(0, 3);
  const everyone = () => (data.value()?.likely ?? []).filter((x) => x.person.fullName.toLowerCase().includes(filter().toLowerCase()));

  return (
    <Sheet title={data.value()?.current.text ?? "Speaker"} onClose={props.onClose}>
      <Show when={data.value()}>
        {(d) => (
          <>
            <p class="small muted">
              {d().current.kind === "confirmed" ? "You named this speaker." : d().current.kind === "auto" ? "Recognized automatically from a saved voice." : "Not identified yet."}{" "}
              {Math.round(d().voiceSeconds)} s of clean speech available for voice matching.
            </p>
            <label class="check">
              <input type="checkbox" checked={learn()} onChange={(e) => setLearn(e.currentTarget.checked)} />
              <span>
                Learn this voice
                <span class="small muted" style={{ display: "block" }}>
                  Saves clean speech from this speaker to their voice profile so future conversations can recognize them.
                </span>
              </span>
            </label>
            <Show when={likely().length > 0}>
              <div class="stack">
                <h3>Likely</h3>
                <For each={likely()}>
                  {(x) => <Button label={`${x.person.fullName} (${Math.round((x.score ?? 0) * 100)}% match)`} kind="primary" onClick={() => finish({ id: x.person.id }, `Named ${x.person.fullName}`)} />}
                </For>
              </div>
            </Show>
            <div class="stack">
              <h3>New person</h3>
              <label class="field">
                Full name
                <input type="text" autocomplete="off" value={fullName()} onInput={(e) => setFullName(e.currentTarget.value)} />
              </label>
              <label class="field">
                Short name <span class="hint">Optional. Shown on the glasses when the full name doesn't fit.</span>
                <input type="text" autocomplete="off" value={shortName()} onInput={(e) => setShortName(e.currentTarget.value)} />
              </label>
              <Button
                label="Create and name"
                kind="primary"
                disabled={!fullName().trim()}
                onClick={() => finish({ fullName: fullName(), ...(shortName().trim() ? { shortName: shortName() } : {}) }, `Named ${fullName().trim()}`)}
              />
            </div>
            <Show when={(d().likely ?? []).length > 0}>
              <div class="stack">
                <h3>Everyone</h3>
                <input type="search" placeholder="Filter people" value={filter()} onInput={(e) => setFilter(e.currentTarget.value)} aria-label="Filter people" />
                <div class="list">
                  <For each={everyone()}>
                    {(x) => (
                      <button type="button" class="item btn quiet" style={{ "justify-content": "flex-start" }} onClick={() => finish({ id: x.person.id }, `Named ${x.person.fullName}`)}>
                        {x.person.fullName}
                        {x.person.shortName ? ` (${x.person.shortName})` : ""}
                      </button>
                    )}
                  </For>
                </div>
              </div>
            </Show>
            <Show when={d().current.kind !== "anonymous"}>
              <Button label="Mark as unknown" kind="danger" onClick={() => finish(null, "Marked as unknown")} />
            </Show>
          </>
        )}
      </Show>
      <Show when={data.error()}>
        <p class="error">{data.error()}</p>
      </Show>
    </Sheet>
  );
}
