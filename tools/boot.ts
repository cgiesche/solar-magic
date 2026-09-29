import { readFileSync } from 'node:fs';
import { Snes } from '../src/core/snes.ts';
import { disasm, hex } from '../src/core/disasm.ts';

const raw = readFileSync('Super Mario World (U) [!].smc');
const rom = new Uint8Array(raw.subarray(raw.length % 0x8000));
const snes = new Snes(rom);
snes.reset();
const t0 = Date.now();
let lastGm = -1;
const frames = Number(process.argv[2] ?? 300);
try {
  for (let f = 0; f < frames; f++) {
    snes.runFrame();
    const gm = snes.wram[0x100];
    if (gm !== lastGm) { console.log(`frame ${f} gm=${hex(gm,2)} pc=${hex(snes.cpu.pbr,2)}:${hex(snes.cpu.pc,4)}`); lastGm = gm; }
  }
} catch (e) {
  console.log('error', e, hex(snes.cpu.pbr,2), hex(snes.cpu.pc,4));
}
console.log('ms', Date.now() - t0, 'cycles', snes.cpu.cycles);
const c = snes.cpu;
for (let i = 0, a = (c.pbr << 16) | c.pc; i < 8; i++) {
  const d = disasm((x) => snes.read(x), a, c.m8, c.x8);
  console.log(hex(a, 6), d.text); a += d.length;
}
