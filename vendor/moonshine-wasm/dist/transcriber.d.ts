/**
 * High-level speech-to-text entry point, mirroring the Python/Swift/Android
 * `Transcriber`. Load it with the async {@link Transcriber.load} factory (which
 * fetches the model from the CDN), then either transcribe a whole buffer or
 * drive a streaming {@link Stream}.
 */
import { AssetDownloader } from './asset-downloader.js';
import { ModelArch, TranscribeFlags } from './enums.js';
import { type LoadModuleOptions, type MoonshineModule } from './module.js';
import { Stream } from './stream.js';
import type { TranscriptEventListener } from './events.js';
import { type Transcript } from './types.js';
/**
 * Load a transcriber from raw in-memory model bytes for a non-streaming model.
 * For streaming models (or word-timestamp/spelling extras) use
 * {@link TranscriberFromFiles} and key each buffer by its canonical filename.
 */
export interface TranscriberFromBytes {
    encoder: Uint8Array;
    decoder: Uint8Array;
    tokenizer: Uint8Array;
    /** Optional spelling-CNN for alphanumeric fusion (SpellingMode). */
    spelling?: Uint8Array;
    modelArch?: ModelArch;
}
/**
 * Load a transcriber from in-memory model buffers keyed by their canonical
 * manifest filename (e.g. `encoder_model.ort`, `decoder_model_merged.ort`,
 * `tokenizer.bin` for non-streaming; `frontend.ort` (or `frontend.model.ort`
 * plus `frontend.weights.ort`), `encoder.ort`,
 * `adapter.ort`, `cross_kv.ort`, `decoder_kv.ort`, `streaming_config.json`,
 * `tokenizer.bin` for streaming; plus optional `decoder_with_attention.ort` /
 * `decoder_kv_with_attention.ort` and `spelling_cnn.ort`). This is the general
 * in-memory loader and works for every architecture.
 *
 * The diarization models `segmentation.ort` and `embedding.ort` can be supplied
 * the same way when using the `identify_speakers` option; leave them out and
 * they are fetched from the CDN.
 */
