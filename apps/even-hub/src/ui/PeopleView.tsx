import { createSignal, For, Show } from "solid-js";
import { activeAttributions, displayName, G2_SPEAKER_NAME_MAX_BYTES } from "@irl/domain";
import { embeddingSpaceOf } from "@irl/provider-local";
import { app, bumpData, Button, go, Sheet, toast, useData, when } from "./lib";

export function PeopleView() {
  const people = useData(
    () => 0,
    async () => {
      const list = await app().storage.repo.listPeople();
      return Promise.all(list.map(async (person) => ({ person, profile: await app().identity.profileSummary(person.id) })));
    },
  );
  const space = () => embeddingSpaceOf(app().settings.get().models.speakerEmbedding);
  return (
    <>
      <h1>People</h1>
      <Show
        when={(people.value() ?? []).length > 0}
        fallback={
          <Show when={!people.loading()}>
            <div class="panel">
              <h2>No one named yet</h2>
              <p class="muted">Tap a speaker's name in any transcript or summary to name them. With "Learn this voice" on, they'll be recognized in later conversations.</p>
            </div>
          </Show>
        }
      >
        <div class="list">
          <For each={people.value() ?? []}>
            {(row) => {
              const current = () => row.profile.profiles.find((p) => p.profile.embeddingSpace === space());
              return (
                <a href={`#/people/${row.person.id}`}>
                  <strong>{row.person.fullName}</strong>
                  <span class="small muted">
                    {row.person.shortName ? `Glasses show "${row.person.shortName}". ` : ""}
                    {!current()
                      ? "No voice profile"
                      : current()!.profile.needsReenrollment
                        ? "Voice needs re-enrollment"
                        : `Voice profile: ${current()!.prototypes} sample set${current()!.prototypes === 1 ? "" : "s"}, ${Math.round(current()!.evidenceMs / 1000)} s of speech`}
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

export function PersonView(props: { id: string }) {
  const data = useData(
    () => props.id,
    async (id) => {
      const { repo } = app().storage;
      const person = await repo.getPerson(id);
      if (!person) return null;
      const [profile, attributions, people] = await Promise.all([app().identity.profileSummary(id), repo.attributionsForPerson(id), repo.listPeople()]);
      const recordingIds = [...new Set(attributions.filter((a) => !a.undone).map((a) => a.recordingId))];
      const recordings = (await Promise.all(recordingIds.map((r) => repo.getRecording(r)))).filter((r) => !!r);
      // Only recordings where this person is the active attribution.
      const appearances = [];
      for (const r of recordings) {
        const active = activeAttributions(await repo.listAttributions(r!.id));
        const mine = [...active.values()].filter((a) => a.personId === id);
        if (mine.length) appearances.push({ recording: r!, auto: mine.every((a) => a.source === "auto") });
      }
      return { person, profile, appearances, others: people.filter((p) => p.id !== id) };
    },
  );
  const [fullName, setFullName] = createSignal<string | null>(null);
  const [shortName, setShortName] = createSignal<string | null>(null);
  const [merging, setMerging] = createSignal(false);
  const [forgetting, setForgetting] = createSignal(false);

  return (
    <Show when={data.value()} fallback={<p class="muted">{data.loading() ? "Loading…" : "This person was removed."}</p>}>
      {(d) => (
        <>
          <a href="#/people" class="small">
            People
          </a>
          <h1>{d().person.fullName}</h1>
          <div class="panel">
            <h2>Names</h2>
            <label class="field">
              Full name
              <input type="text" value={fullName() ?? d().person.fullName} onInput={(e) => setFullName(e.currentTarget.value)} />
            </label>
            <label class="field">
              Short name <span class="hint">Used on the glasses. Glasses show: "{displayName({ fullName: fullName() ?? d().person.fullName, shortName: (shortName() ?? d().person.shortName) || undefined }, G2_SPEAKER_NAME_MAX_BYTES)}"</span>
              <input type="text" value={shortName() ?? d().person.shortName ?? ""} onInput={(e) => setShortName(e.currentTarget.value)} />
            </label>
            <Button
              label="Save names"
              kind="primary"
              disabled={fullName() === null && shortName() === null}
              onClick={async () => {
                await app().identity.updatePerson(props.id, { ...(fullName() !== null ? { fullName: fullName()! } : {}), ...(shortName() !== null ? { shortName: shortName() } : {}) });
                setFullName(null);
                setShortName(null);
                bumpData();
                toast("Names saved. Every transcript and summary uses them now.");
              }}
            />
          </div>

          <div class="panel">
            <h2>Voice profile</h2>
            <Show when={d().profile.profiles.length > 0} fallback={<p class="muted">No voice saved. Name this person with "Learn this voice" on to start recognizing them.</p>}>
              <For each={d().profile.profiles}>
                {(p) => (
                  <div class="stack" style={{ gap: "2px" }}>
                    <strong>{p.profile.embeddingSpace === embeddingSpaceOf(app().settings.get().models.speakerEmbedding) ? "Current voice model" : "Other voice model"}</strong>
                    <span class="small muted">
                      {p.profile.needsReenrollment
                        ? "Needs re-enrollment: name this person in a new conversation with Learn this voice on. Until then they aren't recognized automatically."
                        : `${p.prototypes} sample set${p.prototypes === 1 ? "" : "s"}, ${Math.round(p.evidenceMs / 1000)} s of speech, quality ${Math.round(p.quality * 100)}%. ${p.clips} audio clip${p.clips === 1 ? "" : "s"} kept for re-enrollment.`}
                    </span>
                    <span class="small muted">{p.profile.embeddingSpace}</span>
                  </div>
                )}
              </For>
            </Show>
            <div class="row">
              <Button label="Forget voice" kind="danger" disabled={d().profile.profiles.length === 0} onClick={() => setForgetting(true)} />
              <Button label="Merge into another person" disabled={d().others.length === 0} onClick={() => setMerging(true)} />
            </div>
          </div>

          <div class="stack">
            <h2>Conversations</h2>
            <Show when={d().appearances.length > 0} fallback={<p class="muted">Not in any conversation.</p>}>
              <div class="list">
                <For each={d().appearances}>
                  {(a) => (
                    <a href={`#/rec/${a.recording.id}`}>
                      <strong>{a.recording.title ?? "Untitled conversation"}</strong>
                      <span class="small muted">
                        {when(a.recording.startedAt ?? a.recording.createdAt)}
                        {a.auto ? " · recognized automatically" : ""}
                      </span>
                    </a>
                  )}
                </For>
              </div>
            </Show>
          </div>

          <Show when={merging()}>
            <Sheet title={`Merge ${d().person.fullName} into…`} onClose={() => setMerging(false)}>
              <p class="small muted">Their names in past conversations and their voice samples move to the person you pick. You can undo right after.</p>
              <div class="list">
                <For each={d().others}>
                  {(other) => (
                    <Button
                      label={other.fullName}
                      kind="quiet"
                      onClick={async () => {
                        const op = await app().identity.mergePeople(other.id, props.id);
                        setMerging(false);
                        go(`#/people/${other.id}`);
                        bumpData();
                        toast(`Merged into ${other.fullName}`, { label: "Undo", run: async () => {
                          await app().identity.undo(op);
                          bumpData();
                          go(`#/people/${props.id}`);
                        } });
                      }}
                    />
                  )}
                </For>
              </div>
            </Sheet>
          </Show>
          <Show when={forgetting()}>
            <ForgetSheet id={props.id} name={d().person.fullName} onClose={() => setForgetting(false)} />
          </Show>
        </>
      )}
    </Show>
  );
}

function ForgetSheet(props: { id: string; name: string; onClose: () => void }) {
  const [keepLabels, setKeepLabels] = createSignal(true);
  return (
    <Sheet title={`Forget ${props.name}'s voice`} onClose={props.onClose}>
      <p>This permanently deletes {props.name}'s voice embeddings and saved audio clips. They won't be recognized automatically again. This can't be undone.</p>
      <label class="check">
        <input type="checkbox" checked={keepLabels()} onChange={(e) => setKeepLabels(e.currentTarget.checked)} />
        <span>Keep "{props.name}" as the speaker name in past conversations</span>
      </label>
      <Button
        label="Forget voice"
        kind="danger"
        onClick={async () => {
          await app().identity.forgetVoice(props.id, { keepLabels: keepLabels() });
          props.onClose();
          bumpData();
          if (!keepLabels()) go("#/people");
          toast("Voice forgotten");
        }}
      />
    </Sheet>
  );
}
