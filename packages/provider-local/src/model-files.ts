import type { ModelCatalogEntry } from "@irl/domain";
import { LOCK } from "./catalog";
import { Sha256 } from "./sha256";

export const MODEL_CACHE = "irl-models-v1";
/** transformers.js keeps its downloads in this Cache Storage bucket (env.cacheKey). */
export const TJS_CACHE = "transformers-cache";

export function hfUrl(repo: string, revision: string, path: string): string {
  return `https://huggingface.co/${repo}/resolve/${revision}/${path}`;
}

const HF_RESOLVE = /^https:\/\/huggingface\.co\/(.+?)\/resolve\/([^/]+)\/(.+)$/;

function expectedSha(url: string): { sha256: string; size: number } | null {
  const m = HF_RESOLVE.exec(url);
  if (!m) return null;
  const [, repo, revision, path] = m;
  const locked = LOCK.repos[repo!];
  if (!locked || locked.revision !== revision) return null;
  const f = locked.files.find((x) => x.path === decodeURIComponent(path!));
  return f?.sha256 ? { sha256: f.sha256, size: f.size } : null;
}

export class IntegrityError extends Error {}

/**
 * fetch() that verifies pinned files while streaming (plan.md §6.1: download once, verify integrity hash,
 * cache locally). Unpinned URLs pass through unchanged. A mismatch errors the body stream, so neither
 * transformers.js nor our cache ever stores a bad file.
 */
export function verifyingFetch(base: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const res = await base(input, init);
    const expected = expectedSha(url);
    if (!expected || !res.ok || !res.body || (init?.method && init.method !== "GET")) return res;
    const hash = new Sha256();
    let size = 0;
    const checked = res.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, ctl) {
          hash.update(chunk);
          size += chunk.byteLength;
          ctl.enqueue(chunk);
        },
        flush(ctl) {
          const got = hash.hex();
          if (got !== expected.sha256 || size !== expected.size) ctl.error(new IntegrityError(`integrity check failed for ${url}: sha256 ${got.slice(0, 12)}… size ${size}`));
        },
      }),
    );
    return new Response(checked, { status: res.status, statusText: res.statusText, headers: res.headers });
  };
}

export type ProgressFn = (loaded: number, total: number) => void;

/** Downloads (or reads from cache) one pinned file for ORT-direct adapters. */
export async function loadModelFile(entry: ModelCatalogEntry, path: string, onProgress?: ProgressFn): Promise<Uint8Array> {
  const src = entry.manifest.source;
  if (src.type !== "hf") throw new Error("only Hugging Face sources are supported");
  const url = hfUrl(src.repo, src.revision, path);
  const cache = await caches.open(MODEL_CACHE);
  const hit = await cache.match(url);
  if (hit) return new Uint8Array(await hit.arrayBuffer());
  const res = await verifyingFetch()(url);
  if (!res.ok || !res.body) throw new Error(`download failed (${res.status}) for ${path}`);
  const total = Number(res.headers.get("content-length") ?? entry.manifest.files.find((f) => f.path === path)?.bytes ?? 0);
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    loaded += value.byteLength;
    onProgress?.(loaded, total);
  }
  const bytes = new Uint8Array(loaded);
  let off = 0;
  for (const p of parts) {
    bytes.set(p, off);
    off += p.byteLength;
  }
  await cache.put(url, new Response(bytes, { headers: { "content-type": "application/octet-stream", "content-length": String(loaded) } }));
  return bytes;
}

/** Files of an entry that exist in either cache. */
export async function cachedFiles(entry: ModelCatalogEntry): Promise<{ cached: number; total: number; bytes: number }> {
  const src = entry.manifest.source;
  if (src.type !== "hf" || !entry.manifest.files.length) return { cached: 0, total: 0, bytes: 0 };
  const [ours, tjs] = await Promise.all([caches.open(MODEL_CACHE), caches.open(TJS_CACHE)]);
  let cached = 0;
  let bytes = 0;
  const locked = LOCK.repos[src.repo];
  const files = entry.manifest.files.filter((f) => !locked || locked.files.some((l) => l.path === f.path));
  for (const f of files) {
    const url = hfUrl(src.repo, src.revision, f.path);
    if ((await ours.match(url)) || (await tjs.match(url))) {
      cached++;
      bytes += f.bytes ?? 0;
    }
  }
  return { cached, total: files.length, bytes };
}

export async function deleteModelFiles(entry: ModelCatalogEntry): Promise<void> {
  const src = entry.manifest.source;
  if (src.type !== "hf") return;
  const [ours, tjs] = await Promise.all([caches.open(MODEL_CACHE), caches.open(TJS_CACHE)]);
  for (const f of entry.manifest.files) {
    const url = hfUrl(src.repo, src.revision, f.path);
    await ours.delete(url);
    await tjs.delete(url);
  }
}
