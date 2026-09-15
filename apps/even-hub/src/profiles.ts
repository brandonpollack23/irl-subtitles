import { ALL_ROLES, repairSelection, ROLE_KEYS, SERVICE_SECRETS, type ConfigProfile, type ModelRole, type ModelSelection, type SecretName } from "@irl/domain";
import { availabilityOnDevice, catalogEntry, defaultSelection, entriesForRole, supportsLanguage, type DeviceCapabilities } from "@irl/provider-local";
import type { SettingsStore } from "@irl/storage";

/**
 * Local models this device can't run (e.g. one needing shader-f16) replaced by the most preferred option that can,
 * or the role's "off"/"same-as-live" special when none can.
 */
export function fitDevice(models: ModelSelection, language: string, caps: DeviceCapabilities | null): { models: ModelSelection; replaced: { role: ModelRole; from: string; to: string }[] } {
  const next = { ...models };
  const replaced: { role: ModelRole; from: string; to: string }[] = [];
  for (const role of ALL_ROLES) {
    const key = ROLE_KEYS[role];
    const entry = catalogEntry(next[key]);
    if (!entry || availabilityOnDevice(entry, caps).status === "available") continue;
    const options = entriesForRole(role).filter((e) => availabilityOnDevice(e, caps).status === "available" && supportsLanguage(e, language));
    const to = options.find((e) => e.planDefault) ?? options[0];
    (next as Record<string, string>)[key] = to?.id ?? (role === "stt-live" || role === "summary" ? "off" : role === "stt-final" ? "same-as-live" : next[key]);
    replaced.push({ role, from: entry.displayName, to: to?.displayName ?? next[key] });
  }
  return { models: next, replaced };
}

export interface VoiceMigration {
  reembedded: number;
  needsReenrollment: number;
}

export interface ProfileDeps {
  settings: Pick<SettingsStore, "get" | "update">;
  hasSecret: (name: SecretName) => Promise<boolean>;
  caps: DeviceCapabilities | null;
  /** Re-embeds saved voices for a new voice model; resolves null when nobody has a voice profile yet. */
  migrateVoices: (modelId: string) => Promise<VoiceMigration | null>;
}

export interface ProfileSwitch {
  profile: ConfigProfile;
  /** Roles whose saved choice can't run now (its key was removed, this device can't run it), switched to this phone. */
  reset: ModelRole[];
  /** Saved voices being re-enrolled for the profile's voice model, when switching changed it. */
  voices: Promise<VoiceMigration | null> | null;
}

/**
 * Makes a profile's language, power policy and models the current settings (irl-subt-r4t). Like any settings change it
 * applies to the next recording. The profile itself isn't edited when something in it can't run: it stays as saved,
 * shows as modified, and works again once the key is back.
 */
export async function switchProfile(deps: ProfileDeps, id: string): Promise<ProfileSwitch | null> {
  const current = deps.settings.get();
  const profile = current.configProfiles.find((p) => p.id === id);
  if (!profile) return null;
  const names = Object.values(SERVICE_SECRETS);
  const saved = new Set((await Promise.all(names.map(async (n) => ((await deps.hasSecret(n)) ? n : null)))).filter((n): n is SecretName => n !== null));
  const cloud = repairSelection(profile.models, { language: profile.language, hasSecret: (n) => saved.has(n) }, defaultSelection(profile.language));
  const device = fitDevice(cloud.models, profile.language, deps.caps);
  const reset = ALL_ROLES.filter((r) => cloud.reset.includes(r) || device.replaced.some((x) => x.role === r));
  const models = device.models;
  await deps.settings.update({ language: profile.language, powerPolicy: profile.powerPolicy, models, activeConfigProfileId: profile.id });
  const voiceChanged = models.speakerEmbedding !== current.models.speakerEmbedding;
  return { profile, reset, voices: voiceChanged ? deps.migrateVoices(models.speakerEmbedding) : null };
}
