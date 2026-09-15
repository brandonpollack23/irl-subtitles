import type { UiLocale } from "@irl/domain";
import type { Messages } from "./catalogs/en";

/** Locale-aware formatting for the UI. Clock durations (formatClock, "12:05") are locale-neutral and stay in domain. */
export function formatters(locale: UiLocale, m: Messages) {
  const number = (n: number, digits = 0) => new Intl.NumberFormat(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);
  return {
    number,
    percent: (fraction: number) => new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 }).format(fraction),
    /** "12 s" / "12秒". */
    seconds: (s: number, digits = 0) => m.common.seconds(number(s, digits)),
    bytes: (n: number) => (n >= 2 ** 30 ? `${number(n / 2 ** 30, 1)} GB` : n >= 2 ** 20 ? `${number(n / 2 ** 20)} MB` : `${number(n / 1024)} KB`),
    /** Full date and time: exports and recovery notices. */
    dateTime: (iso: string) => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso)),
    /** Short list date: "Today, 2:05 PM", else "Sep 14, 2:05 PM" (「今日 14:05」「9月14日 14:05」). */
    when: (iso: string | null, now: Date = new Date()) => {
      if (!iso) return "";
      const d = new Date(iso);
      if (d.toDateString() === now.toDateString()) return m.format.today(new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(d));
      return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(d);
    },
    /** A language code as a name in the UI language ("ja" → "Japanese" / "日本語"). */
    language: (code: string) => {
      try {
        return new Intl.DisplayNames([locale], { type: "language" }).of(code) ?? code;
      } catch {
        return code;
      }
    },
    list: (items: readonly string[]) => new Intl.ListFormat(locale, { style: "short", type: "conjunction" }).format(items),
  };
}

export type Formatters = ReturnType<typeof formatters>;
