import { afterEach, describe, expect, it } from "vitest";
import { G2_MENU_LABEL_MAX_BYTES, PROFILE_NAME_MAX_BYTES, UI_LOCALES, UserError, utf8ByteLength } from "@irl/domain";
import { describer, en, fmt, formatters, ja, keyPaths, locale, localeChanges, matchLocale, messages, resolveLocale, setLocale, t } from "../src";

describe("locale resolution", () => {
  it("matches the first supported primary language", () => {
    expect(matchLocale(["ja-JP", "en-US"])).toBe("ja");
    expect(matchLocale(["fr-FR", "ja"])).toBe("ja");
    expect(matchLocale(["en_GB"])).toBe("en");
  });

  it("falls back to English", () => {
    expect(matchLocale(["fr-FR", "de"])).toBe("en");
    expect(matchLocale([])).toBe("en");
  });

  it("uses an explicit choice over the phone's languages", () => {
    expect(resolveLocale("system", ["ja-JP"])).toBe("ja");
    expect(resolveLocale("en", ["ja-JP"])).toBe("en");
    expect(resolveLocale("ja", ["en-US"])).toBe("ja");
  });
});

describe("catalogs", () => {
  it("every locale has every English key", () => {
    const want = keyPaths(en).sort();
    for (const l of UI_LOCALES) expect(keyPaths(messages(l)).sort()).toEqual(want);
  });

  it("every function takes the same arguments in every locale", () => {
    const get = (o: object, path: string) => path.split(".").reduce<unknown>((x, k) => (x as Record<string, unknown>)[k], o);
    for (const path of keyPaths(en)) {
      const base = get(en, path);
      for (const l of UI_LOCALES) {
        const v = get(messages(l), path);
        expect(typeof v, `${l}:${path}`).toBe(typeof base);
        if (typeof base === "function") expect((v as () => string).length, `${l}:${path}`).toBe((base as () => string).length);
      }
    }
  });

  it("leaves no English in Japanese beyond names and technical terms", () => {
    // Brand and product names, units, and tokens that stay Latin in Japanese UI text.
    const allowed = new Set([
      "common.appName", "settings.version", "diagnostics.webgpu", "settings.computeWebGpu", "settings.computeCpu", "glasses.profileActive",
      // Punctuation-only templates around values.
      "boot.step", "settings.downloadCount", "settings.bytesOf", "glasses.audioTag", "speakers.maybe", "selection.withModel", "stages.fromService", "dataFlow.sentence",
    ]);
    const get = (o: object, path: string) => path.split(".").reduce<unknown>((x, k) => (x as Record<string, unknown>)[k], o);
    const sample = (v: unknown): string => (typeof v === "function" ? String((v as (...a: unknown[]) => unknown)(...Array.from({ length: v.length }, () => "x"))) : String(v));
    for (const path of keyPaths(en)) {
      if (allowed.has(path)) continue;
      const text = sample(get(ja, path));
      expect(/[\u3040-\u30ff\u3400-\u9fff]/.test(text), `ja:${path} "${text}"`).toBe(true);
      expect(text, `ja:${path} copies English`).not.toBe(sample(get(en, path)));
    }
  });
});

describe("active locale", () => {
  afterEach(() => setLocale("en"));

  it("switches messages and formatters and notifies", () => {
    const seen: string[] = [];
    const off = localeChanges.on((l) => seen.push(l));
    setLocale("ja");
    expect(locale()).toBe("ja");
    expect(t().common.close).toBe("閉じる");
    expect(fmt().seconds(3)).toBe("3秒");
    setLocale("ja");
    off();
    expect(seen).toEqual(["ja"]);
  });
});

describe("formatters", () => {
  const now = new Date(2026, 8, 15, 18, 0);
  const earlier = new Date(2026, 8, 15, 14, 5).toISOString();
  const yesterday = new Date(2026, 8, 14, 14, 5).toISOString();

  it("formats dates in English", () => {
    const f = formatters("en", messages("en"));
    expect(f.when(earlier, now)).toBe("Today, 2:05 PM");
    expect(f.when(yesterday, now)).toBe("Sep 14, 2:05 PM");
    expect(f.when(null, now)).toBe("");
  });

  it("formats dates in Japanese", () => {
    const f = formatters("ja", messages("ja"));
    expect(f.when(earlier, now)).toBe("今日 14:05");
    expect(f.when(yesterday, now)).toBe("9月14日 14:05");
  });

  it("formats numbers, sizes, and language names", () => {
    const e = formatters("en", messages("en"));
    const j = formatters("ja", messages("ja"));
    expect(e.bytes(1.5 * 2 ** 30)).toBe("1.5 GB");
    expect(e.bytes(300 * 2 ** 20)).toBe("300 MB");
    expect(e.percent(0.42)).toBe("42%");
    expect(e.seconds(12)).toBe("12 s");
    expect(j.seconds(12)).toBe("12秒");
    expect(e.language("ja")).toBe("Japanese");
    expect(j.language("ja")).toBe("日本語");
    expect(j.language("en")).toBe("英語");
    expect(e.list(["Soniox", "Speechmatics"])).toBe("Soniox & Speechmatics");
  });
});

