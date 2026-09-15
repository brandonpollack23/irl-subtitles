import { createSignal, For, Show } from "solid-js";
import {
  activeProfile,
  dataFlow,
  MAX_CONFIG_PROFILES,
  newConfigProfile,
  profileFields,
  profileMatches,
  profileNameProblem,
  type ConfigProfile,
  type ModelRole,
  type Settings,
} from "@irl/domain";
import { describe, fmt, t } from "@irl/i18n";
import { app, Button, toast } from "./lib";

type Props = { s: Settings; update: (p: Partial<Settings>) => Promise<void> };

const powerLabel = (p: Settings["powerPolicy"]) => (p === "low-power" ? t().settings.powerLow : p === "fast" ? t().settings.powerFast : t().settings.powerBalanced);
const roleTitles = (roles: readonly ModelRole[]) => fmt().list(roles.map((r) => t().settings.roles[r].title));

/** Switches profile and says what happened: what couldn't run as saved, and voices re-enrolled for a new voice model. */
export async function switchToProfile(id: string): Promise<void> {
  const r = await app().switchProfile(id);
  if (!r) return;
  toast(`${t().profiles.switched(r.profile.name)}${r.reset.length ? t().profiles.reset(roleTitles(r.reset)) : ""}`);
  if (r.voices) {
    toast(t().settings.reenrolling);
    const done = await r.voices;
    if (done) toast(t().settings.reenrolled(done.reembedded, done.needsReenrollment));
  }
}

/** Settings > Profiles: save the current language, power and models, switch, update, rename, delete. */
export function ProfilesSection(props: Props) {
  const [name, setName] = createSignal("");
  const [renaming, setRenaming] = createSignal<string | null>(null);
  const [newName, setNewName] = createSignal("");
  const profiles = () => props.s.configProfiles;
  const active = () => activeProfile(props.s);
  const full = () => profiles().length >= MAX_CONFIG_PROFILES;
  const problem = () => (name().trim() ? profileNameProblem(name(), profiles()) : null);

  const save = async () => {
    const p = newConfigProfile(name(), props.s);
    await props.update({ configProfiles: [...profiles(), p], activeConfigProfileId: p.id });
    setName("");
    toast(t().profiles.saved(p.name));
  };
  const replace = (id: string, next: (p: ConfigProfile) => ConfigProfile) => profiles().map((p) => (p.id === id ? next(p) : p));

  return (
    <section class="panel">
      <h2>{t().profiles.title}</h2>
      <p class="small muted">{t().profiles.intro}</p>
      <Show when={profiles().length} fallback={<p class="small muted">{t().profiles.empty}</p>}>
        <div class="list">
          <For each={profiles()}>
            {(p) => {
              const isActive = () => active()?.id === p.id;
              const changed = () => props.s.activeConfigProfileId === p.id && !profileMatches(p, props.s);
              const renameProblem = () => profileNameProblem(newName(), profiles(), p.id);
              return (
                <div class="item stack" style={{ gap: "8px" }}>
                  <div class="spread">
                    <strong>{p.name}</strong>
                    <Show when={isActive() || changed()}>
                      <span class={["badge", { busy: isActive() }]}>{isActive() ? t().profiles.inUse : t().profiles.changed}</span>
                    </Show>
                  </div>
                  <span class="small muted">{t().profiles.summary(fmt().language(p.language), powerLabel(p.powerPolicy), describe().dataFlow(dataFlow(p.models)))}</span>
                  <Show
                    when={renaming() === p.id}
                    fallback={
                      <div class="row">
                        <Show when={!isActive()}>
                          <Button label={t().profiles.use} kind="primary" onClick={() => switchToProfile(p.id)} />
                        </Show>
                        <Show when={changed()}>
                          <Button
                            label={t().profiles.update}
                            title={t().profiles.updateHint}
                            onClick={async () => {
                              await props.update({ configProfiles: replace(p.id, (x) => ({ ...x, ...profileFields(props.s) })) });
                              toast(t().profiles.updated(p.name));
                            }}
                          />
                        </Show>
                        <Button
                          label={t().profiles.rename}
                          kind="quiet"
                          onClick={async () => {
                            setNewName(p.name);
                            setRenaming(p.id);
                          }}
                        />
                        <Button
                          label={t().profiles.delete}
                          kind="danger"
                          onClick={async () => {
                            if (!confirm(t().profiles.deleteConfirm(p.name))) return;
                            const gone = p;
                            await props.update({ configProfiles: profiles().filter((x) => x.id !== gone.id), ...(props.s.activeConfigProfileId === gone.id ? { activeConfigProfileId: null } : {}) });
                            toast(t().profiles.deleted(gone.name));
                          }}
                        />
                      </div>
                    }
                  >
                    <label class="field">
                      {t().profiles.name}
                      <input type="text" autocomplete="off" value={newName()} onInput={(e) => setNewName(e.currentTarget.value)} />
                      <Show when={renameProblem() && newName().trim()}>
                        <span class="hint warn">{t().profiles.nameProblems[renameProblem()!]}</span>
                      </Show>
                    </label>
                    <div class="row">
                      <Button
                        label={t().common.save}
                        kind="primary"
                        disabled={!!renameProblem()}
                        onClick={async () => {
                          const next = newName().trim();
                          await props.update({ configProfiles: replace(p.id, (x) => ({ ...x, name: next })) });
                          setRenaming(null);
                          toast(t().profiles.renamed(next));
                        }}
                      />
                      <Button label={t().common.cancel} kind="quiet" onClick={async () => setRenaming(null)} />
                    </div>
                  </Show>
                </div>
              );
            }}
          </For>
        </div>
      </Show>
      <Show when={!full()} fallback={<p class="small muted">{t().profiles.limit(MAX_CONFIG_PROFILES)}</p>}>
        <label class="field">
          {t().profiles.name}
          <span class="hint">{t().profiles.nameHint}</span>
          <input type="text" autocomplete="off" value={name()} onInput={(e) => setName(e.currentTarget.value)} />
          <Show when={problem()}>
            <span class="hint warn">{t().profiles.nameProblems[problem()!]}</span>
          </Show>
        </label>
        <div class="row">
          <Button label={t().profiles.saveCurrent} disabled={!name().trim() || !!problem()} onClick={save} />
        </div>
      </Show>
    </section>
  );
}

/** The idle Live page's quick switcher; hidden until a profile is saved. */
export function ProfilePicker(props: { s: Settings }) {
  const active = () => activeProfile(props.s);
  const last = () => props.s.configProfiles.find((p) => p.id === props.s.activeConfigProfileId);
  return (
    <Show when={props.s.configProfiles.length}>
      <label class="field">
        {t().profiles.picker}
        <select
          value={active()?.id ?? ""}
          onChange={(e) => {
            const id = e.currentTarget.value;
            if (id) void switchToProfile(id);
          }}
        >
          <Show when={!active()}>
            <option value="">{last() ? t().profiles.changedOption(last()!.name) : t().profiles.noneActive}</option>
          </Show>
          <For each={props.s.configProfiles}>{(p) => <option value={p.id}>{p.name}</option>}</For>
        </select>
      </label>
    </Show>
  );
}
