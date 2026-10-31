import { readFileSync } from 'node:fs';
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator, OV_L1, OV_L2 } from '../src/core/levelemu.ts';
import { loadLevel, serializeLayer1, serializeLayer2, serializeSprites, isL1Vertical } from '../src/core/level.ts';
import { renderLevel, composite } from '../src/core/render.ts';
import { writePng, outDir } from './png.ts';
import { editorImage } from './fixture.ts';

const rom = new Rom(await editorImage());
const emu = new LevelEmulator(rom);
let t0 = Date.now();
emu.boot();
console.log('boot ms', Date.now() - t0);
const out = outDir();
const list = process.argv[2] ? process.argv[2].split(',').map((s) => parseInt(s, 16)) : [...Array(0x25).keys(), ...Array.from({ length: 0x3c }, (_, i) => 0x101 + i)];
let bad = 0;
for (const n of list) {
  const lv = loadLevel(rom, n);
  t0 = Date.now();
  const a = emu.load(n);
  const ta = Date.now() - t0;
  const l1 = serializeLayer1(rom, lv), l2 = serializeLayer2(rom, lv);
  const byteOwner = new Int32Array(0x10000).fill(-1);
  const b = emu.load(n, { layer1: l1, layer2: l2 ?? undefined, sprites: serializeSprites(lv.sprites, lv.spriteHeader, isL1Vertical(rom, lv.header.mode)), byteOwner });
  let diff = 0;
  for (let i = 0xc800; i < 0x10000; i++) if (a.wram[i] !== b.wram[i] || a.wram[i + 0x10000] !== b.wram[i + 0x10000]) diff++;
  let sprDiff = 0; // compare sprite load status later
  const status = `${n.toString(16).padStart(3, '0')} mode=${lv.header.mode.toString(16)} ts=${lv.header.tileset} scr=${lv.header.screens} objs=${lv.objects.length} l2=${lv.layer2Objects?.length ?? '-'} exits=${lv.exits.length} spr=${lv.sprites.length} ok=${a.ok}/${b.ok} frames=${a.frames} ${ta}ms diff=${diff}${a.error ? ' ' + a.error : ''}`;
  if (diff || !a.ok || !b.ok) bad++;
  console.log(status);
  if (out) {
    const li = renderLevel(rom, a, lv.header.mode, lv.header.screens);
    writePng(`${out}/l${n.toString(16).padStart(3, '0')}.png`, li.width, li.height, composite(li));
  }
}
console.log('bad', bad);
if (bad) process.exitCode = 1;
