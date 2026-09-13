const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array, seed = 0): number {
  let c = ~seed >>> 0;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return ~c >>> 0;
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/** Truncates to at most maxBytes of UTF-8 without splitting a code point; appends … when cut. */
export function truncateUtf8(value: string, maxBytes: number): string {
  if (utf8ByteLength(value) <= maxBytes) return value;
  const ellipsis = "…";
  const budget = maxBytes - utf8ByteLength(ellipsis);
  let out = "";
  let used = 0;
  for (const ch of value) {
    const n = utf8ByteLength(ch);
    if (used + n > budget) break;
    out += ch;
    used += n;
  }
  return budget > 0 ? out + ellipsis : out;
}

export class Emitter<T> {
  private listeners = new Set<(value: T) => void>();

  on(listener: (value: T) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(value: T): void {
    for (const l of [...this.listeners]) {
      try {
        l(value);
      } catch (e) {
        console.error("listener failed", e);
      }
    }
  }
}

/** Serializes async operations per key so read-modify-write updates never interleave. */
export class KeyedMutex {
  private tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => undefined);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return next;
  }
}

/** Async FIFO with an optional capacity; push reports false once full so callers can shed load. */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiters: ((r: IteratorResult<T>) => void)[] = [];
  private closed = false;

  constructor(private readonly capacity = Infinity) {}

  get size(): number {
    return this.items.length;
  }

  push(item: T): boolean {
    if (this.closed) return false;
    const w = this.waiters.shift();
    if (w) {
      w({ value: item, done: false });
      return true;
    }
    if (this.items.length >= this.capacity) return false;
    this.items.push(item);
    return true;
  }

  close(): void {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true });
  }

  next(): Promise<IteratorResult<T>> {
    const item = this.items.shift();
    if (item !== undefined) return Promise.resolve({ value: item, done: false });
    if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
    return new Promise((ok) => this.waiters.push(ok));
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return { next: () => this.next() };
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((ok) => setTimeout(ok, ms));
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function float32ToBytes(v: Float32Array): Uint8Array {
  return new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
}

export function bytesToFloat32(b: Uint8Array): Float32Array {
  const copy = b.slice();
  return new Float32Array(copy.buffer, 0, Math.floor(copy.byteLength / 4));
}
