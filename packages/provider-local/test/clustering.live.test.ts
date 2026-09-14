import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { defaultSettings, parseWav, resampleLinear, SAMPLE_RATE, type TimeRange } from "@irl/domain";
import { defaultSelection } from "../src/catalog";
import { clusterParams, OnlineClusterer, refineClusters, windowGrid, type ClusterParams } from "../src/clustering";
import { LocalEngines } from "../src/engines";
import { LocalToolkit } from "../src/toolkit";
import { nodeWorkers } from "./harness/node-workers";
// @ts-expect-error plain JS test support
import { defaultCacheDir, installWebEnv } from "./harness/web-env.mjs";

/**
 * Speaker clustering on real CAM++ embeddings (irl-subt-kdl.15). Fixtures: `pnpm fixtures` builds conversation-a
 * (Alice/Bob alternating) and conversation-b (Carol/Alice) from LibriSpeech, joined by 0.7 s of digital silence;
 * jfk.wav is one voice on an old, noisy recording. Each clip also runs through a "mic" condition (band-limited,
 * quieter, noise at 12 and 6 dB SNR) so thresholds aren't tuned on clean audio alone. IRL_CLUSTER_REPORT=<file.json>
 * writes the cosine distributions and a threshold sweep, which the values in clustering.ts were chosen from.
 */
const fixtures = new URL("../../../apps/even-hub/public/fixtures/", import.meta.url);
const haveFixtures = fs.existsSync(new URL("dev/conversation-a.wav", fixtures));
const MODEL = "campplus-voxceleb";
const SPACE = "campplus-voxceleb@wespeaker-1";

function load(name: string): Float32Array {
  const wav = parseWav(new Uint8Array(fs.readFileSync(new URL(name, fixtures))));
  return resampleLinear(wav.samples, wav.sampleRate);
}

/** Utterance spans between the fixture script's 0.7 s silences (digital silence, give or take a count). */
function utterances(s: Float32Array): TimeRange[] {
  const out: TimeRange[] = [];
  const minGap = 0.5 * SAMPLE_RATE;
  let start = -1;
  let zeros = 0;
  for (let i = 0; i < s.length; i++) {
    if (Math.abs(s[i]!) < 3 / 32768) {
      zeros++;
      if (zeros === minGap && start >= 0) {
        out.push({ startSample: start, endSample: i - minGap + 1 });
        start = -1;
      }
    } else {
      if (start < 0) start = i;
      zeros = 0;
    }
  }
  if (start >= 0) out.push({ startSample: start, endSample: s.length });
  return out;
}

/** Seeded noise so runs are repeatable. */
function rng(seed: number) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
}

/** Phone-mic stand-in: 150 Hz high-pass, ~3.4 kHz low-pass, -12 dB, white noise at `snrDb`. */
function micCondition(s: Float32Array, snrDb: number, seed = 7): Float32Array {
  const out = new Float32Array(s.length);
  const hp = Math.exp((-2 * Math.PI * 150) / SAMPLE_RATE);
  const lp = 1 - Math.exp((-2 * Math.PI * 3400) / SAMPLE_RATE);
  let prevIn = 0, prevHp = 0, prevLp = 0, power = 0, n = 0;
  for (let i = 0; i < s.length; i++) {
    const h = hp * (prevHp + s[i]! - prevIn);
    prevIn = s[i]!;
    prevHp = h;
    prevLp += lp * (h - prevLp);
    out[i] = prevLp * 0.25;
    if (Math.abs(s[i]!) >= 3 / 32768) (power += out[i]! ** 2), n++;
  }
  const noise = Math.sqrt(power / Math.max(1, n) / 10 ** (snrDb / 10));
  const r = rng(seed);
  for (let i = 0; i < out.length; i++) out[i]! += r() * noise * Math.sqrt(3);
  return out;
}

interface Win {
  speaker: string;
  utterance: number;
  vector: Float32Array;
  quality: number;
}

const norm = (v: Float32Array) => {
  let n = 0;
  for (const x of v) n += x * x;
  const k = 1 / Math.sqrt(n || 1);
  return v.map((x) => x * k);
};
const dot = (a: Float32Array, b: Float32Array) => a.reduce((s, x, i) => s + x * b[i]!, 0);
const centroid = (ws: readonly Win[]) => {
  const sum = new Float32Array(ws[0]!.vector.length);
  for (const w of ws) for (let i = 0; i < sum.length; i++) sum[i]! += w.vector[i]!;
  return norm(sum);
};
const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => +(s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? NaN).toFixed(3);
  return { n: s.length, min: q(0), p05: q(0.05), p50: q(0.5), p95: q(0.95), max: +(s.at(-1) ?? NaN).toFixed(3) };
};

