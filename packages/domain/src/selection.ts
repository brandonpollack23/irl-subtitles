import type { ModelRole, ModelSelection } from "./models";
import { LANGUAGES } from "./settings";

/**
 * One selection model for every role (irl-subt-3xb.1): a role holds either a local catalog id, a special ("off",
 * "same-as-live"), or a cloud service option from SERVICE_OPTIONS. Cloud options can intrinsically provide other
 * roles (a live stream does its own endpointing and final tokens), which locks those roles. The resolver below is
 * pure so the settings UI and the pipeline read the same rules.
 */

export type CloudService = "soniox" | "speechmatics" | "summary-endpoint";

export type SecretName = "soniox_api_key" | "speechmatics_api_key";

export const SERVICE_NAMES: Record<CloudService, string> = { soniox: "Soniox", speechmatics: "Speechmatics", "summary-endpoint": "the cloud summary service" };

export const SERVICE_SECRETS: Record<Exclude<CloudService, "summary-endpoint">, SecretName> = { soniox: "soniox_api_key", speechmatics: "speechmatics_api_key" };

export const ROLE_KEYS: Record<ModelRole, keyof ModelSelection> = {
  vad: "vad",
  "stt-live": "sttLive",
  "stt-final": "sttFinal",
  "speaker-embedding": "speakerEmbedding",
  summary: "summary",
};

export const ALL_ROLES: readonly ModelRole[] = ["vad", "stt-live", "stt-final", "speaker-embedding", "summary"];

/**
 * - live-stream: realtime STT + diarization while recording.
 * - batch-final: the recording's audio is sent after Stop for the final transcript and speaker turns.
 * - voice-id: the service recognizes saved people itself from voiceprints it issued.
 * - summary: transcript text only.
 */
export type ServiceOptionKind = "live-stream" | "batch-final" | "voice-id" | "summary";

/** "always", or only while live captions are off (a batch service then also finds the speech). */
export type ProvideCondition = "always" | "when-live-off";

export interface ServiceOption {
  id: string;
  kind: ServiceOptionKind;
  roles: readonly ModelRole[];
  service: CloudService;
  /** The service's own model name, sent in its config. */
  model: string;
  displayName: string;
  execution: "cloud";
  languages: readonly string[] | "auto";
  provides: Partial<Record<ModelRole, ProvideCondition>>;
  requires: { secret?: SecretName; roleService?: { roles: readonly ModelRole[]; service: CloudService }; summaryEndpoint?: boolean };
  /** What leaves the phone, for consent wording. */
  sends: "audio" | "audio-and-voiceprints" | "transcript";
  notes?: string;
}

/** Speechmatics realtime language codes by app language; realtime has no automatic language detection. */
export const SPEECHMATICS_LANGUAGES: Record<string, string> = { en: "en", ja: "ja", zh: "cmn", ko: "ko", es: "es", fr: "fr", de: "de", ar: "ar", vi: "vi", uk: "uk" };

function soniox(model: string): ServiceOption {
  return {
    id: `soniox:${model}`, kind: "live-stream", roles: ["stt-live"], service: "soniox", model, displayName: model === "stt-rt-v5" ? "Soniox" : `Soniox (${model})`, execution: "cloud", languages: "auto",
    provides: { vad: "always", "stt-final": "always" }, requires: { secret: "soniox_api_key" }, sends: "audio",
    notes: "Audio is streamed to Soniox for transcription and speaker separation while recording.",
  };
}

function speechmaticsLive(model: string): ServiceOption {
  return {
    id: `speechmatics:${model}`, kind: "live-stream", roles: ["stt-live"], service: "speechmatics", model, displayName: `Speechmatics (${model})`, execution: "cloud", languages: Object.keys(SPEECHMATICS_LANGUAGES),
    provides: { vad: "always", "stt-final": "always" }, requires: { secret: "speechmatics_api_key" }, sends: "audio",
    notes: "Audio is streamed to Speechmatics for transcription and speaker separation while recording.",
  };
}

