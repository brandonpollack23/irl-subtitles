import { createSignal, Show } from "solid-js";
import { ActionButton, Card, createLog, createReporter, KeyValue, LogView, ReportCard } from "../components";
import { enableIsolationServiceWorker, removeServiceWorkers, runInventory } from "../spikes/capabilities";
import { summarizeWebGPU, type WebGPUProbe } from "../spikes/webgpu-probe";

type Inventory = Awaited<ReturnType<typeof runInventory>>;

function summarize(data: Inventory): Record<string, unknown> {
  const worker = data.worker as { webgpu?: WebGPUProbe | { error: string }; opfsSyncAccessHandle?: unknown };
  return {
    secureContext: data.platform.location.isSecureContext,
    "WebGPU (main)": summarizeWebGPU(data.webgpuMain as WebGPUProbe | { error: string }),
    "WebGPU (worker)": summarizeWebGPU(worker.webgpu),
    crossOriginIsolated: data.platform.crossOriginIsolated,
    wasmSimd: data.platform.wasm.simd,
    opfsSyncInWorker: worker.opfsSyncAccessHandle,
  };
}

export function CapabilitiesPanel() {
  const log = createLog();
  const reporter = createReporter("capabilities");
  const [summary, setSummary] = createSignal<Record<string, unknown> | null>(null);

  const run = async () => {
    const data = await runInventory(log.log);
    setSummary(summarize(data));
    log.log("done");
    await reporter.publish(data);
  };

  return (
    <>
      <Card title="Spike irl-subt-0i6.2 — WebGPU & platform inventory">
        <p class="muted">
          Run in the Even app (sideload and packaged .ehpk), Android Chrome, and iOS Safari. Never enable browser flags or
          Safari feature flags.
        </p>
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
