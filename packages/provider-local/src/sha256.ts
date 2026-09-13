/**
 * Incremental SHA-256 (Web Crypto has no streaming digest). Lets multi-GB model files be verified as they
 * stream into the cache instead of buffering a second copy in memory.
 */
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export class Sha256 {
  private h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  private buf = new Uint8Array(64);
  private bufLen = 0;
  private total = 0;
  private w = new Uint32Array(80);

  update(data: Uint8Array): this {
    let off = 0;
    this.total += data.length;
    if (this.bufLen) {
      const take = Math.min(64 - this.bufLen, data.length);
      this.buf.set(data.subarray(0, take), this.bufLen);
      this.bufLen += take;
      off = take;
      if (this.bufLen === 64) {
        this.block(this.buf, 0);
        this.bufLen = 0;
      }
    }
    for (; off + 64 <= data.length; off += 64) this.block(data, off);
    if (off < data.length) {
      this.buf.set(data.subarray(off), 0);
      this.bufLen = data.length - off;
    }
    return this;
  }

  private block(d: Uint8Array, o: number) {
    const w = this.w;
    for (let i = 0; i < 16; i++) w[i] = (d[o + i * 4]! << 24) | (d[o + i * 4 + 1]! << 16) | (d[o + i * 4 + 2]! << 8) | d[o + i * 4 + 3]!;
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15]!, y = w[i - 2]!;
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) | 0;
    }
    let [a, b, c, dd, e, f, g, h] = this.h as unknown as number[];
    for (let i = 0; i < 64; i++) {
      const t1 = (h! + (((e! >>> 6) | (e! << 26)) ^ ((e! >>> 11) | (e! << 21)) ^ ((e! >>> 25) | (e! << 7))) + ((e! & f!) ^ (~e! & g!)) + K[i]! + w[i]!) | 0;
      const t2 = ((((a! >>> 2) | (a! << 30)) ^ ((a! >>> 13) | (a! << 19)) ^ ((a! >>> 22) | (a! << 10))) + ((a! & b!) ^ (a! & c!) ^ (b! & c!))) | 0;
      h = g; g = f; f = e; e = (dd! + t1) | 0; dd = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    this.h[0]! += a!; this.h[1]! += b!; this.h[2]! += c!; this.h[3]! += dd!;
    this.h[4]! += e!; this.h[5]! += f!; this.h[6]! += g!; this.h[7]! += h!;
  }

  hex(): string {
    const bits = this.total * 8;
    const pad = new Uint8Array(((this.bufLen < 56 ? 56 : 120) - this.bufLen) + 8);
    pad[0] = 0x80;
    const view = new DataView(pad.buffer);
    view.setUint32(pad.length - 8, Math.floor(bits / 2 ** 32));
    view.setUint32(pad.length - 4, bits >>> 0);
    // Padding is not message data.
    const savedTotal = this.total;
    this.update(pad);
    this.total = savedTotal;
    return [...this.h].map((x) => x.toString(16).padStart(8, "0")).join("");
  }
}
