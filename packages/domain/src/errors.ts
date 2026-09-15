import type { CloudService } from "./selection";
import { errorMessage } from "./util";

/**
 * Failures a user can act on or should understand, by code so the UI can say them in its own language
 * (irl-subt-0n7.4). The message stays English for logs and diagnostics.
 */
export type UserErrorCode =
  | "glasses-unavailable"
  | "glasses-page"
  | "glasses-audio"
  | "key-missing"
  | "key-rejected"
  | "service-unreachable"
  | "service-timeout"
  | "recording-in-progress"
  | "audio-setting-locked"
  | "full-name-required"
  | "cancelled";

export class UserError extends Error {
  readonly code: UserErrorCode;
  readonly service?: CloudService;

  constructor(code: UserErrorCode, message: string, opts: { service?: CloudService } = {}) {
    super(message);
    this.name = "UserError";
    this.code = code;
    if (opts.service) this.service = opts.service;
  }
}

/** What went wrong, as stored and shown: a code the UI translates when there is one, and the raw detail always. */
export interface Problem {
  detail: string;
  code?: UserErrorCode;
  service?: CloudService;
}

export function problemOf(e: unknown): Problem {
  if (e instanceof UserError) return { detail: e.message, code: e.code, ...(e.service ? { service: e.service } : {}) };
  return { detail: errorMessage(e) };
}

/** A live-recording problem and when it happened: starting capture, while recording, or saving audio or transcript. */
export interface LiveProblem extends Problem {
  during: "start" | "recording" | "saving";
}
