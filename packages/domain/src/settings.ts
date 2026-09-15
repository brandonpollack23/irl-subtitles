import type { PersonId } from "./audio";
import type { MatchPolicy } from "./identity";
import type { ModelSelection, PowerPolicy } from "./models";
import type { SecretName } from "./selection";

export type CaptureSourceKind = "glasses" | "phone-mic" | "wav-file";

/**
 * Non-secret settings (plan.md §10). Changes apply to the next recording: a recording snapshots
 * language and model selection (local models and cloud service options) when it starts.
 */
export interface Settings {
  language: string;
  models: ModelSelection;
  powerPolicy: PowerPolicy;
  /** Default for the glasses "Save audio" toggle. Off: non-persisted mode. */
  persistAudio: boolean;
  deleteAudioAfterProcessing: boolean;
  /** Default state of "Learn this voice" in the speaker sheet. */
  learnVoiceDefault: boolean;
  /** Store short consented audio clips with voice samples so profiles can be re-embedded later. */
  keepVoiceClips: boolean;
  cloudSummaryEndpoint: string;
  consentNoticeAcceptedAt: string | null;
  captureSource: CaptureSourceKind;
  showCaptionsOnGlasses: boolean;
  /** The person who is the wearer ("me"); at most one. Set from their page in People. */
  selfPersonId: PersonId | null;
  /** Leave the wearer's own speech (speakers recognized as selfPersonId) off the glasses captions. */
  hideOwnSpeechOnGlasses: boolean;
  matchPolicies: Record<string, MatchPolicy>;
  /** Show each speaker's match scores and why a name was withheld while recording (match tuning). */
  showMatchDetails: boolean;
  /** Diagnostics include transcript text only when explicitly enabled. */
  diagnosticsIncludeContent: boolean;
  firstRunBenchmarkAt: string | null;
  /** When the user agreed to send data to each cloud service (audio; for Speechmatics voice ID also voiceprints). */
  cloudConsent: Partial<Record<CloudConsentKey, string>>;
}

export type CloudConsentKey = "soniox" | "speechmatics" | "speechmatics-voiceprints" | "summary-endpoint";

export interface LanguageOption {
  code: string;
  name: string;
}

export const LANGUAGES: readonly LanguageOption[] = [
  { code: "en", name: "English" },
  { code: "ja", name: "Japanese" },
  { code: "zh", name: "Chinese" },
  { code: "ko", name: "Korean" },
  { code: "es", name: "Spanish" },
  { code: "fr", name: "French" },
  { code: "de", name: "German" },
  { code: "ar", name: "Arabic" },
  { code: "vi", name: "Vietnamese" },
  { code: "uk", name: "Ukrainian" },
  { code: "auto", name: "Automatic (best effort)" },
];

export function defaultSettings(models: ModelSelection): Settings {
  return {
    language: "en",
    models,
    powerPolicy: "balanced",
    persistAudio: false,
    deleteAudioAfterProcessing: false,
    learnVoiceDefault: true,
    keepVoiceClips: true,
    cloudSummaryEndpoint: "",
    consentNoticeAcceptedAt: null,
    captureSource: "glasses",
    showCaptionsOnGlasses: true,
    selfPersonId: null,
    hideOwnSpeechOnGlasses: false,
    matchPolicies: {},
    showMatchDetails: false,
    diagnosticsIncludeContent: false,
    firstRunBenchmarkAt: null,
    cloudConsent: {},
  };
}

export interface SecretStore {
  put(name: SecretName, value: string): Promise<void>;
  get(name: SecretName): Promise<string | null>;
  delete(name: SecretName): Promise<void>;
  has(name: SecretName): Promise<boolean>;
}

/**
 * Settings saved before cloud services became per-role options (irl-subt-3xb.1): `provider: "soniox"` picked the
 * live path and `sonioxModel` its model; now live captions select "soniox:<model>". The summary special "cloud"
 * is the "cloud-summary" option. Returns a copy without the retired fields.
 */
export function migrateSettings(saved: Record<string, unknown>): Record<string, unknown> {
  const { provider, sonioxModel, ...rest } = saved;
  const models = { ...((rest.models as Record<string, unknown> | undefined) ?? {}) };
  let changed = false;
  if (provider === "soniox") {
    models.sttLive = `soniox:${typeof sonioxModel === "string" && sonioxModel ? sonioxModel : "stt-rt-v5"}`;
    changed = true;
  }
  if (models.summary === "cloud") {
    models.summary = "cloud-summary";
    changed = true;
  }
  if (changed || rest.models) rest.models = models;
  if (provider === "soniox" && !(rest.cloudConsent as Record<string, unknown> | undefined)?.soniox) {
    // Choosing Soniox as the provider was the consent to stream audio to it.
    rest.cloudConsent = { ...((rest.cloudConsent as Record<string, unknown> | undefined) ?? {}), soniox: new Date(0).toISOString() };
  }
  return rest;
}
