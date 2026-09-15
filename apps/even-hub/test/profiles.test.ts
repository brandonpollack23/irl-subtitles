import { describe, expect, it, vi } from "vitest";
import { defaultSettings, newConfigProfile, type SecretName, type Settings } from "@irl/domain";
import { defaultSelection, type DeviceCapabilities } from "@irl/provider-local";
import { fitDevice, switchProfile, type ProfileDeps } from "../src/profiles";

const NO_GPU = { platform: "android", userAgent: "", secureContext: true, crossOriginIsolated: false, webgpu: { available: false, shaderF16: false }, wasmSimd: true } as unknown as DeviceCapabilities;
const F16_GPU = { ...NO_GPU, webgpu: { available: true, shaderF16: true } } as DeviceCapabilities;

function deps(settings: Settings, opts: { secrets?: SecretName[]; caps?: DeviceCapabilities } = {}) {
  let current = settings;
  const store = {
    get: () => current,
    update: vi.fn(async (patch: Partial<Settings>) => (current = { ...current, ...patch, models: { ...current.models, ...(patch.models ?? {}) } })),
  };
  const migrateVoices = vi.fn(async () => ({ reembedded: 2, needsReenrollment: 0 }));
  const d: ProfileDeps = { settings: store, caps: opts.caps ?? F16_GPU, hasSecret: async (n) => opts.secrets?.includes(n) ?? false, migrateVoices };
  return { d, store, migrateVoices, current: () => current };
}

describe("switching configuration profiles (irl-subt-r4t)", () => {
  const en = defaultSelection("en");
  const ja = defaultSelection("ja");

  it("applies the profile's language, power policy and models and remembers it as active", async () => {
    const base = defaultSettings(en);
    const profile = newConfigProfile("Japanese cloud", { language: "ja", powerPolicy: "fast", models: { ...ja, sttLive: "soniox:stt-rt-v5" } });
    const { d, current } = deps({ ...base, configProfiles: [profile] }, { secrets: ["soniox_api_key"] });
    const r = await switchProfile(d, profile.id);
    expect(r?.reset).toEqual([]);
    expect(current()).toMatchObject({ language: "ja", powerPolicy: "fast", models: profile.models, activeConfigProfileId: profile.id });
    // Settings outside the profile stay.
    expect(current().persistAudio).toBe(base.persistAudio);
  });

  it("puts cloud options whose key was removed back on this phone, leaving the saved profile as it was", async () => {
    const profile = newConfigProfile("Soniox", { language: "en", powerPolicy: "balanced", models: { ...en, sttLive: "soniox:stt-rt-v5" } });
    const { d, current } = deps({ ...defaultSettings(en), configProfiles: [profile] });
    const r = await switchProfile(d, profile.id);
    expect(r?.reset).toEqual(["stt-live"]);
    expect(current().models.sttLive).toBe(en.sttLive);
    expect(current().configProfiles[0]!.models.sttLive).toBe("soniox:stt-rt-v5");
  });

  it("replaces local models this device can't run", async () => {
    const profile = newConfigProfile("GPU summary", { language: "en", powerPolicy: "balanced", models: { ...en, summary: "gemma-4-e2b-qat-mobile" } });
    const { d, current } = deps({ ...defaultSettings(en), configProfiles: [profile] }, { caps: NO_GPU });
    const r = await switchProfile(d, profile.id);
    // The default final-transcript model needs WebGPU too.
    expect(r?.reset).toEqual(["stt-final", "summary"]);
    expect(current().models.summary).toBe("off");
    expect(fitDevice(profile.models, "en", F16_GPU).replaced).toEqual([]);
  });

  it("re-enrolls saved voices only when the voice model changes", async () => {
    const same = newConfigProfile("Same voices", { language: "en", powerPolicy: "low-power", models: en });
    const other = newConfigProfile("Other voices", { language: "en", powerPolicy: "balanced", models: { ...en, speakerEmbedding: "wespeaker-resnet34-lm" } });
    const { d, migrateVoices } = deps({ ...defaultSettings(en), configProfiles: [same, other] });
    expect((await switchProfile(d, same.id))?.voices).toBeNull();
    const r = await switchProfile(d, other.id);
    expect(await r?.voices).toEqual({ reembedded: 2, needsReenrollment: 0 });
    expect(migrateVoices).toHaveBeenCalledWith("wespeaker-resnet34-lm");
  });

  it("does nothing for a profile that was deleted", async () => {
    const { d, store } = deps(defaultSettings(en));
    expect(await switchProfile(d, "cfg_gone")).toBeNull();
    expect(store.update).not.toHaveBeenCalled();
  });
});
