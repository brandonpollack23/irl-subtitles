/**
 * Fetches model assets from the Moonshine CDN and caches them in the browser,
 * driven by the JSON manifest helpers in the C ABI (so we never re-implement
 * the file/URL layout in JS). Mirrors the download flow of the Python/Swift/
 * Android bindings, adapted to `fetch` + the Cache API.
 */
/** One downloaded asset. */
export interface DownloadedAsset {
    /** The canonical filename (basename), e.g. `encoder_model.ort`. */
    readonly name: string;
    readonly bytes: Uint8Array;
}
export interface AssetDownloaderOptions {
    /** Cache name used with the browser Cache API. */
    cacheName?: string;
    /**
     * Called with (loadedBytes, totalBytes|undefined, currentFile).
     *
     * A model is many files, so the byte counts are cumulative across the whole
     * set being fetched, not per file. `total` is the sum of the sizes the
     * manifest declares, and is undefined only when fetching files whose sizes
     * are not known up front — report those as indeterminate rather than
     * inventing a percentage.
     */
    onProgress?: (loaded: number, total: number | undefined, file: string) => void;
    /**
     * Fetches manifest files from here instead of the base URL the manifest names,
     * so applications can host the assets themselves.
     */
    baseUrl?: string;
}
/**
 * Downloads model files with transparent caching. A single instance can be
 * reused across models; entries are keyed by absolute URL.
 */
export declare class AssetDownloader {
    private readonly cacheName;
    private readonly onProgress?;
    private readonly baseUrl?;
    private session?;
    constructor(options?: AssetDownloaderOptions);
    /**
     * Downloads every file listed in a `{groups:[...]}` manifest (STT / embedding),
     * returning them keyed by canonical filename.
     */
    downloadManifest(manifestJson: string): Promise<Map<string, Uint8Array>>;
    /** Downloads a flat list of URLs, returning bytes keyed by basename. */
    downloadFiles(urls: string[]): Promise<Map<string, Uint8Array>>;
    /**
     * Downloads a map of canonical filename -> URL, returning bytes keyed by the
     * supplied filename (not the URL basename). Use this when the caller controls
     * the canonical keys, e.g. feeding a transcriber's in-memory loader.
     */
    downloadNamedFiles(files: Record<string, string> | Map<string, string>): Promise<Map<string, Uint8Array>>;
    /** Fetches a single URL, using the Cache API when available. */
    fetchFile(url: string): Promise<Uint8Array>;
    /**
     * Runs `body` as a single accounted download, so progress is reported
     * against the whole set of files rather than restarting at zero for each.
     * Nested calls (a shared downloader fetching several models) each get their
     * own accounting and restore the outer one when they finish.
     */
    private inSession;
    /** Rolls a finished file's bytes into the running total. */
    private finishFile;
    private reportProgress;
    private readWithProgress;
    private openCache;
}
//# sourceMappingURL=asset-downloader.d.ts.map