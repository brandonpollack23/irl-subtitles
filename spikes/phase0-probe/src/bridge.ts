import {
  AudioInputSource,
  StartUpPageCreateResult,
  waitForEvenAppBridge,
  type EvenAppBridge,
  type EvenHubEvent,
} from "@evenrealities/even_hub_sdk";

let bridgePromise: Promise<EvenAppBridge | null> | null = null;
const hubListeners = new Set<(e: EvenHubEvent) => void>();

/** Resolves null outside the Even App WebView (desktop browser, simulator without bridge). */
export function getBridge(timeoutMs = 4000): Promise<EvenAppBridge | null> {
  bridgePromise ??= (async () => {
    // waitForEvenAppBridge() also resolves in a plain browser, so gate on the injected
    // Flutter host, allowing for it to be injected shortly after page load.
    const hasHost = () => typeof (window as unknown as { flutter_inappwebview?: unknown }).flutter_inappwebview !== "undefined";
    const deadline = performance.now() + timeoutMs;
    while (!hasHost() && performance.now() < deadline) await new Promise((ok) => setTimeout(ok, 100));
    if (!hasHost()) return null;
    const bridge = await Promise.race([
      waitForEvenAppBridge().catch(() => null),
      new Promise<null>((ok) => setTimeout(() => ok(null), timeoutMs * 3)),
    ]);
    // One SDK subscription fanned out to spikes, so modules can come and go.
    bridge?.onEvenHubEvent((e) => hubListeners.forEach((l) => l(e)));
    return bridge;
  })();
  return bridgePromise;
}

export function onHubEvent(listener: (e: EvenHubEvent) => void): () => void {
  hubListeners.add(listener);
  return () => hubListeners.delete(listener);
}

export const MENU = { startCapture: 1, stopCapture: 2, marker: 3 } as const;

const HUD_ID = 1;
const HUD_NAME = "status";

/**
 * Minimal G2 page: one full-screen text container and a contextual menu.
 * The SDK requires the startup page to exist before glasses audio can open.
 */
class Hud {
  private created: Promise<boolean> | null = null;
  private pending: string | null = null;
  private inFlight = false;

  ensurePage(): Promise<boolean> {
    this.created ??= (async () => {
      const bridge = await getBridge();
      if (!bridge) return false;
      const result = await bridge.createStartUpPageContainer({
        containerTotalNum: 1,
        textObject: [
          {
            xPosition: 0,
            yPosition: 0,
            width: 576,
            height: 288,
            containerID: HUD_ID,
            containerName: HUD_NAME,
            content: "Phase 0 probe\nidle",
            isEventCapture: 1,
          },
        ],
        menuObject: {
          menuItems: [
            { itemName: "Start capture", itemID: MENU.startCapture },
            { itemName: "Stop capture", itemID: MENU.stopCapture },
            { itemName: "Marker", itemID: MENU.marker },
          ],
        },
      } as never);
      return result === StartUpPageCreateResult.success;
    })();
    return this.created;
  }

  /** Coalesces updates so a slow BLE link never queues a backlog of stale text. */
  async setText(content: string): Promise<void> {
    this.pending = content;
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const bridge = await getBridge();
      if (!bridge || !(await this.ensurePage())) return;
      while (this.pending !== null) {
        const next = this.pending;
        this.pending = null;
        await bridge.textContainerUpgrade({ containerID: HUD_ID, containerName: HUD_NAME, content: next } as never);
      }
    } finally {
      this.inFlight = false;
    }
  }
}

export const hud = new Hud();

export async function openGlassesMic(open: boolean): Promise<boolean> {
  const bridge = await getBridge();
  if (!bridge) return false;
  if (open && !(await hud.ensurePage())) return false;
  return bridge.audioControl(open, AudioInputSource.Glasses);
}
