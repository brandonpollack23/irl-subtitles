/**
 * Error hierarchy mirroring the Python bindings' `errors.py`, so failing calls
 * surface as typed exceptions instead of raw negative return codes.
 *
 * The embind bridge throws `Error("moonshine:<code>:<text>")`; {@link toMoonshineError}
 * parses that back into the right subclass.
 */
/** Moonshine error codes from `core/moonshine-c-api.h`. */
export declare const MoonshineErrorCode: {
    readonly NONE: 0;
    readonly UNKNOWN: -1;
    readonly INVALID_HANDLE: -2;
    readonly INVALID_ARGUMENT: -3;
    readonly BUSY: -4;
};
/** Base class for all errors thrown by the Moonshine binding. */
export declare class MoonshineError extends Error {
    /** The underlying numeric error code, if known. */
    readonly code: number;
    constructor(message: string, code?: number);
}
export declare class MoonshineUnknownError extends MoonshineError {
    constructor(message?: string);
}
export declare class MoonshineInvalidHandleError extends MoonshineError {
    constructor(message?: string);
}
export declare class MoonshineInvalidArgumentError extends MoonshineError {
    constructor(message?: string);
}
/**
 * Raised when a call would have competed with a streaming reply for the
 * synthesizer, e.g. {@link TextToSpeech.synthesize} part-way through a
 * {@link TextToSpeech.stream}.
 */
export declare class MoonshineBusyError extends MoonshineError {
    constructor(message?: string);
}
/** Raised when a network/asset download fails. */
export declare class MoonshineDownloadError extends MoonshineError {
    constructor(message: string);
}
/**
 * Lets {@link toMoonshineError} decode native exceptions. Called with the
 * Emscripten module as soon as it is instantiated.
 */
export declare function registerErrorModule(mod: unknown): void;
/**
 * Normalizes anything thrown across the embind boundary into a
 * {@link MoonshineError}. Recognizes the `moonshine:<code>:<text>` format
 * emitted by the C++ bridge.
 */
export declare function toMoonshineError(err: unknown): MoonshineError;
/** Runs `fn`, re-throwing any embind error as a typed {@link MoonshineError}. */
export declare function wrapErrors<T>(fn: () => T): T;
//# sourceMappingURL=errors.d.ts.map