/** The live pass's view: windows on the post-processing grid inside VAD speech, low-quality windows dropped. */
async function windowsFor(toolkit: LocalToolkit, samples: Float32Array, spans: readonly TimeRange[], speakers: readonly string[]): Promise<Win[]> {
  expect(spans.length).toBe(speakers.length);
  const regions = await toolkit.detectSpeech("silero-vad-v6", samples, 0);
  const grid = windowGrid(regions);
  const out: Win[] = [];
  const embedded = await toolkit.embed(MODEL, grid.map((range) => ({ range, samples: samples.slice(range.startSample, range.endSample) })));
  for (const e of embedded) {
    const mid = (e.startSample + e.endSample) / 2;
    const u = spans.findIndex((s) => mid >= s.startSample && mid < s.endSample);
    if (u < 0 || e.quality < 0.15) continue;
    out.push({ speaker: speakers[u]!, utterance: u, vector: norm(e.vector), quality: e.quality });
  }
  return out;
}

/** Live (OnlineClusterer, confirmed speakers) and post-capture (refineClusters seeded with live labels) speaker counts. */
function cluster(ws: readonly Win[], params: ClusterParams) {
  const online = new OnlineClusterer(params);
  const live = ws.map((w) => online.assign(w.vector));
  const confirmedLabels = new Set(live.filter((a) => a.confirmed).map((a) => a.label));
  const { labels } = refineClusters(ws.map((w) => w.vector), live.map((a) => (confirmedLabels.has(a.label) ? a.label : null)), params);
  const purity = (ls: readonly number[]) => {
    // Share of windows whose cluster's majority speaker is their own speaker.
    const by = new Map<number, Map<string, number>>();
    ls.forEach((l, i) => by.set(l, (by.get(l) ?? new Map()).set(ws[i]!.speaker, (by.get(l)?.get(ws[i]!.speaker) ?? 0) + 1)));
    let ok = 0;
    for (const m of by.values()) ok += Math.max(...m.values());
    return +(ok / ls.length).toFixed(3);
  };
  return { live: confirmedLabels.size, refined: new Set(labels).size, livePurity: purity(live.map((a) => a.label)), refinedPurity: purity(labels) };
}

