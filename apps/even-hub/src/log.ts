import { Emitter, redact } from "@irl/domain";

export interface LogLine {
  t: string;
  level: "debug" | "info" | "warn" | "error";
  scope: string;
  message: string;
}

const MAX = 1500;
const lines: LogLine[] = [];
export const logEvents = new Emitter<LogLine>();
let includeContent = false;

export function setLogContent(enabled: boolean): void {
  includeContent = enabled;
}

function stringify(parts: unknown[]): string {
  return parts
    .map((p) => {
      const r = redact(p, { includeContent });
      return typeof r === "string" ? r : JSON.stringify(r);
    })
    .join(" ");
}

export function log(level: LogLine["level"], scope: string, ...parts: unknown[]): void {
  const line: LogLine = { t: new Date().toISOString(), level, scope, message: stringify(parts) };
  lines.push(line);
  if (lines.length > MAX) lines.splice(0, lines.length - MAX);
  logEvents.emit(line);
}

export const logger = (scope: string) => ({
  debug: (...p: unknown[]) => log("debug", scope, ...p),
  info: (...p: unknown[]) => log("info", scope, ...p),
  warn: (...p: unknown[]) => log("warn", scope, ...p),
  error: (...p: unknown[]) => log("error", scope, ...p),
});

export function logLines(): readonly LogLine[] {
  return lines;
}

/**
 * Captures console output and uncaught errors into the redacted diagnostics buffer (plan.md §11: secrets
 * and transcript contents are never kept in diagnostics unless the user opts in).
 */
export function installConsoleCapture(): void {
  for (const level of ["warn", "error"] as const) {
    const orig = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      log(level, "console", ...args);
      orig(...args);
    };
  }
  addEventListener("error", (e) => log("error", "uncaught", e.message, `${e.filename}:${e.lineno}`));
  addEventListener("unhandledrejection", (e) => log("error", "unhandled", e.reason));
}

export function diagnosticsText(extra: Record<string, unknown>): string {
  return JSON.stringify({ generatedAt: new Date().toISOString(), app: __APP_VERSION__, build: __BUILD_ID__, ...(redact(extra, { includeContent }) as object), log: lines }, null, 2);
}
