/// <reference lib="webworker" />
import { Transcriber } from "@irl/moonshine-wasm";

/** Dev-only spike (irl-subt-kdl.7): Moonshine Streaming in a worker, WAV fed as fast as it goes. */
self.onmessage = async (e: MessageEvent<{ arch: number; dir: string; files: string[]; audio: Float32Array }>) => {
  const { arch, dir, files, audio } = e.data;
  try {
    const t0 = performance.now();
    const map = new Map<string, Uint8Array>();
    for (const f of files) map.set(f, new Uint8Array(await (await fetch(`${dir}/${f}`)).arrayBuffer()));
    const fetchMs = performance.now() - t0;
    const t1 = performance.now();
    const transcriber = await Transcriber.load({ files: map, modelArch: arch });
    const loadMs = performance.now() - t1;
    const stream = transcriber.createStream({ updateInterval: 0.5 });
    stream.start();
    const passes: number[] = [];
    const lines = new Map<string, { text: string; latencyMs: number }>();
    for (let off = 0; off < audio.length; off += 1600) {
      stream.addAudio(audio.subarray(off, off + 1600), 16000);
      const t = performance.now();
      const snap = stream.transcribe();
      const ms = performance.now() - t;
      if (ms > 1) passes.push(ms);
      for (const l of snap.lines) if (l.isComplete && !lines.has(l.id)) lines.set(l.id, { text: l.text, latencyMs: l.lastTranscriptionLatencyMs });
    }
    const t2 = performance.now();
    stream.stop();
    passes.push(performance.now() - t2);
    const total = passes.reduce((a, b) => a + b, 0);
    const sorted = [...passes].sort((a, b) => a - b);
    postMessage({
      arch, fetchMs: Math.round(fetchMs), loadMs: Math.round(loadMs), audioS: audio.length / 16000, passes: passes.length, computeLoad: +(total / 1000 / (audio.length / 16000)).toFixed(3),
      passP50: Math.round(sorted[sorted.length >> 1]!), passP95: Math.round(sorted[Math.floor(sorted.length * 0.95)]!),
      lineLatencyMs: [...lines.values()].map((l) => l.latencyMs), text: [...lines.values()].map((l) => l.text).join(" ").slice(0, 200),
    });
  } catch (err) {
    postMessage({ arch, error: String(err) });
  }
};
