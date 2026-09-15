import {
  activeAttributions,
  displayName,
  resolveCluster,
  speakerLabel,
  type ClusterId,
  type Person,
  type Recording,
  type SpeakerAttribution,
  type SpeakerCluster,
  type SpeakerLabel,
  type SummaryRecord,
  type TranscriptSegment,
} from "@irl/domain";
import { t } from "@irl/i18n";
import { loadTranscript } from "@irl/pipeline";
import { createSignal } from "solid-js";
import type { LiveSnapshot } from "@irl/pipeline";
import type { WarmupStatus } from "@irl/provider-local";
import { app } from "./lib";

export interface RecordingModel {
  recording: Recording;
  segments: TranscriptSegment[];
  clusters: Map<ClusterId, SpeakerCluster>;
  attributions: Map<ClusterId, SpeakerAttribution>;
  people: Map<string, Person>;
  summary: SummaryRecord | undefined;
  hasAudio: boolean;
  label(clusterId: ClusterId): SpeakerLabel;
  ordinal(clusterId: ClusterId): number | undefined;
}

export async function loadRecording(id: string): Promise<RecordingModel | null> {
  const { repo } = app().storage;
  const recording = await repo.getRecording(id);
  if (!recording) return null;
  const [{ segments, clusters }, attrs, people, summary, chunks] = await Promise.all([loadTranscript(repo, id), repo.listAttributions(id), repo.listPeople(), repo.getSummary(id), repo.listChunks(id)]);
  const attributions = activeAttributions(attrs);
  const peopleMap = new Map(people.map((p) => [p.id, p]));
  const hasAudio = chunks.length > 0 && (recording.audioRetention === "persisted" || app().ephemeral.get(id) !== null);
  return {
    recording, segments, clusters, attributions, people: peopleMap, summary, hasAudio,
    label: (cid) => {
      const resolved = resolveCluster(clusters, cid);
      const c = clusters.get(resolved);
      return speakerLabel(resolved, clusters, attributions, peopleMap, { candidate: c?.candidatePersonId ? { personId: c.candidatePersonId } : null, words: t().speakers });
    },
    ordinal: (cid) => clusters.get(resolveCluster(clusters, cid))?.ordinal,
  };
}

export interface HistoryRow {
  recording: Recording;
  people: string[];
}

export async function loadHistory(): Promise<HistoryRow[]> {
  const { repo } = app().storage;
  const [recordings, people] = await Promise.all([repo.listRecordings(), repo.listPeople()]);
  const names = new Map(people.map((p) => [p.id, displayName(p)]));
  return Promise.all(
    recordings.map(async (recording) => {
      const attrs = activeAttributions(await repo.listAttributions(recording.id));
      const who = [...new Set([...attrs.values()].map((a) => (a.personId ? names.get(a.personId) : undefined)).filter((x): x is string => !!x))];
      return { recording, people: who };
    }),
  );
}

export function stateLabel(r: Recording): { text: string; kind: "busy" | "bad" | "plain" } {
  const s = t().states;
  switch (r.state) {
    case "starting":
    case "recording":
      return { text: s.recording, kind: "busy" };
    case "paused":
      return { text: s.paused, kind: "busy" };
    case "finalizing":
    case "captured":
      return { text: s.processing, kind: "busy" };
    case "interrupted":
      return { text: s.interrupted, kind: "bad" };
    case "failed":
      return { text: s.failed, kind: "bad" };
    case "ready":
      return r.processing.summary.status === "failed" ? { text: s.summaryFailed, kind: "bad" } : { text: s.ready, kind: "plain" };
  }
}

let liveSignal: ReturnType<typeof createSignal<LiveSnapshot>> | null = null;

/** The controller's live snapshot as a Solid signal, throttled to ~8 updates/s. */
export function liveSnapshot(): () => LiveSnapshot {
  if (!liveSignal) {
    const controller = app().controller;
    liveSignal = createSignal<LiveSnapshot>(controller.current, { ownedWrite: true });
    const [, set] = liveSignal;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let latest = controller.current;
    controller.live.on((s) => {
      const stateChanged = s.state !== latest.state;
      latest = s;
      if (stateChanged) {
        set(() => s);
        return;
      }
      timer ??= setTimeout(() => {
        timer = null;
        set(() => latest);
      }, 125);
    });
  }
  return liveSignal[0];
}

let warmupSignal: ReturnType<typeof createSignal<WarmupStatus>> | null = null;

/** Whether the selected live models are still loading in the background. */
export function warmupStatus(): () => WarmupStatus {
  if (!warmupSignal) {
    const { warmup } = app();
    warmupSignal = createSignal<WarmupStatus>(warmup.current, { ownedWrite: true });
    const [, set] = warmupSignal;
    warmup.status.on((s) => set(() => s));
  }
  return warmupSignal[0];
}
