# Phase 0 results sheet

See docs/phase0/RUNBOOK.md. The JSON reports in `results/<spike>/` have the
numbers. This sheet records what they can't.

| Device label | Phone / OS / host version | Mode(s) | Spike | Result (pass / fail / blocker) | What happened that the report won't show |
| --- | --- | --- | --- | --- | --- |
| `fold7-chrome` | Galaxy Z Fold7 SM-F966Q (Snapdragon 8 Elite) / Android 16 / Chrome 152.0.7977.82 | C (`adb reverse`, `http://localhost:5173`) | 2 | pass | Isolated with SAB, WASM threads, OPFS sync handles. WebGPU on Adreno 8xx in the page and a worker, f16 ok, maxBuffer 2048 MiB |
| `fold7-even-A` | Galaxy Z Fold7 / Android 16 / Even app (`com.even.sg`), WebView Chrome 151.0.7922.199 | A (`adb reverse`, QR for `http://localhost:5173`) | 2 | WebGPU pass. **Not isolated** | COOP/COEP headers arrive, but `crossOriginIsolated` is false and there's no `SharedArrayBuffer`. The service-worker attempt didn't help (`serviceWorkerController: true`, still not isolated) |
| `fold7-even-Aprime-nocoi` | same | A′ | 2 | WebGPU pass, not isolated (expected) | Same as mode A: WebGPU and OPFS sync handles in the worker work without the headers |
| `iphone-even` | | A, B | 2 | not run (decision: no iPhone testing) | |
| `iphone-safari` | | C | 2 | not run (decision: no iPhone testing) | |
| `fold7-even-B` | | B | 2 | not run | Spike closed without it |

## Once per phone

### Galaxy Z Fold7 (Android 16)

- **Secure context in mode A:** yes, over `adb reverse` to `localhost`, so no
  certificate was needed. LAN `http://` and A-https weren't tried.
- **Isolation:** not isolated in the Even app, with headers, via the service
  worker, and without headers. The same page in Chrome on the same phone is
  isolated, so this comes from the Even app's Android WebView, not the serving.
  So far, Turso on OPFS isn't available in the Even app on Android. Storage
  falls back to IndexedDB (`packages/storage/src/turso-driver.ts` already
  refuses Turso when the page isn't isolated). Without SAB, ORT's WASM EP is
  single-threaded there. Mode B (packaged `.ehpk`) wasn't run.
- **WebGPU:** present without flags in the Even WebView, in the page and in a
  dedicated worker. Adapter `qualcomm/adreno-8xx`, both power preferences.
  Known-answer f32 and f16 compute are correct, `shader-f16` is available, and
  maxBufferSize and maxStorageBufferBindingSize are 2 GiB. matmul256 p50 is
  3.1 ms in the WebView and 6.8 ms in Chrome.
- **Storage:** OPFS `createSyncAccessHandle` works in a worker (1 MiB
  write+flush 2–3.4 ms). Quota estimate is 10 GiB. `navigator.storage.persist()`
  returned false.
- **Driving the probe:** the Even app's screen can be captured over adb, but
  its WebView isn't remotely debuggable (no `webview_devtools_remote` socket).
  So mode A was driven with `adb shell input` taps.