function speechmaticsBatch(model: string): ServiceOption {
  return {
    id: `speechmatics-batch:${model}`, kind: "batch-final", roles: ["stt-final"], service: "speechmatics", model, displayName: `Speechmatics (${model}, after you stop)`, execution: "cloud", languages: "auto",
    provides: { vad: "when-live-off" }, requires: { secret: "speechmatics_api_key" }, sends: "audio",
    notes: "After you stop, the recording's audio is uploaded to Speechmatics for the final transcript and speakers.",
  };
}

function sonioxAsync(model: string): ServiceOption {
  return {
    id: `soniox-async:${model}`, kind: "batch-final", roles: ["stt-final"], service: "soniox", model, displayName: model === "stt-async-v5" ? "Soniox (after you stop)" : `Soniox (${model}, after you stop)`, execution: "cloud", languages: "auto",
    provides: { vad: "when-live-off" }, requires: { secret: "soniox_api_key" }, sends: "audio",
    notes: "After you stop, the recording's audio is uploaded to Soniox for the final transcript and speakers, then deleted there.",
  };
}

export const SPEECHMATICS_VOICE_ID = "speechmatics:voice-id";
export const CLOUD_SUMMARY = "cloud-summary";

export const SERVICE_OPTIONS: readonly ServiceOption[] = [
  soniox("stt-rt-v5"),
  speechmaticsLive("enhanced"),
  speechmaticsLive("standard"),
  speechmaticsBatch("enhanced"),
  sonioxAsync("stt-async-v5"),
  {
    id: SPEECHMATICS_VOICE_ID, kind: "voice-id", roles: ["speaker-embedding"], service: "speechmatics", model: "speaker-id", displayName: "Speechmatics voice identification", execution: "cloud", languages: "auto",
    provides: {}, requires: { secret: "speechmatics_api_key", roleService: { roles: ["stt-live", "stt-final"], service: "speechmatics" } }, sends: "audio-and-voiceprints",
    notes: "Speechmatics recognizes saved people itself. Voiceprints it issues for them are stored by Speechmatics and on this phone.",
  },
  {
    id: CLOUD_SUMMARY, kind: "summary", roles: ["summary"], service: "summary-endpoint", model: "endpoint", displayName: "Cloud summary service (sends transcript only)", execution: "cloud", languages: "auto",
    provides: {}, requires: { summaryEndpoint: true }, sends: "transcript",
  },
];

/** A cloud option by id. Pinned Soniox/Speechmatics model names that aren't listed still resolve to their family. */
export function serviceOption(id: string): ServiceOption | undefined {
  const listed = SERVICE_OPTIONS.find((o) => o.id === id);
  if (listed) return listed;
  if (id === "cloud") return SERVICE_OPTIONS.find((o) => o.id === CLOUD_SUMMARY);
  const [family, model] = splitOnce(id, ":");
  if (!model) return undefined;
  if (family === "soniox") return soniox(model);
  if (family === "soniox-async") return sonioxAsync(model);
  if (family === "speechmatics" && model !== "voice-id") return speechmaticsLive(model);
  if (family === "speechmatics-batch") return speechmaticsBatch(model);
  return undefined;
}

function splitOnce(s: string, sep: string): [string, string | undefined] {
  const i = s.indexOf(sep);
  return i < 0 ? [s, undefined] : [s.slice(0, i), s.slice(i + 1)];
}

export function isCloudOption(id: string): boolean {
  return serviceOption(id) !== undefined;
}

export function optionSupportsLanguage(o: Pick<ServiceOption, "languages">, language: string): boolean {
  if (o.languages === "auto") return true;
  return language !== "auto" && o.languages.includes(language);
}

export type SelectionLocks = Record<ModelRole, string | null>;

