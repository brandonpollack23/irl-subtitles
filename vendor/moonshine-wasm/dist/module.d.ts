/**
 * Loads and caches the Emscripten module produced by the core build
 * (`moonshine.mjs` + `moonshine.wasm`). Everything else in the binding goes
 * through the singleton returned by {@link loadMoonshineModule}.
 */
/** Raw embind class/function surface exported by moonshine.mjs. */
export interface MoonshineModule {
    Transcriber: new (keys: string[], buffers: Uint8Array[], modelArch: number, optionNames: string[], optionValues: string[]) => RawTranscriber;
    Stream: new (transcriber: RawTranscriber, flags: number) => RawStream;
    EmbeddingModel: new (keys: string[], buffers: Uint8Array[], modelArch: number, modelVariant: string) => RawEmbeddingModel;
    TextToSpeech?: new (language: string, keys: string[], buffers: Uint8Array[], optionNames: string[], optionValues: string[]) => RawTextToSpeech;
    GraphemeToPhonemizer?: new (language: string, keys: string[], buffers: Uint8Array[]) => RawGraphemeToPhonemizer;
    version(): number;
    sttDependencies(language: string, modelArch: string, includeSpelling: boolean): string;
    embeddingDependencies(modelName: string, variant: string): string;
    diarizationDependencies(): string;
    ttsDependencies?(languages: string, voice: string): string;
    ttsVoices?(languages: string, optionNames: string[], optionValues: string[]): string;
    /** JSON array of utterances; see {@link splitSayUtterances}. */
    ttsSplitUtterances?(language: string, text: string): string;
    g2pDependencies?(languages: string): string;
    extractSpeechClip?(audio: Float32Array, sampleRate: number, ttsHandle: number, clipDurationSeconds: number, minimumSpeechSeconds: number): RawSpeechClip;
}
/** Result of {@link MoonshineModule.extractSpeechClip}. */
export interface RawSpeechClip {
    /** 16 kHz mono PCM; `undefined` until `isComplete`. */
    audio?: Float32Array;
    startTime: number;
    speechDuration: number;
    isComplete: boolean;
    transcript?: string;
}
export interface RawTranscriber {
    transcribe(audio: Float32Array, sampleRate: number, flags: number): any;
    setKeyterms(keyterms: string): void;
    setContext(context: string, maxTerms: number): void;
    close(): void;
}
export interface RawStream {
    start(): void;
    stop(): void;
    addAudio(audio: Float32Array, sampleRate: number, flags: number): void;
    transcribe(flags: number): any;
    close(): void;
}
export interface RawEmbeddingModel {
    calculateEmbedding(sentence: string): Float32Array;
    distance(embeddingA: Float32Array, embeddingB: Float32Array): number;
    close(): void;
}
export interface RawTextToSpeech {
    say(text: string): {
        audio: Float32Array;
        sampleRate: number;
    };
    handle(): number;
    pushText(text: string): void;
    flush(): void;
    endInput(): void;
    cancel(): void;
    isStreaming(): boolean;
    nextChunk(): RawTtsChunk;
    close(): void;
}
/**
 * One chunk from {@link RawTextToSpeech.nextChunk}. `status` is 0 when `audio`
 * holds a chunk, 1 when no complete sentence is buffered yet, 2 once input
 * ended and everything queued has been synthesized, and 3 once a cancel
 * discarded the reply that was being generated.
 */
export interface RawTtsChunk {
    audio?: Float32Array;
    sampleRate: number;
    text: string;
    utteranceId: number;
    isFinal: boolean;
    status: number;
}
export interface RawGraphemeToPhonemizer {
    textToPhonemes(text: string): string;
    close(): void;
}
/** Options for {@link loadMoonshineModule}. */
export interface LoadModuleOptions {
    /**
     * Override how the `.wasm` (and worker) files are located. Useful when the
     * generated `moonshine.mjs` is served from a different path than the `.wasm`.
     */
    locateFile?: (path: string, scriptDirectory: string) => string;
    /** Provide the Emscripten factory directly (e.g. a custom bundling setup). */
    factory?: EmscriptenFactory;
}
type EmscriptenFactory = (opts?: Record<string, unknown>) => Promise<MoonshineModule>;
/**
 * Loads (and memoizes) the Moonshine WASM module. Safe to call repeatedly; the
 * heavy compile happens once.
 */
export declare function loadMoonshineModule(options?: LoadModuleOptions): Promise<MoonshineModule>;
/** Clears the cached module (mainly for tests). */
export declare function resetMoonshineModule(): void;
export {};
//# sourceMappingURL=module.d.ts.map