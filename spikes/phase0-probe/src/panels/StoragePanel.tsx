import { createSignal, onSettled, Show } from "solid-js";
import { ActionButton, Card, createLog, createReporter, Field, KeyValue, LogView, ReportCard } from "../components";
import { benchLatency, clearStorageSpike, TortureWriter, tortureWasInterrupted, verifyTorture } from "../spikes/storage";

export function StoragePanel() {
  const log = createLog();
  const reporter = createReporter("storage");
  const [chunks, setChunks] = createSignal(60);
  const [encrypt, setEncrypt] = createSignal(true);
  const [torture, setTorture] = createSignal<{ counter: number; rate: number } | null>(null);
  const [tortureRunning, setTortureRunning] = createSignal(false);
  const [interrupted, setInterrupted] = createSignal<string | null>(null);
  const writer = new TortureWriter((counter, rate) => setTorture({ counter, rate: Math.round(rate) }));

  onSettled(() => {
    setInterrupted(tortureWasInterrupted());
  });

  const bench = async () => {
    const r = await benchLatency({ chunks: chunks(), chunkSeconds: 5, encrypt: encrypt() }, log.log);
    await reporter.publish({ kind: "latency", ...r });
  };
  const startTorture = async () => {
    setTortureRunning(true);
    try {
      await writer.run(log.log);
    } finally {
      setTortureRunning(false);
    }
  };
  const verify = async () => {
    const r = await verifyTorture(log.log);
    setInterrupted(null);
    await reporter.publish({ kind: "torture-verify", ...r });
  };

  return (
    <>
      <Card title="Spike irl-subt-0i6.4 — Turso on OPFS vs IndexedDB">
        <Show when={interrupted()}>
          <p class="warn">
            Torture writer was running at last launch (since {interrupted()}) and never stopped cleanly. Run Verify now.
          </p>
        </Show>
        <h4>1. Write latency (5 s PCM chunks)</h4>
        <div class="row">
          <Field label="Chunks">
            <input type="number" min="1" value={chunks()} onChange={(e) => setChunks(Number(e.currentTarget.value))} />
          </Field>
          <label>
            <input type="checkbox" checked={encrypt()} onChange={(e) => setEncrypt(e.currentTarget.checked)} /> AES-GCM encrypt
          </label>
          <ActionButton label="Run latency bench" onRun={bench} />
        </div>
        <h4>2. Force-stop durability</h4>
        <p class="muted">
          Start the torture writer, then force-stop the Even app mid-write (runbook). Relaunch and press Verify. Repeat after
          installing a newer .ehpk for the upgrade test.
        </p>
        <div class="row">
          <ActionButton label="Start torture writer" onRun={startTorture} disabled={tortureRunning()} />
          <ActionButton label="Stop cleanly" onRun={() => writer.stop()} disabled={!tortureRunning()} />
          <ActionButton label="Verify" onRun={verify} disabled={tortureRunning()} />
        </div>
        <Show when={torture()}>{(t) => <KeyValue data={{ committedCounter: t().counter, rowsPerSec: t().rate }} />}</Show>
        <div class="row">
          <ActionButton label="Clear storage spike data" onRun={() => clearStorageSpike(log.log)} disabled={tortureRunning()} />
        </div>
        <LogView lines={log.lines()} />
      </Card>
      <ReportCard status={reporter.status()} json={reporter.json()} />
    </>
  );
}
