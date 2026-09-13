# Phase 0 probe

Throwaway Even Hub app that runs the plan.md §13 Phase 0 feasibility spikes on
real hardware and uploads JSON reports to `results/` on the laptop. It is not the
MVP app.

- How to run it on a phone and G2: [docs/phase0/RUNBOOK.md](../../docs/phase0/RUNBOOK.md)
- Tickets: epic `irl-subt-0i6` (`bw show irl-subt-0i6`)

| Path | What |
| --- | --- |
| `src/spikes/` | Framework-free spike logic (capabilities, capture, storage, secrets, Soniox, WebGPU benchmarks) |
| `src/panels/` | SolidJS 2 panels, one per spike |
| `src/models/registry.json` | Benchmark registry: every plan.md §6.1 catalog option, its ONNX source, and static dims |
| `scripts/models.py` | `pnpm models fetch\|inspect\|fixtures --all`: downloads, graph metadata, CPU reference fixtures |
| `vite.config.ts` | COOP/COEP headers, `/__probe` report sink, `/models` file serving |
| `results/` | Reports uploaded from devices (`recordings/` and model files are gitignored) |
| `results/archive/` | Superseded runs (desktop development results from 2026-09-13), kept for reference |

```sh
pnpm dev          # sideload server (cross-origin isolated); pnpm dev:no-coi for the unisolated variant
pnpm certs        # once: mkcert certificate for localhost + LAN IPs (phones must trust its root CA)
pnpm dev:https    # same server over HTTPS, for phone Chrome/Safari (WebGPU needs a secure context)
pnpm qr           # QR code for the Even app
pnpm ehpk         # packaged build for private upload
pnpm test         # unit tests for the framework-free logic
```
