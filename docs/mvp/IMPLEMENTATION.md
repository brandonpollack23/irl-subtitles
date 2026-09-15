# MVP implementation notes

What was built against plan.md, where it deviates, and why. Written 2026-09-13,
before any device or G2 testing (see [DEBUG-PLAN.md](DEBUG-PLAN.md)). Phase 0
(irl-subt-0i6) is still open: everything here assumes its spikes will pass and
needs checking against them.

## Layout

| Path | What |
| --- | --- |
| `packages/domain` | Canonical types (sample clock, tokens, turns, clusters, attributions, people, summary schema), identity matching policy, redaction |
| `packages/storage` | One schema for SQL (Turso/OPFS; node:sqlite in tests) and IndexedDB, typed `Repository`, AES-GCM sealing, blob stores, secrets, settings |
| `packages/capture` | G2 / phone mic / WAV audio sources, frame sequencer, chunk recorder, `RecordingAudio` reader, WebCodecs Opus |
| `packages/pipeline` | Recording controller, provider coordinator, reconciler, post-processor, identity service, recovery, retention, export |
| `packages/provider-local` | Model catalog + lock, device capabilities, ML workers, live local run, clustering, scheduler, benchmarks |
| `packages/provider-soniox` | Soniox fused provider with reconnect and de-duplication |
| `packages/provider-speechmatics` | Speechmatics realtime (raw WebSocket + temporary key), batch final transcript, key test |
| `packages/provider-summary` | Prompting, chunk/reduce, JSON validation; local and cloud providers |
| `apps/even-hub` | Composition root, G2 controller, SolidJS 2 phone UI |
| `services/summary-api` | Optional transcript-only summary endpoint (Claude) |

`pnpm check` typechecks and runs the unit/integration tests. `pnpm dev` serves the
app on :5174 (cross-origin isolated). `pnpm pin-models` refreshes
`catalog.lock.json`; `pnpm fixtures` builds multi-speaker test WAVs.

## Deviations from plan.md

- **Sample indices are `number`, not `bigint`.** 2^53 samples is ~17,800 years of
  audio; numbers survive JSON, SQL, and IndexedDB without codecs.
- **Model defaults.** Several §6.1 defaults have no working web adapter yet, so they
  are in the catalog as unavailable with the reason, and defaults fall to the
  first available entry (plan.md's own selection rules):
  - Live STT: **Moonshine Streaming Small** (en, ja, es, de; Tiny for zh, ar, vi)
    instead of Medium, through Moonshine Voice's own WASM runtime built single-thread
    (`vendor/moonshine-wasm`), fed the audio continuously; Medium is selectable but used
    0.88x of one core in the Even simulator. Korean and Ukrainian keep Moonshine Base
    (no streaming checkpoint), which captions each VAD utterance and re-decodes it while
    it grows; Whisper Small for `auto` (irl-subt-kdl.9).
  - Final STT: Qwen3-ASR + ForcedAligner → **Whisper Large-v3-Turbo (timestamped,
    word timing)**. Parakeet TDT also unavailable.
  - Summary: Gemma 4 E2B mobile QAT stays default but needs `shader-f16`; on GPUs
    without it the app falls back to **Gemma 4 E2B q4**.
  - VAD TEN and ECAPA-TDNN are unavailable (license review / frontend not ported).
- **Runtimes.** Whisper, Moonshine, WeSpeaker, Gemma, Qwen run through
  transformers.js 4.2 (its decode loops keep KV caches on the GPU). Silero, CAM++
  (WeSpeaker export, using transformers.js's Kaldi fbank), and ReDimNet run on ORT
  Web directly. ORT is 1.29.0 everywhere (pnpm override). Each worker runs one build, chosen
  when it's created: the plain SIMD build for CPU sessions and the asyncify build only for
  WebGPU sessions (`ort-flavor.ts`, `ort-env.ts`). transformers.js is handed the CPU build
  through its `Symbol.for("onnxruntime")` hook, with a small pnpm patch so an injected
  runtime still accepts `wasm`/`cpu` devices. On JavaScriptCore the asyncify build made
  model loads ~10x slower (irl-subt-kdl.2).
- **Integrity.** Every catalog repo is pinned to a commit; downloads are verified
  against SHA-256 while streaming (`verifyingFetch`), for our cache and
  transformers.js's.
- **No grammar-constrained decoding.** transformers.js 4.2 has none; summaries are
  validated against the schema with one repair round instead.
- **Clustering is JS, not WASM.** Cosine bookkeeping over ~1 window/s is trivial.
- **Storage runs on the main thread.** Turso already does its file I/O in its own
  worker; audio blobs are written from a dedicated OPFS worker.
- **Non-persisted mode (the default)** seals audio with an in-memory-only key, uses
  it for processing, then deletes it. After a crash the scratch audio is
  unreadable and deleted on relaunch. Transcripts, summaries, and speaker windows
  are kept. If you meant "keep nothing at all", that's a follow-up.
- **Session clusters keep their embeddings** (`voice_windows`, sealed) so a speaker
  can be named and learned after audio is gone.
- **Pause** stops the audio source (the mic is released) and the sample clock
  simply continues when resumed; gaps are reported, never filled with silence.
- **Cloud services are per-role options** (irl-subt-3xb): `@irl/domain` `selection.ts` lists them next to the local
  catalog; an option that provides another role (a live stream's endpointing and final tokens) locks that role.
  Recordings snapshot the locks. The reconnect ring is shared (`ReplayRing`).
- **Speechmatics speaker labels** follow the Soniox rule (`S<conn>-<label>`), except enrolled voices, whose labels are
  opaque person tokens and stay `SM-<token>` across connections.
- **Soniox speaker labels are scoped per connection** (`S<conn>-<label>`) and linked
  after Stop with local embeddings, because Soniox numbering restarts on reconnect.
- **Opus** uses WebCodecs, not a WASM encoder; without it audio stays PCM.
- **Speaker-ID calibration** uses the user's own confirmed conversations (real G2
  audio) rather than a bundled dataset.
- **`packages/ui`** wasn't split out; the phone UI lives in `apps/even-hub/src/ui`.
- **Cloud summary endpoint origins** must be in the CSP (`IRL_SUMMARY_ORIGIN` at
  build time) and in `app.json`'s whitelist; there's no dynamic allowlist.
- **Credential broker** (kxh) is post-MVP as planned; the Soniox key is stored
  sealed on the phone.
