import { Emitter, UI_LOCALES, type UiLocale } from "@irl/domain";
import { en, type Messages } from "./catalogs/en";
import { ja } from "./catalogs/ja";
import { describer, type Describer } from "./describe";
import { formatters, type Formatters } from "./format";
import { withFallback } from "./merge";

export { en, type Messages } from "./catalogs/en";
export { ja } from "./catalogs/ja";
export { describer, type Describer } from "./describe";
export { formatters, type Formatters } from "./format";
export { matchLocale, resolveLocale, systemLanguages } from "./locale";
export { keyPaths, withFallback, type DeepPartial } from "./merge";

const catalogs: Record<UiLocale, Messages> = { en, ja: withFallback(en, ja) };

/** Each UI locale's name in its own language, for the language picker. */
export const LOCALE_NAMES: Record<UiLocale, string> = { en: "English", ja: "日本語" };

export function messages(locale: UiLocale): Messages {
  return catalogs[locale];
}

let current: UiLocale = "en";
let currentFormat = formatters(current, catalogs[current]);
let currentDescribe = describer(current, catalogs[current]);

/** Fires after the active UI locale changes. */
export const localeChanges = new Emitter<UiLocale>();

export function locale(): UiLocale {
  return current;
}

export function setLocale(next: UiLocale): void {
  if (next === current || !UI_LOCALES.includes(next)) return;
  current = next;
  currentFormat = formatters(next, catalogs[next]);
  currentDescribe = describer(next, catalogs[next]);
  localeChanges.emit(next);
}

/** The active locale's messages. Read at render time, not captured at module load. */
export function t(): Messages {
  return catalogs[current];
}

/** Formatters for the active locale. */
export function fmt(): Formatters {
  return currentFormat;
}

/** Domain codes as sentences in the active locale. */
export function describe(): Describer {
  return currentDescribe;
}
