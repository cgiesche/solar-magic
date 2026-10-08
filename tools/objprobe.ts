// Checks the emulated object kinds (objkinds.ts) against what the vanilla object routines do.
// usage: node tools/objprobe.ts [tileset…]   (default: one tileset per object set)
import { readFileSync } from 'node:fs';
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { loadLevel, L2_PTRS } from '../src/core/level.ts';
import { ObjKindProbe, type ObjKind } from '../src/core/objkinds.ts';

const rom = new Rom(new Uint8Array(readFileSync('test/fixtures/smw.smc')));
const emu = new LevelEmulator(rom);
emu.boot();
const base = loadLevel(rom, 0x105);

// reference, read from the routines in bank $0D; key: object set (tileset) → object → [type nibble, count]
const COMMON: Record<number, [string, number]> = { 0x0f: ['lo', 6], 0x10: ['hi', 4], 0x12: ['lo', 10], 0x13: ['lo', 15], 0x15: ['lo', 2], 0x17: ['hi', 2], 0x1e: ['lo', 2] };
const EXPECT: Record<number, Record<number, [string, number]>> = {
  0: { 0x33: ['lo', 7] /* big multi-screen object, unclear */, 0x34: ['lo', 4], 0x37: ['lo', 2], 0x3d: ['hi', 2], 0x3e: ['lo', 8], 0x3f: ['hi', 5] },
  1: { 0x36: ['lo', 2] /* low nibble 0 / not 0 */, 0x37: ['hi', 2], 0x38: ['lo', 3], 0x3d: ['lo', 4], 0x3e: ['hi', 2], 0x3f: ['lo', 3] },
  2: { 0x35: ['lo', 4], 0x36: ['hi', 2], 0x37: ['lo', 4], 0x38: ['hi', 2], 0x39: ['lo', 3], 0x3a: ['lo', 6], 0x3b: ['hi', 2] },
  3: { 0x38: ['lo', 2], 0x39: ['lo', 4], 0x3c: ['hi', 2], 0x3e: ['lo', 4] },
  4: { 0x37: ['hi', 3], 0x39: ['lo', 3], 0x3a: ['lo', 4] },
};
const f = (k: ObjKind | undefined) => (!k ? 'plain' : k.type ? `${k.type}×${k.count}` : `lo=${k.lo} hi=${k.hi}`);
let bad = 0;
for (const ts of process.argv.length > 2 ? process.argv.slice(2).map(Number) : [0, 1, 2, 3, 4]) {
  const t0 = Date.now();
  const lv = { ...base, header: { ...base.header, tileset: ts } };
  const { kinds } = new ObjKindProbe(emu, lv, rom.r24(L2_PTRS + 0x105 * 3)).result();
  const exp = { ...COMMON, ...(EXPECT[ts] ?? {}) };
  const lines: string[] = [];
  for (let n = 1; n < 0x40; n++) {
    const k = kinds.get(n), e = exp[n];
    const got = f(k), want = e ? `${e[0]}×${e[1]}` : null;
    const wrong = want ? got !== want : !!k?.type;
    if (wrong) bad++;
    if (k || e) lines.push(`  ${n.toString(16).padStart(2, '0')}: ${got}${wrong ? `   ≠ ${want ?? 'no type'}` : ''}`);
  }
  console.log(`tileset ${ts} (${Date.now() - t0} ms)\n${lines.join('\n')}`);
}
console.log('mismatches', bad);
if (bad) process.exitCode = 1;
