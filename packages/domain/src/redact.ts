/**
 * Diagnostics redaction (plan.md §11): secrets are always removed; transcript content is removed
 * unless the user opted in. Applied to every log line before it is kept or exported.
 */
const SECRET_KEYS = /(api[_-]?key|authorization|token|secret|password|bearer)/i;
const CONTENT_KEYS = /^(text|transcript|finalText|provisionalText|overview|title|content|caption|fullName|shortName|summary)$/i;
const BEARER = /(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/g;
/** Long opaque strings that look like credentials. */
const KEYLIKE = /\b[A-Za-z0-9_-]{32,}\b/g;

export interface RedactOptions {
  includeContent: boolean;
}

export function redactString(s: string): string {
  return s.replace(BEARER, "$1[redacted]").replace(KEYLIKE, "[redacted]");
}

export function redact(value: unknown, opts: RedactOptions, depth = 0): unknown {
  if (depth > 8) return "[depth]";
  if (typeof value === "string") return redactString(value);
  if (value instanceof Error) return redactString(`${value.name}: ${value.message}`);
  if (ArrayBuffer.isView(value)) return `[${value.constructor.name} ${value.byteLength}B]`;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, opts, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEYS.test(k)) out[k] = "[redacted]";
      else if (!opts.includeContent && CONTENT_KEYS.test(k) && typeof v === "string") out[k] = `[${v.length} chars]`;
      else out[k] = redact(v, opts, depth + 1);
    }
    return out;
  }
  return value;
}
