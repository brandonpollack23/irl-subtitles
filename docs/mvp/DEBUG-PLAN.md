# MVP debug plan

The MVP was built without glasses or phones. This plan walks every feature and
every plan.md §14 acceptance criterion from the easiest environment to the real
one, so each failure shows up where it's cheapest to debug:

1. **Desktop Chrome** with WAV replay: pipeline, models, storage, UI.
2. **Desktop fallbacks**: no cross-origin isolation, no WebGPU.
3. **Even simulator**: the G2 surface, menus, and bridge audio.
4. **Phone browsers** (Android Chrome, iOS Safari): WebGPU, memory, OPFS on phones.
5. **Even app + G2** (Android, then iOS): the product.
6. **Soniox**.
7. **Lifecycle and endurance**: 60 minutes, kills, backgrounding, quota.

Tick the boxes as you go. Each check says what should happen and where to look if
it doesn't. [IMPLEMENTATION.md](IMPLEMENTATION.md) lists deviations from plan.md.
Phase 0 runbook: [../phase0/RUNBOOK.md](../phase0/RUNBOOK.md) (certs, sideloading,
simulator) still applies.

## Already verified on desktop (2026-09-13)

Chrome 153, Linux, RTX 40-series (WebGPU without `shader-f16`), dev server on
:5174, WAV replay of the LibriSpeech fixtures:

- Boot with Turso on OPFS, OPFS blob store, WebGPU, WASM threads, WebCodecs Opus.
- Model download for the default selection with SHA-256 verification against
  `catalog.lock.json` (Silero, Moonshine Base, Whisper Base timestamped, CAM++,
  Gemma 4 E2B q4 ≈3.4 GB).
- Device-aware fallback: Gemma mobile QAT, Gemma E4B, and Qwen3.5 disabled with
  "needs shader-f16"; summary default moved to Gemma E2B q4.
- Live: VAD utterances, Moonshine captions, online CAM++ clustering with correct
  Speaker 1/2 alternation on a two-voice recording.
- Stop: Whisper final pass (word timing), diarization refinement (8 turns, all
  correct), Gemma summary with anchored items, state Ready, non-persisted audio
  removed.
- Naming Speaker 1 with Learn this voice relabeled every turn.
- A second conversation recognized that person automatically (live after ~30 s of
  evidence, and after Stop), while the new voice stayed anonymous.
- Unit/integration tests: `pnpm check` (44 tests: storage contract on SQLite and
  IndexedDB, crypto, capture/recovery, full pipeline with fakes, summaries, Soniox
  normalization, clustering, VAD, scheduler, SHA-256).

Not yet verified anywhere: everything below that isn't ticked.

## 0. Setup

```sh
pnpm install
pnpm check                       # typecheck + tests
pnpm fixtures                    # multi-speaker WAVs into apps/even-hub/public/fixtures/dev/
pnpm dev                         # http://localhost:5174, cross-origin isolated
IRL_COI=0 pnpm dev               # same, not isolated (IndexedDB fallback)
cd apps/even-hub && node scripts/certs.mjs && pnpm dev:https   # phones (install mkcert CA, see RUNBOOK)
pnpm --filter @irl/even-hub sim  # Even simulator with automation on :9898
pnpm --filter @irl/even-hub qr   # QR for sideloading into the Even app
pnpm --filter @irl/even-hub ehpk # packaged build
```

Where to look first, always: **Settings → Diagnostics** (device table, redacted
log, "Download diagnostics"). On Android, `chrome://inspect`; on iOS, Safari's
Develop menu. The simulator's automation API serves `GET /api/console`.
In dev builds a **DEV badge** (top right) names the host (Even simulator / Even app /
browser) and the database; tap it for what's available and why a backend fell back.
The same report is logged at boot (`platform` scope, plus a `console.table` in dev).

