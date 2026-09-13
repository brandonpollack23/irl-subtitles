import { describe, expect, it } from "vitest";
import { crc32 } from "../src/util/crc32";
import { pcmToFloat32, rmsDbfs, wavHeader } from "../src/util/pcm";

describe("pcm utils", () => {
  it("writes a 44-byte mono 16 kHz WAV header", () => {
    const h = new DataView(wavHeader(32000).buffer);
    expect(h.byteLength).toBe(44);
    expect(h.getUint32(24, true)).toBe(16000);
    expect(h.getUint32(40, true)).toBe(32000);
    expect(h.getUint16(22, true)).toBe(1);
  });

  it("decodes s16le and measures level", () => {
    const pcm = new Uint8Array(new Int16Array([16384, -16384, 16384, -16384]).buffer);
    expect([...pcmToFloat32(pcm)]).toEqual([0.5, -0.5, 0.5, -0.5]);
    expect(rmsDbfs(pcm)).toBeCloseTo(-6.02, 1);
  });

  it("computes standard CRC-32", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });
});
