import { describe, expect, it } from "vitest";
import { activeProfile, defaultSettings, newConfigProfile, profileMatches, profileNameProblem, PROFILE_NAME_MAX_BYTES, type ModelSelection, type Settings } from "../src";

const LOCAL: ModelSelection = { vad: "silero", sttLive: "moonshine", sttFinal: "whisper", speakerEmbedding: "campplus", summary: "gemma" };

describe("configuration profiles (irl-subt-r4t)", () => {
  it("snapshots language, power and models, and matches only while all of them are unchanged", () => {
    const s = defaultSettings(LOCAL);
    const p = newConfigProfile("  Local  ", s);
    expect(p).toMatchObject({ name: "Local", language: "en", powerPolicy: "balanced", models: LOCAL });
    // A copy: later settings edits don't reach into the profile.
    expect(p.models).not.toBe(s.models);
    expect(profileMatches(p, s)).toBe(true);
    expect(profileMatches(p, { ...s, language: "ja" })).toBe(false);
    expect(profileMatches(p, { ...s, powerPolicy: "fast" })).toBe(false);
    expect(profileMatches(p, { ...s, models: { ...LOCAL, sttLive: "soniox:stt-rt-v5" } })).toBe(false);
    // Settings outside the profile don't matter.
    const other: Settings = { ...s, persistAudio: true, captureSource: "phone-mic" };
    expect(profileMatches(p, other)).toBe(true);
  });

  it("is active only while the settings still match the profile last switched to", () => {
    const s = defaultSettings(LOCAL);
    const cloud = newConfigProfile("Cloud", { ...s, models: { ...LOCAL, sttLive: "soniox:stt-rt-v5" } });
    const local = newConfigProfile("Local", s);
    const base = { ...s, configProfiles: [cloud, local] };
    expect(activeProfile({ ...base, activeConfigProfileId: local.id })?.name).toBe("Local");
    expect(activeProfile({ ...base, activeConfigProfileId: local.id, powerPolicy: "fast" })).toBeNull();
    // Matching settings alone don't make a profile active: the user never switched to it.
    expect(activeProfile({ ...base, activeConfigProfileId: null })).toBeNull();
    expect(activeProfile({ ...base, activeConfigProfileId: "gone" })).toBeNull();
  });

  it("rejects empty, duplicate and over-budget names", () => {
    const existing = [newConfigProfile("Cloud", defaultSettings(LOCAL))];
    expect(profileNameProblem("   ", existing)).toBe("empty");
    expect(profileNameProblem(" cloud ", existing)).toBe("duplicate");
    expect(profileNameProblem("Cloud", existing, existing[0]!.id)).toBeNull();
    expect(profileNameProblem("a".repeat(PROFILE_NAME_MAX_BYTES), existing)).toBeNull();
    expect(profileNameProblem("a".repeat(PROFILE_NAME_MAX_BYTES + 1), existing)).toBe("too-long");
    // Japanese is 3 bytes per character: 8 characters fit, 9 don't.
    expect(profileNameProblem("会議用クラウド字幕", existing)).toBe("too-long");
    expect(profileNameProblem("会議用クラウド字", existing)).toBeNull();
  });
});
