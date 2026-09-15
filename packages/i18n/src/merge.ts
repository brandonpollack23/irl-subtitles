export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends (...args: never[]) => unknown ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K];
};

function isGroup(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The base catalog with every string the overlay defines replaced; groups merge key by key. */
export function withFallback<T extends object>(base: T, overlay: DeepPartial<T>): T {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(overlay)) {
    if (v === undefined) continue;
    const b = (base as Record<string, unknown>)[k];
    out[k] = isGroup(b) && isGroup(v) ? withFallback(b, v) : v;
  }
  return out as T;
}

/** Dotted paths of every string or function in a catalog, for parity checks. */
export function keyPaths(catalog: object, prefix = ""): string[] {
  return Object.entries(catalog).flatMap(([k, v]) => (isGroup(v) ? keyPaths(v, `${prefix}${k}.`) : [`${prefix}${k}`]));
}
