import { lsGet, lsSet } from "./report";

/** Launch counter: each relaunch after a force-stop, reclaim, or .ehpk upgrade bumps it. */
export const launchNumber = Number(lsGet("probe.launches") ?? "0") + 1;
lsSet("probe.launches", String(launchNumber));

export type LifecycleListener = (event: string, visibility: DocumentVisibilityState) => void;
const listeners = new Set<LifecycleListener>();

for (const ev of ["visibilitychange", "freeze", "resume"]) {
  document.addEventListener(ev, () => listeners.forEach((l) => l(ev, document.visibilityState)));
}
for (const ev of ["pagehide", "pageshow", "online", "offline"]) {
  window.addEventListener(ev, () => listeners.forEach((l) => l(ev, document.visibilityState)));
}

export function onLifecycle(listener: LifecycleListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
