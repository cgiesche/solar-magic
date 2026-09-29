import { readFileSync } from 'node:fs';
import { Rom, pcToSnes } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
const rom = new Rom(new Uint8Array(readFileSync('Super Mario World (U) [!].smc')));
const emu = new LevelEmulator(rom); emu.boot();
const t0=Date.now();
const r = emu.load(parseInt(process.argv[2] ?? '105', 16));
console.log('ms', Date.now()-t0);
let known = 0;
for (let row = 0; row < 16; row++) {
  let s = row.toString(16) + ': ';
  for (let c = 0; c < 16; c++) { const i = (row * 16 + c) * 2; const a = r.cgramSrc[i], b = r.cgramSrc[i + 1]; if (a >= 0) known++; s += (a >= 0 ? pcToSnes(a).toString(16).slice(-5) + (b === a + 1 ? '' : '!') : '  -  ') + ' '; }
  console.log(s);
}
console.log('known', known);
