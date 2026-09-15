import { AudioInputSource } from "@evenrealities/even_hub_sdk";
import { float32ToPcm, parseWav, resampleLinear, SAMPLE_RATE, type CaptureSourceKind, UserError } from "@irl/domain";
import { getBridge, onHubEvent } from "./even";

export type PcmSink = (pcm: Uint8Array) => void;

/**
 * Anything that produces s16le/16 kHz/mono PCM. Pause is implemented by the controller as stop/start so
 * the microphone is actually released while paused.
 */
export interface AudioSource {
  readonly kind: CaptureSourceKind;
  readonly label: string;
  start(sink: PcmSink): Promise<void>;
  stop(): Promise<void>;
}

/**
 * G2 four-mic array through the Even bridge (plan.md §3). The glasses page must exist before
 * audioControl(true), so the caller provides `preparePage`.
 */
export class G2AudioSource implements AudioSource {
  readonly kind = "glasses" as const;
  readonly label = "G2 microphones";
  private dispose: (() => void) | null = null;
  private lastFrameAt = 0;
  private onVisible = () => void this.rearmIfStalled();
  rearms = 0;

  constructor(private readonly preparePage: () => Promise<boolean>) {}

  async start(sink: PcmSink): Promise<void> {
    const bridge = await getBridge();
    if (!bridge) throw new UserError("glasses-unavailable", "Even bridge unavailable: G2 capture only works inside the Even app");
    if (!(await this.preparePage())) throw new UserError("glasses-page", "could not create the glasses page (required before opening the microphone)");
    this.dispose = onHubEvent((e) => {
      const pcm = e.audioEvent?.audioPcm;
      if (!pcm?.byteLength) return;
      this.lastFrameAt = performance.now();
      sink(pcm);
    });
    this.lastFrameAt = performance.now();
    const ok = await bridge.audioControl(true, AudioInputSource.Glasses);
    if (!ok) {
      this.dispose();
      this.dispose = null;
      throw new UserError("glasses-audio", "audioControl(true) failed: are the glasses connected?");
    }
    document.addEventListener("visibilitychange", this.onVisible);
  }

  /** Android may silently stop delivering audio after backgrounding; re-issue audioControl when we return. */
  private async rearmIfStalled(): Promise<void> {
    if (document.visibilityState !== "visible" || !this.dispose) return;
    await new Promise((ok) => setTimeout(ok, 1500));
    if (!this.dispose || performance.now() - this.lastFrameAt < 1500) return;
    this.rearms++;
    await (await getBridge())?.audioControl(true, AudioInputSource.Glasses);
  }

  async stop(): Promise<void> {
    document.removeEventListener("visibilitychange", this.onVisible);
    this.dispose?.();
    this.dispose = null;
    await (await getBridge())?.audioControl(false).catch(() => false);
  }
}

/** Phone microphone for standalone Chrome/Safari development (the G2 stand-in, plan.md §3). */
export class PhoneMicSource implements AudioSource {
  readonly kind = "phone-mic" as const;
  readonly label = "Phone microphone";
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private bridgeDispose: (() => void) | null = null;

  constructor(private readonly workletUrl: string) {}

  async start(sink: PcmSink): Promise<void> {
    // Inside the Even app the phone mic is reached through the bridge rather than getUserMedia.
    const bridge = await getBridge(300);
    if (bridge) {
      this.bridgeDispose = onHubEvent((e) => e.audioEvent?.audioPcm?.byteLength && sink(e.audioEvent.audioPcm));
      if (await bridge.audioControl(true, AudioInputSource.Phone)) return;
      this.bridgeDispose();
      this.bridgeDispose = null;
    }
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: false, autoGainControl: true } });
    this.ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    await this.ctx.audioWorklet.addModule(this.workletUrl);
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, "pcm-capture", { numberOfInputs: 1, numberOfOutputs: 0 });
    const rate = this.ctx.sampleRate;
    let pending: Float32Array[] = [];
    let pendingLen = 0;
    const frameLen = Math.round(rate / 10);
    this.node.port.onmessage = (e: MessageEvent<Float32Array>) => {
      pending.push(e.data);
      pendingLen += e.data.length;
      if (pendingLen < frameLen) return;
      const joined = new Float32Array(pendingLen);
      let off = 0;
      for (const p of pending) {
        joined.set(p, off);
        off += p.length;
      }
      pending = [];
      pendingLen = 0;
      sink(float32ToPcm(resampleLinear(joined, rate)));
    };
    src.connect(this.node);
    await this.ctx.resume();
  }

  async stop(): Promise<void> {
    if (this.bridgeDispose) {
      this.bridgeDispose();
      this.bridgeDispose = null;
      await (await getBridge(300))?.audioControl(false).catch(() => false);
    }
    this.node?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    await this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.stream = null;
    this.node = null;
  }
}

/**
 * Replays a WAV file as live 100 ms frames (dev and debugging without glasses). `speed` > 1 feeds faster
 * than real time; the sample clock is unaffected.
 */
export class WavFileSource implements AudioSource {
  readonly kind = "wav-file" as const;
  private timer: ReturnType<typeof setInterval> | null = null;
  private samples: Float32Array | null = null;
  private offset = 0;
  readonly finished: Promise<void>;
  private resolveFinished!: () => void;

  constructor(private readonly bytes: () => Promise<Uint8Array>, readonly label = "WAV file", private readonly speed = 1, private readonly loop = false) {
    this.finished = new Promise((ok) => (this.resolveFinished = ok));
  }

  async start(sink: PcmSink): Promise<void> {
    if (!this.samples) {
      const wav = parseWav(await this.bytes());
      this.samples = resampleLinear(wav.samples, wav.sampleRate);
    }
    const frame = SAMPLE_RATE / 10;
    this.timer = setInterval(() => {
      const s = this.samples!;
      if (this.offset >= s.length) {
        if (this.loop) this.offset = 0;
        else {
          this.resolveFinished();
          return;
        }
      }
      const end = Math.min(s.length, this.offset + frame);
      sink(float32ToPcm(s.subarray(this.offset, end)));
      this.offset = end;
    }, 100 / this.speed);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
