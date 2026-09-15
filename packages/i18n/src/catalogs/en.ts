/**
 * English: the source catalog. Every key here must exist in every other catalog (checked by type and by test).
 * Parameterized strings are functions; keep grammar (plurals, word order) inside them.
 */
export const en = {
  common: {
    appName: "IRL Subtitles",
    close: "Close",
    save: "Save",
    cancel: "Cancel",
    loading: "Loading…",
    undo: "Undo",
    seconds: (n: string) => `${n} s`,
  },
  boot: {
    starting: "Starting",
    step: (step: string) => `${step}…`,
    failed: (detail: string) => `IRL Subtitles couldn't start: ${detail}`,
  },
  format: {
    today: (time: string) => `Today, ${time}`,
  },
  display: {
    title: "Display language",
    hint: "Language of the app on this phone and the glasses. Recording language is set separately below.",
    system: (current: string) => `Phone setting (${current})`,
  },
};

export type Messages = typeof en;
