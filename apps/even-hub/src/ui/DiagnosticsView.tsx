import { createSignal, For, onSettled, Show } from "solid-js";
import { t } from "@irl/i18n";
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
        engines: { policy: a.engines.policy, computeMode: a.engines.computeMode, benchmarks: a.engines.benchmarks.length },
        recovered: a.recovered.map((r) => ({ id: r.recording.id, readableChunks: r.readableChunks, badChunks: r.badChunks, audioLost: r.audioLost })),
      };
    },
  );
  const [preferTurso, setPreferTurso] = createSignal(localStorage.getItem("irl.storage.preferTurso") !== "0");

  return (
    <>
      <a href="#/settings" class="small">
        {t().nav.settings}
      </a>
      <h1>{t().diagnostics.title}</h1>
      <Show when={info.value()}>
        {(i) => (
          <div class="panel">
            <h2>{t().diagnostics.device}</h2>
            <table class="kv">
              <tbody>
                <tr><th>{t().diagnostics.evenApp}</th><td>{i().inEvenApp ? t().diagnostics.yes : t().diagnostics.noBrowser}</td></tr>
                <tr><th>{t().diagnostics.database}</th><td>{i().storage.database}{i().storage.fallbackReasons.length ? ` (${i().storage.fallbackReasons.join("; ")})` : ""}</td></tr>
                <tr><th>{t().diagnostics.audioFiles}</th><td>{i().storage.blobs}</td></tr>
                <tr><th>{t().diagnostics.storageUsed}</th><td>{t().diagnostics.storage(i().storage.usageBytes !== null ? bytes(i().storage.usageBytes!) : "?", i().storage.quotaBytes !== null ? bytes(i().storage.quotaBytes!) : "?", String(i().storage.persisted))}</td></tr>
                <tr><th>WebGPU</th><td>{i().capabilities.webgpu.available ? `${i().capabilities.webgpu.vendor ?? ""} ${i().capabilities.webgpu.architecture ?? ""}, shader-f16: ${i().capabilities.webgpu.shaderF16}, max buffer ${bytes(i().capabilities.webgpu.maxBufferSize ?? 0)}` : t().diagnostics.unavailable(i().capabilities.webgpu.error ?? "")}</td></tr>
                <tr><th>WASM</th><td>SIMD {String(i().capabilities.wasmSimd)}, threads {String(i().capabilities.wasmThreads)}</td></tr>
                <tr><th>Isolation</th><td>secure {String(i().capabilities.secureContext)}, cross-origin isolated {String(i().capabilities.crossOriginIsolated)}</td></tr>
                <tr><th>Opus</th><td>{String(i().capabilities.webCodecsOpus)}</td></tr>
                <tr><th>{t().diagnostics.platform}</th><td>{i().capabilities.platform}, {i().capabilities.hardwareConcurrency} cores, {i().capabilities.deviceMemoryGb ?? "?"} GB</td></tr>
                <tr><th>{t().diagnostics.glassesErrors}</th><td>{i().glassesUiFailures}</td></tr>
              </tbody>
            </table>
          </div>
        )}
      </Show>
      <div class="panel">
        <h2>{t().diagnostics.logs}</h2>
        <p class="small muted">{t().diagnostics.logsNote}</p>
        <pre class="diag">{lines().map((l) => `${l.t.slice(11, 23)} ${l.level} [${l.scope}] ${l.message}`).join("\n")}</pre>
        <div class="row">
          <Button label={t().diagnostics.download} onClick={() => download(`irl-diagnostics-${Date.now()}.json`, new Blob([diagnosticsText({ info: info.value() })], { type: "application/json" }))} />
          <Button
            label={t().diagnostics.copy}
            onClick={async () => {
              await navigator.clipboard.writeText(diagnosticsText({ info: info.value() }));
              toast(t().diagnostics.copied);
            }}
          />
        </div>
      </div>
      <div class="panel">
        <h2>{t().diagnostics.developer}</h2>
        <label class="check">
          <input
            type="checkbox"
            checked={preferTurso()}
            onChange={(e) => {
              localStorage.setItem("irl.storage.preferTurso", e.currentTarget.checked ? "1" : "0");
              setPreferTurso(e.currentTarget.checked);
              toast(t().diagnostics.preferTursoToast);
            }}
          />
          <span>{t().diagnostics.preferTurso}</span>
        </label>
        <div class="row">
          <Button
            label={t().diagnostics.deleteModels}
            kind="danger"
            onClick={async () => {
              if (!confirm(t().diagnostics.deleteModelsConfirm)) return;
              await app().engines.release(["audio", "asr", "llm", "stream"]);
              await clearModelCache();
              app().engines.forgetDownloads();
              toast(t().diagnostics.modelsDeleted);
            }}
          />
          <Button label={t().diagnostics.reload} onClick={() => location.reload()} />
        </div>
        <details>
          <summary>{t().diagnostics.benchmarks}</summary>
          <pre class="diag">
            <For each={app().engines.benchmarks}>{(b) => `${b.modelId} ${b.target} ok=${b.ok} rtf=${b.realTimeFactor?.toFixed(3) ?? "-"} tps=${b.tokensPerSecond?.toFixed(1) ?? "-"} ${b.knownAnswer?.detail ?? b.error ?? ""}\n`}</For>
          </pre>
        </details>
      </div>
    </>
  );
}
