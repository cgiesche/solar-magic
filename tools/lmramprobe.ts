// Which bytes of Lunar Magic's RAM block at $7FC000-$7FC0FF a ROM's code reads and writes (#265,
// docs/research/lunar-magic-submap-graphics.md, "$7FC00B"): the ROM booted to the title screen (its demo level),
// a new game to the overworld, each submap loaded and run, then levels loaded and played for a while (right held,
// jumping now and then). Prints each byte touched, with the code addresses that read (r) and wrote (w) it, and
// the bytes nothing touched.
// node tools/lmramprobe.ts <rom> [levels, hex, e.g. 0-1ff; default: all] [frames per level, default 120]
import { readFileSync } from 'node:fs';
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { RAM, GM, LM_RAM_BLOCK } from '../src/core/ram.ts';
import { Apu, loadApu } from '../src/core/apu.ts';

const [file, range = '0-1ff', framesArg = '120'] = process.argv.slice(2);
const [lo, hi] = range.split('-').map((h) => parseInt(h, 16));
const frames = Number(framesArg);
const raw = readFileSync(file);
const rom = new Rom(new Uint8Array(raw.subarray(raw.length % 0x8000)));
const emu = new LevelEmulator(rom);
const s = emu.snes;
await loadApu();
s.apu = new Apu(); // the sound unit itself: custom music engines wait for it at the boot
const [BASE, SIZE] = [LM_RAM_BLOCK[0] - 0x7e0000, LM_RAM_BLOCK[1]]; // as a WRAM offset
const reads = Array.from({ length: SIZE }, () => new Set<number>());
const writes = Array.from({ length: SIZE }, () => new Set<number>());
s.hook = {
  onWramRead: (a) => { if (a >= BASE && a < BASE + SIZE) reads[a - BASE].add(s.cpu.opPc); },
  onWramWrite: (a) => { if (a >= BASE && a < BASE + SIZE) writes[a - BASE].add(s.cpu.opPc); },
};
const w = s.wram;
let failed = 0;
const run = (n: number, pad = 0) => { for (let f = 0; f < n; f++) { s.joy1 = pad && (f % 40 < 10) ? pad | 0x8000 : pad; s.runFrame(); } s.joy1 = 0; };

emu.boot();
let overworld = true;
try { emu.startGame(0); } catch { overworld = false; }
if (overworld) {
  run(120);
  for (let k = 1; k <= 6; k++) {
    w[RAM.submap] = w[RAM.submap + 1] = k;
    w[RAM.gameMode] = GM.overworldLoad;
    for (let f = 0; w[RAM.gameMode] !== GM.overworld && f < 500; f++) s.runFrame();
    run(60);
  }
}
for (let l = lo; l <= hi; l++) {
  try { emu.load(l); run(frames, 0x0100); } catch { failed++; }
}

const hex = (n: number, d: number) => n.toString(16).toUpperCase().padStart(d, '0');
const list = (set: Set<number>) => [...set].sort((a, b) => a - b).slice(0, 6).map((p) => hex(p, 6)).join(' ') + (set.size > 6 ? ` +${set.size - 6}` : '');
console.log(`${file}: ${overworld ? 'overworld and its submaps, ' : 'no overworld reached, '}levels ${hex(lo, 3)}-${hex(hi, 3)}, ${frames} frames each${failed ? `, ${failed} failed to load` : ''}`);
const at = (i: number) => `$${hex(LM_RAM_BLOCK[0] + i, 6)}`;
const used = (i: number) => reads[i].size > 0 || writes[i].size > 0;
const free: string[] = [];
for (let i = 0; i < SIZE; i++) {
  if (used(i)) { console.log(`${at(i)}  r ${list(reads[i]) || '-'}  w ${list(writes[i]) || '-'}`); continue; }
  let end = i;
  while (end + 1 < SIZE && !used(end + 1)) end++;
  free.push(end === i ? at(i) : `${at(i)}-${at(end)}`);
  i = end;
}
console.log(`untouched: ${free.join(', ') || 'none'}`);
