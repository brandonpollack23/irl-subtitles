import { Emitter, migrateSettings, type Settings } from "@irl/domain";
import type { Repository } from "./repository";

const KEY = "settings.v1";

/** Non-secret settings persisted as one document; secrets never pass through here. */
export class SettingsStore {
  private current: Settings;
  readonly changes = new Emitter<Settings>();

  private constructor(private readonly repo: Repository, initial: Settings) {
    this.current = initial;
  }

  static async open(repo: Repository, defaults: Settings): Promise<SettingsStore> {
    const saved = migrateSettings((await repo.getSetting<Record<string, unknown>>(KEY)) ?? {}) as Partial<Settings>;
    const merged: Settings = { ...defaults, ...saved, models: { ...defaults.models, ...(saved.models ?? {}) } };
    for (const k of Object.keys(merged) as (keyof Settings)[]) {
      if (/key|secret|token/i.test(k)) delete (merged as unknown as Record<string, unknown>)[k];
    }
    return new SettingsStore(repo, merged);
  }

  get(): Settings {
    return this.current;
  }

  async update(patch: Partial<Settings>): Promise<Settings> {
    const next: Settings = { ...this.current, ...patch, models: { ...this.current.models, ...(patch.models ?? {}) } };
    await this.repo.putSetting(KEY, next);
    this.current = next;
    this.changes.emit(next);
    return next;
  }
}
