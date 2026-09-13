/**
 * Optional transcript-only summary service (plan.md §6.3, irl-subt-9ij.2). The app sends normalized
 * transcript lines and speaker display names, never audio or voice embeddings, and receives the compact
 * summary JSON its CloudSummaryProvider validates.
 *
 *   ANTHROPIC_API_KEY=… SUMMARY_API_TOKEN=… ALLOWED_ORIGIN=https://your-app-origin pnpm start
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import Anthropic from "@anthropic-ai/sdk";
import { extractJson, systemPrompt, transcriptPrompt, type PreparedTranscript, type PromptLine } from "@irl/provider-summary";

const PORT = Number(process.env.PORT ?? 8787);
const TOKEN = process.env.SUMMARY_API_TOKEN ?? "";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN ?? "";
const MODEL = process.env.SUMMARY_MODEL ?? "claude-opus-5";
const MAX_BODY_BYTES = 4 * 1024 * 1024;

const client = new Anthropic();

interface RequestBody {
  version: 1;
  language: string;
  speakers: { tag: string; name: string }[];
  lines: PromptLine[];
}

function isBody(v: unknown): v is RequestBody {
  const b = v as RequestBody;
  return !!b && b.version === 1 && Array.isArray(b.lines) && Array.isArray(b.speakers) && b.lines.every((l) => typeof l.ref === "number" && typeof l.text === "string");
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((ok, fail) => {
    let size = 0;
    const parts: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        fail(new Error("body too large"));
        req.destroy();
      } else parts.push(c);
    });
    req.on("end", () => ok(Buffer.concat(parts).toString("utf8")));
    req.on("error", fail);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function summarize(body: RequestBody): Promise<unknown> {
  const prepared: PreparedTranscript = {
    lines: body.lines,
    legend: body.speakers,
    tagToCluster: new Map(),
    refToSegment: new Map(),
  };
  // Long transcripts fit comfortably in a 1M-token context, so no chunking is needed here.
  const stream = client.beta.messages.stream({
    model: MODEL,
    max_tokens: 64000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    thinking: { type: "adaptive" },
    output_config: { effort: "medium" },
    system: systemPrompt(body.language),
    messages: [{ role: "user", content: transcriptPrompt(prepared, body.lines) }],
  });
  const message = await stream.finalMessage();
  if (message.stop_reason === "refusal") throw Object.assign(new Error("the model declined to summarize this transcript"), { status: 422 });
  const text = message.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  return extractJson(text);
}

createServer(async (req, res) => {
  if (ALLOWED_ORIGIN) {
    res.setHeader("access-control-allow-origin", ALLOWED_ORIGIN);
    res.setHeader("access-control-allow-headers", "content-type, authorization");
    res.setHeader("access-control-allow-methods", "POST, OPTIONS");
    res.setHeader("vary", "origin");
  }
  if (req.method === "OPTIONS") return void res.writeHead(204).end();
  if (req.method !== "POST" || req.url !== "/v1/summarize") return send(res, 404, { error: "not found" });
  if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) return send(res, 401, { error: "unauthorized" });
  try {
    const parsed: unknown = JSON.parse(await readBody(req));
    if (!isBody(parsed)) return send(res, 400, { error: "expected {version: 1, language, speakers, lines}" });
    // Never log transcript content.
    console.log(`summarize: ${parsed.lines.length} lines, ${parsed.speakers.length} speakers`);
    send(res, 200, { summary: await summarize(parsed) });
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) return send(res, 429, { error: "rate limited, retry later" });
    if (e instanceof Anthropic.APIError) return send(res, 502, { error: `upstream error ${e.status}` });
    const status = (e as { status?: number }).status ?? 500;
    send(res, status, { error: e instanceof Error ? e.message : "failed" });
  }
}).listen(PORT, () => console.log(`summary-api listening on :${PORT} (model ${MODEL})`));