| Symptom area | Start reading |
| --- | --- |
| Boot, wiring | `apps/even-hub/src/services.ts` |
| Glasses UI, menu | `apps/even-hub/src/glasses.ts` |
| Start/pause/stop, states | `packages/pipeline/src/controller.ts` |
| Live events, restarts, live naming | `packages/pipeline/src/coordinator.ts` |
| After Stop (final STT, speakers, summary, compression) | `packages/pipeline/src/post-processor.ts` |
| Naming, learning, undo, merge, forget | `packages/pipeline/src/identity-service.ts` |
| Live VAD/STT/embedding loop, degradation | `packages/provider-local/src/live-provider.ts`, `scheduler.ts` |
| Model loading, targets, worker crashes | `packages/provider-local/src/engines.ts`, `workers/*.worker.ts` |
| Downloads, hashes | `packages/provider-local/src/model-files.ts`, `catalog.ts`, `catalog.lock.json` |
| Audio chunks, recovery | `packages/capture/src/chunk-recorder.ts`, `recording-audio.ts`, `packages/pipeline/src/recovery.ts` |
| Database, encryption | `packages/storage/src/*` |
| Soniox | `packages/provider-soniox/src/*` |

## 1. Desktop Chrome, WAV replay

Settings → Microphone → Audio file (testing); pick `fixtures/dev/conversation-a.wav`
(the file is kept in memory until reload).

### Models and settings
- [x] Download selected models finishes with "Models downloaded and verified".
- [ ] Measure this phone: results appear under Diagnostics → Benchmark results; every
      entry `ok=true` with a known answer (JFK phrase for English STT, same-speaker
      cosine for embeddings, "Paris" for the LLM); selection updates.
      *If an STT known answer fails:* check dtype for that entry in `catalog.ts` and
      the worker console; try the other target (WASM vs WebGPU).
- [ ] Change language to Japanese: live captions switch to Moonshine Base (ja);
      English-only models show "other language".
- [ ] Switch voice model to WeSpeaker ResNet34 with a named person: the warning
      appears; afterwards People shows a profile for the new model (re-enrolled
      from clips) or "Needs re-enrollment" (if audio clips were off).
- [ ] Delete downloaded models (Diagnostics), then start recording without
      downloading: capture works, live shows "…model not downloaded — processing
      later", the recording still saves.

### Recording flow
- [x] Start → captions → Stop and summarize → Ready (non-persisted).
- [ ] With Save audio on: header says "audio saved"; Load audio plays the whole
      conversation; Audio storage stage says "saved … MiB" (Opus).
      *No playback:* `RecordingAudio.wav`, chunk codec in Diagnostics logs; decode
      errors point at `packages/capture/src/opus.ts`.
- [ ] Pause for ~5 s then Resume: clock stops while paused, no gap is reported,
      transcript continues after resume.
- [ ] Add marker: marker buttons under the player seek to that time.
- [ ] Live banner with REC stays visible on every tab while recording.
- [ ] Reprocess: change Final transcript to Whisper Small, open an older conversation,
      "Re-transcribe with…" runs final STT → speakers → recognition → summary again.
- [ ] Retry failed steps: set Summary to Cloud with no address, record, see Summary
      "failed" while the recording is Ready; set Summary back and retry.
- [ ] Transcript search highlights matches; Show source jumps to and highlights the
      supporting segments.
- [ ] Rename conversation.

### People and identity
- [x] Tap Speaker 1 → Create and name with Learn this voice → every reference relabels.
- [x] Next conversation with the same voice → recognized automatically ("Recognized
      automatically" tooltip), other voice anonymous.
- [ ] Undo from the toast: name disappears, People shows no voice samples, and the
      automatic match in the later conversation reverts to Speaker N.
- [ ] Mark as unknown on an automatically recognized speaker: stays unknown after
      reprocessing (manual beats auto).
- [ ] People → rename full/short name: glasses preview line updates; transcripts and
      summaries use the new name without reprocessing.
- [ ] Merge two people, then Undo from the toast.
- [ ] Forget voice with and without "keep name": profile gone; with keep, past
      transcripts keep the name; without, they revert to Speaker N.
- [ ] Short utterances: a speaker with only 1–2 short lines stays anonymous (not
      falsely named). Expected by policy (8 s evidence minimum).
- [ ] Calibrate voice recognition with ≥2 named people across ≥2 conversations:
      shows EER and a threshold; Use threshold saves it.

### Deletion and export
- [ ] Delete audio: transcript, summary, names remain; Load audio disappears.
- [ ] Delete conversation (without removing samples): person still recognized next time.
- [ ] Delete conversation with "Also remove voice samples": that person's profile
      loses the samples/prototypes learned there.
- [ ] Export text/JSON: names marked "confirmed by you" / "recognized automatically";
      no audio, no embeddings in the file.

### Recovery (desktop)
- [ ] Save audio on, record ~20 s, close the tab mid-recording, reopen: "Recovered
      recording" banner; Finish processing produces a transcript of the saved part;
      the mic did not start by itself.
- [ ] Same with Save audio off: banner says audio wasn't saved; Discard removes it;
      Diagnostics → Storage used doesn't keep growing across repeats (scratch files
      are deleted).

