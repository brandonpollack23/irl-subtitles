import { createMemo, createSignal, For, Show } from "solid-js";
import { ActionButton, Card, createLog, createReporter, Field, LogView, ReportCard } from "../components";
import type { EpChoice } from "../spikes/bench.worker";
import { defaultLiveStack, EPS, graphAvailable, registry, runBench, runLiveStack, STACK_EPS, type BenchOptions, type StackEp } from "../spikes/models";

export function ModelsPanel() {
  const log = createLog(500);
  const reporter = createReporter("models");
  const runnable = registry.filter((m) => m.graphs.length > 0);
  const [modelId, setModelId] = createSignal(runnable[0]!.id);
  const [graphName, setGraphName] = createSignal(runnable[0]!.graphs[0]!.name);
  const [eps, setEps] = createSignal<EpChoice[]>(["webgpu", "wasm"]);
  const [iterations, setIterations] = createSignal(30);
  const [sustained, setSustained] = createSignal(0);
  const [stackMinutes, setStackMinutes] = createSignal(60);
  const [stackEp, setStackEp] = createSignal<StackEp>("mixed");
  const [compareWasm, setCompareWasm] = createSignal(true);
  const [available, setAvailable] = createSignal<Record<string, boolean>>({});

  const model = createMemo(() => registry.find((m) => m.id === modelId())!);
  const opts = (): BenchOptions => ({ iterations: iterations(), warmup: 3, sustainedSeconds: sustained(), compareWithWasm: compareWasm() });
  const toggleEp = (ep: EpChoice, on: boolean) => setEps((cur) => (on ? [...new Set([...cur, ep])] : cur.filter((e) => e !== ep)));

  const checkFiles = async () => {
    const found: Record<string, boolean> = {};
    for (const m of runnable) for (const g of m.graphs) found[`${m.id}/${g.name}`] = await graphAvailable(m.id, g);
    setAvailable(found);
    log.log(`${Object.values(found).filter(Boolean).length}/${Object.keys(found).length} graphs served by the laptop`);
  };

  const runSelected = async () => {
    const g = model().graphs.find((x) => x.name === graphName()) ?? model().graphs[0]!;
    for (const ep of eps()) {
      const r = await runBench(model(), g, ep, opts(), log.log);
      log.log(`${model().id}/${g.name} [${ep}] ${r.ok ? `p50 ${(r.latencyMs as { p50: number }).p50} ms` : `FAILED at ${r.stage}: ${String(r.error).slice(0, 160)}`}`);
      await reporter.publish({ kind: "graph", ...r });
    }
  };

  const runMatrix = async (onlyDefaults: boolean) => {
    const targets = runnable.filter((m) => !onlyDefaults || m.catalogDefault);
    for (const m of targets) {
      for (const g of m.graphs) {
        if (available()[`${m.id}/${g.name}`] === false) {
          log.log(`skip ${m.id}/${g.name}: files not served`);
          continue;
        }
        for (const ep of eps()) {
          const r = await runBench(m, g, ep, { ...opts(), sustainedSeconds: 0 }, log.log);
          log.log(`${m.id}/${g.name} [${ep}] ${r.ok ? `p50 ${(r.latencyMs as { p50: number }).p50} ms` : `FAILED at ${r.stage}`}`);
          await reporter.publish({ kind: "graph", matrix: onlyDefaults ? "defaults" : "all", ...r });
        }
      }
    }
    log.log("matrix done");
  };

  const liveStack = async () => {
    const r = await runLiveStack(defaultLiveStack(stackEp()), stackMinutes() * 60, log.log);
    await reporter.publish({ kind: "live-stack", ...r });
  };

  return (
    <>
      <Card title="Spike irl-subt-0i6.3 — ONNX graphs through WebGPU">
        <p class="muted">
          Graph-level: node placement (WebGPU vs CPU fallback), session creation, per-step latency, drift vs CPU ORT fixtures and WASM. Model files are
          served by the laptop (run the models fetch script first). Plug in to power only for the matrix; unplug for sustained runs.
        </p>
        <div class="row">
          <ActionButton label="Check model files" onRun={checkFiles} />
        </div>
        <div class="row">
          <Field label="Model">
            <select
              value={modelId()}
              onChange={(e) => {
                setModelId(e.currentTarget.value);
                setGraphName(registry.find((m) => m.id === e.currentTarget.value)!.graphs[0]!.name);
              }}
            >
              <For each={runnable}>{(m) => <option value={m.id}>{`${m.role} · ${m.displayName}${m.catalogDefault ? " (default)" : ""}`}</option>}</For>
            </select>
          </Field>
          <Field label="Graph">
            <select value={graphName()} onChange={(e) => setGraphName(e.currentTarget.value)}>
              <For each={model().graphs}>
                {(g) => <option value={g.name}>{`${g.name}${available()[`${model().id}/${g.name}`] === false ? " (missing)" : ""}`}</option>}
              </For>
            </select>
          </Field>
        </div>
        <Show when={model().notes}>
          <p class="muted">{model().notes}</p>
        </Show>
        <div class="row">
          <For each={EPS}>
            {(ep) => (
              <label>
                <input type="checkbox" checked={eps().includes(ep)} onChange={(e) => toggleEp(ep, e.currentTarget.checked)} /> {ep}
              </label>
            )}
          </For>
        </div>
        <div class="row">
          <Field label="Iterations">
            <input type="number" min="1" value={iterations()} onChange={(e) => setIterations(Number(e.currentTarget.value))} />
          </Field>
          <Field label="Sustained seconds (selected graph)">
            <input type="number" min="0" value={sustained()} onChange={(e) => setSustained(Number(e.currentTarget.value))} />
          </Field>
          <label>
            <input type="checkbox" checked={compareWasm()} onChange={(e) => setCompareWasm(e.currentTarget.checked)} /> compare with WASM
          </label>
        </div>
        <div class="row">
          <ActionButton label="Run selected graph" onRun={runSelected} />
          <ActionButton label="Run defaults matrix" onRun={() => runMatrix(true)} />
          <ActionButton label="Run full matrix" onRun={() => runMatrix(false)} />
        </div>
        <h4>Concurrent live stack (defaults: VAD + live STT + speaker embedding)</h4>
        <div class="row">
          <Field label="Minutes">
            <input type="number" min="1" value={stackMinutes()} onChange={(e) => setStackMinutes(Number(e.currentTarget.value))} />
          </Field>
          <Field label="EP (mixed: VAD on wasm, rest on webgpu)">
            <select value={stackEp()} onChange={(e) => setStackEp(e.currentTarget.value as StackEp)}>
              <For each={STACK_EPS}>{(ep) => <option value={ep}>{ep}</option>}</For>
            </select>
          </Field>
          <ActionButton label="Run live stack" onRun={liveStack} />
        </div>
        <LogView lines={log.lines()} />
      </Card>
      <ReportCard status={reporter.status()} json={reporter.json()} />
    </>
  );
}
