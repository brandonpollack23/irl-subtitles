import { Emitter } from "@irl/domain";

/**
 * Timings from the local live path, for diagnostics, the live harness, and the dev bench (irl-subt-kdl.1).
 * Audio positions are in seconds on the recording's sample clock; audio arrives in real time, so a lag in
 * audio seconds is also a wall-clock lag.
 */
export type LiveMetric =
  | {
      kind: "stt";
      runId: string;
      final: boolean;
      /** Audio the model was given. */
      audioS: number;
      /** Audio this call covered that no earlier call for the utterance had. */
      newAudioS: number;
      computeMs: number;
      /** Audio received after the end of the transcribed range by the time its text was emitted. */
      lagS: number;
    }
  | { kind: "vad"; runId: string; audioS: number; computeMs: number }
  | { kind: "embed"; runId: string; windows: number; computeMs: number }
  | { kind: "load"; modelId: string; engine: string; ms: number; ok: boolean }
  | { kind: "warmup-inference"; modelId: string; ms: number }
  | { kind: "degraded"; runId: string; level: number; reason: string | null };

export const liveMetrics = new Emitter<LiveMetric>();

export interface LiveMetricsSummary {
  sttCalls: number;
  interimCalls: number;
  finalCalls: number;
  /** How far behind the audio interim text was when shown (p50/p95/max, s). */
  interimLagS: Stats | null;
  /** Speech end (VAD) to final text (p50/p95/max, s). */
  finalLagS: Stats | null;
  /** STT compute per second of new audio: above 1 can never keep up. */
  sttComputePerNewAudio: number | null;
  /** Mean STT compute per call (ms). */
  sttMsPerCall: number | null;
  vadRtf: number | null;
  embedMsPerWindow: number | null;
  loads: { modelId: string; ms: number; ok: boolean }[];
  warmupInferences: { modelId: string; ms: number }[];
  maxDegradedLevel: number;
}

export interface Stats {
  p50: number;
  p95: number;
  max: number;
  n: number;
}

export function stats(values: readonly number[]): Stats | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
  const r = (x: number) => Math.round(x * 100) / 100;
  return { p50: r(at(0.5)), p95: r(at(0.95)), max: r(s[s.length - 1]!), n: s.length };
}

export function summarizeLiveMetrics(events: readonly LiveMetric[]): LiveMetricsSummary {
  const stt = events.filter((e): e is Extract<LiveMetric, { kind: "stt" }> => e.kind === "stt");
  const vad = events.filter((e): e is Extract<LiveMetric, { kind: "vad" }> => e.kind === "vad");
  const embed = events.filter((e): e is Extract<LiveMetric, { kind: "embed" }> => e.kind === "embed");
  const sum = <T>(xs: readonly T[], f: (x: T) => number) => xs.reduce((n, x) => n + f(x), 0);
  const round = (x: number) => Math.round(x * 1000) / 1000;
  const newAudio = sum(stt, (e) => e.newAudioS);
  const vadAudio = sum(vad, (e) => e.audioS);
  const windows = sum(embed, (e) => e.windows);
  return {
    sttCalls: stt.length,
    interimCalls: stt.filter((e) => !e.final).length,
    finalCalls: stt.filter((e) => e.final).length,
    interimLagS: stats(stt.filter((e) => !e.final).map((e) => e.lagS)),
    finalLagS: stats(stt.filter((e) => e.final).map((e) => e.lagS)),
    sttComputePerNewAudio: newAudio > 0 ? round(sum(stt, (e) => e.computeMs) / 1000 / newAudio) : null,
    sttMsPerCall: stt.length ? Math.round(sum(stt, (e) => e.computeMs) / stt.length) : null,
    vadRtf: vadAudio > 0 ? round(sum(vad, (e) => e.computeMs) / 1000 / vadAudio) : null,
    embedMsPerWindow: windows ? Math.round(sum(embed, (e) => e.computeMs) / windows) : null,
    loads: events.flatMap((e) => (e.kind === "load" ? [{ modelId: e.modelId, ms: Math.round(e.ms), ok: e.ok }] : [])),
    warmupInferences: events.flatMap((e) => (e.kind === "warmup-inference" ? [{ modelId: e.modelId, ms: Math.round(e.ms) }] : [])),
    maxDegradedLevel: Math.max(0, ...events.flatMap((e) => (e.kind === "degraded" ? [e.level] : []))),
  };
}
