// End-to-end save test: modify every vanilla level, save to ROM, reload, compare emulation.
import { readFileSync } from 'node:fs';
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { loadLevel, serializeLayer1, serializeLayer2, serializeSprites, isL1Vertical, newUid } from '../src/core/level.ts';
import { saveLevel } from '../src/core/save.ts';
import { readL1, readL2, writeL1, writeL2, OverworldEmulator } from '../src/core/overworld.ts';
import { editorImage } from './fixture.ts';

const rom = new Rom(await editorImage());
const emu = new LevelEmulator(rom); emu.boot();
const levels = [...Array(0x25).keys(), ...Array.from({ length: 0x3b }, (_, i) => 0x101 + i)];
const expected = new Map<number, Uint8Array>();
let bad = 0;
for (const n of levels) {
  const lv = loadLevel(rom, n);
  // modifications: add objects and sprites (forces relocation for many)
  lv.objects.push({ uid: newUid(), num: 0x0d, ext: 0, x: 3, y: 3, size: 0x21 });
  for (let i = 0; i < 6; i++) lv.sprites.push({ uid: newUid(), num: 0x0f, x: 4 + i * 2, y: 5, extra: 0 });
  if (lv.objects.length > 3) { const o = lv.objects[1]; o.x = Math.min(o.x + 1, lv.header.screens * 16 - 1); }
  const r = emu.load(n, { layer1: serializeLayer1(rom, lv), layer2: serializeLayer2(rom, lv) ?? undefined, sprites: serializeSprites(lv.sprites, lv.spriteHeader, isL1Vertical(rom, lv.header.mode)) });
  expected.set(n, r.wram.slice(0xc800, 0x10000));
  saveLevel(rom, lv);
}
for (const n of levels) {
  const r = emu.load(n);
  const exp = expected.get(n)!;
  let d = 0; for (let i = 0; i < exp.length; i++) if (exp[i] !== r.wram[0xc800 + i]) d++;
  const lv = loadLevel(rom, n);
  if (d || !r.ok) { bad++; console.log('level', n.toString(16), 'diff', d, r.error ?? ''); }
  if (lv.sprites.length < 6) { bad++; console.log('sprites lost', n.toString(16)); }
}
if (bad) process.exitCode = 1;
console.log('levels bad:', bad, 'rom size', (rom.size / 1024) + 'KB', 'rats blocks', rom.scanRats().length);
// overworld roundtrip
const l1 = readL1(rom), l2 = readL2(rom);
l2[5] = 0x1234; l1[10] = 0x56;
writeL1(rom, l1); writeL2(rom, l2);
const l2b = readL2(rom), l1b = readL1(rom);
console.log('ow roundtrip', l2b[5] === 0x1234 && l1b[10] === 0x56);
const oe = new OverworldEmulator(rom);
console.log('ow loads', oe.load(0, false).ok);
// checksum
const out = rom.output(false);
let sum = 0; for (const b of out) sum += b; 
console.log('checksum field', (out[0x7fde] | (out[0x7fdf] << 8)).toString(16), 'complement ok', ((out[0x7fdc] | (out[0x7fdd] << 8)) ^ (out[0x7fde] | (out[0x7fdf] << 8))) === 0xffff);
