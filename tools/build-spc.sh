#!/bin/sh
# Builds snes_spc 0.9.0 (SPC700 + S-DSP emulator by Shay Green "blargg", LGPL-2.1) as WebAssembly
# into src/vendor/spc/. Source: the unmodified 0.9.0 release as kept by blarggs-audio-libraries
# (commit ec8ee2b, "Initial import"). Needs Emscripten and git.
set -e
SPC_REPO=https://github.com/blarggs-audio-libraries/snes_spc
SPC_COMMIT=ec8ee2b
ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=${SPC_WORK:-$ROOT/node_modules/.cache/snes-spc-src}
OUT=$ROOT/src/vendor/spc
command -v em++ >/dev/null 2>&1 || PATH=/usr/lib/emscripten:$PATH

if [ ! -d "$WORK/.git" ]; then
  mkdir -p "$(dirname "$WORK")"
  git clone -q "$SPC_REPO" "$WORK"
fi
git -C "$WORK" checkout -q $SPC_COMMIT
S=$WORK/snes_spc
mkdir -p "$OUT"
# the accurate DSP (snes_spc/SPC_DSP.cpp, needed for save states) and the output filter
em++ -O3 -std=c++14 -fno-exceptions -I"$S" -DNDEBUG -Wno-shift-negative-value \
  "$S/SNES_SPC.cpp" "$S/SNES_SPC_misc.cpp" "$S/SNES_SPC_state.cpp" "$S/SPC_DSP.cpp" "$S/SPC_Filter.cpp" \
  "$ROOT/tools/spc-wasm/wrapper.cpp" \
  -sMODULARIZE -sEXPORT_ES6 -sEXPORT_NAME=createSpc -sENVIRONMENT=web,worker,node \
  -sALLOW_MEMORY_GROWTH -sSINGLE_FILE=0 -sFILESYSTEM=0 \
  -sEXPORTED_FUNCTIONS=_malloc,_free \
  -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAP16 \
  -o "$OUT/spc.mjs"
cp "$WORK/license.txt" "$OUT/LICENSE.txt"
echo "snes_spc 0.9.0 -> $OUT"
