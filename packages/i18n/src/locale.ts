import { UI_LOCALES, type UiLanguage, type UiLocale } from "@irl/domain";

/** The first supported locale among BCP-47 tags in preference order ("ja-JP" → "ja"); English otherwise. */
export function matchLocale(tags: readonly string[]): UiLocale {
  for (const tag of tags) {
    const primary = tag.toLowerCase().split(/[-_]/)[0];
    const hit = UI_LOCALES.find((l) => l === primary);
    if (hit) return hit;
  }
  return "en";
}

/** The phone's preferred languages as the WebView reports them; the Even Hub SDK exposes no locale of its own. */
export function systemLanguages(): readonly string[] {
  if (typeof navigator === "undefined") return [];
  return navigator.languages?.length ? navigator.languages : navigator.language ? [navigator.language] : [];
}

export function resolveLocale(preference: UiLanguage, system: readonly string[] = systemLanguages()): UiLocale {
  return preference === "system" ? matchLocale(system) : preference;
}
