import { cosine, l2normalize, SAMPLE_RATE, type TimeRange } from "@irl/domain";

export interface ClusterParams {
  /** Cosine to a centroid needed to join an existing speaker during capture. */
  assign: number;
  /** Centroid cosine at which two speakers are merged after capture. */
  merge: number;
  /** Windows needed before a new speaker becomes visible. */
  minWindowsToConfirm: number;
  /** Speakers with fewer windows after refinement are folded into their nearest neighbour. */
  minWindowsToKeep: number;
}

/** Thresholds per embedding space family; `IRL_CLUSTER_REPORT=report.json pnpm test:live` re-measures them (clustering.live.test.ts). */
const PARAMS: Record<string, ClusterParams> = {
  default: { assign: 0.55, merge: 0.7, minWindowsToConfirm: 2, minWindowsToKeep: 2 },
  // CAM++ on 2 s windows (irl-subt-kdl.15; LibriSpeech fixtures + jfk, clean and through a noisy band-limited mic):
  // different speakers, window to speaker centroid, max 0.38 (p95 <= 0.25); same speaker, window to an early
  // (first-utterance) centroid, p50 0.54-0.66 and p05 down to 0.28 at 6 dB SNR, which the old 0.55 split into extra
  // speakers. Utterance centroids: same speaker min 0.44, different max 0.35. Joining sits just above the
  // different-speaker tail; merging after capture folds the remaining noisy splits back in.
  "campplus-voxceleb": { assign: 0.4, merge: 0.45, minWindowsToConfirm: 2, minWindowsToKeep: 2 },
};

export function clusterParams(embeddingSpace: string): ClusterParams {
  const family = embeddingSpace.split("@")[0]!;
  return PARAMS[family] ?? PARAMS.default!;
}

interface Centroid {
  label: number;
  sum: Float32Array;
  count: number;
  confirmed: boolean;
}

function add(sum: Float32Array, v: Float32Array, w = 1) {
  for (let i = 0; i < sum.length; i++) sum[i]! += v[i]! * w;
}

/**
 * Online speaker clustering for capture (plan.md §6.1 step 4): each clean window joins the closest
 * confirmed speaker above `assign`, otherwise opens a tentative speaker that is confirmed after a second
 * matching window. Cheap enough to run on the main thread at ~1 window/second.
 */
export class OnlineClusterer {
  private centroids: Centroid[] = [];
  private nextLabel = 0;

  constructor(readonly params: ClusterParams) {}

  /** Returns the label and whether it just became a confirmed (visible) speaker. */
  assign(vector: Float32Array): { label: number; confirmed: boolean; newlyConfirmed: boolean; score: number } {
    const v = l2normalize(vector);
    let best: Centroid | null = null;
    let bestScore = -1;
    for (const c of this.centroids) {
      const s = cosine(v, c.sum);
      // Tentative speakers need a slightly stronger match so noise doesn't spawn speakers.
      const bar = c.confirmed ? this.params.assign : this.params.assign + 0.05;
      if (s >= bar && s > bestScore) {
        best = c;
        bestScore = s;
      }
    }
    if (!best) {
      best = { label: this.nextLabel++, sum: new Float32Array(v), count: 1, confirmed: this.params.minWindowsToConfirm <= 1 };
      this.centroids.push(best);
      return { label: best.label, confirmed: best.confirmed, newlyConfirmed: best.confirmed, score: 1 };
    }
    add(best.sum, v);
    best.count++;
    const newlyConfirmed = !best.confirmed && best.count >= this.params.minWindowsToConfirm;
    if (newlyConfirmed) best.confirmed = true;
    return { label: best.label, confirmed: best.confirmed, newlyConfirmed, score: bestScore };
  }

  nearestConfirmed(vector: Float32Array): number | null {
    const v = l2normalize(vector);
    let best: { label: number; s: number } | null = null;
    for (const c of this.centroids) {
      if (!c.confirmed) continue;
      const s = cosine(v, c.sum);
      if (!best || s > best.s) best = { label: c.label, s };
    }
    return best?.label ?? null;
  }
}

/**
 * Post-capture refinement (plan.md §6.1 step 5): start from live labels (or an online pass), then
 * alternately merge speakers whose centroids agree and reassign windows to their best centroid, which
 * splits windows that drifted into the wrong speaker. Tiny leftover speakers fold into the nearest one.
 */
