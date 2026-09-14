import type { DeviceCapabilities } from "@irl/provider-local";
import type { StorageDiagnostics } from "@irl/storage";

export interface PlatformFeature {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface PlatformReport {
  /** Where the page is running: the Even simulator, the Even app on a phone, or a plain browser. */
  host: string;
  engine: string;
  database: string;
  audio: string;
  features: PlatformFeature[];
  fallbackReasons: string[];
}

function engineOf(ua: string): string {
  if (/Firefox\//.test(ua)) return "Gecko";
  if (/Chrom(e|ium)\/|CriOS\//.test(ua)) return "Chromium";
  if (/AppleWebKit\//.test(ua)) return /X11|Linux/.test(ua) && !/Android/.test(ua) ? "WebKitGTK" : "WebKit";
  return "unknown";
}

const BACKEND_LABEL: Record<string, string> = { "turso-opfs": "Turso (OPFS)", "sqlite-node": "SQLite (node)", indexeddb: "IndexedDB", opfs: "OPFS", memory: "memory" };

/** What this page can and can't use, in one place, for the dev marker and the logs. */
export function platformReport(caps: DeviceCapabilities, storage: StorageDiagnostics, inEvenApp: boolean): PlatformReport {
  // The simulator also provides the Even bridge; only a phone runs the real app.
  const host = inEvenApp ? (caps.platform === "desktop" ? "Even simulator" : `Even app (${caps.platform})`) : `Browser (${caps.platform})`;
  const reason = (prefix: string) => storage.fallbackReasons.find((r) => r.startsWith(`${prefix}: `))?.slice(prefix.length + 2);
  const gpu = caps.webgpu;
  return {
    host,
    engine: engineOf(caps.userAgent),
    database: BACKEND_LABEL[storage.database] ?? storage.database,
    audio: BACKEND_LABEL[storage.blobs] ?? storage.blobs,
    features: [
      { name: "Even bridge", ok: inEvenApp },
      { name: "Secure context", ok: caps.secureContext },
      { name: "Cross-origin isolated", ok: caps.crossOriginIsolated },
      { name: "SharedArrayBuffer", ok: typeof SharedArrayBuffer === "function" },
      { name: "OPFS", ok: typeof navigator.storage?.getDirectory === "function" },
      { name: "OPFS sync access handles", ok: storage.blobs === "opfs", detail: reason("opfs") },
      { name: "Turso database", ok: storage.database === "turso-opfs", detail: reason("turso") },
      { name: "Persistent storage", ok: storage.persisted === true, detail: storage.persisted === null ? reason("storage manager") : undefined },
      { name: "WebGPU", ok: gpu.available, detail: gpu.available ? [gpu.vendor, gpu.architecture].filter(Boolean).join(" ") || undefined : gpu.error },
      { name: "WebGPU shader-f16", ok: gpu.shaderF16 },
      { name: "WASM SIMD", ok: caps.wasmSimd },
      { name: "WASM threads", ok: caps.wasmThreads },
      { name: "WebCodecs Opus", ok: caps.webCodecsOpus },
    ],
    fallbackReasons: storage.fallbackReasons,
  };
}
