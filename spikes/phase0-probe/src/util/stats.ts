export interface Summary {
  n: number;
  min: number;
  max: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
}

export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

export function summarize(values: readonly number[]): Summary {
  const s = [...values].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  return {
    n: s.length,
    min: s[0] ?? NaN,
    max: s[s.length - 1] ?? NaN,
    mean: s.length ? sum / s.length : NaN,
    p50: percentile(s, 50),
    p95: percentile(s, 95),
    p99: percentile(s, 99),
  };
}

export function round(n: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

export function roundSummary(s: Summary, digits = 2): Summary {
  return Object.fromEntries(Object.entries(s).map(([k, v]) => [k, k === "n" ? v : round(v, digits)])) as unknown as Summary;
}
