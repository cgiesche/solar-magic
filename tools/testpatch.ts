import { readFileSync } from 'node:fs';
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { loadLevel, serializeLayer1, newUid } from '../src/core/level.ts';
import { installEditorPatch, setGfxEntry, setLevelGfx, DM16_EXT } from '../src/core/patches.ts';
import { saveLevel } from '../src/core/save.ts';

const orig = new Rom(new Uint8Array(readFileSync('test/fixtures/smw.smc')));
const rom = new Rom(new Uint8Array(readFileSync('test/fixtures/smw.smc')));
const p = installEditorPatch(rom);
console.log('patch at', p.base.toString(16), 'rom size', rom.size.toString(16));
const e0 = new LevelEmulator(orig); e0.boot();
const e1 = new LevelEmulator(rom); e1.boot();
const levels = [...Array(0x25).keys(), ...Array.from({ length: 0x3b }, (_, i) => 0x101 + i)];
let bad = 0;
for (const n of levels) {
  const a = e0.load(n), b = e1.load(n);
  let d = 0, dv = 0, dc = 0;
  for (let i = 0xc800; i < 0x10000; i++) if (a.wram[i] !== b.wram[i] || a.wram[i + 0x10000] !== b.wram[i + 0x10000]) d++;
  for (let i = 0; i < 0x10000; i++) if (a.vram[i] !== b.vram[i]) dv++;
  for (let i = 0; i < 0x200; i++) if (a.cgram[i] !== b.cgram[i]) dc++;
  if (d || dc || !b.ok) { bad++; console.log('level', n.toString(16), 'map', d, 'vram', dv, 'cgram', dc, b.error ?? ''); }
  else if (dv) console.log('  (level', n.toString(16), 'vram differs in', dv, 'bytes – animation timing)');
}
console.log('patched vs vanilla: bad', bad);
if (bad) process.exitCode = 1;
// DM16
const lv = loadLevel(rom, 0x105);
lv.objects.push({ uid: newUid(), num: 0, ext: DM16_EXT, x: 30, y: 10, size: 0x23, tile: 0x130 });
const r = e1.load(0x105, { layer1: serializeLayer1(rom, lv) });
const rd = (x: number, y: number) => { const a = 0xc800 + (x >> 4) * 0x1b0 + y * 16 + (x & 15); return r.wram[a] | (r.wram[a + 0x10000] << 8); };
let s = ''; for (let y = 9; y < 14; y++) { for (let x = 29; x < 35; x++) s += rd(x, y).toString(16).padStart(3, '0') + ' '; s += '\n'; }
console.log('DM16 test (expect 130 in 4x3 at 30,10):\n' + s, r.ok, r.error ?? '');
// raw ExGFX: take VRAM FG1 (0000-0FFF) of level 105 and use as ExGFX 80 for FG1
const base = e1.load(0x105);
const raw = base.vram.slice(0, 0x1000);
const modified = raw.slice(); for (let i = 0; i < 0x200; i++) modified[i] ^= 0xff;
const addr = rom.allocWrite(modified);
setGfxEntry(rom, 0x80, addr, true);
setLevelGfx(rom, 0x105, [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x80]);
e1.syncRom();
const r2 = e1.load(0x105);
let eq = 0; for (let i = 0; i < 0x1000; i++) if (r2.vram[i] === modified[i]) eq++;
let other = 0; for (let i = 0x1000; i < 0x8000; i++) if (r2.vram[i] !== base.vram[i]) other++;
console.log('ExGFX raw: FG1 match', eq, '/4096; other diffs', other, r2.ok);
if (eq !== 4096 || other) process.exitCode = 1;
// level 106 unaffected
setLevelGfx(rom, 0x105, new Array(8).fill(0xff));
// sprite relocation: add many sprites
const lv2 = loadLevel(rom, 0x105);
for (let i = 0; i < 20; i++) lv2.sprites.push({ uid: newUid(), num: 0x0f, x: 40 + i * 3, y: 20, extra: 0 });
console.log(saveLevel(rom, lv2).join(' | '));
const lv3 = loadLevel(rom, 0x105);
console.log('reloaded sprites', lv3.sprites.length, 'addr', lv3.sprAddr.toString(16));
e1.syncRom();
const r3 = e1.load(0x105);
console.log('load after save ok', r3.ok, r3.error ?? '');
