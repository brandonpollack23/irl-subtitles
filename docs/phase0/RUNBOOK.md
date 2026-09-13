# Phase 0 device runbook

How to run the Phase 0 feasibility spikes (plan.md §13, epic `irl-subt-0i6`) on
real hardware with the probe app in `spikes/phase0-probe`. Each spike's results
feed the go/no-go record (`irl-subt-0i6.7`).

The probe is throwaway spike code. It is not the MVP app.

## What you need

- A laptop and the phones on the same Wi-Fi: an Android flagship (Snapdragon 8
  Elite Gen 5, Dimensity 9500, or Tensor G5 class) and an iPhone (A18 Pro/A19
  class) on **iOS 26 or later**. Repeat on each reference device you have.
- Even Realities app **2.2.10 or later** on each phone, with a G2 paired and
  charged. The G2 can only be connected to one phone at a time.
- Current Chrome on the Android phone, and Safari on the iPhone.
- A Soniox API key, for spike 5 only.
- Optional but useful: `adb` over USB with developer options enabled, for memory,
  thermal, and battery readings the WebView can't see. On iOS, a Mac with
  Safari **Develop** menu (Settings → Apps → Safari → Advanced → Web Inspector
  on the phone) shows console errors and memory.
- About 15 GB of free disk on the laptop for model files.

## One-time laptop setup

```sh
cd spikes/phase0-probe
pnpm install
pnpm models fetch --all       # ~13 GB from Hugging Face / sherpa-onnx releases
pnpm models inspect --all     # graph I/O metadata, bundled into the app
pnpm models fixtures --all    # CPU reference outputs for drift checks
pnpm test                     # unit tests should pass
pnpm certs                    # HTTPS certificate for phone browsers (needs mkcert: `mise install`)
```

### Trust the certificate on each phone (once)

WebGPU, OPFS, and `SharedArrayBuffer` only exist in a secure context. Phone
browsers only treat `https://` or `localhost` as secure, so the phone must trust
the laptop's mkcert root CA. `pnpm certs` prints its path (`rootCA.pem`).

- **iPhone:** AirDrop or email `rootCA.pem` to the phone and open it. Install the
  profile in Settings → General → VPN & Device Management. Then turn it on in
  Settings → General → About → Certificate Trust Settings. The second step is
  easy to miss, and Safari won't trust the certificate without it.
- **Android:** copy `rootCA.pem` to the phone, then Settings → Security →
  More security settings → Install from device storage → CA certificate.
  Chrome trusts user CAs. App WebViews often don't. If the Even app on Android
  shows `secureContext: false` in mode A **and** can't load mode A-https, write
  that down and tell me. It decides how we sideload during development, and
  mode B still shows what a shipped build gets.

If your laptop's LAN IP changes, run `pnpm certs` again. The CA stays the same,
so phones don't need to reinstall it.

## How the phone reaches the probe

| Mode | Command | Use for |
| --- | --- | --- |
| **A. Sideload, isolated** | `pnpm dev`, then `pnpm qr` and scan the QR in the Even app | Spikes 1, 2, 4, 5, 6 and all model benchmarks |
| **A-https. Sideload over HTTPS** | `pnpm dev:https`, then `pnpm qr:https` | Use instead of A when mode A's inventory shows `secureContext: false` |
| **A′. Sideload, not isolated** | `pnpm dev:no-coi`, then `pnpm qr` | Spike 2 only: what the WebView does without COOP/COEP headers |
| **B. Packaged `.ehpk`** | `pnpm ehpk`, upload `phase0-probe.ehpk` as a private build on the Even Hub site, then open it from the Even app | Spikes 2, 4, 6: isolation, storage, and upgrades as Even actually serves apps |
| **C. Phone browser** | `pnpm dev:https`, then open `https://<laptop-LAN-IP>:5173` in Safari (iOS) or Chrome (Android) | Spikes 2 and 3 in standalone Safari and Chrome. There's no G2, so capture uses the phone mic |

For Android Chrome only, you can skip certificates: connect USB, run
`adb reverse tcp:5173 tcp:5173` and `pnpm dev`, then open
`http://localhost:5173` on the phone.

Run every mode on **both** phones: the Even app on Android and on iOS.

In modes A, A-https, A′, and C, every report is uploaded automatically to
`spikes/phase0-probe/results/<spike>/` on the laptop. The status line under
each report says `saved on laptop: …`.

In mode B, the app is served by Even, not the laptop. On **Overview**, set
**Report sink** to `http://<laptop-LAN-IP>:5173/__probe` and press
**Test sink**. The network whitelist may block that. If it does, use **Copy
JSON** on each report and send it to yourself (email or notes), then drop the
files into `results/<spike>/`. The last five reports per spike are also kept
on the phone.

On first launch in any mode, open **Overview** and set **Device label** (for
example `pixel10pro-even`, `iphone17pro-safari`). Include the host (Even app,
Chrome, or Safari), since the same phone is tested in several. Every report
carries it.

