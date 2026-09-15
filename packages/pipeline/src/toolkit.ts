import type {
  ClusterId,
  LiveSpeechProvider,
  ModelCatalogEntry,
  SummaryProvider,
  TimeRange,
  VoiceEmbedding,
} from "@irl/domain";

export interface FinalWord {
  text: string;
  startSample: number;
  endSample: number;
  confidence?: number;
}

export interface ClusterAssignment {
  /** Window index → cluster label (stable small integers). */
  labels: number[];
  /** Label pairs merged during refinement, for diagnostics. */
  merges: [number, number][];
}

/**
 * Local processing capabilities the pipeline needs after Stop and for reprocessing. Implemented by
 * @irl/provider-local; kept as an interface so pipeline code never depends on ONNX or model details.
 */
export interface ProcessingToolkit {
  catalog(): readonly ModelCatalogEntry[];
  embeddingSpace(modelId: string): string;
  /** Speech regions in absolute samples. */
  detectSpeech(vadModelId: string, samples: Float32Array, startSample: number, onProgress?: (f: number) => void): Promise<TimeRange[]>;
  transcribe(
    modelId: string,
    samples: Float32Array,
    startSample: number,
    language: string,
    opts: { wordTimestamps: boolean },
  ): Promise<{ words: FinalWord[]; language?: string; timing: "word" | "segment-interpolated" }>;
  embed(modelId: string, windows: { samples: Float32Array; range: TimeRange }[]): Promise<VoiceEmbedding[]>;
  /** Window grid (1.5–3 s windows, ~1 s hop) over speech regions. */
  windowGrid(regions: readonly TimeRange[]): TimeRange[];
  /** Offline clustering with optional initial labels (live assignments) and merge/split refinement. */
  cluster(vectors: readonly Float32Array[], initial: readonly (number | null)[], embeddingSpace: string): ClusterAssignment;
  /** Centroid cosine above which two speaker labels are the same voice. */
  mergeThreshold(embeddingSpace: string): number;
  liveProvider(kind: "local"): LiveSpeechProvider;
  summaryProvider(modelId: string): SummaryProvider | null;
  /** Release model sessions (after post-processing, on memory pressure). */
  release(roles?: readonly string[]): Promise<void>;
}

export type ClusterLabel = { clusterId: ClusterId; ordinal: number };
