// Lunar Magic's overworld ExAnimation when Mario's submap changes (#253, docs/research/lunar-magic-submap-graphics.md,
// "Walking to another submap"): a ROM Lunar Magic saved, its overworld loaded on submap `from`, then $1F11 set to
// `to` for 30 frames; prints the list pointer ($7FC000–$7FC002), the list's length ($7FC00C) and the settings
// ($7FC00A) Lunar Magic set up, before and after. They stay the load submap's.
// node tools/lmowsubmap.ts <rom> <from> <to>   (e.g. "resources_local/Journey to Kaizo v1.1 (LM rom).smc" 0 5)
import { readFileSync } from 'node:fs';
import { Rom } from '../src/core/rom.ts';
import { OverworldEmulator } from '../src/core/overworld.ts';
import { RAM } from '../src/core/ram.ts';

const [file, from, to] = [process.argv[2], Number(process.argv[3] ?? 0), Number(process.argv[4] ?? 1)];
const raw = readFileSync(file);
const rom = new Rom(new Uint8Array(raw.subarray(raw.length % 0x8000)));
const emu = new OverworldEmulator(rom);
emu.load(from, 0);
const s = emu.snes, w = s.wram;
const at = (a: number) => w[a - 0x7e0000];
const state = () => `list ${[0x7fc002, 0x7fc001, 0x7fc000].map((a) => at(a).toString(16).padStart(2, '0')).join('')}, length ${at(0x7fc00c)}, settings ${at(0x7fc00a).toString(16)}`;
for (let f = 0; f < 10; f++) s.runFrame();
console.log(`submap ${from} loaded: ${state()}`);
w[RAM.submap] = w[RAM.submap + 1] = to;
for (let f = 0; f < 30; f++) s.runFrame();
console.log(`$1F11 = ${to}, 30 frames: ${state()}`);
emu.load(to, 0);
for (let f = 0; f < 10; f++) s.runFrame();
console.log(`submap ${to} loaded: ${state()}`);
