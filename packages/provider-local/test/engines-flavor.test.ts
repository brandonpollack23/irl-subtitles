import { expect, it } from "vitest";
import type { DeviceCapabilities } from "../src/device";
import { LocalEngines } from "../src/engines";
import type { OrtFlavor } from "../src/ort-flavor";

/** A worker that acknowledges every request and remembers what it was asked. */
class FakeWorker {
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: { message: string }) => void) | null = null;
  calls: string[] = [];
  terminated = false;
  constructor(readonly kind: string, readonly flavor: OrtFlavor) {}
  postMessage(msg: { id: number; method: string }) {
    this.calls.push(msg.method);
    queueMicrotask(() => this.onmessage?.({ data: { id: msg.id, ok: true, result: null } }));
  }
  terminate() {
    this.terminated = true;
  }
}

function engines(webgpu: boolean) {
  const made: FakeWorker[] = [];
  const factory = (kind: string) => (flavor: OrtFlavor) => {
    const w = new FakeWorker(kind, flavor);
    made.push(w);
    return w as unknown as Worker;
  };
  const e = new LocalEngines({ audio: factory("audio"), asr: factory("asr"), llm: factory("llm"), stream: factory("stream") });
  e.caps = { platform: "desktop", webgpu: { available: webgpu, shaderF16: true } } as DeviceCapabilities;
  return { e, made };
}

it("runs CPU sessions on the plain build and WebGPU sessions on the asyncify build", async () => {
  const { e, made } = engines(false);
  await e.ensureVad("silero-vad-v6");
  await e.ensureEmbedding("campplus-voxceleb");
  expect(await e.ensureAsr("moonshine-base-en")).toBe("wasm");
  expect(made.map((w) => `${w.kind}:${w.flavor}`)).toEqual(["audio:wasm", "asr:wasm"]);
});

it("replaces a worker whose build a load can't use, reloading the audio worker's VAD", async () => {
  const { e, made } = engines(true);
  await e.ensureVad("silero-vad-v6");
  e.benchmarks = [{ modelId: "campplus-voxceleb", target: "webgpu", ok: true, realTimeFactor: 0.01, measuredAt: "", userAgent: "" }];
  await e.ensureEmbedding("campplus-voxceleb");
  const [first, second] = made;
  expect(first!.flavor).toBe("wasm");
  expect(first!.terminated).toBe(true);
  expect(second!.flavor).toBe("webgpu");
  expect(second!.calls).toEqual(["embed.load", "vad.load"]);
  expect(e.flavorOf("audio")).toBe("webgpu");
});
