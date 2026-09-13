import { waitForEvenAppBridge, type EvenAppBridge, type EvenHubEvent } from "@evenrealities/even_hub_sdk";

let bridgePromise: Promise<EvenAppBridge | null> | null = null;
const hubListeners = new Set<(e: EvenHubEvent) => void>();

/** Resolves null outside the Even App WebView (desktop/phone browsers). */
export function getBridge(timeoutMs = 3000): Promise<EvenAppBridge | null> {
  bridgePromise ??= (async () => {
    // waitForEvenAppBridge() also resolves in a plain browser, so gate on the injected Flutter host,
    // allowing for it to appear shortly after page load.
    const hasHost = () => typeof (globalThis as { flutter_inappwebview?: unknown }).flutter_inappwebview !== "undefined";
    const deadline = performance.now() + timeoutMs;
    while (!hasHost() && performance.now() < deadline) await new Promise((ok) => setTimeout(ok, 100));
    if (!hasHost()) return null;
    const bridge = await Promise.race([
      waitForEvenAppBridge().catch(() => null),
      new Promise<null>((ok) => setTimeout(() => ok(null), timeoutMs * 3)),
    ]);
    // One SDK subscription fanned out so modules can subscribe and unsubscribe independently.
    bridge?.onEvenHubEvent((e) => hubListeners.forEach((l) => l(e)));
    return bridge;
  })();
  return bridgePromise;
}

export function onHubEvent(listener: (e: EvenHubEvent) => void): () => void {
  hubListeners.add(listener);
  return () => hubListeners.delete(listener);
}

/** Test/simulation hook: inject events as if the bridge had delivered them. */
export function emitHubEvent(e: EvenHubEvent): void {
  hubListeners.forEach((l) => l(e));
}