## 2. Desktop fallbacks

- [ ] `IRL_COI=0 pnpm dev`: Diagnostics → Database `indexeddb` with reason
      "Turso on OPFS needs a cross-origin isolated page"; WASM threads false; the full
      flow in section 1 still works (slower).
- [ ] Chrome with WebGPU off (`--disable-features=WebGPU` or
      `chrome://flags/#enable-unsafe-webgpu` off): summary models show "Needs WebGPU";
      Whisper Large shows unavailable; Moonshine/Whisper Base run on WASM; recording
      still works.
- [ ] Simulated GPU failure: in devtools, kill the `irl-asr` worker during a
      recording (Sources → Threads → terminate, or `app().engines.reset("asr")` from a
      breakpoint). Capture continues; live shows "Captions paused — processing later";
      the final pass fills in the transcript.
- [ ] Storage failure: fill quota (devtools → Application → Storage → simulate custom
      quota ~50 MB) and record with Save audio on: an error line appears but
      recording and live captions continue (plan.md §14: capture never stops).

## 3. Even simulator (G2 surface)

`pnpm dev` then `pnpm --filter @irl/even-hub sim`. The simulator emits bridge
audio from your laptop mic (choose with `--aid`) and supports the context menu.
Automation: `curl -XPOST localhost:9898/api/input -d '{"action":"context_menu"}'`,
`curl localhost:9898/api/screenshot/glasses > g.png`.

The simulator is WebKitGTK: cross-origin isolated, but no SharedArrayBuffer and no
OPFS (off by default in WebKitGTK; even when enabled, sync access handles are
unsupported). Turso can't run there, so the DEV badge should read "Even simulator ·
DB IndexedDB" and storage should open with no Turso timeout.

**Live latency bench (dev builds).** Open the app with
`?bench=live[&wav=/fixtures/dev/<file>.wav][&stt=<model id>]`: it downloads the selected
live models, waits for warmup, plays the WAV through a real local recording, and logs one
`[bench] {"stage":"done",…}` console line (model load times, interim/final caption lag,
STT compute per second of new audio, VAD RTF, when captions appeared). Every recording
also logs a `live-metrics` summary to Diagnostics. Without a desktop session the simulator
runs on a headless compositor:

```sh
mutter --headless --wayland --no-x11 --wayland-display sim-wl --virtual-monitor 1280x900 &
WAYLAND_DISPLAY=sim-wl GDK_BACKEND=wayland WEBKIT_DISABLE_DMABUF_RENDERER=1 \
  pnpm --filter @irl/even-hub exec evenhub-simulator "http://localhost:5174/?bench=live" --automation-port 9898
curl -s localhost:9898/api/console | grep -o '\[bench\][^"]*'
```

Baseline 2026-09-14 (simulator, WebKitGTK 2.52.6, no WebGPU, no SharedArrayBuffer;
Moonshine Base, two_cities_16k.wav from moonshine-ai/moonshine test-assets): Moonshine
load 43.2 s, CAM++ 3.1 s; 2.0 s per STT call; final lag p50 2.5 s / p95 9.0 s; first
caption 5.5 s, then none until 18 s; scheduler at level 1.

- [ ] On launch the glasses show "IRL Subtitles  Local" and "Ready… Tap to start. Double tap to exit."
      *Blank:* `createStartUpPageContainer` result in the console (`glasses` log scope).
- [ ] Gestures mirror Conversate (`/api/input` `click` / `double_click`):
  - [ ] Tap on Ready starts recording (after ~0.5 s): status line "REC 00:03 …", phone shows
        the live banner; captions appear on the glasses body, speaker name prefix once clustered.
  - [ ] Tap while recording pauses ("PAUSED", "Tap to resume. Double tap to end."); tap again resumes.
  - [ ] Double tap while recording or paused stops and summarizes, without pausing first.
  - [ ] Double tap on Ready shows the system exit dialog; confirming closes the phone WebView too.
  - [ ] Tap-then-hold to open the menu while recording does not pause. *On hardware:* if it does,
        the menu's tap is reaching us before `FOREGROUND_ENTER_EVENT`; raise `TAP_SETTLE_MS`.
  - [ ] Log which field taps arrive on (`textEvent` vs `sysEvent`) on real glasses and the R1 ring.
