# Phase 0 device runbook

How to run the Phase 0 feasibility spikes (plan.md §13, epic `irl-subt-0i6`) on
real hardware with the probe app in `spikes/phase0-probe`. Each spike's results
feed the go/no-go record (`irl-subt-0i6.7`).

The probe is throwaway spike code. It is not the MVP app.

## What you need

- A laptop and an Android flagship phone (Snapdragon 8 Elite Gen 5, Dimensity
  9500, or Tensor G5 class) on the same Wi-Fi. Repeat on each reference device
  you have.
- Even Realities app **2.2.10 or later**, with a G2 paired and charged.
- A Soniox API key, for spike 5 only.
- Optional but useful: `adb` over USB with developer options enabled, for memory,
  thermal, and battery readings the WebView can't see.
- About 15 GB of free disk on the laptop for model files.

## One-time laptop setup

```sh
cd spikes/phase0-probe
pnpm install
pnpm models fetch --all       # ~13 GB from Hugging Face / sherpa-onnx releases
pnpm models inspect --all     # graph I/O metadata, bundled into the app
pnpm models fixtures --all    # CPU reference outputs for drift checks
pnpm test                     # unit tests should pass
```

## How the phone reaches the probe

| Mode | Command | Use for |
| --- | --- | --- |
| **A. Sideload, isolated** | `pnpm dev`, then `pnpm qr` and scan the QR in the Even app | Spikes 1, 2, 4, 5, 6 and all model benchmarks |
| **A′. Sideload, not isolated** | `pnpm dev:no-coi`, then `pnpm qr` | Spike 2 only: what the WebView does without COOP/COEP headers |
| **B. Packaged `.ehpk`** | `pnpm ehpk`, upload `phase0-probe.ehpk` as a private build on the Even Hub site, then open it from the Even app | Spikes 2, 4, 6: isolation, storage, and upgrades as Even actually serves apps |

In modes A and A′, every report is uploaded automatically to
`spikes/phase0-probe/results/<spike>/` on the laptop. The status line under
each report says `saved on laptop: …`.

In mode B, the app is served by Even, not the laptop. On **Overview**, set
**Report sink** to `http://<laptop-LAN-IP>:5173/__probe` and press
**Test sink**. The network whitelist may block that. If it does, use **Copy
JSON** on each report and send it to yourself (email or notes), then drop the
files into `results/<spike>/`. The last five reports per spike are also kept
on the phone.

On first launch in any mode, open **Overview** and set **Device label** (for
example `pixel10pro`). Every report carries it.

---

## Spike 2: WebNN and platform inventory (`irl-subt-0i6.2`)

**This decides whether the local MVP can exist at all.**

1. Mode A: **Capabilities → Run inventory**. Leave "include full
   opSupportLimits" off.
2. Run it again with that box on. It's a larger report, but it's the operator
   support table.
3. Mode A′: **Run inventory**.
4. Mode B: **Run inventory**. If the header pill says **NOT isolated**, press
   **Try isolation via service worker**. The app reloads. Press **Run
   inventory** again, then **Remove service worker**.

Never enable anything in `chrome://flags` or developer settings. Flag-gated
support doesn't count.

**Pass:** in mode A **and** mode B, the summary shows `navigator.ml (main)` and
`navigator.ml (worker)` as `true`, and at least one of `npu:ok` / `gpu:ok`.

**Blocker:** `navigator.ml` is false in the Even app. Stop and tell me.

Also note the header pill in mode B. If it says "NOT isolated" even after the
service-worker attempt, Turso on OPFS is off the table.

## Spike 1: 60-minute G2 capture soak (`irl-subt-0i6.1`)

Mode A. Wear the glasses and talk or play speech audio nearby for part of the
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
   `adb shell am force-stop <package>`). Don't press Stop.
3. Relaunch the probe. It should show "Torture writer was running…". Press
   **Verify**.
4. Repeat steps 2–3 three times. Then do it once with a swipe-away from recents
   instead of a force-stop.
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

**Pass:** `ok: true` with `writtenByVersion` older than `currentAppVersion`
after the upgrade. `bridgeStorage` shows whether the Even bridge's own storage
also survived, for comparison.

## Spike 5: Soniox through the Even WebView (`irl-subt-0i6.5`)

Mode A first. Then mode B, since the manifest whitelist only matters there.

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

## Spike 3: model benchmarks through WebNN (`irl-subt-0i6.3.*`)

Mode A only. Models stream from the laptop, so keep it on fast Wi-Fi and plug
the phone in for this spike.

1. **Models → Check model files**. It should report all graphs served.
2. Tick `webnn-npu`, `webnn-gpu`, `webnn-cpu`; untick `wasm`. Iterations: 30.
   **compare with WASM** on.
3. **Run defaults matrix**. It takes a while, especially the Gemma and Qwen3
   graphs.
4. **Run full matrix**. This covers every catalog option and takes much
   longer. Start it and leave it.
5. **Unplug** for the sustained runs. Select **Moonshine Streaming Medium →
   encoder-int8**, sustained seconds `600`, tick only the device type that won
   step 3, then **Run selected graph**. Repeat for **CAM++**.
6. **Concurrent live stack**: minutes `60`, EP = the winner from step 3,
   **Run live stack**. Keep the screen on and the probe in the foreground,
   phone unplugged. With `adb`, every 10 minutes run:
   `adb shell dumpsys thermalservice | grep -i "temperature\|status"` and
   `adb shell dumpsys meminfo | grep -i even`
   Paste those into a text file next to the results.

**Expected failures:** these are findings, not harness bugs.

- Graphs with `If` nodes (Whisper and Moonshine merged decoders) will likely
  fall back or fail on WebNN.
- On desktop Chrome, Silero VAD failed WebNN session creation outright.
- int4 `MatMulNBits` graphs (Qwen3-ASR decoder, Whisper-turbo, Gemma) may not
  be accepted by the WebNN EP.

**What I look at:** per graph and device type, `webnnCoverage.fullyOnWebNN`,
`latencyMs.p95`, `realTimeHeadroom` (≥ 2 is comfortable for live roles), drift
vs fixture and vs WASM, and in the live stack, `overruns` growing over time
(thermal throttling).

**Blocker:** no speaker-embedding model (CAM++, WeSpeaker, ECAPA, ReDimNet)
runs with `fullyOnWebNN: true` and `realTimeHeadroom` > 1 on any device type.

---

## When you're done

Tell me which devices you ran and anything you saw that the reports won't show
(glasses display glitches, app crashes, heat, dialogs). Reports are already in
`spikes/phase0-probe/results/`, and I'll write the go/no-go record from them.

Known gaps in this harness, tracked as tickets:

- No ONNX export exists for Moonshine Streaming Tiny or the per-language (ja)
  checkpoints.
- Benchmarks are graph-level: audio feature extraction and autoregressive
  decode loops aren't timed end to end yet.
