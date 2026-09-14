# @irl/moonshine-wasm

The speech-to-text part of [Moonshine Voice's WebAssembly binding](https://github.com/moonshine-ai/moonshine/tree/main/language-bindings/wasm)
(`@moonshine-ai/moonshine-wasm` 0.1.5, MIT), built from commit
`234f60faa0eb388b01cdf7e60aca232af37aefda` as the **single-thread SIMD** variant.

The published npm build uses pthreads, which need `SharedArrayBuffer` and a cross-origin
isolated page. The Even simulator (WebKitGTK) has no `SharedArrayBuffer` and the packaged
Even app isn't isolated, so the app ships this build instead (irl-subt-kdl.7).

Only the files the live STT worker imports are kept (`transcriber`, `stream`, `module`,
`enums`, `errors`, `events`, `types`, `asset-downloader`, plus `moonshine.mjs` and
`moonshine.wasm`). The WASM embeds ONNX Runtime 1.23.2 as a minimal build restricted to
Moonshine's operators, so models must be `.ort` files; they are pinned in the app's model
catalog, not downloaded from the Moonshine CDN at runtime.

Rebuild: `scripts/build-moonshine-wasm.sh` (needs git, cmake, ninja, python3; installs
emsdk 4.0.8 and builds ORT under `~/.cache/irl-moonshine-build`, about 10 minutes).
