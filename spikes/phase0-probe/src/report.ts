import { getBridge } from "./bridge";

export interface ReportEnvelope<T> {
  spike: string;
  appVersion: string;
  buildId: string;
  createdAt: string;
  environment: EnvironmentSummary;
  data: T;
}

export interface EnvironmentSummary {
  origin: string;
  userAgent: string;
  inEvenApp: boolean;
  glasses: { model?: string; snSuffix?: string; battery?: number } | null;
  servedWithCoiHeaders: boolean;
  crossOriginIsolated: boolean;
  hardwareConcurrency: number;
  deviceMemoryGb: number | null;
  tester: string | null;
}

const LS_SINK = "probe.sink";
const LS_TESTER = "probe.tester";

export function sinkUrl(): string {
  return lsGet(LS_SINK) ?? `${location.origin}/__probe`;
}
export function setSinkUrl(url: string): void {
  lsSet(LS_SINK, url);
}
export function tester(): string | null {
  return lsGet(LS_TESTER);
}
export function setTester(name: string): void {
  lsSet(LS_TESTER, name);
}

export function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
export function lsSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* quota or disabled storage: reports still go to the sink */
  }
}

export async function environment(): Promise<EnvironmentSummary> {
  const bridge = await getBridge();
  let glasses: EnvironmentSummary["glasses"] = null;
  if (bridge) {
    try {
      const info = await bridge.getDeviceInfo();
      if (info) glasses = { model: info.model, snSuffix: info.sn?.slice(-4), battery: info.status?.batteryLevel };
    } catch {
      glasses = null;
    }
  }
  return {
    origin: location.origin,
    userAgent: navigator.userAgent,
    inEvenApp: bridge !== null,
    glasses,
    servedWithCoiHeaders: __SERVED_COI__,
    crossOriginIsolated: globalThis.crossOriginIsolated === true,
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemoryGb: (navigator as { deviceMemory?: number }).deviceMemory ?? null,
    tester: tester(),
  };
}

export async function envelope<T>(spike: string, data: T): Promise<ReportEnvelope<T>> {
  return {
    spike,
    appVersion: __APP_VERSION__,
    buildId: __BUILD_ID__,
    createdAt: new Date().toISOString(),
    environment: await environment(),
    data,
  };
}

/** Keeps the last few reports per spike on-device so nothing is lost if upload fails. */
function remember(report: ReportEnvelope<unknown>): void {
  const key = `probe.reports.${report.spike}`;
  let list: unknown[] = [];
  try {
    list = JSON.parse(lsGet(key) ?? "[]") as unknown[];
  } catch {
    list = [];
  }
  list.unshift(report);
  lsSet(key, JSON.stringify(list.slice(0, 5)));
}

export async function publish<T>(spike: string, data: T): Promise<{ report: ReportEnvelope<T>; saved?: string; error?: string }> {
  const report = await envelope(spike, data);
  remember(report);
  try {
    const res = await fetch(`${sinkUrl()}/report`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(report),
    });
    if (!res.ok) return { report, error: `sink HTTP ${res.status}` };
    const { saved } = (await res.json()) as { saved: string };
    return { report, saved };
  } catch (e) {
    return { report, error: `sink unreachable: ${String(e)}` };
  }
}

export async function uploadBinary(name: string, data: Blob, onProgress?: (sent: number) => void): Promise<void> {
  const piece = 4 * 1024 * 1024;
  for (let offset = 0; offset < data.size; offset += piece) {
    const res = await fetch(`${sinkUrl()}/upload?name=${encodeURIComponent(name)}&offset=${offset}`, {
      method: "POST",
      body: data.slice(offset, offset + piece),
    });
    if (!res.ok) throw new Error(`upload HTTP ${res.status}`);
    onProgress?.(Math.min(data.size, offset + piece));
  }
}