export interface TranscriberFromFiles {
    files: Record<string, Uint8Array> | Map<string, Uint8Array>;
    modelArch?: ModelArch;
}
/** Load a transcriber by fetching a model from the CDN by language. */
export interface TranscriberFromCatalog {
    /** Language code (e.g. `"en"`) or English name (e.g. `"English"`). */
    language: string;
    modelArch?: ModelArch;
    /** Also fetch + load the spelling model if one is published. */
    includeSpelling?: boolean;
    downloader?: AssetDownloader;
    onProgress?: (loaded: number, total: number | undefined, file: string) => void;
}
export type TranscriberLoadOptions = (TranscriberFromBytes | TranscriberFromFiles | TranscriberFromCatalog) & {
    /** Options forwarded to the WASM module loader. */
    moduleOptions?: LoadModuleOptions;
    module?: MoonshineModule;
    /**
     * Extra `moonshine_option_t` entries passed to the native transcriber (see
     * the "Transcriber options" section of the README). For example
     * `{ skip_transcription: 'true' }` runs only the voice-activity detector and
     * segmentation, skipping the STT model entirely — no model files are needed,
     * so `files` may be empty in that mode.
     */
    options?: Record<string, string>;
};
/** Options for {@link Transcriber.loadFromUrls}. */
export interface TranscriberFromUrlsOptions {
    modelArch?: ModelArch;
    downloader?: AssetDownloader;
    onProgress?: (loaded: number, total: number | undefined, file: string) => void;
    moduleOptions?: LoadModuleOptions;
    module?: MoonshineModule;
    /** Extra native transcriber options (see {@link TranscriberLoadOptions.options}). */
    options?: Record<string, string>;
}
export declare class Transcriber {
    private readonly raw;
    private readonly module;
    private defaultStream;
    private closed;
    private constructor();
    /**
     * Loads a transcriber. Pass raw non-streaming bytes ({@link
     * TranscriberFromBytes}), a keyed map of model files ({@link
     * TranscriberFromFiles}, which also supports streaming), or a `language` to
     * fetch the model from the Moonshine CDN ({@link TranscriberFromCatalog},
     * cached for next time). All paths load the model purely in memory — the
     * browser has no natural filesystem.
     */
    static load(options: TranscriberLoadOptions): Promise<Transcriber>;
    /**
     * Loads a transcriber from a map of canonical filename -> URL. Downloads each
     * remote file into a buffer (with caching, via {@link AssetDownloader}) and
     * feeds the buffers through the in-memory loader. Convenient when you host the
     * model files yourself instead of using the Moonshine CDN catalog.
     *
     * @example
     * const t = await Transcriber.loadFromUrls({
     *   'encoder_model.ort': '/models/encoder_model.ort',
     *   'decoder_model_merged.ort': '/models/decoder_model_merged.ort',
     *   'tokenizer.bin': '/models/tokenizer.bin',
     * }, { modelArch: ModelArch.Base });
     */
    static loadFromUrls(files: Record<string, string> | Map<string, string>, options?: TranscriberFromUrlsOptions): Promise<Transcriber>;
    /** Builds the raw WASM transcriber from a keyed, in-memory file map. */
    private static construct;
    /** Transcribes a complete buffer of PCM audio (non-streaming). */
    transcribe(audio: Float32Array, options?: {
        sampleRate?: number;
        flags?: TranscribeFlags;
    }): Transcript;
    /**
     * Biases the decoder towards a list of terms, replacing any previous list.
     *
     * Useful for jargon, product names and proper nouns the model would otherwise
     * be unlikely to produce. No retraining is involved, so the list can follow
     * whatever the user is looking at and can be changed while a stream is
     * running; it takes effect on the next transcription and does not rewrite text
     * already emitted.
     *
     * Match the capitalization and spelling you want to see in the output. Pass an
     * empty array to turn biasing off, and set the strength with the
     * `keyterm_boost` option at load time. Only the streaming architectures can
     * apply this; the others throw.
     *
     * @param keyterms Terms to bias towards, e.g. `['Kubernetes', 'Ceph']`. Commas
     *   are the delimiter used internally, so terms must not contain them.
     */
    setKeyterms(keyterms: string[]): void;
    /**
     * Picks the key terms out of a passage of text and biases towards them,
     * replacing any previous list.
     *
     * Where {@link setKeyterms} wants a list, this wants context: pass the
     * document on screen, the agenda for the meeting, the last few messages in the
     * thread, and the unusual words in it are found for you. A word counts as
     * unusual when the model's own tokenizer has no single symbol for it, which is
     * the case biasing helps with, so the judgment follows the language of the
     * loaded model with no word lists involved.
     *
     * Like {@link setKeyterms}, this can be called while a stream is running,
     * takes effect on the next transcription, and does not rewrite text already
     * emitted. The capitalization in the passage is what gets asked for in the
     * transcript. Only the streaming architectures can apply this; the others
     * throw.
     *
     * @param context The passage to read terms out of. Pass an empty string to
     *   turn biasing off.
     * @param maxTerms Most terms to take, 200 by default. Worth keeping modest: a
     *   long list costs accuracy on the words you did not ask for, so the terms
     *   the passage leans on hardest are kept and its long tail is dropped.
     */
    setContext(context: string, maxTerms?: number): void;
    /**
     * Creates a new streaming session.
     *
     * `updateInterval` is the seconds of new audio the stream collects before
     * {@link Stream.transcribe} will make another pass over the engine; see there
     * for why asking more often than that costs more than it returns.
     */
    createStream(options?: {
        flags?: TranscribeFlags;
        updateInterval?: number;
    }): Stream;
    private ensureDefaultStream;
    addListener(listener: TranscriptEventListener): void;
    removeAllListeners(): void;
    start(): void;
    addAudio(audio: Float32Array, sampleRate: number, flags?: TranscribeFlags): void;
    stop(): void;
    /** Architecture-name helper for logging/UX. */
    archName(arch: ModelArch): string;
    close(): void;
    [Symbol.dispose](): void;
}
//# sourceMappingURL=transcriber.d.ts.map