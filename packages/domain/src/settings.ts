import type { MatchPolicy } from "./identity";
import type { ModelSelection, PowerPolicy } from "./models";
import type { ProviderKind } from "./recording";

export type CaptureSourceKind = "glasses" | "phone-mic" | "wav-file";

/**
 * Non-secret settings (plan.md §10). Changes apply to the next recording: a recording snapshots
 * provider, language, and model selection when it starts.
 */
export interface Settings {
  provider: ProviderKind;
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
  matchPolicies: Record<string, MatchPolicy>;
  /** Diagnostics include transcript text only when explicitly enabled. */
  diagnosticsIncludeContent: boolean;
  firstRunBenchmarkAt: string | null;
  /** Soniox model name; kept here so it can be pinned without a release. */
  sonioxModel: string;
}

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
    provider: "local",
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
    matchPolicies: {},
    diagnosticsIncludeContent: false,
    firstRunBenchmarkAt: null,
    sonioxModel: "stt-rt-v5",
  };
}

export interface SecretStore {
  put(name: "soniox_api_key", value: string): Promise<void>;
  get(name: "soniox_api_key"): Promise<string | null>;
  delete(name: "soniox_api_key"): Promise<void>;
  has(name: "soniox_api_key"): Promise<boolean>;
}