/** Roles provided by another role's cloud option, and by which option. Needs nothing but the selection. */
export function selectionLocks(models: ModelSelection): SelectionLocks {
  const locks: SelectionLocks = { vad: null, "stt-live": null, "stt-final": null, "speaker-embedding": null, summary: null };
  const liveOff = models.sttLive === "off";
  const apply = (o: ServiceOption | undefined, from: ModelRole) => {
    if (!o || !o.roles.includes(from)) return;
    for (const [role, cond] of Object.entries(o.provides) as [ModelRole, ProvideCondition][]) {
      if (role !== from && !locks[role] && (cond === "always" || liveOff)) locks[role] = o.id;
    }
  };
  apply(serviceOption(models.sttLive), "stt-live");
  if (!locks["stt-final"]) apply(serviceOption(models.sttFinal), "stt-final");
  return locks;
}

/** What actually runs for a role: the locking option, or the stored selection. */
export function effectiveId(models: ModelSelection, role: ModelRole, locks: SelectionLocks = selectionLocks(models)): string {
  return locks[role] ?? models[ROLE_KEYS[role]];
}

/** The service behind a role's effective option, if it is a cloud option. */
export function roleService(models: ModelSelection, role: ModelRole, locks?: SelectionLocks): CloudService | null {
  return serviceOption(effectiveId(models, role, locks))?.service ?? null;
}

export interface LocalOption {
  id: string;
  label: string;
  disabled: string | null;
}

export interface ResolveContext {
  language: string;
  hasSecret: (name: SecretName) => boolean;
  /** A cloud summary endpoint address is set. */
  summaryEndpoint: boolean;
  /** Local catalog options for a role, with their device/language availability. */
  local: (role: ModelRole) => readonly LocalOption[];
}

export interface RoleOption {
  id: string;
  label: string;
  group: "local" | "cloud" | "special";
  disabled: string | null;
}

export interface RoleLock {
  by: string;
  service: CloudService;
  /** "Provided by Soniox" */
  label: string;
  reason: string;
}

export interface RoleResolution {
  role: ModelRole;
  selected: string;
  effective: string;
  locked: RoleLock | null;
  options: RoleOption[];
  /** Why the stored selection can't run as chosen (e.g. its key was removed), or null. */
  invalid: string | null;
}

export type ResolvedSelection = Record<ModelRole, RoleResolution>;

const SPECIALS: Partial<Record<ModelRole, [string, string][]>> = {
  "stt-live": [["off", "Off (capture now, process later)"]],
  "stt-final": [["same-as-live", "Same as live captions"]],
  summary: [["off", "Off"]],
};

function languageName(code: string): string {
  return LANGUAGES.find((l) => l.code === code)?.name ?? code;
}

function lockReason(o: ServiceOption, role: ModelRole): string {
  const name = SERVICE_NAMES[o.service];
  if (role === "vad") return o.kind === "live-stream" ? `${name} detects speech itself while streaming.` : `${name} finds the speech in the uploaded recording.`;
  if (role === "stt-final") return `${name}'s final captions are the transcript.`;
  return `${name} provides this.`;
}

/** Why a cloud option can't be picked for a role right now, or null. */
export function cloudOptionBlocker(o: ServiceOption, role: ModelRole, models: ModelSelection, ctx: Pick<ResolveContext, "language" | "hasSecret" | "summaryEndpoint">): string | null {
  if (!o.roles.includes(role)) return "Not available for this role";
  if (!optionSupportsLanguage(o, ctx.language)) return `Doesn't support ${languageName(ctx.language)}`;
  if (o.requires.secret && !ctx.hasSecret(o.requires.secret)) return `Save a ${SERVICE_NAMES[o.service]} key`;
  if (o.requires.summaryEndpoint && !ctx.summaryEndpoint) return "Set the cloud summary service address";
  const need = o.requires.roleService;
  if (need) {
    const locks = selectionLocks(models);
    const ok = need.roles.some((r) => r !== role && roleService(models, r, locks) === need.service);
    if (!ok) return `Needs ${SERVICE_NAMES[need.service]} ${need.roles.map((r) => (r === "stt-live" ? "live captions" : r === "stt-final" ? "final transcript" : r)).join(" or ")}`;
  }
  return null;
}

