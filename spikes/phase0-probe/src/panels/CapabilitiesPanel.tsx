import { createSignal, Show } from "solid-js";
import { ActionButton, Card, createLog, createReporter, KeyValue, LogView, ReportCard } from "../components";
import { enableIsolationServiceWorker, removeServiceWorkers, runInventory } from "../spikes/capabilities";

type Inventory = Awaited<ReturnType<typeof runInventory>>;

function summarize(data: Inventory): Record<string, unknown> {
  const webnn = data.webnnMain as { navigatorMl?: boolean; contexts?: { deviceType: string; created: boolean; knownAnswer?: { ok: boolean } }[] };
  const worker = data.worker as { webnn?: { navigatorMl?: boolean }; opfsSyncAccessHandle?: unknown };
  return {
    "navigator.ml (main)": webnn.navigatorMl ?? "error",
    "navigator.ml (worker)": worker.webnn?.navigatorMl ?? "error",
    contexts: (webnn.contexts ?? []).map((c) => `${c.deviceType}:${c.created ? (c.knownAnswer?.ok ? "ok" : "KAT-fail") : "no"}`).join(" "),
    crossOriginIsolated: data.platform.crossOriginIsolated,
    wasmSimd: data.platform.wasm.simd,
    opfsSyncInWorker: worker.opfsSyncAccessHandle,
  };
}

export function CapabilitiesPanel() {
  const log = createLog();
  const reporter = createReporter("capabilities");
  const [opLimits, setOpLimits] = createSignal(false);
  const [summary, setSummary] = createSignal<Record<string, unknown> | null>(null);

  const run = async () => {
    const data = await runInventory(log.log, opLimits());
    setSummary(summarize(data));
    log.log("done");
    await reporter.publish(data);
  };

  return (
    <>
      <Card title="Spike irl-subt-0i6.2 — WebNN & platform inventory">
        <p class="muted">
          Run in sideload mode (served with and without COOP/COEP) and from the packaged .ehpk. Never enable Chrome flags.
        </p>
        <label class="row">
          <input type="checkbox" checked={opLimits()} onChange={(e) => setOpLimits(e.currentTarget.checked)} />
          include full opSupportLimits (large)
        </label>
        <div class="row">
          <ActionButton label="Run inventory" onRun={run} />
          <ActionButton label="Try isolation via service worker" onRun={enableIsolationServiceWorker} />
          <ActionButton label="Remove service worker" onRun={removeServiceWorkers} />
        </div>
        <Show when={summary()}>{(s) => <KeyValue data={s()} />}</Show>
        <LogView lines={log.lines()} />
      </Card>
      <ReportCard status={reporter.status()} json={reporter.json()} />
    </>
  );
}
