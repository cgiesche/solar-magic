// Event progress (overworld.ts): the overworld shown with the events 0 … n-1 passed – layer 1 and layer 2 – is the
// game's after loading a save in which they passed – a save file written into SRAM as the game checks it (the test's independent knowledge:
// file A's 0x8D bytes of $1EA2–$1F2E summing with the word after them to $5A5A, $009DC6; the event bits at
// $1F02 as the game sets them, mask $80 >> e%8 of byte e/8, $04E44B), chosen on the file select screen.
import { Rom } from '../src/core/rom.ts';
import { Snes } from '../src/core/snes.ts';
import { OverworldEmulator, eventBits, gameL1, gameL2, OW_EVENTS, type OwRender } from '../src/core/overworld.ts';
import { GM, RAM } from '../src/core/ram.ts';
import { cleanImage, editorImage } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const same = (a: ArrayLike<number>, b: ArrayLike<number>) => a.length === b.length && Array.from(a).every((v, i) => v === b[i]);
const hx = (v: number) => v.toString(16).toUpperCase().padStart(2, '0');

// the overworld after loading save file A with events 0 … n-1 passed, Mario on submap `map`
function fromSave(rom: Rom, n: number, map: number): OwRender {
  const s = new Snes(rom.data), w = s.wram;
  s.reset();
  for (let f = 0; w[RAM.gameMode] !== GM.title && f < 2000; f++) s.runFrame();
  const file = new Uint8Array(0x8d), events = RAM.owEvents - RAM.levelFlags; // the file starts with $1EA2
  for (let e = 0; e < n; e++) file[events + (e >> 3)] |= 0x80 >> (e & 7);
  file[RAM.submap - RAM.levelFlags] = map;
  const sum = (0x5a5a - file.reduce((a, v) => a + v, 0)) & 0xffff;
  s.sram.set(file, 0);
  s.sram[0x8d] = sum & 0xff; s.sram[0x8e] = sum >> 8;
  for (let f = 0; w[RAM.gameMode] !== GM.overworld && f < 1500; f++) {
    s.joy1 = (f % 16) < 4 ? (w[RAM.gameMode] === GM.title ? 0x1000 : 0x0080) : 0;
    s.runFrame();
  }
  s.joy1 = 0;
  for (let i = 0; i < 3; i++) s.runFrame();
  check(w[RAM.gameMode] === GM.overworld && same(w.subarray(RAM.owEvents, RAM.owEvents + 15), file.subarray(events, events + 15)),
    `save file with events 00–${hx(n)} (excl.) loaded`);
  return { vram: s.vram.slice(), cgram: s.cgram.slice(), wram: w.slice(), ppuRegs: s.ppuRegs.slice(), ok: true };
}

// ---- the event bits ----
check(same(eventBits(0), new Uint8Array(15)) && same(eventBits(OW_EVENTS), new Uint8Array(15).fill(0xff)), 'no event, every event');
check(same(eventBits(10).subarray(0, 3), [0xff, 0xc0, 0]), 'events 00–09: byte 0, bits 7–6 of byte 1');

// ---- the shown overworld is the game's after loading such a save ----
for (const [name, rom, progress] of [
  ['clean game', new Rom(cleanImage()), [0, 2, 6, 0x0c, 0x20, 0x45, OW_EVENTS]],
  ['with the editor patches', new Rom(await editorImage()), [0, 0x20, OW_EVENTS]],
] as [string, Rom, number[]][]) {
  const emu = new OverworldEmulator(rom), shown = new Map<number, Uint16Array>();
  for (const map of [0, 1]) for (const n of progress) {
    const r = emu.load(map, n), save = fromSave(rom, n, map), l1 = gameL1(r).slice();
    if (map === 0) shown.set(n, l1);
    check(r.ok && same(l1, gameL1(save)) && same(gameL2(r), gameL2(save)), `${name}, map ${map}: event progress ${hx(n)} (of ${hx(OW_EVENTS)}) – layers 1 and 2 as after loading the save`);
  }
  // each step shows more: the map changes from none to some to all
  const steps = progress.map((n) => shown.get(n)!);
  check(steps.slice(1).every((l1, k) => !same(l1, steps[k])), `${name}: every step of the progress shows another layer 1`);
}

if (bad) { console.log(`${bad} failed`); process.exit(1); }
console.log('all ok');