export function resolveSelection(models: ModelSelection, ctx: ResolveContext): ResolvedSelection {
  const locks = selectionLocks(models);
  const out = {} as ResolvedSelection;
  for (const role of ALL_ROLES) {
    const selected = models[ROLE_KEYS[role]];
    const lockOption = locks[role] ? serviceOption(locks[role]!)! : null;
    const options: RoleOption[] = [
      ...ctx.local(role).map((l): RoleOption => ({ id: l.id, label: l.label, group: "local", disabled: l.disabled })),
      ...(SPECIALS[role] ?? []).map(([id, label]): RoleOption => ({ id, label, group: "special", disabled: null })),
      ...SERVICE_OPTIONS.filter((o) => o.roles.includes(role)).map((o): RoleOption => ({ id: o.id, label: o.displayName, group: "cloud", disabled: cloudOptionBlocker(o, role, models, ctx) })),
    ];
    // A pinned model that isn't listed still shows as selected.
    const cloud = serviceOption(selected);
    if (cloud && !options.some((o) => o.id === selected)) options.push({ id: selected, label: cloud.displayName, group: "cloud", disabled: cloudOptionBlocker(cloud, role, models, ctx) });
    const current = options.find((o) => o.id === selected);
    out[role] = {
      role, selected, effective: locks[role] ?? selected,
      locked: lockOption ? { by: lockOption.id, service: lockOption.service, label: `Provided by ${SERVICE_NAMES[lockOption.service]}`, reason: lockReason(lockOption, role) } : null,
      options,
      invalid: lockOption ? null : current ? current.disabled : `${selected} is not available`,
    };
  }
  return out;
}

/** One sentence on where data goes for this selection; shown in Settings, the idle live page, and recording details. */
export function describeDataFlow(models: ModelSelection): string {
  const locks = selectionLocks(models);
  const live = serviceOption(effectiveId(models, "stt-live", locks));
  const finalId = effectiveId(models, "stt-final", locks);
  const final = locks["stt-final"] ? null : serviceOption(finalId);
  const parts: string[] = [];
  if (live && final && live.service === final.service) parts.push(`audio goes to ${SERVICE_NAMES[live.service]} while recording and after you stop`);
  else {
    if (live) parts.push(`audio goes to ${SERVICE_NAMES[live.service]} while recording`);
    if (final) parts.push(`audio goes to ${SERVICE_NAMES[final.service]} after you stop`);
  }
  const voiceId = serviceOption(models.speakerEmbedding)?.kind === "voice-id";
  if (voiceId) parts.push("Speechmatics recognizes saved voices and keeps their voiceprints");
  else if (parts.length) parts.push("voices are matched on this phone");
  if (serviceOption(models.summary)?.kind === "summary") parts.push("transcript text goes to the cloud summary service");
  if (!parts.length) return "Everything stays on this phone.";
  const text = parts.join("; ");
  return `${text[0]!.toUpperCase()}${text.slice(1)}.`;
}

/** Short label for where live captions come from: "On this phone", "Soniox", "Speechmatics". */
export function liveLabel(models: ModelSelection): string {
  const o = serviceOption(models.sttLive);
  return o ? SERVICE_NAMES[o.service] : "On this phone";
}

/** Cloud services a selection sends audio or voiceprints to (not the transcript-only summary endpoint). */
export function audioServices(models: ModelSelection): Exclude<CloudService, "summary-endpoint">[] {
  const locks = selectionLocks(models);
  const out = new Set<Exclude<CloudService, "summary-endpoint">>();
  for (const role of ALL_ROLES) {
    const s = serviceOption(effectiveId(models, role, locks))?.service;
    if (s && s !== "summary-endpoint") out.add(s);
  }
  return [...out];
}
