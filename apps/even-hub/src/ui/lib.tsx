import type { JSX } from "@solidjs/web";
import { createEffect, createSignal, onSettled, Show, type Accessor } from "solid-js";
import { errorMessage, formatClock, SAMPLE_RATE, splitSpeakerSpans, type ClusterId, type Settings, type SpeakerLabel } from "@irl/domain";
import type { AppServices } from "../services";

let services: AppServices;
export function setServices(s: AppServices): void {
  services = s;
}
export function app(): AppServices {
  return services;
}

// Routing -------------------------------------------------------------------------------------

export type Route =
  | { name: "history" }
  | { name: "live" }
  | { name: "recording"; id: string; focus?: string }
  | { name: "people" }
  | { name: "person"; id: string }
  | { name: "settings" }
  | { name: "diagnostics" }
  | { name: "evaluation" };

function parse(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
  switch (parts[0]) {
    case "live":
      return { name: "live" };
    case "rec":
      return parts[1] ? { name: "recording", id: parts[1], ...(parts[2] ? { focus: parts[2] } : {}) } : { name: "history" };
    case "people":
      return parts[1] ? { name: "person", id: parts[1] } : { name: "people" };
    case "settings":
      return { name: "settings" };
    case "diagnostics":
      return { name: "diagnostics" };
    case "evaluation":
      return { name: "evaluation" };
    default:
      return { name: "history" };
  }
}

const [route, setRoute] = createSignal<Route>(parse(location.hash), { ownedWrite: true });
addEventListener("hashchange", () => {
  setRoute(parse(location.hash));
  window.scrollTo(0, 0);
});
export { route };

export function go(hash: string): void {
  location.hash = hash;
}

// Data loading --------------------------------------------------------------------------------

const [dataVersion, setDataVersion] = createSignal(0, { ownedWrite: true });
export { dataVersion };
export function bumpData(): void {
  setDataVersion((v) => v + 1);
}

/**
 * Loads async data whenever `key` (or stored data) changes. Keeps the last value visible while reloading
 * so lists don't flash; errors are exposed rather than thrown into the tree.
 */
export function useData<K, T>(key: () => K, load: (k: K) => Promise<T>): { value: Accessor<T | undefined>; error: Accessor<string | null>; loading: Accessor<boolean>; reload: () => void } {
  const [value, setValue] = createSignal<T | undefined>(undefined, { ownedWrite: true });
  const [error, setError] = createSignal<string | null>(null, { ownedWrite: true });
  const [loading, setLoading] = createSignal(true, { ownedWrite: true });
  const [nonce, setNonce] = createSignal(0, { ownedWrite: true });
  let seq = 0;
  createEffect(
    () => [key(), dataVersion(), nonce()] as const,
    ([k]) => {
      const mine = ++seq;
      setLoading(true);
      load(k).then(
        (v) => {
          if (mine !== seq) return;
          setValue(() => v);
          setError(null);
          setLoading(false);
        },
        (e) => {
          if (mine !== seq) return;
          setError(errorMessage(e));
          setLoading(false);
        },
      );
    },
  );
  return { value, error, loading, reload: () => setNonce((n) => n + 1) };
}

/** Current settings as a signal that follows changes made anywhere, plus an updater. */
export function useSettings() {
  const [s, setS] = createSignal<Settings>(app().settings.get(), { ownedWrite: true });
  onSettled(() => app().settings.changes.on((next) => setS(() => next)));
  const update = async (patch: Partial<Settings>) => {
    await app().settings.update(patch);
  };
  return [s, update] as const;
}

// Formatting ----------------------------------------------------------------------------------

export function duration(samples: number): string {
  return formatClock(samples);
}

export function when(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay ? `Today, ${d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function bytes(n: number): string {
  if (n >= 2 ** 30) return `${(n / 2 ** 30).toFixed(1)} GB`;
  if (n >= 2 ** 20) return `${Math.round(n / 2 ** 20)} MB`;
  return `${Math.round(n / 1024)} KB`;
}

export function seconds(samples: number): number {
  return samples / SAMPLE_RATE;
}

export function speakerColor(ordinal: number | undefined): string {
  return `var(--spk-${((ordinal ?? 1) - 1) % 6})`;
}

// Components ----------------------------------------------------------------------------------

export function Button(props: { label: string; busyLabel?: string; onClick: () => unknown; kind?: "primary" | "danger" | "quiet" | "record"; disabled?: boolean; title?: string }) {
  const [busy, setBusy] = createSignal(false);
  const run = async () => {
    setBusy(true);
    try {
      await props.onClick();
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <button type="button" class={["btn", props.kind]} disabled={busy() || !!props.disabled} onClick={run} title={props.title}>
      {busy() ? (props.busyLabel ?? props.label) : props.label}
    </button>
  );
}

export function SpeakerName(props: { label: SpeakerLabel; ordinal?: number; onOpen: (clusterId: ClusterId) => void }) {
  return (
    <button
      type="button"
      class={["speaker", { possible: props.label.kind === "possible" }]}
      style={{ "--spk-color": speakerColor(props.ordinal) }}
      onClick={() => props.onOpen(props.label.clusterId)}
      title={props.label.kind === "auto" ? "Recognized automatically. Tap to correct." : props.label.kind === "confirmed" ? "Confirmed by you" : "Tap to name this speaker"}
    >
      {props.label.text}
    </button>
  );
}

/** Renders text with [[clusterId]] spans as tappable speaker names. */
export function SpanText(props: { text: string; label: (id: ClusterId) => SpeakerLabel; ordinal: (id: ClusterId) => number | undefined; onOpen: (id: ClusterId) => void }) {
  return (
    <>
      {splitSpeakerSpans(props.text).map((part) =>
        part.type === "text" ? part.text : <SpeakerName label={props.label(part.clusterId)} ordinal={props.ordinal(part.clusterId)} onOpen={props.onOpen} />,
      )}
    </>
  );
}

export function Sheet(props: { title: string; onClose: () => void; children: JSX.Element }) {
  let panel: HTMLDivElement | undefined;
  onSettled(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && props.onClose();
    addEventListener("keydown", onKey);
    panel?.focus();
    return () => removeEventListener("keydown", onKey);
  });
  return (
    <div class="sheet-backdrop" onClick={(e) => e.target === e.currentTarget && props.onClose()}>
      <div class="sheet" role="dialog" aria-modal="true" aria-label={props.title} tabindex="-1" ref={(el) => (panel = el)}>
        <div class="spread">
          <h2>{props.title}</h2>
          <button type="button" class="btn quiet" onClick={() => props.onClose()}>
            Close
          </button>
        </div>
        {props.children}
      </div>
    </div>
  );
}

// Toasts --------------------------------------------------------------------------------------

interface ToastState {
  text: string;
  action?: { label: string; run: () => unknown };
}
const [currentToast, setToast] = createSignal<ToastState | null>(null, { ownedWrite: true });
let toastTimer: ReturnType<typeof setTimeout> | null = null;

export function toast(text: string, action?: ToastState["action"], ms = 6000): void {
  setToast({ text, action });
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => setToast(null), ms);
}

export function ToastHost() {
  return (
    <Show when={currentToast()}>
      {(t) => (
        <div class="toast" role="status">
          <span>{t().text}</span>
          <Show when={t().action}>
            {(a) => (
              <button
                type="button"
                onClick={async () => {
                  setToast(null);
                  try {
                    await a().run();
                  } catch (e) {
                    toast(errorMessage(e));
                  }
                }}
              >
                {a().label}
              </button>
            )}
          </Show>
        </div>
      )}
    </Show>
  );
}

export function download(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
