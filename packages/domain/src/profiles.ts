import type { ModelSelection } from "./models";
import type { Settings } from "./settings";
import { newId, utf8ByteLength } from "./util";

/**
 * A named snapshot of what decides how a conversation is captured (irl-subt-r4t): the recording language, the power
 * policy, and the model for every role. Switching is quick from Settings, the idle Live page and the glasses menu.
 * A profile is a snapshot, not a link: editing settings afterwards leaves it unchanged until the user updates it.
 */
export interface ConfigProfile {
  id: string;
  name: string;
  language: string;
  powerPolicy: Settings["powerPolicy"];
  models: ModelSelection;
}

export type ProfileFields = Pick<ConfigProfile, "language" | "powerPolicy" | "models">;

/** The glasses menu holds 10 items; Start and Save audio take two. */
export const MAX_CONFIG_PROFILES = 8;
/** A name leaves room for the active marker within the 32-byte glasses menu label. */
export const PROFILE_NAME_MAX_BYTES = 24;

export function profileFields(s: ProfileFields): ProfileFields {
  return { language: s.language, powerPolicy: s.powerPolicy, models: { ...s.models } };
}

/** Whether settings are exactly what the profile saves. */
export function profileMatches(p: ProfileFields, s: ProfileFields): boolean {
  if (p.language !== s.language || p.powerPolicy !== s.powerPolicy) return false;
  const keys = new Set([...Object.keys(p.models), ...Object.keys(s.models)]) as Set<keyof ModelSelection>;
  return [...keys].every((k) => p.models[k] === s.models[k]);
}

/** Why a name can't be saved, or null. Names are compared trimmed and case-insensitively. */
export function profileNameProblem(name: string, profiles: readonly ConfigProfile[], exceptId?: string): "empty" | "too-long" | "duplicate" | null {
  const trimmed = name.trim();
  if (!trimmed) return "empty";
  if (utf8ByteLength(trimmed) > PROFILE_NAME_MAX_BYTES) return "too-long";
  const key = trimmed.toLocaleLowerCase();
  return profiles.some((p) => p.id !== exceptId && p.name.trim().toLocaleLowerCase() === key) ? "duplicate" : null;
}

/** The profile settings were last switched to, while they still match it; null once anything it saves was changed. */
export function activeProfile(s: Pick<Settings, "configProfiles" | "activeConfigProfileId"> & ProfileFields): ConfigProfile | null {
  const p = s.configProfiles.find((x) => x.id === s.activeConfigProfileId);
  return p && profileMatches(p, s) ? p : null;
}

export function newConfigProfile(name: string, from: ProfileFields): ConfigProfile {
  return { id: newId("cfg"), name: name.trim(), ...profileFields(from) };
}
