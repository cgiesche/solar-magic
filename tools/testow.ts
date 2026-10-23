import { readFileSync } from 'node:fs';
import { Rom } from '../src/core/rom.ts';
import { readL2, writeL2, readL1, OverworldEmulator, l2Index, l1Index, scanTranslevels, levelName, translevelToLevel } from '../src/core/overworld.ts';
import { TileCache } from '../src/core/render.ts';
import { writePng } from './png.ts';
const rom = new Rom(new Uint8Array(readFileSync('test/fixtures/smw.smc')));
const l2 = readL2(rom);
const copy = new Rom(rom.output(false));
const size = writeL2(copy, l2);
const l2b = readL2(copy);
console.log('L2 roundtrip', l2.every((v, i) => v === l2b[i]), 'compressed', size, 'orig approx', 0x04cb56 - 0x04a533);
const emu = new OverworldEmulator(rom);
const t0 = Date.now();
const r = emu.load(0, true);
console.log('ow load ms', Date.now() - t0, r.ok);
// render L2 from data
const tc = new TileCache(r.vram, r.cgram, 0);
const W = 512;
const img = new Uint32Array(W * W).fill(0xff000000);
for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
  const e = l2[l2Index(0, x, y)];
  const t = tc.get(e);
  for (let yy = 0; yy < 8; yy++) for (let xx = 0; xx < 8; xx++) if (t[yy * 8 + xx]) img[(y * 8 + yy) * W + x * 8 + xx] = t[yy * 8 + xx];
}
// L1 with events from wram
const w = r.wram;
const rd = (a: number) => rom.r16(a);
for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
  const tile = w[0xc800 + l1Index(0, x, y)];
  const p = w[0x0fbe + tile * 2] | (w[0x0fbf + tile * 2] << 8);
  const words = [0, 1, 2, 3].map((q) => rd(0x050000 | (p + q * 2)));
  const pos = [[0, 0], [0, 8], [8, 0], [8, 8]];
  for (let q = 0; q < 4; q++) { const t = tc.get(words[q]); for (let yy = 0; yy < 8; yy++) for (let xx = 0; xx < 8; xx++) if (t[yy * 8 + xx]) img[(y * 16 + pos[q][1] + yy) * W + x * 16 + pos[q][0] + xx] = t[yy * 8 + xx]; }
}
writePng('/tmp/claude-1000/-home-cgiesche-sources-smw-editor-ai/624ce7dd-933c-4fab-929a-f37f123d88a8/scratchpad/owmain.png', W, W, img);
const tl = scanTranslevels(readL1(rom));
const seen: string[] = [];
for (let i = 0; i < 0x800; i++) if (tl[i]) seen.push(`${tl[i].toString(16)}=${translevelToLevel(tl[i]).toString(16)} ${levelName(rom, tl[i])}`);
console.log(seen.length, seen.slice(0, 12).join(' | '));