- [ ] Menu shows "Start recording" and "Save audio: off"; selecting the toggle
      flips the label and Settings → Save audio.
- [ ] Menu while recording: Add marker, Pause, Stop and summarize. Pause shows
      "PAUSED" and the menu changes to Resume / Stop.
- [ ] Stop: glasses show "Saved. Processing on your phone…", then return to Ready.
- [ ] A named person's short name is used on the glasses when the full name is long.
- [ ] Text never overflows: long captions are cut with "…" (limit ~220 chars body).
- [ ] Menu labels ≤ 32 bytes (the SDK rejects the page otherwise; check console for
      `INVALID_MENU_ITEM_NAME`).

## 4. Phone browsers (standalone)

Serve with `pnpm dev:https` (certs) and open `https://<laptop-ip>:5174` in Android
Chrome and iOS Safari. Microphone: Phone microphone.

- [ ] Diagnostics: WebGPU available? `shader-f16`? max buffer size? cross-origin
      isolated? Database backend? Record these per device (they decide defaults).
- [ ] Download selected models over Wi-Fi. Watch memory on iOS: Gemma E2B (2–3 GB) may
      crash the tab. *If it does:* pick Qwen3.5-2B or Summary Off on that device and note
      it for the catalog (plan.md §6.1 memory budget).
- [ ] Measure this phone: record RTFs. Live STT must be < 0.5× real time to keep the
      captions tier; embedding < 0.25×.
- [ ] Record 2 minutes with 2 people talking: captions keep up (no "slowed" message
      after the first ~10 s); speakers separate.
- [ ] iOS: AudioContext at 16 kHz works (level meter moves). *If silent:* the worklet
      URL or sample rate; see `packages/capture/src/sources.ts` `PhoneMicSource`.
- [ ] iOS: OPFS blob store works (Diagnostics → Audio files `opfs`), otherwise
      `indexeddb` with a reason.
- [ ] ONNX Runtime on Safari: CPU workers already run the plain (non-asyncify) build
      (`irl-asr:wasm` / `irl-audio-ml:wasm` worker names); if WebGPU sessions fail to
      create, the asyncify build is the suspect (see `ort-env.ts`).

## 5. Even app + G2

Sideload with the QR (dev server) first, then an `.ehpk` build. Android first.

- [ ] Launch from the glasses menu and from the phone: both show the Ready page.
- [ ] Diagnostics: Even app `yes`; WebGPU, isolation, database backend inside the
      Even WebView (these may differ from Chrome/Safari).
      *Not isolated in the packaged app:* expected; IndexedDB fallback is used.
- [ ] Settings → Microphone: Glasses. Start from the glasses menu: the level meter on
      the phone moves; clock advances in step with real time.
      *audioControl fails:* glasses connected? The page must exist first
      (`GlassesController.ensurePage`).
- [ ] Gaps: phone Live view shows "N audio gaps" only when the BLE link drops.
- [ ] Live captions and speaker names on the G2 with 2–3 people.
- [ ] Name someone on the phone mid-conversation: the G2 speaker label changes within
      ~10 s (live identification interval).
- [ ] A person named yesterday is recognized today on the G2 after they've spoken
      ~8 s.
- [ ] Lock the phone for 5 minutes mid-recording, unlock: recording continued (check
      transcript coverage and gaps). *Audio stopped after backgrounding:* the G2 source
      re-arms `audioControl` on return; check the log for rearms.
- [ ] Network allowlist: model downloads work inside the Even app (redirect hosts for
      Hugging Face must be whitelisted in `app.json`; add any host the console shows
      as blocked).
- [ ] Repeat on iOS.

## 6. Soniox

- [ ] Settings → Soniox key: Save shows "A key is saved"; the field never shows the key.
- [ ] Test: "Key works"; with a wrong key: "Soniox rejected the key"; offline: "Could
      not reach Soniox…". The key never appears in Diagnostics.
- [ ] Select Soniox, record a 3-speaker conversation: captions stream; speakers
      separate; stop → Final transcript "skipped (Soniox final tokens…)", Speakers
      "N local windows, M speaker labels linked", recognition works for a named person.
