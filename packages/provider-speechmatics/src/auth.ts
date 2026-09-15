export type SpeechmaticsRegion = "eu" | "us";

export const SPEECHMATICS_ENDPOINTS = {
  keys: "https://mp.speechmatics.com",
  batch: "https://asr.api.speechmatics.com",
  realtime: (region: SpeechmaticsRegion) => `wss://${region}.rt.speechmatics.com/v2`,
} as const;

/** Hosts for app.json's network whitelist. */
export const SPEECHMATICS_WHITELIST = ["https://mp.speechmatics.com", "https://asr.api.speechmatics.com", "wss://eu.rt.speechmatics.com", "wss://us.rt.speechmatics.com"] as const;

export class SpeechmaticsAuthError extends Error {}

/**
 * Temporary realtime key (a JWT): browsers can't send the long-lived key to the realtime host. mp.speechmatics.com
 * answers a rejected key without CORS headers, so a rejection reads as a network failure here (spike irl-subt-3xb.4).
 */
export async function mintRealtimeKey(apiKey: string, ttlSeconds = 3600, fetchImpl: typeof fetch = fetch): Promise<string> {
  let r: Response;
  try {
    r = await fetchImpl(`${SPEECHMATICS_ENDPOINTS.keys}/v1/api_keys?type=rt`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ttl: Math.max(60, Math.min(86_400, Math.round(ttlSeconds))) }),
    });
  } catch {
    throw new Error("Could not get a Speechmatics session key (key rejected, offline, or blocked by the network allowlist)");
  }
  if (r.status === 401 || r.status === 403) throw new SpeechmaticsAuthError("Speechmatics rejected the key");
  if (!r.ok) throw new Error(`Speechmatics returned HTTP ${r.status} for a session key`);
  const body = (await r.json().catch(() => ({}))) as { key_value?: string };
  if (!body.key_value) throw new Error("Speechmatics returned no session key");
  return body.key_value;
}

/** Smallest authenticated request; the batch API answers 401 with CORS headers, so a rejection is readable. */
export async function testSpeechmaticsKey(apiKey: string, fetchImpl: typeof fetch = fetch): Promise<{ ok: boolean; message: string }> {
  try {
    const r = await fetchImpl(`${SPEECHMATICS_ENDPOINTS.batch}/v2/jobs?limit=1`, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (r.ok) return { ok: true, message: "Key works" };
    if (r.status === 401 || r.status === 403) return { ok: false, message: "Speechmatics rejected the key" };
    return { ok: false, message: `Speechmatics returned HTTP ${r.status}` };
  } catch {
    return { ok: false, message: "Could not reach Speechmatics (offline, blocked by the network allowlist, or CORS)" };
  }
}
