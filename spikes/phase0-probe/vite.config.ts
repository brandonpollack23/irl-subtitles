/// <reference types="vitest/config" />
import { createReadStream, mkdirSync, readFileSync, statSync, writeFileSync, createWriteStream } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import solid from "@solidjs/vite-plugin";
import { defineConfig, type Plugin } from "vite";

const root = import.meta.dirname;
const resultsDir = join(root, "results");
const modelsDir = join(root, "models");
const appVersion = (JSON.parse(readFileSync(join(root, "app.json"), "utf8")) as { version: string }).version;

// PROBE_COI=0 serves without COOP/COEP so we can see what the WebView does unisolated.
const coi = process.env.PROBE_COI !== "0";

// PROBE_HTTPS=1 serves over TLS with the mkcert certificate from `pnpm certs`. Phone browsers only
// treat localhost or https as a secure context, and WebGPU, OPFS, and SharedArrayBuffer need one.
function https() {
  if (process.env.PROBE_HTTPS !== "1") return undefined;
  try {
    return { key: readFileSync(join(root, "certs", "key.pem")), cert: readFileSync(join(root, "certs", "cert.pem")) };
  } catch {
    throw new Error("PROBE_HTTPS=1 but certs/key.pem or certs/cert.pem is missing: run `pnpm certs` first");
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((ok, fail) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => ok(Buffer.concat(chunks)));
    req.on("error", fail);
  });
}

function safeJoin(base: string, rel: string): string | null {
  const p = normalize(join(base, decodeURIComponent(rel)));
  return p.startsWith(base) ? p : null;
}

/** Dev-server endpoints so reports and recordings from the phone land on the laptop. */
function probeSink(): Plugin {
  const handler = async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const url = new URL(req.url ?? "/", "http://x");
    try {
      if (req.method === "POST" && url.pathname === "/__probe/report") {
        const body = JSON.parse((await readBody(req)).toString("utf8")) as { spike?: string };
        const spike = (body.spike ?? "misc").replace(/[^a-z0-9._-]/gi, "_");
        const file = join(resultsDir, spike, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, JSON.stringify(body, null, 2));
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ saved: file.slice(root.length + 1) }));
        return;
      }
      if (req.method === "POST" && url.pathname === "/__probe/upload") {
        const name = (url.searchParams.get("name") ?? "upload.bin").replace(/[^a-z0-9._-]/gi, "_");
        const file = join(resultsDir, "recordings", name);
        mkdirSync(dirname(file), { recursive: true });
        // offset lets the phone upload large recordings in pieces.
        const offset = Number(url.searchParams.get("offset") ?? "0");
        const out = createWriteStream(file, { flags: offset === 0 ? "w" : "r+", start: offset });
        req.pipe(out);
        out.on("finish", () => res.end(JSON.stringify({ saved: file.slice(root.length + 1), offset })));
        out.on("error", (e) => {
          res.statusCode = 500;
          res.end(String(e));
        });
        return;
      }
      if ((req.method === "GET" || req.method === "HEAD") && url.pathname.startsWith("/models/")) {
        const file = safeJoin(modelsDir, url.pathname.slice("/models/".length));
        if (!file) return next();
        let size: number;
        try {
          size = statSync(file).size;
        } catch {
          res.statusCode = 404;
          res.end("model file not found; run pnpm models:fetch");
          return;
        }
        res.setHeader("content-length", String(size));
        res.setHeader("content-type", "application/octet-stream");
        res.setHeader("cross-origin-resource-policy", "same-origin");
        if (req.method === "HEAD") return void res.end();
        createReadStream(file).pipe(res);
        return;
      }
    } catch (e) {
      res.statusCode = 500;
      res.end(String(e));
      return;
    }
    next();
  };
  return {
    name: "probe-sink",
    configureServer: (server) => void server.middlewares.use(handler),
    configurePreviewServer: (server) => void server.middlewares.use(handler),
  };
}

const headers: Record<string, string> = coi
  ? { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" }
  : {};

export default defineConfig({
  root,
  plugins: [solid(), probeSink()],
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
    __BUILD_ID__: JSON.stringify(new Date().toISOString()),
    __SERVED_COI__: JSON.stringify(coi),
  },
  server: { host: true, port: 5173, strictPort: true, headers, https: https() },
  preview: { host: true, port: 5173, strictPort: true, headers, https: https() },
  optimizeDeps: { exclude: ["onnxruntime-web", "@tursodatabase/database-wasm"] },
  worker: { format: "es" },
  build: { target: "esnext", outDir: resolve(root, "dist"), emptyOutDir: true },
  // Unit tests cover framework-free logic only.
  test: { environment: "node", include: ["test/**/*.test.ts"] },
});
