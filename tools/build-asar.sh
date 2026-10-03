#!/bin/sh
# Builds Asar (https://github.com/RPGHacker/asar, LGPL-3.0) as WebAssembly into src/vendor/asar/.
# Needs Emscripten (emcc/em++ on PATH or in /usr/lib/emscripten) and git.
set -e
ASAR_TAG=v1.91
ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=${ASAR_WORK:-$ROOT/node_modules/.cache/asar-src}
OUT=$ROOT/src/vendor/asar
command -v em++ >/dev/null 2>&1 || PATH=/usr/lib/emscripten:$PATH

if [ ! -d "$WORK/.git" ]; then
  mkdir -p "$(dirname "$WORK")"
  git clone -q --depth 1 --branch $ASAR_TAG https://github.com/RPGHacker/asar "$WORK"
fi
# local fixes (idempotent): include paths resolved like the OS does (repeated slashes, several ".." in a row)
git -C "$WORK" apply --check "$ROOT/tools/asar-wasm/normalize-paths.patch" 2>/dev/null && git -C "$WORK" apply "$ROOT/tools/asar-wasm/normalize-paths.patch"
S=$WORK/src/asar
mkdir -p "$OUT"
em++ -O2 -std=c++14 -fexceptions -Dlinux -Dstricmp=strcasecmp -DASAR_SHARED -I"$S" \
  -Wno-varargs -Wno-unused-result \
  "$S/addr2line.cpp" "$S/arch-65816.cpp" "$S/arch-spc700.cpp" "$S/arch-superfx.cpp" \
  "$S/assembleblock.cpp" "$S/crc32.cpp" "$S/libcon.cpp" "$S/libsmw.cpp" "$S/libstr.cpp" \
  "$S/macro.cpp" "$S/main.cpp" "$S/asar_math.cpp" "$S/virtualfile.cpp" "$S/warnings.cpp" \
  "$S/errors.cpp" "$S/platform/file-helpers.cpp" "$S/platform/linux/file-helpers-linux.cpp" \
  "$S/interface-lib.cpp" "$ROOT/tools/asar-wasm/wrapper.cpp" \
  -sMODULARIZE -sEXPORT_ES6 -sEXPORT_NAME=createAsar -sENVIRONMENT=web,worker,node \
  -sALLOW_MEMORY_GROWTH -sINITIAL_MEMORY=33554432 -sSTACK_SIZE=8388608 -sFILESYSTEM=1 \
  -sEXPORTED_FUNCTIONS=_smwe_patch,_smwe_version,_malloc,_free \
  -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAP32,UTF8ToString,stringToNewUTF8 \
  -o "$OUT/asar.mjs"
cp "$WORK/LICENSE"* "$OUT/" 2>/dev/null || true
echo "Asar $ASAR_TAG -> $OUT"
