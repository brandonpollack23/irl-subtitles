// The web APIs the app's model code relies on, for Node: a disk-backed Cache Storage (so downloads survive
// between runs, like the WebView's cache) and `self`. Plain JS so worker threads can load it before any hooks.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const urlOf = (req) => (typeof req === "string" ? req : req.url);

class DiskCache {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }
  file(req) {
    const url = typeof req === "string" ? req : req.url;
    return path.join(this.dir, createHash("sha256").update(url).digest("hex"));
  }
  async match(req) {
    // transformers.js also caches ORT's own WASM files; a cached copy comes back as a blob: URL, which Node
    // can't import. In the WebView those are HTTP assets; here only model downloads are worth caching.
    if (!urlOf(req).startsWith("https:")) return undefined;
    const f = this.file(req);
    if (!fs.existsSync(`${f}.body`)) return undefined;
    const meta = JSON.parse(fs.readFileSync(`${f}.json`, "utf8"));
    return new Response(fs.readFileSync(`${f}.body`), { status: 200, headers: meta.headers });
  }
  async put(req, res) {
    if (!urlOf(req).startsWith("https:")) return;
    const f = this.file(req);
    const body = Buffer.from(await res.arrayBuffer());
    // Write the body first: a key only exists once its bytes do.
    fs.writeFileSync(`${f}.body`, body);
    fs.writeFileSync(`${f}.json`, JSON.stringify({ url: typeof req === "string" ? req : req.url, headers: Object.fromEntries(res.headers) }));
  }
  async keys() {
    return fs
      .readdirSync(this.dir)
      .filter((n) => n.endsWith(".json"))
      .map((n) => new Request(JSON.parse(fs.readFileSync(path.join(this.dir, n), "utf8")).url));
  }
  async delete(req) {
    const f = this.file(req);
    const had = fs.existsSync(`${f}.body`);
    for (const s of [".body", ".json"]) fs.rmSync(`${f}${s}`, { force: true });
    return had;
  }
}

export function installWebEnv(cacheDir) {
  globalThis.self ??= globalThis;
  globalThis.caches = {
    open: async (name) => new DiskCache(path.join(cacheDir, name)),
    keys: async () => (fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir) : []),
    delete: async (name) => {
      fs.rmSync(path.join(cacheDir, name), { recursive: true, force: true });
      return true;
    },
  };
}

/**
 * transformers.js picks its runtime (onnxruntime-node vs onnxruntime-web and the "wasm" device) from
 * process.release at import time. The app runs it in a WebView, so hide Node while it loads.
 */
export async function importAsWeb(specifier) {
  const release = process.release;
  Object.defineProperty(process, "release", { value: { name: "webview" }, configurable: true });
  try {
    return await import(specifier);
  } finally {
    Object.defineProperty(process, "release", { value: release, configurable: true });
  }
}

export const defaultCacheDir = () => process.env.IRL_MODEL_CACHE ?? path.join(process.env.HOME ?? ".", ".cache/irl-subtitles-models");
