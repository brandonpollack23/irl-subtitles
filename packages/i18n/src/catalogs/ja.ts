import type { DeepPartial } from "../merge";
import type { Messages } from "./en";

/** Japanese. Missing keys fall back to English until the catalog is complete. */
export const ja: DeepPartial<Messages> = {
  common: {
    appName: "IRL Subtitles",
    close: "閉じる",
    save: "保存",
    cancel: "キャンセル",
    loading: "読み込み中…",
    undo: "元に戻す",
    seconds: (n) => `${n}秒`,
  },
  boot: {
    starting: "起動中",
    step: (step) => `${step}…`,
    failed: (detail) => `IRL Subtitles を起動できませんでした: ${detail}`,
  },
  format: {
    today: (time) => `今日 ${time}`,
  },
  display: {
    title: "表示言語",
    hint: "このスマートフォンとグラスでのアプリの言語です。録音の言語は下で別に設定します。",
    system: (current) => `スマートフォンの設定（${current}）`,
  },
};
