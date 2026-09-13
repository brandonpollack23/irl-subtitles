import { createSignal, onSettled, Show } from "solid-js";
import { hud, MENU, onHubEvent } from "../bridge";
import { ActionButton, Card, createReporter, Field, KeyValue, ReportCard } from "../components";
import { uploadBinary } from "../report";
import { CaptureSoak, persistedWav, previousUnfinishedSession, type CaptureLive, type CaptureSource } from "../spikes/capture";
import { opfsFile } from "../util/opfs";

export function CapturePanel() {
  const reporter = createReporter("capture");
  const [live, setLive] = createSignal<CaptureLive | null>(null);
  const [source, setSource] = createSignal<CaptureSource>("glasses");
  const [persist, setPersist] = createSignal(true);
  const [autoRearm, setAutoRearm] = createSignal(false);
  const [lastPath, setLastPath] = createSignal<string | null>(null);
  const [uploadStatus, setUploadStatus] = createSignal("");
  const [previous, setPrevious] = createSignal<Record<string, unknown> | null>(null);
  const soak = new CaptureSoak(setLive);

  const start = async () => {
    await soak.start({ source: source(), persistPcm: persist(), autoRearm: autoRearm() });
    setLastPath(soak.persistPath);
  };
  const stop = async () => {
    const report = await soak.stop();
    if (report) await reporter.publish(report);
  };

  onSettled(() => {
    const prev = previousUnfinishedSession();
    if (prev) {
      void (async () => {
        const file = prev.persistPath ? await opfsFile(prev.persistPath) : null;
        const data = { ...prev, persistedBytesOnDisk: file?.size ?? null, detectedAtLaunchAfter: new Date().toISOString() };
        setPrevious(data);
        if (prev.persistPath) setLastPath(prev.persistPath);
        await reporter.publish({ kind: "unfinished-session-detected", ...data });
      })();
    }
    // The glasses menu drives the soak without touching the phone; Stop goes through stop() so it still reports.
    return onHubEvent((e) => {
      if (e.menuItemClickEvent?.itemID === MENU.startCapture && !soak.running) {
        start().catch((err) => void hud.setText(`Start failed:\n${String(err).slice(0, 200)}`));
      }
      if (e.menuItemClickEvent?.itemID === MENU.stopCapture && soak.running) void stop();
    });
  });

  const upload = async () => {
    const path = lastPath();
    const wav = path ? await persistedWav(path) : null;
    if (!wav) return setUploadStatus("no persisted recording found");
    const name = `${path!.split("/").pop()!.replace(".pcm", "")}.wav`;
    await uploadBinary(name, wav, (sent) => setUploadStatus(`uploaded ${(sent / 2 ** 20).toFixed(1)} / ${(wav.size / 2 ** 20).toFixed(1)} MiB`));
    setUploadStatus(`uploaded results/recordings/${name}`);
  };

  return (
    <>
      <Card title="Spike irl-subt-0i6.1 — 60-minute G2 capture soak">
        <p class="muted">
          Start, then lock the phone / switch apps per the runbook. The glasses menu has Start / Stop / Marker.
        </p>
        <Show when={previous()}>
          {(p) => (
            <div class="warn">
              Previous launch ended without Stop — reported automatically.
              <KeyValue data={p()} />
            </div>
          )}
        </Show>
        <div class="row">
          <Field label="Source">
            <select value={source()} onChange={(e) => setSource(e.currentTarget.value as CaptureSource)}>
              <option value="glasses">G2 glasses mic</option>
              <option value="phone">Phone mic (via Even app)</option>
              <option value="synthetic">Synthetic (browser test)</option>
            </select>
          </Field>
          <label>
            <input type="checkbox" checked={persist()} onChange={(e) => setPersist(e.currentTarget.checked)} /> persist PCM to OPFS
          </label>
          <label>
            <input type="checkbox" checked={autoRearm()} onChange={(e) => setAutoRearm(e.currentTarget.checked)} /> re-arm mic on foreground
          </label>
        </div>
        <div class="row">
          <ActionButton label="Start" onRun={start} disabled={!!live()?.running} />
          <ActionButton label="Marker" onRun={() => soak.addMarker("phone")} disabled={!live()?.running} />
          <ActionButton label="Stop & report" onRun={stop} disabled={!live()?.running} />
        </div>
        <Show when={live()}>
          {(l) => (
            <>
              <div class="big">{new Date(l().elapsedS * 1000).toISOString().slice(11, 19)}</div>
              <KeyValue
                data={{
                  running: l().running,
                  audioSeconds: l().audioS,
                  frames: l().frames,
                  gaps: l().gaps,
                  levelDbfs: l().levelDbfs,
                  persistedMiB: (l().persistedBytes / 2 ** 20).toFixed(1),
                  lastEvent: l().lastEvent,
                }}
              />
            </>
          )}
        </Show>
        <div class="row">
          <ActionButton label="Upload recording as WAV" onRun={upload} disabled={!lastPath() || !!live()?.running} />
          <span class="muted">{uploadStatus()}</span>
        </div>
      </Card>
      <ReportCard status={reporter.status()} json={reporter.json()} />
    </>
  );
}
