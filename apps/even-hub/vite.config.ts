import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import solid from "@solidjs/vite-plugin";
import { defineConfig, type Plugin } from "vite";

const root = import.meta.dirname;
const appVersion = (JSON.parse(readFileSync(join(root, "app.json"), "utf8")) as { version: string }).version;

// Dev server is cross-origin isolated by default so Turso/OPFS and WASM threads are available; IRL_COI=0
// serves without isolation to exercise the IndexedDB fallback the way a non-isolated WebView would.
const coi = process.env.IRL_COI !== "0";
const coiHeaders: Record<string, string> = coi ? { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" } : {};

function https() {
  if (process.env.IRL_HTTPS !== "1") return undefined;
  try {
    return { key: readFileSync(join(root, "certs", "key.pem")), cert: readFileSync(join(root, "certs", "cert.pem")) };
  } catch {
    throw new Error("IRL_HTTPS=1 needs certs/key.pem and certs/cert.pem: run `node scripts/certs.mjs` first");
  }
}

/** Network allowlist (plan.md §11). Must match app.json's Even whitelist. */
const CONNECT = [
  "'self'",
  "blob:",
  "data:",
  "https://huggingface.co",
  "https://*.huggingface.co",
  "https://*.hf.co",
  // Moonshine Streaming models (versioned paths, pinned by SHA-256 in catalog.lock.json).
  "https://download.moonshine.ai",
  "https://api.soniox.com",
  "wss://stt-rt.soniox.com",
  // Speechmatics (irl-subt-3xb.5): session keys, batch jobs, realtime regions.
  "https://mp.speechmatics.com",
  "https://asr.api.speechmatics.com",
  "wss://eu.rt.speechmatics.com",
  "wss://us.rt.speechmatics.com",
  ...(process.env.IRL_SUMMARY_ORIGIN ? [process.env.IRL_SUMMARY_ORIGIN] : []),
];

function csp(): Plugin {
  return {
    name: "irl-csp",
    transformIndexHtml(html, ctx) {
      const dev = !!ctx.server;
      // Dev only: the Even simulator (Tauri on WebKitGTK) relays console output over fetch("ipc://localhost/…").
      // Blocking it makes WebKit print "internal error… This is a WebKit bug" before Tauri
      // falls back to postMessage. The Even app itself doesn't use it, so the shipped policy stays on the whitelist.
      const devConnect = dev ? " ws: wss: ipc: http://ipc.localhost" : "";
      const policy = [
        "default-src 'self'",
        // wasm-unsafe-eval: ONNX Runtime WASM; blob: the runtime loads its factory from a cached blob URL.
        `script-src 'self' 'wasm-unsafe-eval' blob:${dev ? " 'unsafe-inline'" : ""}`,
        "worker-src 'self' blob:",
        `connect-src ${CONNECT.join(" ")}${devConnect}`,
        "img-src 'self' data: blob:",
        "media-src 'self' blob:",
        "style-src 'self' 'unsafe-inline'",
        "font-src 'self' data:",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
      ].join("; ");
      return html.replace("<!--CSP-->", `<meta http-equiv="Content-Security-Policy" content="${policy}" />`);
    },
  };
}

export default defineConfig({
  root,
  plugins: [solid(), csp()],
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
    __BUILD_ID__: JSON.stringify(new Date().toISOString()),
  },
  server: { host: true, port: 5174, strictPort: true, headers: coiHeaders, https: https() },
  preview: { host: true, port: 5174, strictPort: true, headers: coiHeaders, https: https() },
  optimizeDeps: { exclude: ["onnxruntime-web", "@tursodatabase/database-wasm", "@huggingface/transformers"] },
  worker: { format: "es" },
  build: { target: "esnext", outDir: resolve(root, "dist"), emptyOutDir: true, chunkSizeWarningLimit: 4096 },
});
