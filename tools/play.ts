import { Rom } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { PPU } from '../src/core/ppu.ts';
import { writePng, outDir } from './png.ts';
import { cleanImage } from './fixture.ts';
const rom = new Rom(cleanImage());
const e = new LevelEmulator(rom); e.boot();
const n = parseInt(process.argv[2] ?? '105', 16);
e.load(n);
const ppu = new PPU(e.snes); e.snes.ppu = ppu;
const out = outDir();
const t0 = Date.now();
for (let f = 0; f < 200; f++) { e.snes.joy1 = f > 60 ? 0x0100 | (f % 40 < 10 ? 0x8000 : 0) : 0; e.snes.runFrame(); if (out && (f === 40 || f === 199)) writePng(`${out}/play${f}.png`, 256, 224, ppu.frame); }
console.log('ms per frame', (Date.now() - t0) / 200, 'gm', e.snes.wram[0x100].toString(16));
