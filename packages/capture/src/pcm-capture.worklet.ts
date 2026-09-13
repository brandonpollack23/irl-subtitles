// AudioWorklet: forwards mono Float32 render quanta to the main thread.
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, ctor: unknown): void;

class PcmCapture extends AudioWorkletProcessor {
  process(inputs: Float32Array[][]): boolean {
    const ch = inputs[0]?.[0];
    if (ch?.length) this.port.postMessage(ch.slice());
    return true;
  }
}

registerProcessor("pcm-capture", PcmCapture);