describe.skipIf(!haveFixtures)("CAM++ speaker clustering on the dev fixtures", () => {
  it("resolves each clip to its true speaker count, live and after refinement, clean and through a mic", async () => {
    const cacheDir = defaultCacheDir();
    installWebEnv(cacheDir);
    const engines = new LocalEngines(nodeWorkers(cacheDir));
    for (const id of ["silero-vad-v6", MODEL]) if (!(await engines.isDownloaded(id))) await engines.download(id);
    const toolkit = new LocalToolkit(engines, () => defaultSettings(defaultSelection("en")));
    expect(toolkit.embeddingSpace(MODEL)).toBe(SPACE);

    const a = load("dev/conversation-a.wav");
    const b = load("dev/conversation-b.wav");
    const jfk = load("jfk.wav");
    const clips = [
      { name: "conversation-a", samples: a, speakers: ["alice", "bob", "alice", "bob", "alice", "bob", "alice", "bob"], expected: 2 },
      { name: "conversation-b", samples: b, speakers: ["carol", "alice", "carol", "alice", "carol", "alice", "carol", "alice"], expected: 2 },
      { name: "jfk", samples: jfk, speakers: ["jfk"], expected: 1 },
    ];
    const conditions = [
      { name: "clean", apply: (s: Float32Array) => s },
      { name: "mic-12dB", apply: (s: Float32Array) => micCondition(s, 12) },
      { name: "mic-6dB", apply: (s: Float32Array) => micCondition(s, 6) },
    ];

    const windows = new Map<string, Win[]>();
    for (const c of clips) for (const cond of conditions) windows.set(`${c.name}/${cond.name}`, await windowsFor(toolkit, cond.apply(c.samples), c.speakers.length > 1 ? utterances(c.samples) : [{ startSample: 0, endSample: c.samples.length }], c.speakers));
    await engines.release(["audio"]);

    const params = clusterParams(SPACE);
    const results: Record<string, ReturnType<typeof cluster> & { expected: number }> = {};
    for (const c of clips) for (const cond of conditions) results[`${c.name}/${cond.name}`] = { ...cluster(windows.get(`${c.name}/${cond.name}`)!, params), expected: c.expected };

    const reportTo = process.env.IRL_CLUSTER_REPORT;
    if (reportTo) {
      const report: Record<string, unknown> = { params, results, before: {} as Record<string, unknown> };
      const old = clusterParams("uncalibrated@x");
      for (const [k, ws] of windows) (report.before as Record<string, unknown>)[k] = cluster(ws, old);
      for (const cond of conditions) {
        // Same condition, all clips: Alice appears in both conversations.
        const ws = [...windows].filter(([k]) => k.endsWith(`/${cond.name}`)).flatMap(([, w]) => w);
        const same: number[] = [], diff: number[] = [], toCentroidSame: number[] = [], toCentroidDiff: number[] = [], early: number[] = [], earlyDiff: number[] = [];
        for (let i = 0; i < ws.length; i++) for (let j = i + 1; j < ws.length; j++) (ws[i]!.speaker === ws[j]!.speaker ? same : diff).push(dot(ws[i]!.vector, ws[j]!.vector));
        const speakers = [...new Set(ws.map((w) => w.speaker))];
        for (const w of ws) {
          for (const s of speakers) {
            const others = ws.filter((x) => x.speaker === s && x !== w);
            if (!others.length) continue;
            (s === w.speaker ? toCentroidSame : toCentroidDiff).push(dot(w.vector, centroid(others)));
            // Early in a conversation a speaker's centroid holds only their first few windows.
            const firstUtt = others.filter((x) => x.utterance === others[0]!.utterance && x !== w).slice(0, 3);
            if (firstUtt.length && w.utterance !== others[0]!.utterance) (s === w.speaker ? early : earlyDiff).push(dot(w.vector, centroid(firstUtt)));
          }
        }
        // Centroid-to-centroid: one centroid per utterance, compared across utterances.
        const byUtt = new Map<string, Win[]>();
        for (const [k, w] of windows) if (k.endsWith(`/${cond.name}`)) for (const x of w) byUtt.set(`${k}#${x.utterance}`, [...(byUtt.get(`${k}#${x.utterance}`) ?? []), x]);
        const utts = [...byUtt.values()].filter((u) => u.length >= 2);
        const cSame: number[] = [], cDiff: number[] = [];
        for (let i = 0; i < utts.length; i++) for (let j = i + 1; j < utts.length; j++) (utts[i]![0]!.speaker === utts[j]![0]!.speaker ? cSame : cDiff).push(dot(centroid(utts[i]!), centroid(utts[j]!)));
        const pairs: Record<string, ReturnType<typeof stats>> = {};
        for (const x of speakers) for (const y of speakers) {
          if (x >= y) continue;
          const xs = ws.filter((w) => w.speaker === x), ys = ws.filter((w) => w.speaker === y);
          pairs[`${x}-${y}`] = stats([...xs.map((w) => dot(w.vector, centroid(ys))), ...ys.map((w) => dot(w.vector, centroid(xs)))]);
        }
        report[cond.name] = {
          pairsWindowToCentroid: pairs,
          windowToWindow: { same: stats(same), different: stats(diff) },
          windowToCentroid: { same: stats(toCentroidSame), different: stats(toCentroidDiff) },
          windowToEarlyCentroid: { same: stats(early), different: stats(earlyDiff) },
          utteranceCentroids: { same: stats(cSame), different: stats(cDiff) },
        };
      }
      // Which (assign, merge, confirm) settings get each clip's live and refined count right.
      const sweep: Record<string, { live: string[]; refined: string[] }> = {};
      for (const confirm of [2, 3]) {
        for (let assign = 0.25; assign <= 0.601; assign += 0.05) {
          for (let merge = 0.25; merge <= 0.701; merge += 0.05) {
            const p = { ...params, minWindowsToConfirm: confirm, assign: +assign.toFixed(2), merge: +merge.toFixed(2) };
            const entry = { live: [] as string[], refined: [] as string[] };
            for (const [k, ws] of windows) {
              const r = cluster(ws, p);
              const want = clips.find((c) => k.startsWith(`${c.name}/`))!.expected;
              if (r.live !== want || r.livePurity < 0.95) entry.live.push(`${k}:${r.live}`);
              if (r.refined !== want || r.refinedPurity < 0.95) entry.refined.push(`${k}:${r.refined}@${r.refinedPurity}`);
            }
            sweep[`${confirm} ${p.assign.toFixed(2)} ${p.merge.toFixed(2)}`] = entry;
          }
        }
      }
      report.sweep = sweep;
      // Vitest hides a passing test's console output, so the report goes to a file.
      fs.writeFileSync(reportTo, JSON.stringify(report, null, 1));
    }

    for (const [k, r] of Object.entries(results)) {
      // At 6 dB SNR a live split is allowed as long as refinement merges it.
      if (!k.endsWith("/mic-6dB")) expect.soft(r.live, `${k} live speakers`).toBe(r.expected);
      expect.soft(r.livePurity, `${k} live purity`).toBeGreaterThanOrEqual(0.95);
      expect.soft(r.refined, `${k} refined speakers`).toBe(r.expected);
      expect.soft(r.refinedPurity, `${k} refined purity`).toBeGreaterThanOrEqual(0.95);
    }
  });
});
