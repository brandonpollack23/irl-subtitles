import { describe, expect, it } from "vitest";
import {
  dataFlow,
  migrateSettings,
  repairSelection,
  recordingLocks,
  resolveSelection,
  selectionLocks,
  serviceOption,
  type ModelRole,
  type ModelSelection,
  type ResolveContext,
  type SecretName,
} from "../src";

const LOCAL: ModelSelection = { vad: "silero", sttLive: "moonshine", sttFinal: "whisper", speakerEmbedding: "campplus", summary: "gemma" };

function ctx(opts: { secrets?: SecretName[]; language?: string; summaryEndpoint?: boolean } = {}): ResolveContext {
  const local: Record<ModelRole, string> = { vad: "silero", "stt-live": "moonshine", "stt-final": "whisper", "speaker-embedding": "campplus", summary: "gemma" };
  return {
    language: opts.language ?? "en",
    hasSecret: (n) => opts.secrets?.includes(n) ?? false,
    summaryEndpoint: opts.summaryEndpoint ?? false,
    local: (role) => [{ id: local[role], label: local[role], disabled: null }],
  };
}

const option = (r: ReturnType<typeof resolveSelection>, role: ModelRole, id: string) => r[role].options.find((o) => o.id === id);

describe("selection resolver", () => {
  it("leaves an all-local selection unlocked with cloud options disabled until a key is saved", () => {
    const r = resolveSelection(LOCAL, ctx());
    for (const role of ["vad", "stt-live", "stt-final", "speaker-embedding", "summary"] as const) {
      expect(r[role].locked).toBeNull();
      expect(r[role].invalid).toBeNull();
    }
    expect(option(r, "stt-live", "soniox:stt-rt-v5")).toMatchObject({ group: "cloud", disabled: { code: "key", service: "soniox" } });
    expect(option(r, "stt-live", "speechmatics:enhanced")?.disabled).toEqual({ code: "key", service: "speechmatics" });
    expect(option(r, "stt-live", "off")).toMatchObject({ group: "special", disabled: null });
    expect(option(r, "summary", "cloud-summary")?.disabled).toEqual({ code: "summary-endpoint" });
    expect(dataFlow(LOCAL)).toEqual({ live: null, final: null, voiceId: null, summary: false });
  });

  it("a live stream locks speech detection and the final transcript but not the voice model", () => {
    const models = { ...LOCAL, sttLive: "soniox:stt-rt-v5" };
    const r = resolveSelection(models, ctx({ secrets: ["soniox_api_key"] }));
    expect(r.vad.locked).toEqual({ by: "soniox:stt-rt-v5", service: "soniox", kind: "live-stream" });
    expect(r["stt-final"].locked?.service).toBe("soniox");
    expect(r["stt-final"].effective).toBe("soniox:stt-rt-v5");
    // The stored choice survives, so unlocking returns to it.
    expect(r["stt-final"].selected).toBe("whisper");
    expect(r["speaker-embedding"].locked).toBeNull();
    expect(r["stt-live"].invalid).toBeNull();
    expect(dataFlow(models)).toEqual({ live: "soniox", final: null, voiceId: null, summary: false });
  });

  it("reports a selected option whose key is gone as invalid", () => {
    const r = resolveSelection({ ...LOCAL, sttLive: "speechmatics:enhanced" }, ctx());
    expect(r["stt-live"].invalid).toEqual({ code: "key", service: "speechmatics" });
    expect(r.vad.locked?.by).toBe("speechmatics:enhanced");
  });

  it("disables options that don't support the language", () => {
    const r = resolveSelection(LOCAL, ctx({ secrets: ["speechmatics_api_key", "soniox_api_key"], language: "auto" }));
    expect(option(r, "stt-live", "speechmatics:enhanced")?.disabled).toEqual({ code: "language", language: "auto" });
    expect(option(r, "stt-live", "soniox:stt-rt-v5")?.disabled).toBeNull();
    // Batch accepts automatic language detection.
    expect(option(r, "stt-final", "speechmatics-batch:enhanced")?.disabled).toBeNull();
  });

  it("a batch final transcript locks speech detection only while live captions are off", () => {
    const withLive = { ...LOCAL, sttFinal: "speechmatics-batch:enhanced" };
    expect(selectionLocks(withLive)).toMatchObject({ vad: null, "stt-final": null });
    expect(dataFlow(withLive)).toEqual({ live: null, final: "speechmatics", voiceId: null, summary: false });
    const liveOff = { ...withLive, sttLive: "off" };
    expect(selectionLocks(liveOff).vad).toBe("speechmatics-batch:enhanced");
  });

  it("Speechmatics voice ID needs Speechmatics audio in live captions or the final transcript", () => {
    const secrets: SecretName[] = ["speechmatics_api_key", "soniox_api_key"];
    expect(option(resolveSelection(LOCAL, ctx({ secrets })), "speaker-embedding", "speechmatics:voice-id")?.disabled).toEqual({ code: "needs-service", service: "speechmatics", roles: ["stt-live", "stt-final"] });
    expect(option(resolveSelection({ ...LOCAL, sttLive: "soniox:stt-rt-v5" }, ctx({ secrets })), "speaker-embedding", "speechmatics:voice-id")?.disabled).toEqual({ code: "needs-service", service: "speechmatics", roles: ["stt-live", "stt-final"] });
    expect(option(resolveSelection({ ...LOCAL, sttLive: "speechmatics:standard" }, ctx({ secrets })), "speaker-embedding", "speechmatics:voice-id")?.disabled).toBeNull();
    expect(option(resolveSelection({ ...LOCAL, sttFinal: "speechmatics-batch:enhanced" }, ctx({ secrets })), "speaker-embedding", "speechmatics:voice-id")?.disabled).toBeNull();
    // Without a key it still needs the key first.
    expect(option(resolveSelection({ ...LOCAL, sttLive: "speechmatics:standard" }, ctx()), "speaker-embedding", "speechmatics:voice-id")?.disabled).toEqual({ code: "key", service: "speechmatics" });
    const voiceId = { ...LOCAL, sttLive: "speechmatics:enhanced", speakerEmbedding: "speechmatics:voice-id" };
    expect(dataFlow(voiceId)).toEqual({ live: "speechmatics", final: null, voiceId: "speechmatics", summary: false });
  });

  it("resolves pinned model names that aren't listed", () => {
    expect(serviceOption("soniox:stt-rt-v9")).toMatchObject({ service: "soniox", model: "stt-rt-v9", kind: "live-stream" });
    expect(serviceOption("cloud")?.id).toBe("cloud-summary");
    expect(serviceOption("whisper")).toBeUndefined();
    const r = resolveSelection({ ...LOCAL, sttLive: "soniox:stt-rt-v9" }, ctx({ secrets: ["soniox_api_key"] }));
    expect(option(r, "stt-live", "soniox:stt-rt-v9")).toMatchObject({ group: "cloud", disabled: null });
  });
});

