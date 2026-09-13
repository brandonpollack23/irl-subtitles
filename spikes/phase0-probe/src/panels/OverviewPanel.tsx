import { createSignal, onSettled, Show } from "solid-js";
import { getBridge } from "../bridge";
import { ActionButton, Card, createLog, Field, KeyValue, LogView } from "../components";
import { launchNumber, onLifecycle } from "../lifecycle";
import { environment, setSinkUrl, setTester, sinkUrl, tester, type EnvironmentSummary } from "../report";

export function OverviewPanel() {
  const lifecycle = createLog(200);
  const [env, setEnv] = createSignal<EnvironmentSummary | null>(null);
  const refresh = async () => setEnv(await environment());

  onSettled(() => {
    void refresh();
    void getBridge().then((b) => lifecycle.log(b ? "Even bridge connected" : "no Even bridge (browser mode)"));
    return onLifecycle((ev, vis) => lifecycle.log(ev, vis));
  });

  const testSink = async () => {
    const r = await fetch(`${sinkUrl()}/report`, { method: "POST", body: JSON.stringify({ spike: "sink-test" }) });
    alert(r.ok ? "sink OK" : `sink HTTP ${r.status}`);
  };

  return (
    <>
      <Card title="Setup">
        <Field label="Device label (e.g. pixel10-pro)">
          <input value={tester() ?? ""} placeholder="device label" onChange={(e) => setTester(e.currentTarget.value.trim())} />
        </Field>
        <Field label="Report sink (laptop dev server)">
          <input value={sinkUrl()} onChange={(e) => setSinkUrl(e.currentTarget.value.trim())} />
        </Field>
        <div class="row">
          <ActionButton label="Test sink" onRun={testSink} />
          <ActionButton label="Refresh" onRun={refresh} />
        </div>
      </Card>
      <Card title="Environment">
        <Show when={env()}>
          {(e) => <KeyValue data={{ launch: launchNumber, appVersion: __APP_VERSION__, buildId: __BUILD_ID__, ...e() }} />}
        </Show>
      </Card>
      <Card title="Lifecycle events this launch">
        <LogView lines={lifecycle.lines()} />
      </Card>
    </>
  );
}
