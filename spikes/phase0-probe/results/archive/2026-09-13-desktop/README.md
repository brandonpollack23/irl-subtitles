# Desktop results, 2026-09-13 (not device evidence)

Reports from building and debugging the probe in desktop Chrome 153 (Linux,
NVIDIA RTX 40-series), served from localhost. None of them are from a phone or
the Even app, so they don't count toward any Phase 0 pass/fail decision.

- `models/` before 12:47Z uses the retired WebNN harness (`webnn-*` EPs,
  `webnnCoverage`). WebNN wasn't available outside the Chrome flag, and the last
  defaults matrix hung creating Silero sessions (10-minute timeouts). This is
  why local inference switched to WebGPU (irl-subt-0i6.18).
- `capabilities/2026-09-13T12-47-35-955Z.json` is the first WebGPU inventory:
  known-answer ok in page and worker, no `shader-f16` on this adapter.
- The WebGPU-era desktop benchmark numbers (run from devtools, not saved as
  reports) are recorded on irl-subt-0i6.3.1.1, 0i6.3.2, 0i6.3.4, and 0i6.3.9.

Device runs write to `results/<spike>/` again, starting empty.
