import type { ExecutionTarget, ModelCatalogEntry, ModelFile } from "@irl/domain";
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

/** transformers.js 4.2 graph file suffix per dtype (DEFAULT_DTYPE_SUFFIX_MAPPING). */
const DTYPE_SUFFIX: Record<string, string> = { fp32: "", fp16: "_fp16", int8: "_int8", uint8: "_uint8", q8: "_quantized", q4: "_q4", q2: "_q2", q1: "_q1", q4f16: "_q4f16", q2f16: "_q2f16", q1f16: "_q1f16", bnb4: "_bnb4" };
const GRAPH = /\.onnx(_data(_\d+)?)?$/;

/**
 * Pinned files the entry's adapter reads when running on any of `targets`. transformers.js picks each
 * session's graph by dtype, so graphs for other dtypes are skipped; without a per-session dtype map every
 * pinned file counts.
 */
export function filesForTargets(entry: ModelCatalogEntry, targets: readonly ExecutionTarget[]): ModelFile[] {
  const files = entry.manifest.files;
  if (!entry.manifest.adapter.startsWith("tjs-")) return files;
  const dtypes = (entry.manifest.params?.dtype ?? {}) as Partial<Record<ExecutionTarget, string | Record<string, string>>>;
  const stems = new Set<string>();
  for (const t of targets) {
    const d = dtypes[t];
    if (!d || typeof d === "string") return files;
    for (const [session, dtype] of Object.entries(d)) {
      const suffix = DTYPE_SUFFIX[dtype];
      if (suffix === undefined) return files;
      stems.add(`onnx/${session}${suffix}`);
    }
  }
  return files.filter((f) => !GRAPH.test(f.path) || stems.has(f.path.replace(GRAPH, "")));
}

/** transformers.js adapters read Cache Storage through transformers.js; ORT-direct adapters use loadModelFile. */
function cacheFor(entry: ModelCatalogEntry): Promise<Cache> {
  return caches.open(entry.manifest.adapter.startsWith("tjs-") ? TJS_CACHE : MODEL_CACHE);
}

/** Files not yet in the cache the entry's adapter reads from. Uses keys(), so no cached body is opened. */
export async function missingFiles(entry: ModelCatalogEntry, files: readonly ModelFile[]): Promise<ModelFile[]> {
  const src = entry.manifest.source;
  if (src.type !== "hf") return [...files];
  const cached = new Set((await (await cacheFor(entry)).keys()).map((r) => r.url));
  return files.filter((f) => !cached.has(hfUrl(src.repo, src.revision, f.path)));
}

/**
 * Downloads files into the cache the adapter reads from, streaming each verified response straight into
 * Cache Storage: no JS copy of the weights and no inference session. Loading a model just to download it
 * held several copies of its weights at once (JS buffer, cache body, WASM heap, GPU), enough for WebKit to
 * kill the process on the summary models. A file that fails its pinned hash errors the stream, so it is
 * never stored.
 */
export async function downloadModelFiles(entry: ModelCatalogEntry, files: readonly ModelFile[], onProgress?: ProgressFn): Promise<void> {
  const src = entry.manifest.source;
  if (src.type !== "hf") throw new Error("only Hugging Face sources are supported");
  const cache = await cacheFor(entry);
  const missing = new Set(await missingFiles(entry, files));
  const total = files.reduce((n, f) => n + (f.bytes ?? 0), 0);
  let loaded = total - [...missing].reduce((n, f) => n + (f.bytes ?? 0), 0);
  onProgress?.(loaded, total);
  for (const f of missing) {
    const url = hfUrl(src.repo, src.revision, f.path);
    const res = await verifyingFetch()(url);
    if (!res.ok || !res.body) throw new Error(`download failed (${res.status}) for ${f.path}`);
    const counted = res.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, ctl) {
          loaded += chunk.byteLength;
          onProgress?.(loaded, total);
          ctl.enqueue(chunk);
        },
      }),
    );
    // transformers.js sizes its read buffer from content-length; the pinned size is the decoded size.
    const headers = new Headers({ "content-type": res.headers.get("content-type") ?? "application/octet-stream" });
    if (f.bytes) headers.set("content-length", String(f.bytes));
    await cache.put(url, new Response(counted, { headers }));
  }
}

/** Drops both model caches outright, including files transformers.js cached outside the pinned manifests. */
export async function clearModelCache(): Promise<void> {
  await Promise.all([caches.delete(MODEL_CACHE), caches.delete(TJS_CACHE)]);
}