describe("repairing a selection", () => {
  it("resets options whose key was removed, and voice ID that depended on them, to the fallback", () => {
    const models = { ...LOCAL, sttLive: "speechmatics:enhanced", speakerEmbedding: "speechmatics:voice-id", summary: "cloud-summary" };
    const withKey = repairSelection(models, { language: "en", hasSecret: () => true }, LOCAL);
    expect(withKey.reset).toEqual([]);
    const soniox = repairSelection({ ...models, sttFinal: "soniox-async:stt-async-v5" }, { language: "en", hasSecret: (n) => n === "speechmatics_api_key" }, LOCAL);
    expect(soniox.reset).toEqual(["stt-final"]);
    const gone = repairSelection(models, { language: "en", hasSecret: (n) => n === "soniox_api_key" }, LOCAL);
    expect(gone.reset).toEqual(["stt-live", "speaker-embedding"]);
    // The summary endpoint isn't a key; it stays.
    expect(gone.models).toEqual({ ...LOCAL, summary: "cloud-summary" });
  });

  it("resets a live option that doesn't support a new language and voice ID with it", () => {
    const models = { ...LOCAL, sttLive: "speechmatics:enhanced", speakerEmbedding: "speechmatics:voice-id" };
    const r = repairSelection(models, { language: "auto", hasSecret: () => true }, { ...LOCAL, sttLive: "whisper-auto" });
    expect(r.models).toMatchObject({ sttLive: "whisper-auto", speakerEmbedding: "campplus" });
  });
});

describe("settings migration", () => {
  it("turns provider soniox into a Soniox live captions option and drops retired fields", () => {
    const out = migrateSettings({ provider: "soniox", sonioxModel: "stt-rt-v4", language: "en", models: { ...LOCAL, summary: "cloud" } });
    expect(out).not.toHaveProperty("provider");
    expect(out).not.toHaveProperty("sonioxModel");
    expect(out.models).toEqual({ ...LOCAL, sttLive: "soniox:stt-rt-v4", summary: "cloud-summary" });
    expect((out.cloudConsent as Record<string, string>).soniox).toBeTruthy();
  });

  it("leaves local settings unchanged apart from the retired fields", () => {
    expect(migrateSettings({ provider: "local", sonioxModel: "stt-rt-v5", language: "ja", models: LOCAL })).toEqual({ language: "ja", models: LOCAL });
    expect(migrateSettings({})).toEqual({});
  });

  it("maps recordings made with provider soniox and no snapshot to the Soniox rules", () => {
    const locks = recordingLocks({ provider: "soniox", models: LOCAL });
    expect(locks).toMatchObject({ vad: "soniox:stt-rt-v5", "stt-final": "soniox:stt-rt-v5" });
    expect(recordingLocks({ provider: "local", models: LOCAL })["stt-final"]).toBeNull();
    const snap = selectionLocks({ ...LOCAL, sttLive: "speechmatics:enhanced" });
    expect(recordingLocks({ provider: "speechmatics", models: LOCAL, selection: { locks: snap } })).toBe(snap);
  });
});
