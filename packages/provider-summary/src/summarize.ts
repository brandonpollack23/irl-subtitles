import {
  errorMessage,
  formatClock,
  speakerSpan,
  validateSummary,
  type ClusterId,
  type ConversationSummary,
  type SummaryInput,
  type SummaryProvider,
  type TranscriptSegment,
} from "@irl/domain";

/**
 * Compact wire format the models see: numbered lines with short speaker tags, and short numeric refs
 * instead of segment ids. Speakers stay references ({S1}), never baked names, so renaming a person
 * re-renders the summary without regenerating it (plan.md §6.3).
 */
export interface CompactSummary {
  title: string;
  overview: string;
  keyPoints: { text: string; refs: number[] }[];
  decisions: { text: string; refs: number[] }[];
  actionItems: { text: string; owner: string | null; due: string | null; refs: number[] }[];
  openQuestions: { text: string; refs: number[] }[];
}

export interface PromptLine {
  ref: number;
  tag: string;
  time: string;
  text: string;
}

export interface PreparedTranscript {
  lines: PromptLine[];
  tagToCluster: Map<string, ClusterId>;
  refToSegment: Map<number, string>;
  legend: { tag: string; name: string }[];
}

export function prepareTranscript(segments: readonly TranscriptSegment[], names: ReadonlyMap<ClusterId, string>, includeNames: boolean): PreparedTranscript {
  const tagToCluster = new Map<string, ClusterId>();
  const clusterToTag = new Map<ClusterId, string>();
  const refToSegment = new Map<number, string>();
  const lines: PromptLine[] = [];
  segments.forEach((s, i) => {
    let tag = "S?";
    if (s.clusterId) {
      tag = clusterToTag.get(s.clusterId) ?? `S${clusterToTag.size + 1}`;
      clusterToTag.set(s.clusterId, tag);
      tagToCluster.set(tag, s.clusterId);
    }
    const ref = i + 1;
    refToSegment.set(ref, s.id);
    lines.push({ ref, tag, time: formatClock(s.startSample), text: s.text });
  });
  const legend = [...clusterToTag.entries()].map(([cluster, tag]) => ({ tag, name: includeNames ? (names.get(cluster) ?? tag) : tag }));
  return { lines, tagToCluster, refToSegment, legend };
}

const SCHEMA_TEXT = `{"title": string (max 8 words), "overview": string (2-4 sentences), "keyPoints": [{"text": string, "refs": [line numbers]}], "decisions": [{"text": string, "refs": [line numbers]}], "actionItems": [{"text": string, "owner": speaker tag like "S1" or null, "due": string or null, "refs": [line numbers]}], "openQuestions": [{"text": string, "refs": [line numbers]}]}`;

export function systemPrompt(language: string): string {
  return [
    "You summarize recorded conversations for the people who took part.",
    `Respond with one JSON object and nothing else, matching: ${SCHEMA_TEXT}`,
    "Refer to speakers only by their tag in braces, for example {S1} proposed moving the launch. Never invent names.",
    "Every item needs refs: the transcript line numbers that support it. Use empty arrays when a section has nothing.",
    "Only include decisions, action items, and questions that are actually in the transcript.",
    language && language !== "auto" && language !== "en" ? `Write the summary in the transcript's language (${language}).` : "Write the summary in the transcript's language.",
  ].join("\n");
}

export function transcriptPrompt(p: PreparedTranscript, lines: readonly PromptLine[]): string {
  const legend = p.legend.map((l) => (l.name === l.tag ? l.tag : `${l.tag} = ${l.name}`)).join(", ");
  return `Speakers: ${legend || "unknown"}\nTranscript (line number, time, speaker, text):\n${lines.map((l) => `${l.ref} [${l.time}] ${l.tag}: ${l.text}`).join("\n")}`;
}

export function reducePrompt(partials: readonly CompactSummary[]): string {
  return `These are summaries of consecutive parts of one conversation, in order. Merge them into a single summary of the whole conversation with the same JSON format, keeping the line-number refs and speaker tags as given. Remove duplicates.\n${partials.map((s, i) => `Part ${i + 1}: ${JSON.stringify(s)}`).join("\n")}`;
}

