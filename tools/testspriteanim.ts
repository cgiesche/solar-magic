// Sprite animation in the editor (src/core/spritegfx.ts): walking enemies captured with several
// images, every image on the sprite's spot (no walking away or falling out of view, although the
// sprite moves in the game). Usage: node tools/testspriteanim.ts
import { readFileSync } from 'node:fs';
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { loadLevel } from '../src/core/level.ts';
import { captureSprites } from '../src/core/spritegfx.ts';

const rom = new Rom(new Uint8Array(readFileSync('Super Mario World (U) [!].smc')));
const emu = new LevelEmulator(rom);
emu.boot();
let bad = 0;
const fail = (msg: string) => { bad++; console.log('FAIL', msg); };
const lv = loadLevel(rom, 0x105);
const bg = lv.layer2Pointer >> 16 === 0xff ? lv.layer2Pointer : 0xffd900;
const nums = [0x04, 0x05, 0x08, 0x0f, 0x11, 0x1a];
const t0 = Date.now();
const res = captureSprites(emu, lv.number, lv.header, lv.spriteHeader, bg, nums);
console.log(`${Date.now() - t0}ms`);
for (const n of nums) {
  const img = res.get(n);
  if (!img) { fail(`${n.toString(16)}: no image`); continue; }
  const a = img.anim;
  const total = a ? a.seq.reduce((t, [, d]) => t + d, 0) : 0;
  console.log(`${n.toString(16).padStart(2, '0')}: ${a ? `${a.imgs.length} images, ${a.seq.length} steps, ${total} frames` : 'still'}`);
  if (!a) { if (n !== 0x1a) fail(`${n.toString(16)}: not animated`); continue; }
  const mx = img.ox + img.w / 2, my = img.oy + img.h / 2;
  for (const f of a.imgs) {
    const dx = f.ox + f.w / 2 - mx, dy = f.oy + f.h / 2 - my;
    if (Math.abs(dx) > 8 || Math.abs(dy) > 8) fail(`${n.toString(16)}: image moved by ${dx},${dy}`);
  }
}
console.log('bad', bad);
if (bad) process.exitCode = 1;
