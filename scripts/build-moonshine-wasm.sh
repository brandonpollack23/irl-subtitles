#!/bin/bash
# Rebuilds vendor/moonshine-wasm: Moonshine Voice's WASM binding as the single-thread SIMD variant (no
# SharedArrayBuffer needed). See vendor/moonshine-wasm/README.md.
set -eo pipefail
COMMIT=234f60faa0eb388b01cdf7e60aca232af37aefda
REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
B=${IRL_MOONSHINE_BUILD:-$HOME/.cache/irl-moonshine-build}
mkdir -p "$B"
cd "$B"
[ -d moonshine ] || git clone https://github.com/moonshine-ai/moonshine.git
git -C moonshine fetch --depth 1 origin "$COMMIT" && git -C moonshine checkout -q "$COMMIT"
[ -d emsdk ] || git clone --depth 1 https://github.com/emscripten-core/emsdk.git
(cd emsdk && ./emsdk install 4.0.8 && ./emsdk activate 4.0.8)
[ -d venv ] || python3 -m venv venv
venv/bin/pip install -q flatbuffers numpy
# shellcheck disable=SC1091
source "$B/emsdk/emsdk_env.sh"
export PATH="$B/venv/bin:$PATH" EMSDK="$B/emsdk" MOONSHINE_ORT_ROOT="$B/ort"
cd moonshine
# Only the single-thread ORT archive is needed; upstream builds the threaded one first.
sed -i 's#^build_variant simd-threaded#[ -n "${SKIP_THREADED:-}" ] || build_variant simd-threaded#' scripts/build-ort-wasm.sh
SKIP_THREADED=1 scripts/build-wasm.sh single-thread
D=language-bindings/wasm/dist
OUT="$REPO_ROOT/vendor/moonshine-wasm/dist"
for f in module transcriber stream enums errors events types asset-downloader; do cp "$D/$f.js" "$D/$f.d.ts" "$OUT/"; done
cp "$D/moonshine.mjs" "$D/moonshine.wasm" "$OUT/"
echo "vendored into $OUT"
