function isGroup(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Dotted paths of every string or function in a catalog, for parity checks. */
export function keyPaths(catalog: object, prefix = ""): string[] {
  return Object.entries(catalog).flatMap(([k, v]) => (isGroup(v) ? keyPaths(v, `${prefix}${k}.`) : [`${prefix}${k}`]));
}
