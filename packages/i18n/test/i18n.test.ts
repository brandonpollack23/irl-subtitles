import { afterEach, describe, expect, it } from "vitest";
import { UI_LOCALES } from "@irl/domain";
import { en, fmt, formatters, keyPaths, locale, localeChanges, matchLocale, messages, resolveLocale, setLocale, t, withFallback } from "../src";

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

  it("fills missing strings from the base catalog", () => {
    const merged = withFallback({ a: "A", g: { b: "B", c: (n: number) => `C${n}` } }, { g: { b: "ビー" } });
    expect(merged).toMatchObject({ a: "A", g: { b: "ビー" } });
    expect(merged.g.c(2)).toBe("C2");
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
