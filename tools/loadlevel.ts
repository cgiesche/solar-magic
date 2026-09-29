import { readFileSync } from 'node:fs';
import { Snes } from '../src/core/snes.ts';
import { hex } from '../src/core/disasm.ts';
import { decodeTile, cgramToRGBA } from '../src/core/gfx.ts';
import { writePng } from './png.ts';

const raw = readFileSync('Super Mario World (U) [!].smc');
const rom = new Uint8Array(raw.subarray(raw.length % 0x8000));
const snes = new Snes(rom);
snes.reset();
let f = 0;
while (snes.wram[0x100] !== 0x07) { snes.runFrame(); f++; }
console.log('title at frame', f);
const level = parseInt(process.argv[2] ?? '105', 16);
const w = snes.wram;
w[0x141a] = 1; w[0x95] = 0; w[0x97] = 0; w[0x5b] = 0; w[0x19b8] = level & 0xff; w[0x0dd6] = 0; w[0x1f11] = (level >> 8) & 1; w[0x1b93] = 0;
w[0x100] = 0x11;
const t0 = Date.now();
let n = 0;
while (w[0x100] !== 0x14 && n < 200) { snes.runFrame(); n++; }
console.log('reached gm', hex(w[0x100],2), 'after', n, 'frames', Date.now()-t0, 'ms');
console.log('level mode', hex(w[0x1925],2), 'tileset', hex(w[0x1931],2), 'screens', hex(w[0x5d],2));
let s = ''; for (let i = 0; i < 16; i++) s += hex(w[0x0fbe + i*2] | (w[0x0fbf + i*2] << 8), 4) + ' '; console.log('map16 ptrs', s);
// render level map (horizontal): 
const scr = w[0x5d] || 32;
const W = scr * 256, H = 27 * 16;
const pal = cgramToRGBA(snes.cgram);
const img = new Uint32Array(W * H).fill(pal[0]);
const tile = new Uint8Array(64);
function draw8(t: number, px: number, py: number) {
  const num = t & 0x3ff, p = (t >> 10) & 7, xf = t & 0x4000, yf = t & 0x8000;
  decodeTile(snes.vram, num * 32, 4, tile);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const c = tile[(yf ? 7 - y : y) * 8 + (xf ? 7 - x : x)];
    if (c) img[(py + y) * W + px + x] = pal[p * 16 + c];
  }
}
for (let sc = 0; sc < scr; sc++) for (let y = 0; y < 27; y++) for (let x = 0; x < 16; x++) {
  const i = sc * 0x1b0 + y * 16 + x;
  const t16 = w[0xc800 + i] | (w[0x1c800 + i] << 8);
  const ptr = w[0x0fbe + t16 * 2] | (w[0x0fbf + t16 * 2] << 8);
  const base = (0x0d << 15) | (ptr & 0x7fff);
  const rd = (k: number) => rom[base + k * 2] | (rom[base + k * 2 + 1] << 8);
  const px = sc * 256 + x * 16, py = y * 16;
  draw8(rd(0), px, py); draw8(rd(1), px, py + 8); draw8(rd(2), px + 8, py); draw8(rd(3), px + 8, py + 8);
}
writePng(process.argv[3] ?? '/tmp/claude-1000/level.png', W, H, img);