---

## Spike 2: WebGPU and platform inventory (`irl-subt-0i6.2`)

**This decides whether local models can run on each platform.**

Do this on the Android phone and on the iPhone.

1. Mode A: **Capabilities → Run inventory**. If `secureContext` is `false`,
   switch to mode A-https and run it again.
2. Mode A′: **Run inventory**.
3. Mode B: **Run inventory**. If the header pill says **NOT isolated**, press
   **Try isolation via service worker**. The app reloads. Press **Run
   inventory** again, then **Remove service worker**.
4. Mode C: **Run inventory** in Chrome (Android) and in Safari (iOS).

Never enable anything in `chrome://flags`, Safari's Feature Flags, or developer
settings. Flag-gated support doesn't count.

**Pass:** in the Even app (mode A or A-https, **and** mode B), `WebGPU (main)`
and `WebGPU (worker)` both show an adapter with `ok`. For example
`qualcomm/adreno-8xx ok f16:ok maxBuffer 1024 MiB`. Note `f16` and
`maxBuffer`, which limit model precision and size.

**Blocker:** `navigator.gpu missing` in the Even app on a platform. Local STT and
summaries can't run there, so stop and tell me. If it says `(not a secure
context)`, it's a serving problem, not a blocker: retry with A-https.

Also note the header pill in mode B. If it says "NOT isolated" even after the
service-worker attempt, Turso on OPFS is off the table.

## Spike 1: 60-minute G2 capture soak (`irl-subt-0i6.1`)

Mode A, on the Android phone and then on the iPhone. iOS suspends backgrounded
web content far more aggressively, so the lock and app-switch steps matter most
there. Wear the glasses and talk or play speech audio nearby for part of the
run so levels vary.

1. **Capture**: source **G2 glasses mic**, **persist PCM to OPFS** on, **re-arm
   mic on foreground** off.
2. Press **Start** (or use **Start capture** in the glasses menu). Confirm the
   glasses show `REC 00:00:0x`.
3. Follow this timeline, and add a **Marker** (glasses menu) at each step:

   | At | Do |
   | --- | --- |
   | 0–10 min | Phone unlocked, probe in the foreground |
   | 10 min | Press the power button (screen off) and leave it for 10 min |
   | 20 min | Unlock and return to the probe |
   | 25 min | Switch to another app (browser, maps) for 10 min |
   | 35 min | Return to the probe |
   | 40 min | Lock the phone for 15 min |
   | 55 min | Unlock and return |
   | 60 min | **Stop & report** |

4. Press **Upload recording as WAV**. It lands in `results/recordings/`.
5. Run it again with **re-arm mic on foreground** on.

If the app was killed (it restarts, or shows **Previous launch ended without
Stop**), that is a result. The probe reports it automatically on relaunch.
Write down roughly when it happened.

With `adb`, capture battery before and after:
`adb shell dumpsys battery | grep level`

**What I look at:** `coveragePct`, the gap list against your markers, whether
audio resumed after the screen was off and after app switching, whether
`persistedBytes == expectedBytes`, and battery drain.

## Spike 4: Turso on OPFS storage (`irl-subt-0i6.4`)

Run in mode A first, then mode B.

1. **Storage → Run latency bench**: 60 chunks, AES-GCM on.
2. **Start torture writer**. After about 20 seconds, **force-stop the Even
   app**: Android Settings → Apps → Even Realities → Force stop (or
   `adb shell am force-stop <package>`). On iOS, swipe it away in the app
   switcher. Don't press Stop.
3. Relaunch the probe. It should show "Torture writer was running…". Press
   **Verify**.
4. Repeat steps 2–3 three times. On Android, also do it once with a swipe-away
   from recents instead of a force-stop. Run the whole spike on both phones.
5. **Upgrade test (mode B only):** with torture data present, bump `version` in
   `app.json` (for example `0.1.0` → `0.1.1`), run `pnpm ehpk`, and upload and
   install the new build over the old one. Open it and press **Verify**. The
   report's `rowsByAppVersion` and `meta.created_by_version` should show the
   old version's rows surviving.
6. **Capture with storage load:** run Spike 1 for 10 minutes while the torture
   writer runs, and check for new capture gaps.

**Pass:** every Verify shows `ok: true`, `lostAckedCommits: 0`, and
`integrityCheck` is `ok`, including after the upgrade.

**Fallback trigger:** Turso fails to open in mode B, isolation is unavailable in
mode B, or any Verify loses acked commits. Then IndexedDB is the backend.

## Spike 6: encrypted secret persistence (`irl-subt-0i6.6`)

1. Mode B: **Secrets → Store test secret**, then **Verify**.
2. Force-stop, relaunch, **Verify**.
3. Install a newer `.ehpk` (same steps as the Spike 4 upgrade test), then
   **Verify**.
4. Optional: in Android settings, clear the Even app's cache (not storage), then
   **Verify**.
5. Repeat on the iPhone (skip step 4).

**Pass:** `ok: true` with `writtenByVersion` older than `currentAppVersion`
after the upgrade. `bridgeStorage` shows whether the Even bridge's own storage
also survived, for comparison.

## Spike 5: Soniox through the Even WebView (`irl-subt-0i6.5`)

Mode A first. Then mode B, since the manifest whitelist only matters there.
Do both phones.

1. **Soniox**: paste the key. It stays in memory only and is never saved or
   uploaded.
2. **1. Mint temporary key**. Note whether it succeeds.
3. Audio: **G2 glasses mic**, **use temporary key** on, **reconnect on
   foreground** on. **2. Start streaming**. Have a two-person conversation for
   about 3 minutes, including a stretch of silence.
4. Lock the phone for 1 minute, unlock, and talk for another minute.
5. **Stop & report**.

Leave **include transcript in report** off unless you're happy for the text to
land on the laptop.

**Pass:** `finalTokens > 0`, at least 2 `speakers`, no `errors` other than
around the lock period, and the recording continues or reconnects after
unlock (see `events`).

## Spike 3: model benchmarks on WebGPU and WASM (`irl-subt-0i6.3.*`)

Run this on both phones, first in the Even app (mode A, or A-https if needed),
then once in mode C (Chrome on Android, Safari on iOS) for comparison. Models
stream from the laptop, so keep it on fast Wi-Fi and plug the phone in for this
spike.

EPs in the harness:

- `webgpu` is ONNX Runtime's native WebGPU EP, the one the app would ship.
- `webgpu-jsep` is the older JS-kernel WebGPU EP. Its op coverage differs, so
  it's useful as a comparison.
- `wasm` is multithreaded CPU. It's the reference, and the likely winner for
  tiny graphs.

1. **Models → Check model files**. It should report all graphs served.
2. Tick `webgpu` and `wasm`. Iterations: 30. **compare with WASM** on.
3. **Run defaults matrix**. It takes a while, especially the Gemma and Qwen3
   graphs.
4. **Run full matrix**. This covers every catalog option and takes much
   longer. Start it and leave it. On the iPhone, if the page reloads or goes
   blank partway through, iOS killed it for memory. Write down which graph was
   running (it's the last line in the log) and restart the matrix after it.
5. **Unplug** for the sustained runs. Select **Moonshine Streaming Medium →
   encoder-int8**, sustained seconds `600`, tick only the EP that won step 3,
   then **Run selected graph**. Repeat for **CAM++**.
6. **Concurrent live stack**: minutes `60`, EP `mixed` (VAD on WASM, the rest
   on WebGPU), **Run live stack**. Keep the screen on and the probe in the
   foreground, phone unplugged. On Android with `adb`, every 10 minutes run:
   `adb shell dumpsys thermalservice | grep -i "temperature\|status"` and
   `adb shell dumpsys meminfo | grep -i even`
   Paste those into a text file next to the results. On the iPhone, note when
   it gets warm and the battery percentage every 10 minutes.

**Expected findings** (desktop Chrome already shows these; they aren't harness
bugs):

- Small graphs are much faster on WASM than on WebGPU. On desktop, Silero VAD
  was 0.3 ms on WASM and 11 ms on WebGPU. CAM++ was 40 ms and 200 ms.
- The native WebGPU EP gives wrong Silero VAD recurrent state (`stateN` cosine
  about 0.94 vs WASM). JSEP and WASM agree.
- CAM++ fails on `webgpu-jsep` (AveragePool `ceil_mode` isn't implemented) but
  runs fully on native `webgpu`.
- Dynamic-int8 graphs (the Moonshine Streaming Medium export) put
  `MatMulInteger`/`DynamicQuantizeLinear` on the CPU. That's about 150 fallback
  nodes, and it's slow.

**What I look at:** per graph and EP, `placement.allOnGpu`,
`placement.cpuOps`, `latencyMs.p95`, `realTimeHeadroom` (≥ 2 is comfortable
for live roles), drift vs fixture and vs WASM, `gpuAdapter`, and in the live
stack, `overruns` growing over time (thermal throttling).

**Blocker (per platform):** no speaker-embedding model (CAM++, WeSpeaker,
ECAPA, ReDimNet) passes drift checks with `realTimeHeadroom` > 1 on either
`webgpu` or `wasm`.

---

## When you're done

Tell me which devices and hosts (Even app, Chrome, Safari) you ran, and anything you saw that the reports won't show
(glasses display glitches, app crashes, heat, dialogs). Reports are already in
`spikes/phase0-probe/results/`, and I'll write the go/no-go record from them.

Known gaps in this harness, tracked as tickets:

- No ONNX export exists for Moonshine Streaming Tiny or the per-language (ja)
  checkpoints.
- Benchmarks are graph-level: audio feature extraction and autoregressive
  decode loops aren't timed end to end yet.
