import { readFileSync } from 'node:fs';
import { Snes } from '../src/core/snes.ts';
import { hex } from '../src/core/disasm.ts';
import { cgramToRGBA, decodeTile } from '../src/core/gfx.ts';
import { writePng } from './png.ts';
const raw = readFileSync('Super Mario World (U) [!].smc');
const rom = new Uint8Array(raw.subarray(raw.length % 0x8000));
const snes = new Snes(rom); snes.reset();
while (snes.wram[0x100] !== 0x07) snes.runFrame();
const w = snes.wram;
let n = 0; const seen = new Set<number>();
while (w[0x100] !== 0x0e && n < 1500) {
  if (w[0x100] === 0x0b || w[0x100] === 0x0c) w[0x109] = 0;
  snes.joy1 = (n % 16) < 4 ? (w[0x100] === 0x07 ? 0x1000 : 0x0080) : 0;
  snes.runFrame(); n++;
  if (!seen.has(w[0x100])) { seen.add(w[0x100]); console.log('frame', n, 'gm', hex(w[0x100], 2)); }
}
snes.joy1 = 0;
for (let i = 0; i < 5; i++) snes.runFrame();
console.log('gm', hex(w[0x100], 2), 'bgmode', hex(snes.ppuRegs[5], 2), 'bg1sc', hex(snes.ppuRegs[7], 2), 'bg2sc', hex(snes.ppuRegs[8], 2), 'bg3sc', hex(snes.ppuRegs[9], 2), 'nba', hex(snes.ppuRegs[0xb], 2), hex(snes.ppuRegs[0xc], 2), 'submap', w[0x1f11]);
const pal = cgramToRGBA(snes.cgram);
function renderBg(sc: number, charBase: number, bpp: number, file: string) {
  const size = sc & 3; const W = size & 1 ? 64 : 32, H = size & 2 ? 64 : 32;
  const img = new Uint32Array(W * 8 * H * 8).fill(pal[0]);
  const base = (sc & 0xfc) << 9; const tile = new Uint8Array(64);
  for (let ty = 0; ty < H; ty++) for (let tx = 0; tx < W; tx++) {
    const scr = (tx >> 5) + (ty >> 5) * (W / 32);
    const a = base + scr * 0x800 + ((ty & 31) * 32 + (tx & 31)) * 2;
    const e = snes.vram[a] | (snes.vram[a + 1] << 8);
    decodeTile(snes.vram, (charBase + (e & 0x3ff) * bpp * 8) & 0xffff, bpp, tile);
    const p = (e >> 10) & 7;
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      const c = tile[((e & 0x8000) ? 7 - y : y) * 8 + ((e & 0x4000) ? 7 - x : x)];
      if (c) img[(ty * 8 + y) * W * 8 + tx * 8 + x] = pal[(bpp === 2 ? p * 4 : p * 16) + c];
    }
  }
  writePng(file, W * 8, H * 8, img);
}
const S = '/tmp/claude-1000/-home-cgiesche-sources-smw-editor-ai/624ce7dd-933c-4fab-929a-f37f123d88a8/scratchpad/';
renderBg(snes.ppuRegs[7], (snes.ppuRegs[0xb] & 15) << 13, 4, S + 'ow1.png');
renderBg(snes.ppuRegs[8], (snes.ppuRegs[0xb] >> 4) << 13, 4, S + 'ow2.png');
let s1 = '', s2 = '';
for (let i = 0; i < 16; i++) { s1 += hex(w[0x14000 + 0x800 + i * 2] | (w[0x14001 + 0x800 + i * 2] << 8), 4) + ' '; s2 += hex(snes.vram[0x6000 + 0x800 + i * 2] | (snes.vram[0x6001 + 0x800 + i * 2] << 8), 4) + ' '; }
console.log('7F4800', s1); console.log('vram', s2);
