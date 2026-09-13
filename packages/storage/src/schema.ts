/**
 * One declarative schema drives both backends: SQL tables and migrations for Turso (and node:sqlite
 * in tests), and object stores with indexes for the IndexedDB fallback. Rows are camelCase domain
 * objects; SQL columns are their snake_case names.
 *
 * Column spec: "<type>" required, "<type>?" optional (NULL reads back as absent),
 * "<type>!" nullable (NULL reads back as null).
 */
export type ColumnType = "text" | "int" | "real" | "blob" | "json" | "bool";
export type ColumnSpec = `${ColumnType}` | `${ColumnType}?` | `${ColumnType}!`;

export interface TableDef {
  name: string;
  key: readonly string[];
  indexes: readonly (readonly string[])[];
  columns: Readonly<Record<string, ColumnSpec>>;
}

function table(name: string, key: string[], indexes: string[][], columns: Record<string, ColumnSpec>): TableDef {
  return { name, key, indexes, columns };
}

export const SCHEMA_V1: readonly TableDef[] = [
  table("recordings", ["id"], [["state"]], {
    id: "text",
    createdAt: "text",
    startedAt: "text!",
    endedAt: "text!",
    state: "text",
    audioRetention: "text",
    language: "text",
    provider: "text",
    models: "json",
    modelVersions: "json",
    totalSamples: "int",
    recoveryCursor: "int",
    title: "text!",
    markers: "json",
    processing: "json",
    transcriptRevision: "int",
    degraded: "text!",
    gaps: "int",
    error: "text!",
  }),
  table("audio_chunks", ["recordingId", "sequence"], [["recordingId"]], {
    recordingId: "text",
    sequence: "int",
    startSample: "int",
    endSample: "int",
    codec: "text",
    path: "text",
    byteLength: "int",
    checksum: "int",
    keyKind: "text",
    verified: "bool",
    createdAt: "text",
  }),
  table("transcript_tokens", ["id"], [["recordingId"]], {
    id: "text",
    recordingId: "text",
    providerRunId: "text",
    startSample: "int",
    endSample: "int",
    text: "text",
    confidence: "real?",
    language: "text?",
    final: "bool",
    providerSpeakerId: "text?",
    timing: "text",
  }),
  table("speaker_turns", ["id"], [["recordingId"]], {
    id: "text",
    recordingId: "text",
    providerRunId: "text",
    clusterId: "text",
    startSample: "int",
    endSample: "int",
    confidence: "real?",
    final: "bool",
  }),
  table("speaker_clusters", ["recordingId", "clusterId"], [["recordingId"]], {
    recordingId: "text",
    clusterId: "text",
    ordinal: "int",
    evidenceMs: "real",
    providerLabel: "text?",
    mergedInto: "text?",
    candidatePersonId: "text?",
    candidateScore: "real?",
  }),
  table("voice_windows", ["id"], [["recordingId"]], {
    id: "text",
    recordingId: "text",
    clusterId: "text",
    startSample: "int",
    endSample: "int",
    embeddingSpace: "text",
    quality: "real",
    sealedVector: "blob",
  }),
  table("speaker_attributions", ["id"], [["recordingId"], ["personId"], ["operationId"]], {
    id: "text",
    recordingId: "text",
    clusterId: "text",
    personId: "text!",
    confidence: "real",
    source: "text",
    revision: "int",
    operationId: "text",
    createdAt: "text",
    undone: "bool",
  }),
  table("people", ["id"], [], {
    id: "text",
    fullName: "text",
    shortName: "text?",
    createdAt: "text",
    updatedAt: "text",
    externalLink: "json?",
  }),
  table("voice_profiles", ["id"], [["personId"]], {
    id: "text",
    personId: "text",
    embeddingSpace: "text",
    needsReenrollment: "bool",
    createdAt: "text",
    updatedAt: "text",
  }),
  table("voice_prototypes", ["id"], [["profileId"], ["operationId"]], {
    id: "text",
    profileId: "text",
    sealedVector: "blob",
    quality: "real",
    evidenceMs: "real",
    sourceRecordingId: "text",
    operationId: "text",
    createdAt: "text",
  }),
  table("voice_samples", ["id"], [["profileId"], ["recordingId"], ["operationId"]], {
    id: "text",
    profileId: "text",
    recordingId: "text",
    startSample: "int",
    endSample: "int",
    clipPath: "text!",
    consent: "bool",
    operationId: "text",
    createdAt: "text",
  }),
  table("summaries", ["recordingId"], [], {
    recordingId: "text",
    status: "text",
    summary: "json!",
    providerId: "text!",
    transcriptRevision: "int",
    error: "text!",
    updatedAt: "text",
  }),
  table("provider_runs", ["id"], [["recordingId"]], {
    id: "text",
    recordingId: "text",
    provider: "text",
    kind: "text",
    config: "json",
    startedAt: "text",
    endedAt: "text!",
    state: "text",
    error: "text!",
    resume: "json!",
  }),
  table("settings", ["key"], [], {
    key: "text",
    value: "json",
  }),
  table("operations", ["id"], [["recordingId"]], {
    id: "text",
    kind: "text",
    recordingId: "text!",
    payload: "json",
    createdAt: "text",
    undone: "bool",
  }),
];

export const SCHEMA_VERSION = 1;

export function snake(name: string): string {
  return name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

export function parseSpec(spec: ColumnSpec): { type: ColumnType; mode: "required" | "optional" | "nullable" } {
  const last = spec[spec.length - 1];
  if (last === "?") return { type: spec.slice(0, -1) as ColumnType, mode: "optional" };
  if (last === "!") return { type: spec.slice(0, -1) as ColumnType, mode: "nullable" };
  return { type: spec as ColumnType, mode: "required" };
}

const SQL_TYPES: Record<ColumnType, string> = { text: "TEXT", int: "INTEGER", real: "REAL", blob: "BLOB", json: "TEXT", bool: "INTEGER" };

export function createTableSql(def: TableDef): string[] {
  const cols = Object.entries(def.columns).map(([name, spec]) => {
    const { type, mode } = parseSpec(spec);
    return `${snake(name)} ${SQL_TYPES[type]}${mode === "required" ? " NOT NULL" : ""}`;
  });
  const out = [`CREATE TABLE IF NOT EXISTS ${def.name} (${cols.join(", ")}, PRIMARY KEY (${def.key.map(snake).join(", ")}))`];
  for (const idx of def.indexes) {
    out.push(`CREATE INDEX IF NOT EXISTS idx_${def.name}_${idx.map(snake).join("_")} ON ${def.name} (${idx.map(snake).join(", ")})`);
  }
  return out;
}

/** Versioned SQL migrations. Append new versions; never edit an applied one. */
export const SQL_MIGRATIONS: readonly { version: number; statements: readonly string[] }[] = [
  { version: 1, statements: SCHEMA_V1.flatMap(createTableSql) },
];

export function tableDef(name: string): TableDef {
  const def = SCHEMA_V1.find((t) => t.name === name);
  if (!def) throw new Error(`unknown table ${name}`);
  return def;
}
