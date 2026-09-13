import type { ClusterId, PersonId, RecordingId } from "./audio";

export interface AnchoredText {
  /** May contain speaker spans `[[<clusterId>]]`, resolved to names at render time. */
  text: string;
  sourceSegmentIds: string[];
}

export interface ActionItem {
  text: string;
  ownerPersonId?: PersonId;
  ownerClusterId?: ClusterId;
  dueText?: string;
  sourceSegmentIds: string[];
}

export interface ConversationSummary {
  title: string;
  overview: string;
  keyPoints: AnchoredText[];
  decisions: AnchoredText[];
  actionItems: ActionItem[];
  openQuestions: AnchoredText[];
  generatedAt: string;
  providerId: string;
  sourceTranscriptRevision: number;
}

export type SummaryStatus = "pending" | "running" | "ready" | "failed" | "off";

export interface SummaryRecord {
  recordingId: RecordingId;
  status: SummaryStatus;
  summary: ConversationSummary | null;
  providerId: string | null;
  transcriptRevision: number;
  error: string | null;
  updatedAt: string;
}

export type SpeakerSpan = { type: "text"; text: string } | { type: "speaker"; clusterId: ClusterId };

const SPAN = /\[\[([A-Za-z0-9_:.-]+)\]\]/g;

export function splitSpeakerSpans(text: string): SpeakerSpan[] {
  const out: SpeakerSpan[] = [];
  let last = 0;
  for (const m of text.matchAll(SPAN)) {
    if (m.index > last) out.push({ type: "text", text: text.slice(last, m.index) });
    out.push({ type: "speaker", clusterId: m[1]! });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ type: "text", text: text.slice(last) });
  return out;
}

export function speakerSpan(clusterId: ClusterId): string {
  return `[[${clusterId}]]`;
}

export interface SummaryValidation {
  ok: boolean;
  errors: string[];
  value: Omit<ConversationSummary, "generatedAt" | "providerId" | "sourceTranscriptRevision"> | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Validates model output against the ConversationSummary schema. Unknown segment IDs are dropped
 * (and reported) rather than failing the whole summary; missing required fields fail.
 */
export function validateSummary(raw: unknown, validSegmentIds: ReadonlySet<string>): SummaryValidation {
  const errors: string[] = [];
  if (!isRecord(raw)) return { ok: false, errors: ["summary is not a JSON object"], value: null };
  const str = (key: string, required = true): string => {
    const v = raw[key];
    if (typeof v === "string") return v.trim();
    if (required) errors.push(`${key} must be a string`);
    return "";
  };
  const ids = (v: unknown, where: string): string[] => {
    if (!Array.isArray(v)) {
      errors.push(`${where}.sourceSegmentIds must be an array`);
      return [];
    }
    const kept = v.filter((x): x is string => typeof x === "string" && validSegmentIds.has(x));
    if (kept.length !== v.length) errors.push(`${where}: dropped ${v.length - kept.length} unknown segment ids`);
    return kept;
  };
  const anchored = (key: string): AnchoredText[] => {
    const v = raw[key];
    if (!Array.isArray(v)) {
      errors.push(`${key} must be an array`);
      return [];
    }
    return v.flatMap((item, i) => {
      if (!isRecord(item) || typeof item.text !== "string" || !item.text.trim()) {
        errors.push(`${key}[${i}] needs text`);
        return [];
      }
      return [{ text: item.text.trim(), sourceSegmentIds: ids(item.sourceSegmentIds, `${key}[${i}]`) }];
    });
  };
  const title = str("title");
  const overview = str("overview");
  const keyPoints = anchored("keyPoints");
  const decisions = anchored("decisions");
  const openQuestions = anchored("openQuestions");
  const actionRaw = raw.actionItems;
  const actionItems: ActionItem[] = [];
  if (!Array.isArray(actionRaw)) errors.push("actionItems must be an array");
  else {
    actionRaw.forEach((item, i) => {
      if (!isRecord(item) || typeof item.text !== "string" || !item.text.trim()) {
        errors.push(`actionItems[${i}] needs text`);
        return;
      }
      actionItems.push({
        text: item.text.trim(),
        ...(typeof item.ownerClusterId === "string" && item.ownerClusterId ? { ownerClusterId: item.ownerClusterId } : {}),
        ...(typeof item.dueText === "string" && item.dueText ? { dueText: item.dueText } : {}),
        sourceSegmentIds: ids(item.sourceSegmentIds, `actionItems[${i}]`),
      });
    });
  }
  const fatal = errors.filter((e) => !e.includes("dropped"));
  return {
    ok: fatal.length === 0 && title.length > 0,
    errors: title ? errors : [...errors, "title is empty"],
    value: { title, overview, keyPoints, decisions, actionItems, openQuestions },
  };
}
