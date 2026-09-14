import { For, Show } from "solid-js";
import { platformReport } from "../platform";
import { app } from "./lib";

/** Dev builds only: a corner badge naming the host and storage backends, expanding to what's available. */
export function DevPlatformMarker() {
  const a = app();
  const report = platformReport(a.caps, a.storage.diagnostics, a.inEvenApp);
  return (
    <details class="dev-marker">
      <summary>
        DEV · {report.host} · DB {report.database}
      </summary>
      <div class="dev-marker-body">
        <table class="kv small">
          <tbody>
            <tr><th>Host</th><td>{report.host}</td></tr>
            <tr><th>Engine</th><td>{report.engine}</td></tr>
            <tr><th>Database</th><td>{report.database}</td></tr>
            <tr><th>Audio files</th><td>{report.audio}</td></tr>
          </tbody>
        </table>
        <ul class="dev-features small">
          <For each={report.features}>
            {(f) => (
              <li class={f.ok ? "ok" : "missing"}>
                <span aria-hidden="true">{f.ok ? "✓" : "✗"}</span> {f.name}
                <span class="sr-only">{f.ok ? " available" : " unavailable"}</span>
                <Show when={f.detail}>{(d) => <span class="muted"> · {d()}</span>}</Show>
              </li>
            )}
          </For>
        </ul>
      </div>
    </details>
  );
}