/** Pulls the JSON object out of model text (code fences, preambles, trailing commentary). */
export function extractJson(text: string): unknown {
  const stripped = text.replace(/```(?:json)?/gi, "").trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object in model output");
  const candidate = stripped.slice(start, end + 1);
  try {
    return JSON.parse(candidate);
  } catch {
    // Common small-model slips: trailing commas.
    return JSON.parse(candidate.replace(/,\s*([}\]])/g, "$1"));
  }
}

function asCompact(raw: unknown): CompactSummary {
  const r = (raw ?? {}) as Record<string, unknown>;
  const items = (v: unknown) => (Array.isArray(v) ? v : []).map((x) => (typeof x === "string" ? { text: x, refs: [] } : (x as Record<string, unknown>)));
  const refs = (v: unknown) => (Array.isArray(v) ? v.map((n) => Number(String(n).replace(/[^0-9]/g, ""))).filter((n) => Number.isFinite(n) && n > 0) : []);
  const anchored = (v: unknown) => items(v).filter((x) => typeof x.text === "string" && x.text.trim()).map((x) => ({ text: String(x.text), refs: refs(x.refs) }));
  return {
    title: typeof r.title === "string" ? r.title : "",
    overview: typeof r.overview === "string" ? r.overview : "",
    keyPoints: anchored(r.keyPoints),
    decisions: anchored(r.decisions),
    openQuestions: anchored(r.openQuestions),
    actionItems: items(r.actionItems)
      .filter((x) => typeof x.text === "string" && x.text.trim())
      .map((x) => ({ text: String(x.text), owner: typeof x.owner === "string" ? x.owner : null, due: typeof x.due === "string" ? x.due : null, refs: refs(x.refs) })),
  };
}

/** Maps tags and refs back to cluster and segment ids, then validates against the domain schema. */
export function toConversationSummary(compact: CompactSummary, p: PreparedTranscript, meta: { providerId: string; transcriptRevision: number }): ConversationSummary {
  const spans = (text: string) =>
    text.replace(/\{?\b(S\d+)\b\}?/g, (m, tag: string) => {
      const cluster = p.tagToCluster.get(tag);
      return cluster ? speakerSpan(cluster) : m;
    });
  const ids = (refs: number[]) => [...new Set(refs.map((r) => p.refToSegment.get(r)).filter((x): x is string => !!x))];
  const draft = {
    title: compact.title.replace(/\{?\bS\d+\b\}?/g, "").trim(),
    overview: spans(compact.overview),
    keyPoints: compact.keyPoints.map((k) => ({ text: spans(k.text), sourceSegmentIds: ids(k.refs) })),
    decisions: compact.decisions.map((k) => ({ text: spans(k.text), sourceSegmentIds: ids(k.refs) })),
    openQuestions: compact.openQuestions.map((k) => ({ text: spans(k.text), sourceSegmentIds: ids(k.refs) })),
    actionItems: compact.actionItems.map((a) => ({
      text: spans(a.text),
      ...(a.owner && p.tagToCluster.get(a.owner.replace(/[{}]/g, "")) ? { ownerClusterId: p.tagToCluster.get(a.owner.replace(/[{}]/g, ""))! } : {}),
      ...(a.due ? { dueText: a.due } : {}),
      sourceSegmentIds: ids(a.refs),
    })),
  };
  const v = validateSummary(draft, new Set(p.refToSegment.values()));
  if (!v.ok || !v.value) throw new Error(`summary failed validation: ${v.errors.join("; ")}`);
  return { ...v.value, generatedAt: new Date().toISOString(), providerId: meta.providerId, sourceTranscriptRevision: meta.transcriptRevision };
}

export interface ChatModel {
  readonly id: string;
  /** Tokens available for prompt + output. */
  readonly contextTokens: number;
  readonly maxNewTokens: number;
  countTokens(text: string): Promise<number>;
  generate(messages: { role: "system" | "user" | "assistant"; content: string }[], opts: { signal?: AbortSignal; onTokens?: (n: number) => void }): Promise<string>;
}

async function generateCompact(model: ChatModel, system: string, user: string, signal?: AbortSignal): Promise<CompactSummary> {
  const messages = [
    { role: "system" as const, content: system },
    { role: "user" as const, content: user },
  ];
  let text = await model.generate(messages, { signal });
  try {
    return asCompact(extractJson(text));
  } catch (e) {
    // One repair round: small models occasionally drift out of JSON.
    text = await model.generate([...messages, { role: "assistant", content: text }, { role: "user", content: `That was not valid JSON (${errorMessage(e)}). Reply with only the JSON object.` }], { signal });
    return asCompact(extractJson(text));
  }
}

/**
 * plan.md §6.3 LocalSummaryProvider: transcripts that fit the validated context are summarized in one
 * pass; longer ones are summarized in chunks and reduced (recursively if needed). Output is validated
 * against the schema. transformers.js 4.2 has no grammar-constrained decoding, so validation plus one
 * repair round stands in for JSON-constrained decoding.
 */
export class ChunkedSummaryProvider implements SummaryProvider {
  constructor(readonly id: string, private readonly model: ChatModel, private readonly includeNames = false) {}

  async summarize(input: SummaryInput): Promise<ConversationSummary> {
    const p = prepareTranscript(input.segments, input.speakerNames, this.includeNames);
    const system = systemPrompt(input.language);
    const overhead = (await this.model.countTokens(system)) + 200;
    const budget = Math.max(500, this.model.contextTokens - this.model.maxNewTokens - overhead);
    const chunks: PromptLine[][] = [];
    let cur: PromptLine[] = [];
    let used = 0;
    for (const line of p.lines) {
      const n = Math.ceil((await this.model.countTokens(`${line.ref} [${line.time}] ${line.tag}: ${line.text}\n`)) * 1.02);
      if (cur.length && used + n > budget) {
        chunks.push(cur);
        cur = [];
        used = 0;
      }
      cur.push(line);
      used += n;
    }
    if (cur.length) chunks.push(cur);
    input.onProgress?.(0, { code: "summarizing", parts: chunks.length });
    let partials: CompactSummary[] = [];
    for (let i = 0; i < chunks.length; i++) {
      if (input.signal?.aborted) throw new Error("cancelled");
      partials.push(await generateCompact(this.model, system, transcriptPrompt(p, chunks[i]!), input.signal));
      input.onProgress?.((i + 1) / (chunks.length + (chunks.length > 1 ? 1 : 0)), { code: "summary-part", part: i + 1, parts: chunks.length });
    }
    while (partials.length > 1) {
      const groups: CompactSummary[][] = [];
      let group: CompactSummary[] = [];
      let size = 0;
      for (const s of partials) {
        const n = await this.model.countTokens(JSON.stringify(s));
        if (group.length && size + n > budget) {
          groups.push(group);
          group = [];
          size = 0;
        }
        group.push(s);
        size += n;
      }
      if (group.length) groups.push(group);
      if (groups.length === partials.length && partials.length > 1) {
        // Each partial alone fills the budget: reduce pairwise to guarantee progress.
        const paired: CompactSummary[][] = [];
        for (let i = 0; i < partials.length; i += 2) paired.push(partials.slice(i, i + 2));
        groups.splice(0, groups.length, ...paired);
      }
      const next: CompactSummary[] = [];
      for (const g of groups) next.push(g.length === 1 ? g[0]! : await generateCompact(this.model, system, reducePrompt(g), input.signal));
      partials = next;
    }
    input.onProgress?.(1, { code: "validating" });
    return toConversationSummary(partials[0]!, p, { providerId: this.id, transcriptRevision: input.transcriptRevision });
  }
}

/**
 * Opt-in cloud summaries (plan.md §6.3): only the normalized transcript lines and speaker display names
 * are sent; never audio or voice embeddings. The endpoint returns the same compact JSON.
 */
export class CloudSummaryProvider implements SummaryProvider {
  readonly id = "cloud";

  constructor(private readonly endpoint: string, private readonly fetchImpl: typeof fetch = fetch) {}

  async summarize(input: SummaryInput): Promise<ConversationSummary> {
    if (!/^https:\/\//.test(this.endpoint) && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(this.endpoint)) throw new Error("cloud summary endpoint must be https");
    const p = prepareTranscript(input.segments, input.speakerNames, true);
    input.onProgress?.(0.1, { code: "sending-transcript" });
    const res = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 1, language: input.language, speakers: p.legend, lines: p.lines }),
      signal: input.signal,
    });
    if (!res.ok) throw new Error(`cloud summary failed: HTTP ${res.status}`);
    const body = (await res.json()) as { summary?: unknown };
    input.onProgress?.(1, { code: "validating" });
    return toConversationSummary(asCompact(body.summary ?? body), p, { providerId: this.id, transcriptRevision: input.transcriptRevision });
  }
}
