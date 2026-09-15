export type SpeechmaticsRegion = "eu" | "us" | "au";

export const SPEECHMATICS_REGIONS: readonly SpeechmaticsRegion[] = ["eu", "us", "au"];

/**
 * Speechmatics hosts per region. Long-lived keys and batch jobs are region-bound, so batch calls go to the same region
 * as realtime; temporary keys come from one global endpoint and work in any realtime region.
 */
export const SPEECHMATICS_ENDPOINTS = {
  keys: "https://mp.speechmatics.com",
  batch: (region: SpeechmaticsRegion) => `https://${region}1.asr.api.speechmatics.com`,
  realtime: (region: SpeechmaticsRegion) => `wss://${region}.rt.speechmatics.com/v2`,
} as const;

/** Hosts for app.json's network whitelist and the CSP. */
export const SPEECHMATICS_WHITELIST = ["https://mp.speechmatics.com", ...SPEECHMATICS_REGIONS.flatMap((r) => [SPEECHMATICS_ENDPOINTS.batch(r), `wss://${r}.rt.speechmatics.com`])];

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
export async function testSpeechmaticsKey(apiKey: string, region: SpeechmaticsRegion = "eu", fetchImpl: typeof fetch = fetch): Promise<{ ok: boolean; message: string }> {
  try {
    const r = await fetchImpl(`${SPEECHMATICS_ENDPOINTS.batch(region)}/v2/jobs?limit=1`, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (r.ok) return { ok: true, message: "Key works" };
    if (r.status === 401 || r.status === 403) return { ok: false, message: "Speechmatics rejected the key (keys only work in the region they were created in)" };
    return { ok: false, message: `Speechmatics returned HTTP ${r.status}` };
  } catch {
    return { ok: false, message: "Could not reach Speechmatics (offline, blocked by the network allowlist, or CORS)" };
  }
}