describe("describer", () => {
  const en = describer("en", messages("en"));
  const ja = describer("ja", messages("ja"));

  it("says where data goes", () => {
    expect(en.dataFlow({ live: null, final: null, voiceId: null, summary: false })).toBe("Everything stays on this phone.");
    expect(en.dataFlow({ live: "soniox", final: null, voiceId: null, summary: false })).toBe("Audio goes to Soniox while recording; voices are matched on this phone.");
    expect(en.dataFlow({ live: "speechmatics", final: "speechmatics", voiceId: "speechmatics", summary: true })).toBe(
      "Audio goes to Speechmatics while recording and after you stop; Speechmatics recognizes saved voices and keeps their voiceprints; transcript text goes to the cloud summary service.",
    );
    expect(ja.dataFlow({ live: "soniox", final: null, voiceId: null, summary: false })).toBe("録音中は音声が Soniox に送られます。声の照合はこのスマートフォンで行います。");
  });

  it("explains blocked options", () => {
    expect(en.blocker({ code: "key", service: "speechmatics" })).toBe("Save a Speechmatics key");
    expect(en.blocker({ code: "language", language: "auto" })).toBe("Doesn't support Automatic (best effort)");
    expect(en.blocker({ code: "needs-service", service: "speechmatics", roles: ["stt-live", "stt-final"] })).toBe("Needs Speechmatics live captions or final transcript");
    expect(ja.blocker({ code: "language", language: "de" })).toBe("ドイツ語には対応していません");
    expect(ja.lock({ by: "soniox:stt-rt-v5", service: "soniox", kind: "live-stream" }, "stt-final")).toEqual({ label: "Soniox が担当", reason: "Soniox の確定字幕がそのまま文字起こしになります。" });
  });

  it("names cloud options as the domain registry did", () => {
    const names = (d: typeof en) => ["soniox:stt-rt-v5", "soniox:stt-rt-v4", "speechmatics:enhanced", "speechmatics-batch:enhanced", "soniox-async:stt-async-v5", "speechmatics:voice-id", "cloud-summary"].map((id) => d.optionName({ id, label: id, group: "cloud" }, "stt-live"));
    expect(names(en)).toEqual(["Soniox", "Soniox (stt-rt-v4)", "Speechmatics (enhanced)", "Speechmatics (enhanced, after you stop)", "Soniox (after you stop)", "Speechmatics voice identification", "Cloud summary service (sends transcript only)"]);
    expect(en.optionName({ id: "off", label: "", group: "special" }, "stt-live")).toBe("Off (capture now, process later)");
    expect(ja.optionName({ id: "same-as-live", label: "", group: "special" }, "stt-final")).toBe("ライブ字幕と同じ");
  });

  it("renders degraded reasons, errors, notes, and match failures", () => {
    expect(en.degraded({ code: "reconnecting", service: "soniox" })).toBe("Soniox reconnecting — audio is still saving");
    expect(ja.degraded({ code: "not-downloaded", part: "captions" })).toBe("字幕モデルが未ダウンロード — 後で処理します");
    expect(en.error(new UserError("key-missing", "No Soniox API key saved", { service: "soniox" }))).toBe("Save a Soniox key in Settings first.");
    expect(ja.error(new Error("boom"))).toBe("boom");
    expect(en.liveProblem({ during: "start", detail: "x", code: "glasses-audio" })).toBe("Could not start capture: Couldn't open the glasses microphones. Are the glasses connected?");
    expect(en.stageNote({ code: "words", words: 12, speakers: 2, service: "speechmatics", language: "ja" })).toBe("12 words, 2 speakers from Speechmatics, language Japanese");
    expect(ja.stageNote({ code: "recognized", recognized: 1, total: 3 })).toBe("話者3人中1人を認識");
    expect(en.matchFailure({ criterion: "evidence", value: 2000, threshold: 8000 })).toBe("speech 2.0 s < 8 s");
    expect(ja.matchFailure({ criterion: "agreement", value: 0.5, threshold: 0.6 })).toBe("一致率 50% < 60%");
    expect(en.keyTest({ ok: false, code: "rejected", message: "" }, "speechmatics")).toContain("region");
  });

  it("describes where a recording was processed", () => {
    expect(en.recordingServices({ services: [], local: true })).toBe("On-device");
    expect(en.recordingServices({ services: ["speechmatics"], local: true })).toBe("Speechmatics + on-device");
    expect(ja.recordingServices({ services: ["soniox"], local: false })).toBe("Soniox");
  });
});

describe("glasses budgets", () => {
  it("every menu label fits the G2's 32-byte limit untruncated, in every locale", () => {
    for (const l of UI_LOCALES) {
      for (const [key, text] of Object.entries(messages(l).glasses.menu)) expect(utf8ByteLength(text), `${l}:${key} "${text}"`).toBeLessThanOrEqual(G2_MENU_LABEL_MAX_BYTES);
    }
  });

  it("the active profile marker leaves room for a full-length profile name in the menu label", () => {
    for (const l of UI_LOCALES) {
      expect(utf8ByteLength(messages(l).glasses.profileActive("a".repeat(PROFILE_NAME_MAX_BYTES))), l).toBeLessThanOrEqual(G2_MENU_LABEL_MAX_BYTES);
    }
  });

  it("anonymous speaker words leave room for a name on the caption line", () => {
    for (const l of UI_LOCALES) {
      const s = messages(l).speakers;
      expect(utf8ByteLength(s.speaker(12)), l).toBeLessThanOrEqual(24);
      expect(utf8ByteLength(s.maybe("")), l).toBeLessThanOrEqual(6);
    }
  });
});
