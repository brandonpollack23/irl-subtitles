/**
 * Streaming transcription session. Wraps the embind Stream and turns raw
 * transcript snapshots into {@link TranscriptEventListener} callbacks, matching
 * the event-driven API of the other bindings.
 */
import { type TranscriptEventListener } from './events.js';
import { TranscribeFlags } from './enums.js';
import type { RawStream } from './module.js';
import { type Transcript } from './types.js';
/**
 * Seconds of new audio a stream collects before it will run another pass.
 *
 * Matches the C++ `Stream`'s own default and the core's
 * `transcription_interval`, which is the interval below which the engine
 * declines to update anyway.
 */
export declare const DEFAULT_UPDATE_INTERVAL = 0.5;
export declare class Stream {
    private readonly raw;
    private readonly listeners;
    private readonly diff;
    private readonly updateInterval;
    /** Seconds of audio added since the last pass over the engine. */
    private pending;
    /** Wall-clock seconds the last pass took, which is what the next one must earn. */
    private lastPass;
    private latest;
    private closed;
    /** @internal Constructed via {@link Transcriber.createStream}. */
    constructor(raw: RawStream, updateInterval?: number);
    addListener(listener: TranscriptEventListener): void;
    removeListener(listener: TranscriptEventListener): void;
    removeAllListeners(): void;
    start(): void;
    stop(): void;
    /**
     * Feeds PCM audio (mono float in [-1, 1]) into the stream buffer. Cheap; call
     * as often as your audio source produces chunks.
     */
    addAudio(audio: Float32Array, sampleRate: number, flags?: TranscribeFlags): void;
    /**
     * Runs a transcription pass over the buffered audio, dispatches diffed events
     * to listeners, and returns the current transcript snapshot.
     *
     * A pass is only worth making once there is enough new audio to say something
     * new, so one that comes too soon returns the last snapshot instead of
     * entering the engine. Callers are expected to ask on every chunk their audio
     * source produces — an AudioWorklet hands over 128 frames at a time, which is
     * some 375 times a second — and a pass costs far more than that budget: the
     * engine holds back below `transcription_interval` anyway, but with speakers
     * enabled it still re-clips every diarization turn onto every line before it
     * does so, which is work that grows for as long as the meeting does. Left
     * ungoverned that is what puts a live transcript further and further behind
     * the audio. Pass {@link TranscribeFlags.ForceUpdate} to insist.
     *
     * The interval is a floor, not a cadence: a pass has to cover at least as much
     * audio as the last one took to make. Most of what a pass costs is not the
     * audio in it — measured on the tiny model with speakers, 102ms of a pass goes
     * on getting started and 269ms on each second of audio it looks at — so asking
     * twice a second pays that overhead twice a second, and a machine that cannot
     * quite afford it does not fall behind by a fixed amount, it falls behind
     * further every pass. Replayed as a live session, a machine three times slower
     * than the one those numbers came from ends a three-minute meeting 82 seconds
     * behind and is still delivering lines 80 seconds after the audio stopped.
     * Making a pass earn its keep turns that into batch behaviour instead: passes
     * grow until each one covers its own cost, which is 1.6s of audio at a time on
     * that same machine, and the transcript stays within a pass or two of the
     * speaker. It buys headroom rather than working miracles — nothing can be done
     * for a machine that cannot transcribe a second of audio in a second — and
     * where there is headroom to spare the floor governs and nothing changes.
     */
    transcribe(flags?: TranscribeFlags): Transcript;
    close(): void;
    /** Enables `using` (explicit resource management). */
    [Symbol.dispose](): void;
}
//# sourceMappingURL=stream.d.ts.map