- [ ] Toggle airplane mode for 10 s mid-recording: "Soniox reconnecting — audio is
      still saving", then captions resume; the transcript has no duplicated words around
      the reconnect (de-dup by sample range) and speakers from both connections are
      linked after Stop.
- [ ] Remove key: provider switches back to local; old Soniox transcripts unchanged.
- [ ] Inside the Even app: whitelist + CORS for `api.soniox.com` and
      `wss://stt-rt.soniox.com` (Phase 0 spike 5).

## 7. Lifecycle and endurance (plan.md §13 Phase 5)

- [ ] 60-minute G2 recording with Save audio on: no crash; recovery cursor keeps
      advancing (Diagnostics log shows no chunk write failures); final STT + summary
      finish in under ~30 minutes on the reference phone; battery and thermals noted.
- [ ] Same with Save audio off (memory stays flat: audio is on disk sealed with the
      in-memory key, not in RAM).
- [ ] Force-stop the Even app at minute 20: relaunch shows Recovered recording with
      ~20 min saved; Finish processing works; nothing corrupt.
- [ ] Force-stop during post-processing (state finalizing): relaunch shows it as
      recovered; Finish processing resumes.
- [ ] Upgrade the `.ehpk` with a recording and a named person: data, voice profiles, and
      the Soniox key survive (Phase 0 spike 6).
- [ ] Low storage: fill the phone to near full, record: warning and continued capture
      until the OS refuses writes; no corruption.

## 8. plan.md §14 acceptance criteria

| Criterion | Check in |
| --- | --- |
| 60-minute recording survives backgrounding; termination recovers persisted chunks | §7 |
| Local and Soniox produce the same canonical transcript/turn shape | §6 (export JSON from each and compare) |
| Even WebView exposes WebGPU on Android and iOS; runs in Chrome/Safari | §4, §5 Diagnostics |
| Local provider passes known-answer tests and sustained benchmarks | §1 Measure, §4, §7 |
| Default models hold budget for 60 minutes | §7 |
| Model dropdowns list validated entries, apply to next recording, recorded on the recording | §1 (conversation header / export JSON `models`) |
| Changing the voice model re-embeds or marks Needs re-enrollment | §1 People and identity |
| WebGPU loss / inference / OOM failure doesn't stop capture | §2 |
| Tap a speaker in transcript or summary to set full and short name | §1 |
| Relabeling updates all references without rewriting text | §1 |
| Enrolled speaker recognized only after enough evidence | §1 (verified on desktop), §5 |
| Mistaken match can be corrected and undone without contaminated samples | §1 Undo |
| Soniox credentials never in package, logs, exports, settings | §6; also grep the `.ehpk` and a diagnostics export for the key |
| Local mode sends nothing off-device except the opt-in cloud summary | §5: watch the network panel during a local recording (only Hugging Face downloads) |
| Audio keeps saving when STT/diarization/identity/summary/network fail | §2 |
| Delete audio, delete recording, forget voice have distinct semantics | §1 Deletion, People |

## Known risks to look at first

1. **Live caption latency.** Moonshine Base re-decodes the whole utterance for interim
   captions every 1.2 s; on phones this may not keep up. Mitigations already in place:
   the scheduler drops interims, then pauses live STT. Consider Moonshine Tiny as the
   phone default or longer interim intervals (`INTERIM_EVERY_SAMPLES`).
2. **transformers.js on Safari/Even iOS** with the asyncify ORT build (`ort-env.ts`
   forces it for everything).
3. **LLM memory** on phones (Gemma E2B ≈2.3–3.4 GB of weights).
4. **Turso WASM in the packaged Even app** needs cross-origin isolation, which the
   `.ehpk` likely lacks; IndexedDB is the expected path there. Data does not migrate
   between backends.
5. **Clustering thresholds** (`clustering.ts`: assign 0.55, merge 0.70) and match
   policy (`identity.ts`: min score 0.62, margin 0.10, 8 s evidence) are untuned
   guesses for CAM++; recalibrate with real G2 audio (§1 Calibrate).
6. **Whisper hallucinations** on long silences in the final pass; VAD gating should
   prevent most, check transcripts of quiet recordings.
7. **Opus decode alignment**: decoded audio may be shifted a few ms; fine for playback,
   check voice-clip re-embedding still matches.
8. **G2 text limits** (`TEXT_LIMIT`, container sizes in `glasses.ts`) were set from SDK
   docs, not hardware.
