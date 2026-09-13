import type { JSX } from "@solidjs/web";
import { createEffect, createSignal, For, Show, type ParentComponent } from "solid-js";
import { publish } from "./report";

export const Card: ParentComponent<{ title: string }> = (props) => (
  <section class="card">
    <h3>{props.title}</h3>
    {props.children}
  </section>
);

/** Button that disables itself while its (possibly async) handler runs. */
export function ActionButton(props: { label: string; onRun: () => unknown; disabled?: boolean }) {
  const [busy, setBusy] = createSignal(false);
  const run = async () => {
    setBusy(true);
    try {
      await props.onRun();
    } catch (e) {
      console.error(e);
      alert(`${props.label} failed: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <button type="button" disabled={busy() || !!props.disabled} onClick={run}>
      {props.label}
    </button>
  );
}

export interface Log {
  lines: () => readonly string[];
  log: (...parts: unknown[]) => void;
}

export function createLog(max = 300): Log {
  const [lines, setLines] = createSignal<readonly string[]>([]);
  return {
    lines,
    log: (...parts) => {
      const t = new Date().toISOString().slice(11, 23);
      const text = parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ");
      setLines((prev) => [...prev, `${t} ${text}`].slice(-max));
    },
  };
}

export function LogView(props: { lines: readonly string[] }) {
  let el: HTMLPreElement | undefined;
  createEffect(
    () => props.lines.length,
    () => {
      if (el) el.scrollTop = el.scrollHeight;
    },
  );
  return (
    <pre class="log" ref={(e) => (el = e)}>
      {props.lines.join("\n")}
    </pre>
  );
}

export function KeyValue(props: { data: Record<string, unknown> }) {
  return (
    <table class="kv">
      <tbody>
        <For each={Object.entries(props.data)}>
          {(entry) => (
            <tr>
              <th>{entry[0]}</th>
              <td>{typeof entry[1] === "object" ? JSON.stringify(entry[1]) : String(entry[1])}</td>
            </tr>
          )}
        </For>
      </tbody>
    </table>
  );
}

export function Field(props: { label: string; children: JSX.Element }) {
  return (
    <label class="field">
      <span>{props.label}</span>
      {props.children}
    </label>
  );
}

export interface Reporter {
  status: () => string;
  json: () => string;
  publish: (data: unknown) => Promise<void>;
}

/** Publishes a spike report to the laptop sink; the JSON stays on screen as a copy fallback. */
export function createReporter(spike: string): Reporter {
  const [status, setStatus] = createSignal("");
  const [json, setJson] = createSignal("");
  return {
    status,
    json,
    async publish(data) {
      setStatus("uploading…");
      const { report, saved, error } = await publish(spike, data);
      setJson(JSON.stringify(report, null, 2));
      setStatus(saved ? `saved on laptop: ${saved}` : `NOT uploaded (${error}) — use Copy JSON`);
    },
  };
}

export function ReportCard(props: { status: string; json: string }) {
  let pre: HTMLPreElement | undefined;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(props.json);
    } catch {
      const range = document.createRange();
      range.selectNodeContents(pre!);
      getSelection()?.removeAllRanges();
      getSelection()?.addRange(range);
      document.execCommand("copy");
    }
  };
  return (
    <Show when={props.json}>
      <Card title="Report">
        <div class="muted">{props.status}</div>
        <ActionButton label="Copy JSON" onRun={copy} />
        <pre class="report" ref={(el) => (pre = el)}>
          {props.json}
        </pre>
      </Card>
    </Show>
  );
}
