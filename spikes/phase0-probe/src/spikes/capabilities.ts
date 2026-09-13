import { getBridge } from "../bridge";
import { lsGet, lsSet } from "../report";
import { probeWebNN } from "./webnn-probe";

// Minimal modules from wasm-feature-detect.
const WASM_SIMD = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);
const WASM_RELAXED_SIMD = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 15, 1, 13, 0, 65, 1, 253, 15, 65, 2, 253, 15, 253, 128, 2, 11]);
const WASM_THREADS = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 5, 4, 1, 3, 1, 1, 10, 11, 1, 9, 0, 65, 0, 254, 16, 2, 0, 26, 11]);

const LS_COI_SW = "probe.coiServiceWorkerAttempted";

async function attempt<T>(fn: () => Promise<T> | T): Promise<T | { error: string }> {
  try {
    return await fn();
  } catch (e) {
    return { error: String(e) };
  }
}

function workerProbe(): Promise<unknown> {
  return new Promise((ok) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL("./capabilities.worker.ts", import.meta.url), { type: "module" });
    } catch (e) {
      ok({ error: `worker construct: ${String(e)}` });
      return;
    }
    const timer = setTimeout(() => ok({ error: "worker probe timed out after 60s" }), 60_000);
    const result: Record<string, unknown> = {};
    worker.onmessage = (e) => {
      if (e.data.sabEcho) {
        result.sabPostMessage = true;
        return;
      }
      clearTimeout(timer);
      Object.assign(result, e.data.result ?? { error: e.data.error });
      worker.terminate();
      ok(result);
    };
    worker.onerror = (e) => {
      clearTimeout(timer);
      ok({ error: `worker error: ${e.message}` });
    };
    if (typeof SharedArrayBuffer !== "undefined" && crossOriginIsolated) {
      try {
        worker.postMessage(new SharedArrayBuffer(4));
      } catch (e) {
        result.sabPostMessage = String(e);
      }
    }
    worker.postMessage("probe");
  });
}

export async function runInventory(log: (...p: unknown[]) => void, includeOpLimits: boolean) {
  const nav = navigator as Navigator & Record<string, any>;
  log("headers of this document…");
  const documentHeaders = await attempt(async () => {
    const r = await fetch(location.href, { method: "GET", cache: "no-store" });
    const pick = ["cross-origin-opener-policy", "cross-origin-embedder-policy", "content-security-policy", "server", "content-type"];
    return Object.fromEntries(pick.map((k) => [k, r.headers.get(k)]));
  });

  log("platform features…");
  const platform = {
    location: { protocol: location.protocol, origin: location.origin, isSecureContext },
    crossOriginIsolated,
    sharedArrayBuffer: typeof SharedArrayBuffer !== "undefined",
    sharedWasmMemory: await attempt(() => (new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true }), true)),
    wasm: {
      simd: WebAssembly.validate(WASM_SIMD),
      relaxedSimd: WebAssembly.validate(WASM_RELAXED_SIMD),
      threads: WebAssembly.validate(WASM_THREADS),
      jspi: typeof (WebAssembly as any).Suspending !== "undefined",
    },
    workers: {
      dedicated: typeof Worker !== "undefined",
      shared: typeof SharedWorker !== "undefined",
      serviceWorker: "serviceWorker" in navigator,
      serviceWorkerController: !!navigator.serviceWorker?.controller,
    },
    storage: {
      opfsGetDirectory: typeof navigator.storage?.getDirectory === "function",
      estimate: await attempt(async () => {
        const e = await navigator.storage.estimate();
        return { quotaMiB: Math.round((e.quota ?? 0) / 2 ** 20), usageMiB: Math.round((e.usage ?? 0) / 2 ** 20) };
      }),
      persistedBefore: await attempt(() => navigator.storage.persisted()),
      persistRequest: await attempt(() => navigator.storage.persist()),
      indexedDb: await attempt(
        () =>
          new Promise<boolean>((ok, fail) => {
            const req = indexedDB.open("probe-capabilities", 1);
            req.onsuccess = () => (req.result.close(), ok(true));
            req.onerror = () => fail(req.error);
          }),
      ),
      webLocks: "locks" in navigator,
    },
    crypto: {
      subtle: !!crypto.subtle,
      nonExtractableAesGcm: await attempt(async () => {
        const k = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
        return k.extractable === false;
      }),
    },
    webgpu: await attempt(async () => {
      if (!nav.gpu) return { present: false };
      const adapter = await nav.gpu.requestAdapter();
      return { present: true, adapter: adapter ? { info: adapter.info ? { ...adapter.info, vendor: adapter.info.vendor, architecture: adapter.info.architecture } : null } : null };
    }),
    audio: { audioContext: typeof AudioContext !== "undefined", audioWorklet: typeof AudioWorkletNode !== "undefined" },
    network: { webSocket: typeof WebSocket !== "undefined", webTransport: typeof (globalThis as any).WebTransport !== "undefined" },
    battery: await attempt(async () => {
      if (!nav.getBattery) return "getBattery unavailable";
      const b = await nav.getBattery();
      return { level: b.level, charging: b.charging };
    }),
    memory: {
      deviceMemoryGb: nav.deviceMemory ?? null,
      measureUserAgentSpecificMemory: typeof (performance as any).measureUserAgentSpecificMemory === "function",
      performanceMemory: (performance as any).memory
        ? { jsHeapSizeLimitMiB: Math.round((performance as any).memory.jsHeapSizeLimit / 2 ** 20) }
        : null,
    },
    hardwareConcurrency: navigator.hardwareConcurrency,
    userAgentData: await attempt(async () =>
      nav.userAgentData?.getHighEntropyValues
        ? await nav.userAgentData.getHighEntropyValues(["platform", "platformVersion", "model", "fullVersionList", "architecture"])
        : null,
    ),
    coiServiceWorkerAttempted: lsGet(LS_COI_SW),
  };

  log("WebNN on main thread (npu/gpu/cpu)…");
  const webnnMain = await attempt(() => probeWebNN(includeOpLimits));
  log("dedicated worker probe (WebNN, OPFS sync handles, SAB)…");
  const worker = await workerProbe();

  const bridge = await getBridge();
  const evenApp = bridge
    ? await attempt(async () => ({ user: !!(await bridge.getUserInfo()), device: (await bridge.getDeviceInfo())?.toJson?.() ?? null }))
    : null;

  return { documentHeaders, platform, webnnMain, worker, evenApp };
}

export async function enableIsolationServiceWorker(): Promise<void> {
  lsSet(LS_COI_SW, new Date().toISOString());
  await navigator.serviceWorker.register(new URL("coi-sw.js", location.href));
  await navigator.serviceWorker.ready;
  location.reload();
}

export async function removeServiceWorkers(): Promise<void> {
  for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
  try {
    localStorage.removeItem(LS_COI_SW);
  } catch {
    /* storage unavailable */
  }
  location.reload();
}
