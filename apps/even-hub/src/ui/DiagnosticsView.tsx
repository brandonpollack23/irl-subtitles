import { createSignal, For, onSettled, Show } from "solid-js";
import { storageEstimate } from "@irl/storage";
import { clearModelCache } from "@irl/provider-local";
import { diagnosticsText, logEvents, logLines, type LogLine } from "../log";
import { app, Button, bytes, download, toast, useData } from "./lib";

export function DiagnosticsView() {
  const [lines, setLines] = createSignal<readonly LogLine[]>([...logLines()].slice(-200), { ownedWrite: true });
  onSettled(() => logEvents.on(() => setLines([...logLines()].slice(-200))));
  const info = useData(
    () => 0,
    async () => {
      const a = app();
      return {
        storage: { ...a.storage.diagnostics, ...(await storageEstimate()) },
        capabilities: a.caps,
        inEvenApp: a.inEvenApp,
        glassesUiFailures: a.glasses.failures,
        engines: { policy: a.engines.policy, benchmarks: a.engines.benchmarks.length },
        recovered: a.recovered.map((r) => ({ id: r.recording.id, readableChunks: r.readableChunks, badChunks: r.badChunks, audioLost: r.audioLost })),
      };
    },
  );
  const [preferTurso, setPreferTurso] = createSignal(localStorage.getItem("irl.storage.preferTurso") !== "0");

  return (
    <>
      <a href="#/settings" class="small">
        Settings
      </a>
      <h1>Diagnostics</h1>
      <Show when={info.value()}>
        {(i) => (
          <div class="panel">
            <h2>This device</h2>
            <table class="kv">
              <tbody>
                <tr><th>Even app</th><td>{i().inEvenApp ? "yes" : "no (browser)"}</td></tr>
                <tr><th>Database</th><td>{i().storage.database}{i().storage.fallbackReasons.length ? ` (${i().storage.fallbackReasons.join("; ")})` : ""}</td></tr>
                <tr><th>Audio files</th><td>{i().storage.blobs}</td></tr>
                <tr><th>Storage used</th><td>{i().storage.usageBytes !== null ? bytes(i().storage.usageBytes!) : "?"} of {i().storage.quotaBytes !== null ? bytes(i().storage.quotaBytes!) : "?"}, persistent: {String(i().storage.persisted)}</td></tr>
                <tr><th>WebGPU</th><td>{i().capabilities.webgpu.available ? `${i().capabilities.webgpu.vendor ?? ""} ${i().capabilities.webgpu.architecture ?? ""}, shader-f16: ${i().capabilities.webgpu.shaderF16}, max buffer ${bytes(i().capabilities.webgpu.maxBufferSize ?? 0)}` : `unavailable (${i().capabilities.webgpu.error})`}</td></tr>
                <tr><th>WASM</th><td>SIMD {String(i().capabilities.wasmSimd)}, threads {String(i().capabilities.wasmThreads)}</td></tr>
                <tr><th>Isolation</th><td>secure {String(i().capabilities.secureContext)}, cross-origin isolated {String(i().capabilities.crossOriginIsolated)}</td></tr>
                <tr><th>Opus</th><td>{String(i().capabilities.webCodecsOpus)}</td></tr>
                <tr><th>Platform</th><td>{i().capabilities.platform}, {i().capabilities.hardwareConcurrency} cores, {i().capabilities.deviceMemoryGb ?? "?"} GB</td></tr>
                <tr><th>Glasses UI errors</th><td>{i().glassesUiFailures}</td></tr>
              </tbody>
            </table>
          </div>
        )}
      </Show>
      <div class="panel">
        <h2>Logs</h2>
        <p class="small muted">Secrets are always removed. Transcript text is removed unless you allow it in Settings.</p>
        <pre class="diag">{lines().map((l) => `${l.t.slice(11, 23)} ${l.level} [${l.scope}] ${l.message}`).join("\n")}</pre>
        <div class="row">
          <Button label="Download diagnostics" onClick={() => download(`irl-diagnostics-${Date.now()}.json`, new Blob([diagnosticsText({ info: info.value() })], { type: "application/json" }))} />
          <Button
            label="Copy diagnostics"
            onClick={async () => {
              await navigator.clipboard.writeText(diagnosticsText({ info: info.value() }));
              toast("Copied");
            }}
          />
        </div>
      </div>
      <div class="panel">
        <h2>Developer</h2>
        <label class="check">
          <input
            type="checkbox"
            checked={preferTurso()}
            onChange={(e) => {
              localStorage.setItem("irl.storage.preferTurso", e.currentTarget.checked ? "1" : "0");
              setPreferTurso(e.currentTarget.checked);
              toast("Applies after restarting the app. Data in the other backend isn't migrated.");
            }}
          />
          <span>Use Turso database when the page is cross-origin isolated</span>
        </label>
        <div class="row">
          <Button
            label="Delete downloaded models"
            kind="danger"
            onClick={async () => {
              if (!confirm("Delete all downloaded models? They download again when needed.")) return;
              await app().engines.release(["audio", "asr", "llm", "stream"]);
              await clearModelCache();
              app().engines.forgetDownloads();
              toast("Models deleted");
            }}
          />
          <Button label="Reload app" onClick={() => location.reload()} />
        </div>
        <details>
          <summary>Benchmark results</summary>
          <pre class="diag">
            <For each={app().engines.benchmarks}>{(b) => `${b.modelId} ${b.target} ok=${b.ok} rtf=${b.realTimeFactor?.toFixed(3) ?? "-"} tps=${b.tokensPerSecond?.toFixed(1) ?? "-"} ${b.knownAnswer?.detail ?? b.error ?? ""}\n`}</For>
          </pre>
        </details>
      </div>
    </>
  );
}
