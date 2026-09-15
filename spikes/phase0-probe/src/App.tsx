import { createEffect, createSignal, For, type Component } from "solid-js";
import { launchNumber } from "./lifecycle";
import { lsGet, lsSet } from "./report";
import { CapabilitiesPanel } from "./panels/CapabilitiesPanel";
import { CapturePanel } from "./panels/CapturePanel";
import { StoragePanel } from "./panels/StoragePanel";
import { SecretsPanel } from "./panels/SecretsPanel";
import { SonioxPanel } from "./panels/SonioxPanel";
import { SpeechmaticsPanel } from "./panels/SpeechmaticsPanel";
import { ModelsPanel } from "./panels/ModelsPanel";
import { OverviewPanel } from "./panels/OverviewPanel";

interface Tab {
  id: string;
  title: string;
  Panel: Component;
}

const tabs: Tab[] = [
  { id: "overview", title: "Overview", Panel: OverviewPanel },
  { id: "capabilities", title: "Capabilities", Panel: CapabilitiesPanel },
  { id: "capture", title: "Capture", Panel: CapturePanel },
  { id: "storage", title: "Storage", Panel: StoragePanel },
  { id: "secrets", title: "Secrets", Panel: SecretsPanel },
  { id: "soniox", title: "Soniox", Panel: SonioxPanel },
  { id: "speechmatics", title: "Speechmatics", Panel: SpeechmaticsPanel },
  { id: "models", title: "Models", Panel: ModelsPanel },
];

export function App() {
  const [current, setCurrent] = createSignal(lsGet("probe.tab") ?? "overview");
  createEffect(current, (id) => lsSet("probe.tab", id));

  return (
    <>
      <header class="top">
        <strong>Phase 0 Probe</strong>
        <span class="muted">
          v{__APP_VERSION__} · launch #{launchNumber}
        </span>
        <span class={["pill", { ok: crossOriginIsolated, bad: !crossOriginIsolated }]}>
          {crossOriginIsolated ? "cross-origin isolated" : "NOT isolated"}
        </span>
      </header>
      <nav class="tabs">
        <For each={tabs}>
          {(tab) => (
            <button type="button" aria-selected={current() === tab.id ? "true" : "false"} onClick={() => setCurrent(tab.id)}>
              {tab.title}
            </button>
          )}
        </For>
      </nav>
      {/* Every panel stays mounted so long-running soak tests survive tab switches. */}
      <main>
        <For each={tabs}>
          {(tab) => (
            <div hidden={current() !== tab.id}>
              <tab.Panel />
            </div>
          )}
        </For>
      </main>
    </>
  );
}
