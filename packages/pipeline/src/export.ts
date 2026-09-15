import {
  activeAttributions,
  formatClock,
  speakerLabel,
  splitSpeakerSpans,
  type AnchoredText,
  type ClusterId,
  type Person,
  type SpeakerLabel,
  type UiLocale,
} from "@irl/domain";
import { formatters, messages } from "@irl/i18n";
import type { Repository } from "@irl/storage";
import { loadTranscript } from "./post-processor";

export interface RecordingExport {
  format: "irl-subtitles.export.v1";
  exportedAt: string;
  recording: { id: string; title: string | null; createdAt: string; durationSeconds: number; language: string; provider: string; models: Record<string, string> };
  /** Label snapshot at export time; `kind` distinguishes user-confirmed from automatically inferred identities. */
  speakers: { clusterId: ClusterId; label: string; kind: SpeakerLabel["kind"]; confidence: number | null }[];
  transcript: { id: string; start: string; end: string; speaker: string | null; text: string }[];
  summary: unknown;
}

/**
 * plan.md §11: exports distinguish confirmed from inferred identities; audio and voiceprints are never included.
 * The Markdown and speaker labels are in the UI language; JSON keys and `kind` values never change.
 */
export async function exportRecording(repo: Repository, recordingId: string, locale: UiLocale = "en"): Promise<{ json: RecordingExport; markdown: string }> {
  const m = messages(locale);
  const x = m.export;
  const f = formatters(locale, m);
  const rec = await repo.getRecording(recordingId);
  if (!rec) throw new Error("recording not found");
  const { segments, clusters } = await loadTranscript(repo, recordingId);
  const people = new Map<string, Person>((await repo.listPeople()).map((p) => [p.id, p]));
  const attrs = activeAttributions(await repo.listAttributions(recordingId));
  const summaryRec = await repo.getSummary(recordingId);
  const labels = new Map<ClusterId, SpeakerLabel>();
  for (const id of new Set(segments.map((s) => s.clusterId).filter((x): x is string => !!x))) labels.set(id, speakerLabel(id, clusters, attrs, people, { words: m.speakers }));
  const kindNote = (l: SpeakerLabel) => (l.kind === "auto" ? x.autoTag : "");
  const render = (text: string) => splitSpeakerSpans(text).map((p) => (p.type === "text" ? p.text : labels.get(p.clusterId)?.text ?? m.speakers.speaker())).join("");

  const json: RecordingExport = {
    format: "irl-subtitles.export.v1",
    exportedAt: new Date().toISOString(),
    recording: { id: rec.id, title: rec.title, createdAt: rec.createdAt, durationSeconds: Math.round(rec.totalSamples / 16000), language: rec.language, provider: rec.provider, models: { ...rec.models } },
    speakers: [...labels.values()].map((l) => ({ clusterId: l.clusterId, label: l.text, kind: l.kind, confidence: attrs.get(l.clusterId)?.confidence ?? null })),
    transcript: segments.map((s) => ({ id: s.id, start: formatClock(s.startSample), end: formatClock(s.endSample), speaker: s.clusterId ? labels.get(s.clusterId)?.text ?? null : null, text: s.text })),
    summary: summaryRec?.summary ?? null,
  };

  const lines: string[] = [`# ${rec.title ?? x.untitled}`, "", `${f.dateTime(rec.createdAt)} · ${formatClock(rec.totalSamples)}`, ""];
  lines.push(`## ${x.speakers}`, "");
  for (const l of labels.values()) lines.push(`- ${l.text} — ${l.kind === "confirmed" ? x.confirmed : l.kind === "auto" ? x.auto : x.unidentified}`);
  const s = summaryRec?.summary;
  if (s) {
    lines.push("", `## ${m.summary.title}`, "", render(s.overview));
    const list = (title: string, items: readonly AnchoredText[]) => {
      if (!items.length) return;
      lines.push("", `### ${title}`, "");
      for (const i of items) lines.push(`- ${render(i.text)}`);
    };
    list(m.summary.keyPoints, s.keyPoints);
    list(m.summary.decisions, s.decisions);
    if (s.actionItems.length) {
      lines.push("", `### ${m.summary.actionItems}`, "");
      for (const a of s.actionItems) lines.push(`- ${render(a.text)}${a.ownerClusterId ? ` — ${labels.get(a.ownerClusterId)?.text ?? "?"}` : ""}${a.dueText ? ` (${m.summary.due(a.dueText)})` : ""}`);
    }
    list(m.summary.openQuestions, s.openQuestions);
  }
  lines.push("", `## ${x.transcript}`, "");
  for (const seg of segments) {
    const l = seg.clusterId ? labels.get(seg.clusterId) : undefined;
    lines.push(`**[${formatClock(seg.startSample)}] ${l ? l.text + kindNote(l) : x.unknownSpeaker}:** ${seg.text}`, "");
  }
  return { json, markdown: lines.join("\n") };
}
