// What Lunar Magic's overworld ExAnimation does with the manual frames 8-F at the overworld's load (#261,
// docs/research/lunar-magic-submap-graphics.md, "Event Manual 8-F at the load"): on the overworld they hold the
// events of triggers 01-08 ("Event Manual 8-F"). A ROM Lunar Magic saved is booted into a new game, then, as if a
// level had left them so, every manual frame 0-F is set to $A0+n and the overworld loaded again (on each submap);
// prints the overworld lists' Trigger Init, the manual frames after the reset and a new game, what the manual frames hold after the load, and the code that wrote
// them. With "set": each list (an empty one where a submap has none) first gets a Trigger Init of Manual 8 = 01
// only, as Lunar Magic saves one, so its code runs the init on a list that sets some of 8-F and not the others.
// node tools/lmowmanual.ts <rom> [set]   (e.g. "resources_local/Journey to Kaizo v1.1 (LM rom).smc")
import { readFileSync } from 'node:fs';
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { RAM, GM, EXTRIGGER_RAM } from '../src/core/ram.ts';
import { readOwGlobalList, readSubmapList, writeSubmapList, owExanimLayout, emptyList, SUBMAP_LISTS } from '../src/core/exanim.ts';
import { Apu, loadApu } from '../src/core/apu.ts';

const [file, set] = process.argv.slice(2);
const raw = readFileSync(file);
const rom = new Rom(new Uint8Array(raw.subarray(raw.length % 0x8000)));
const hex = (n: number, d = 2) => n.toString(16).toUpperCase().padStart(d, '0');
const init = (l: ReturnType<typeof readOwGlobalList>) => !l ? 'no list' : l.manual.size ? [...l.manual].map(([n, f]) => `Manual ${hex(n, 1)} = ${hex(f)}`).join(', ') : 'no manual frames set';
if (!owExanimLayout(rom)) { console.log(`${file}: no overworld ExAnimation`); process.exit(0); }
if (set === 'set') for (let k = 0; k < SUBMAP_LISTS; k++) {
  const l = readSubmapList(rom, k) ?? emptyList();
  l.manual = new Map([[8, 0x01]]);
  writeSubmapList(rom, k, l);
}
console.log(`${file}\n  global list: ${init(readOwGlobalList(rom))}`);
for (let k = 0; k < SUBMAP_LISTS; k++) console.log(`  submap ${k}: ${init(readSubmapList(rom, k))}`);

const emu = new LevelEmulator(rom);
const s = emu.snes, w = s.wram;
await loadApu();
s.apu = new Apu(); // the sound unit itself: custom music engines wait for it at the boot
const M = EXTRIGGER_RAM.manual - 0x7e0000;
const writes = new Map<number, Set<number>>();
s.hook = { onWramWrite: (a) => { if (a >= M && a < M + 16) { const p = writes.get(a - M) ?? new Set(); p.add(s.cpu.opPc); writes.set(a - M, p); } } };
emu.boot();
emu.startGame(0);
for (let f = 0; f < 60; f++) s.runFrame();
console.log(`  a new game: manual 0-F ${Array.from({ length: 16 }, (_, n) => hex(w[M + n])).join(' ')}`);
for (let k = 0; k < SUBMAP_LISTS; k++) {
  writes.clear();
  for (let n = 0; n < 16; n++) w[M + n] = 0xa0 + n;
  w[RAM.submap] = w[RAM.submap + 1] = k;
  w[RAM.gameMode] = GM.overworldLoad;
  for (let f = 0; w[RAM.gameMode] !== GM.overworld && f < 500; f++) s.runFrame();
  for (let f = 0; f < 30; f++) s.runFrame();
  const by = [...writes].sort((a, b) => a[0] - b[0]).map(([n, p]) => `${hex(n, 1)} by ${[...p].map((x) => hex(x, 6)).join(' ')}`);
  console.log(`  loaded on submap ${k}: manual 0-F ${Array.from({ length: 16 }, (_, n) => hex(w[M + n])).join(' ')}; written: ${by.join(', ') || 'none'}`);
}
