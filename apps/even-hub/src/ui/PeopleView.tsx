import { createSignal, For, Show } from "solid-js";
import { activeAttributions, displayName, G2_SPEAKER_NAME_MAX_BYTES } from "@irl/domain";
import { fmt, t } from "@irl/i18n";
import { embeddingSpaceOf } from "@irl/provider-local";
import { app, bumpData, Button, go, Sheet, toast, useData, useSettings, when } from "./lib";

export function PeopleView() {
  const people = useData(
    () => 0,
    async () => {
      const list = await app().storage.repo.listPeople();
      return Promise.all(list.map(async (person) => ({ person, profile: await app().identity.profileSummary(person.id) })));
    },
  );
  const space = () => embeddingSpaceOf(app().settings.get().models.speakerEmbedding);
  const [settings] = useSettings();
  return (
    <>
      <h1>{t().people.title}</h1>
      <Show
        when={(people.value() ?? []).length > 0}
        fallback={
          <Show when={!people.loading()}>
            <div class="panel">
              <h2>{t().people.emptyTitle}</h2>
              <p class="muted">{t().people.emptyBody}</p>
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
                  <strong>
                    {row.person.fullName}
                    {settings().selfPersonId === row.person.id ? <span class="muted">{t().people.me}</span> : null}
                  </strong>
                  <span class="small muted">
                    {row.person.shortName ? t().people.glassesShow(row.person.shortName) : ""}
                    {!current()
                      ? t().people.noProfile
                      : current()!.profile.needsReenrollment
                        ? t().people.needsReenrollment
                        : t().people.profile(current()!.prototypes, fmt().seconds(current()!.evidenceMs / 1000))}
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
  const [settings, updateSettings] = useSettings();

  return (
    <Show when={data.value()} fallback={<p class="muted">{data.loading() ? t().common.loading : t().people.removed}</p>}>
      {(d) => (
        <>
          <a href="#/people" class="small">
            {t().people.title}
          </a>
          <h1>{d().person.fullName}</h1>
          <div class="panel">
            <h2>{t().people.names}</h2>
            <label class="field">
              {t().people.fullName}
              <input type="text" value={fullName() ?? d().person.fullName} onInput={(e) => setFullName(e.currentTarget.value)} />
            </label>
            <label class="field">
              {t().people.shortName}{" "}
              <span class="hint">{t().people.shortNamePreview(displayName({ fullName: fullName() ?? d().person.fullName, shortName: (shortName() ?? d().person.shortName) || undefined }, G2_SPEAKER_NAME_MAX_BYTES))}</span>
              <input type="text" value={shortName() ?? d().person.shortName ?? ""} onInput={(e) => setShortName(e.currentTarget.value)} />
            </label>
            <Button
              label={t().people.saveNames}
              kind="primary"
              disabled={fullName() === null && shortName() === null}
              onClick={async () => {
                await app().identity.updatePerson(props.id, { ...(fullName() !== null ? { fullName: fullName()! } : {}), ...(shortName() !== null ? { shortName: shortName() } : {}) });
                setFullName(null);
                setShortName(null);
                bumpData();
                toast(t().people.namesSaved);
              }}
            />
          </div>

          <div class="panel">
            <label class="check">
              <input
                type="checkbox"
                checked={settings().selfPersonId === props.id}
                onChange={(e) => void updateSettings({ selfPersonId: e.currentTarget.checked ? props.id : null })}
              />
              <span>
                {t().people.thisIsMe}
                <span class="small muted" style={{ display: "block" }}>
                  {t().people.onlyOneMe}
                </span>
              </span>
            </label>
            <Show when={settings().selfPersonId === props.id}>
              <p class="small">
                {settings().hideOwnSpeechOnGlasses ? t().people.hideOnBefore : t().people.hideOffBefore}
                <a href="#/settings">{t().people.settingsRecording}</a>
                {settings().hideOwnSpeechOnGlasses ? t().people.hideOnAfter : t().people.hideOffAfter}
                {t().people.keepsEverything}
              </p>
            </Show>
          </div>

          <div class="panel">
            <h2>{t().people.voiceProfile}</h2>
            <Show when={d().profile.profiles.length > 0} fallback={<p class="muted">{t().people.noVoiceSaved}</p>}>
              <For each={d().profile.profiles}>
                {(p) => (
                  <div class="stack" style={{ gap: "2px" }}>
                    <strong>{p.profile.embeddingSpace === embeddingSpaceOf(app().settings.get().models.speakerEmbedding) ? t().people.currentModel : t().people.otherModel}</strong>
                    <span class="small muted">
                      {p.profile.needsReenrollment
                        ? t().people.reenrollLong
                        : t().people.profileDetail(p.prototypes, fmt().seconds(p.evidenceMs / 1000), fmt().percent(p.quality), p.clips)}
                    </span>
                    <span class="small muted">{p.profile.embeddingSpace}</span>
                  </div>
                )}
              </For>
            </Show>
            <div class="row">
              <Button label={t().people.forgetVoice} kind="danger" disabled={d().profile.profiles.length === 0} onClick={() => setForgetting(true)} />
              <Button label={t().people.merge} disabled={d().others.length === 0} onClick={() => setMerging(true)} />
            </div>
          </div>

          <div class="stack">
            <h2>{t().people.conversations}</h2>
            <Show when={d().appearances.length > 0} fallback={<p class="muted">{t().people.notInAny}</p>}>
              <div class="list">
                <For each={d().appearances}>
                  {(a) => (
                    <a href={`#/rec/${a.recording.id}`}>
                      <strong>{a.recording.title ?? t().history.untitled}</strong>
                      <span class="small muted">
                        {when(a.recording.startedAt ?? a.recording.createdAt)}
                        {a.auto ? t().people.recognizedAuto : ""}
                      </span>
                    </a>
                  )}
                </For>
              </div>
            </Show>
          </div>

          <Show when={merging()}>
            <Sheet title={t().people.mergeTitle(d().person.fullName)} onClose={() => setMerging(false)}>
              <p class="small muted">{t().people.mergeBody}</p>
              <div class="list">
                <For each={d().others}>
                  {(other) => (
                    <Button
                      label={other.fullName}
                      kind="quiet"
                      onClick={async () => {
                        const op = await app().identity.mergePeople(other.id, props.id);
                        if (settings().selfPersonId === props.id) await updateSettings({ selfPersonId: other.id });
                        setMerging(false);
                        go(`#/people/${other.id}`);
                        bumpData();
                        toast(t().people.mergedInto(other.fullName), { label: t().common.undo, run: async () => {
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
    <Sheet title={t().people.forgetTitle(props.name)} onClose={props.onClose}>
      <p>{t().people.forgetBody(props.name)}</p>
      <label class="check">
        <input type="checkbox" checked={keepLabels()} onChange={(e) => setKeepLabels(e.currentTarget.checked)} />
        <span>{t().people.keepLabels(props.name)}</span>
      </label>
      <Button
        label={t().people.forgetVoice}
        kind="danger"
        onClick={async () => {
          await app().identity.forgetVoice(props.id, { keepLabels: keepLabels() });
          props.onClose();
          bumpData();
          if (!keepLabels()) go("#/people");
          toast(t().people.voiceForgotten);
        }}
      />
    </Sheet>
  );
}
