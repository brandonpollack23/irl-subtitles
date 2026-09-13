import {
  activeAttributions,
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
import { loadTranscript } from "@irl/pipeline";
import { createSignal } from "solid-js";
import type { LiveSnapshot } from "@irl/pipeline";
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
      return speakerLabel(resolved, clusters, attributions, peopleMap, { candidate: c?.candidatePersonId ? { personId: c.candidatePersonId } : null });
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
  const names = new Map(people.map((p) => [p.id, p.fullName]));
  return Promise.all(
    recordings.map(async (recording) => {
      const attrs = activeAttributions(await repo.listAttributions(recording.id));
      const who = [...new Set([...attrs.values()].map((a) => (a.personId ? names.get(a.personId) : undefined)).filter((x): x is string => !!x))];
      return { recording, people: who };
    }),
  );
}

export function stateLabel(r: Recording): { text: string; kind: "busy" | "bad" | "plain" } {
  switch (r.state) {
    case "starting":
    case "recording":
      return { text: "Recording", kind: "busy" };
    case "paused":
      return { text: "Paused", kind: "busy" };
    case "finalizing":
    case "captured":
      return { text: "Processing", kind: "busy" };
    case "interrupted":
      return { text: "Interrupted", kind: "bad" };
    case "failed":
      return { text: "Failed", kind: "bad" };
    case "ready":
      return r.processing.summary.status === "failed" ? { text: "Summary failed", kind: "bad" } : { text: "Ready", kind: "plain" };
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