export function refineClusters(vectors: readonly Float32Array[], initial: readonly (number | null)[], params: ClusterParams, iterations = 4): { labels: number[]; merges: [number, number][] } {
  const n = vectors.length;
  if (!n) return { labels: [], merges: [] };
  const norm = vectors.map((v) => l2normalize(v));
  const labels = new Array<number>(n);
  const online = new OnlineClusterer({ ...params, minWindowsToConfirm: 1 });
  const offset = Math.max(-1, ...initial.map((x) => x ?? -1)) + 1;
  for (let i = 0; i < n; i++) labels[i] = initial[i] ?? offset + online.assign(norm[i]!).label;
  const merges: [number, number][] = [];

  const centroids = () => {
    const map = new Map<number, { sum: Float32Array; count: number }>();
    for (let i = 0; i < n; i++) {
      const c = map.get(labels[i]!) ?? { sum: new Float32Array(norm[0]!.length), count: 0 };
      add(c.sum, norm[i]!);
      c.count++;
      map.set(labels[i]!, c);
    }
    return map;
  };

  for (let it = 0; it < iterations; it++) {
    // Merge the most similar pair repeatedly while above threshold.
    for (;;) {
      const cs = [...centroids().entries()];
      let best: { a: number; b: number; s: number } | null = null;
      for (let i = 0; i < cs.length; i++) {
        for (let j = i + 1; j < cs.length; j++) {
          const s = cosine(cs[i]![1].sum, cs[j]![1].sum);
          if (s >= params.merge && (!best || s > best.s)) best = { a: cs[i]![0], b: cs[j]![0], s };
        }
      }
      if (!best) break;
      const [keep, drop] = (centroids().get(best.a)!.count >= centroids().get(best.b)!.count) ? [best.a, best.b] : [best.b, best.a];
      for (let i = 0; i < n; i++) if (labels[i] === drop) labels[i] = keep;
      merges.push([keep, drop]);
    }
    // Reassign to best centroid.
    const cs = [...centroids().entries()];
    let changed = 0;
    for (let i = 0; i < n; i++) {
      let bestLabel = labels[i]!;
      let bestScore = -2;
      for (const [label, c] of cs) {
        const s = cosine(norm[i]!, c.sum);
        if (s > bestScore) {
          bestScore = s;
          bestLabel = label;
        }
      }
      if (bestLabel !== labels[i]) {
        labels[i] = bestLabel;
        changed++;
      }
    }
    if (!changed) break;
  }

  // Fold tiny clusters.
  const final = centroids();
  const big = [...final.entries()].filter(([, c]) => c.count >= params.minWindowsToKeep);
  if (big.length) {
    for (const [label, c] of final) {
      if (c.count >= params.minWindowsToKeep) continue;
      const nearest = big.map(([l, b]) => ({ l, s: cosine(c.sum, b.sum) })).sort((a, b) => b.s - a.s)[0]!;
      for (let i = 0; i < n; i++) if (labels[i] === label) labels[i] = nearest.l;
      merges.push([nearest.l, label]);
    }
  }
  return { labels, merges };
}

export interface WindowParams {
  windowMs: number;
  hopMs: number;
  minMs: number;
}

export const DEFAULT_WINDOWS: WindowParams = { windowMs: 2000, hopMs: 1000, minMs: 1200 };

/** 1.5–3 s windows about once per second inside speech (plan.md §6.1 rationale). */
export function windowGrid(regions: readonly TimeRange[], p: WindowParams = DEFAULT_WINDOWS): TimeRange[] {
  const win = Math.round((p.windowMs * SAMPLE_RATE) / 1000);
  const hop = Math.round((p.hopMs * SAMPLE_RATE) / 1000);
  const min = Math.round((p.minMs * SAMPLE_RATE) / 1000);
  const out: TimeRange[] = [];
  for (const r of regions) {
    const len = r.endSample - r.startSample;
    if (len < min) continue;
    if (len <= win) {
      out.push({ startSample: r.startSample, endSample: r.endSample });
      continue;
    }
    let s = r.startSample;
    for (; s + win <= r.endSample; s += hop) out.push({ startSample: s, endSample: s + win });
    // Cover the tail when the last hop left a meaningful remainder.
    const lastEnd = out[out.length - 1]!.endSample;
    if (r.endSample - lastEnd >= hop / 2) out.push({ startSample: r.endSample - win, endSample: r.endSample });
  }
  return out;
}

/** Window quality heuristic: level, clipping, and speech coverage (no overlap detector in the MVP). */
export function windowQuality(samples: Float32Array, speechFraction = 1): number {
  if (!samples.length) return 0;
  let acc = 0;
  let clipped = 0;
  for (const v of samples) {
    acc += v * v;
    if (Math.abs(v) > 0.98) clipped++;
  }
  const db = 10 * Math.log10(acc / samples.length + 1e-12);
  const level = Math.min(1, Math.max(0, (db + 50) / 30)); // -50 dBFS → 0, -20 dBFS → 1
  const clip = 1 - Math.min(1, (clipped / samples.length) * 50);
  const duration = Math.min(1, samples.length / (2 * SAMPLE_RATE));
  return Math.round(level * clip * duration * Math.min(1, speechFraction) * 1000) / 1000;
}
