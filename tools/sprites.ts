import { readFileSync } from 'node:fs';
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { loadLevel } from '../src/core/level.ts';
import { captureSprites } from '../src/core/spritegfx.ts';
import { writePng } from './png.ts';
const rom = new Rom(new Uint8Array(readFileSync('Super Mario World (U) [!].smc')));
const emu = new LevelEmulator(rom); emu.boot();
const n = parseInt(process.argv[2] ?? '105', 16);
const lv = loadLevel(rom, n);
const t0 = Date.now();
const nums = Array.from({ length: 0xe7 }, (_, i) => i);
const m = captureSprites(emu, n, lv.header, lv.spriteHeader, lv.layer2Pointer >> 16 === 0xff ? lv.layer2Pointer : 0xffd900, nums);
console.log('ms', Date.now() - t0, 'captured', m.size, [...m.keys()].map(k=>k.toString(16)).join(' '));
const W = 16 * 48, H = Math.ceil(0xe7 / 16) * 48;
const img = new Uint32Array(W * H).fill(0xff404040);
for (const [k, s] of m) {
  const bx = (k % 16) * 48 + 16, by = Math.floor(k / 16) * 48 + 16;
  for (let y = 0; y < s.h; y++) for (let x = 0; x < s.w; x++) {
    const px = bx + s.ox + x, py = by + s.oy + y;
    if (px < 0 || py < 0 || px >= W || py >= H || !s.rgba[y * s.w + x]) continue;
    img[py * W + px] = s.rgba[y * s.w + x];
  }
}
writePng(process.env.OUT ?? '/tmp/spr.png', W, H, img);
