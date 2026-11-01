// ExAnimation on the overworld (issue #244, exanim.ts, the engine's overworld part in kobo/exanimation.ts), in Lunar
// Magic's layout: a list per submap and the overworld's global one, a settings byte per submap.
// Without lists the patched overworld is the clean game's frame by frame; a submap's list runs there only – when the
// overworld loads there and after Mario walked there from the main map –, the global one everywhere unless a submap
// turns it off; color slots and rotations change the submap's palette; an event trigger ("Event Manual 8–F") shows
// its second set once the event of its manual frame is passed; the settings turn off the game's tile animation, the
// level dots' colors; the game's lightning is switched per submap as Lunar Magic does. Lunar Magic's tables are read
// where it keeps them (a ROM it saved, when there).
// node tools/testowexanim.ts
import { existsSync, readFileSync } from 'node:fs';
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { OverworldEmulator, l1Index } from '../src/core/overworld.ts';
import { RAM, PAD } from '../src/core/ram.ts';
import {
  owExanimLayout, readSubmapList, writeSubmapList, readOwGlobalList, writeOwGlobalList, submapAnimSettings, setSubmapAnimSettings,
  submapLightning, setSubmapLightning, LIGHTNING_MASK,
  writeAltFile, emptyList, listBytes, exanimDataRanges, owExanimDataRanges, SUBMAP_LISTS,
  NO_GAME_TILES, NO_LEVEL_LIST, NO_GLOBAL_LIST, NO_DOT_COLORS, type ExList,
} from '../src/core/exanim.ts';
import { overworldDataRanges } from '../src/core/overworld.ts';
import { cleanImage, editorImage } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const hx = (v: number, n = 2) => v.toString(16).toUpperCase().padStart(n, '0');

// the console after the overworld loaded on submap `m`, then `frames` frames each (VRAM, CGRAM, WRAM)
type Shot = { vram: Uint8Array; cgram: Uint8Array; wram: Uint8Array };
function run(rom: Rom, m: number, frames: number, poke?: (w: Uint8Array) => void): { load: Shot; shots: Shot[]; ppu: Uint8Array } {
  const emu = new OverworldEmulator(rom), r = emu.load(m, 0), s = emu.snes;
  poke?.(s.wram);
  const shots: Shot[] = [];
  for (let f = 0; f < frames; f++) { s.runFrame(); shots.push({ vram: s.vram.slice(), cgram: s.cgram.slice(), wram: s.wram.slice() }); }
  return { load: r, shots, ppu: r.ppuRegs };
}
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
const color = (c: Uint8Array, i: number) => c[i * 2] | (c[i * 2 + 1] << 8);
const tile = (v: Uint8Array, word: number) => v.subarray(word * 2, word * 2 + 32);

const clean = new Rom(cleanImage()), rom = new Rom(await editorImage());

// ---- the layout ----
const ow = owExanimLayout(rom);
check(!!ow && rom.r8(0x0480e0) === 0x22 && rom.r8(0x00a4e3) === 0x22, `the hooks at Lunar Magic's places ($048086, $0480E0, $00A4E3)${ow ? `, tables at ${hx(ow.settings, 6)}, ${hx(ow.table, 6)}` : ''}`);
check(Array.from({ length: SUBMAP_LISTS }, (_, m) => submapAnimSettings(rom, m)).every((v) => v === 0) && !readOwGlobalList(rom) && Array.from({ length: SUBMAP_LISTS }, (_, m) => readSubmapList(rom, m)).every((l) => !l),
  'every submap: all animations on, no lists');
// a ROM Lunar Magic saved: its submaps' lists and settings where the editor reads them
const LM = 'resources_local/Journey to Kaizo v1.1 (LM rom).smc';
if (existsSync(LM)) {
  const raw = readFileSync(LM), lm = new Rom(new Uint8Array(raw.subarray(raw.length % 0x8000)));
  const l0 = readSubmapList(lm, 0), s0 = l0?.slots.get(0);
  check(!!l0 && l0.slots.size === 12 && s0?.type === 0x18 && s0.dest === 0x0249 && readSubmapList(lm, 5)?.slots.size === 5 && !readOwGlobalList(lm) && submapAnimSettings(lm, 3) === 0x80,
    `Lunar Magic's tables read (Journey to Kaizo: submap 0 ${l0?.slots.size} slots, its slot 0 ${hx(s0?.type ?? 0)} ${hx(s0?.dest ?? 0, 4)}; settings ${hx(submapAnimSettings(lm, 3))})`);
} else console.log('skip  Lunar Magic\'s tables (no Journey to Kaizo ROM in resources_local)');

// ---- without lists: the clean game's overworld ----
for (const m of [0, 1, 4]) {
  const a = run(clean, m, 40), b = run(rom, m, 40);
  const vr = a.shots.findIndex((x, f) => !same(x.vram, b.shots[f].vram)), cg = a.shots.findIndex((x, f) => !same(x.cgram, b.shots[f].cgram));
  check(vr < 0 && cg < 0, `submap ${m}: VRAM and CGRAM as in the clean game, 40 frames after the load${vr >= 0 || cg >= 0 ? ` (differ from frame ${vr}, ${cg})` : ''}`);
}

// ---- a submap's list ----
// Anim graphic A: tiles 11…, 22…, 33…, 44… (tile k all bytes 0x11 * (k + 1))
const alt = new Uint8Array(0x100);
for (let k = 0; k < 8; k++) alt.fill(0x11 * (k + 1), k * 32, k * 32 + 32);
writeAltFile(rom, 0, alt);
const { ppu } = run(rom, 1, 0);
const charWord = (ppu[0x0b] & 0x0f) << 12, T = charWord + 0x40 * 16; // layer 1/2 tile 040
const yi: ExList = emptyList();
yi.slots.set(0, { type: 0x01, trigger: 0, framesLess1: 1, dest: 0x8000 | T, frames: [0x00, 0x20] });
yi.slots.set(1, { type: 0x14, trigger: 0, framesLess1: 1, dest: 0x21, frames: [0x001f, 0x7c00] });
writeSubmapList(rom, 1, yi);
check(listBytes(readSubmapList(rom, 1)!).join() === listBytes(yi).join(), 'a submap\'s list reads back');
const seen = (shots: Shot[], word: number) => new Set(shots.map((x) => tile(x.vram, word)[0]));
const tiles = (shots: Shot[], word: number) => new Set(shots.map((x) => tile(x.vram, word).join()));
{
  const a = run(rom, 1, 24), m2 = run(rom, 2, 24);
  const t = seen(a.shots, T), c = new Set(a.shots.map((x) => color(x.cgram, 0x21))), p = new Set(a.shots.map((x) => x.wram[0x703 + 0x42] | (x.wram[0x704 + 0x42] << 8)));
  check(tile(a.load.vram, T)[0] === 0x11 || tile(a.load.vram, T)[0] === 0x22, `Yoshi's Island loaded: the tile shows a frame from the start (${hx(tile(a.load.vram, T)[0])})`);
  check(t.has(0x11) && t.has(0x22) && t.size === 2, `Yoshi's Island: VRAM word ${hx(T, 4)} animates (${[...t].map((v) => hx(v)).join(' ')})`);
  check(c.has(0x001f) && c.has(0x7c00) && p.has(0x001f) && p.has(0x7c00), `Yoshi's Island: color 21 animates in CGRAM and the palette (${[...c].map((v) => hx(v, 4)).join(' ')})`);
  check(![...seen(m2.shots, T)].some((v) => v === 0x11 || v === 0x22) && !m2.shots.some((x) => color(x.cgram, 0x21) === 0x7c00), 'Vanilla Dome: not');
}

// the console after Mario walked from the main map onto Yoshi's Island (main map 02,14, whose path leads there),
// then `frames` frames; main: 16 frames on the main map before
function walk(rom: Rom, frames: number): { shots: Shot[]; submap: number; main: Shot[] } {
  const emu = new LevelEmulator(rom), s = emu.snes, w = s.wram;
  const i = l1Index(0, 2, 0x13);
  emu.startGameAt(i);
  w[RAM.submap] = w[RAM.submap + 1] = 0;
  emu.reloadOverworld();
  w[RAM.owTranslevels + i] = 1; w[RAM.levelFlags + 1] = 0x0f;
  const mainShots: Shot[] = [];
  for (let f = 0; f < 16; f++) { s.runFrame(); mainShots.push({ vram: s.vram.slice(), cgram: s.cgram.slice(), wram: s.wram.slice() }); }
  let walked = false;
  for (let f = 0; f < 900; f++) {
    s.joy1 = f < 4 ? PAD.down : 0;
    s.runFrame();
    if (w[RAM.owProcess] !== 3) walked = true;
    else if (walked && f > 30) break;
  }
  const shots: Shot[] = [];
  for (let f = 0; f < frames; f++) { s.runFrame(); shots.push({ vram: s.vram.slice(), cgram: s.cgram.slice(), wram: s.wram.slice() }); }
  return { shots, submap: w[RAM.submap], main: mainShots };
}
{
  const wk = walk(rom, 24), t = seen(wk.shots, T);
  check(wk.submap === 1 && tiles(wk.main, T).size === 1 && t.has(0x11) && t.has(0x22), `walked from the main map (not animated there) onto Yoshi's Island: its tile animates (${[...t].map((v) => hx(v)).join(' ')})`);
}

// ---- the overworld's global list ----
const G = charWord + 0x41 * 16;
const g = emptyList();
g.slots.set(0, { type: 0x01, trigger: 0, framesLess1: 1, dest: 0x8000 | G, frames: [0x40, 0x60] });
writeOwGlobalList(rom, g);
check(readOwGlobalList(rom)?.slots.get(0)?.dest === (0x8000 | G), 'the global list reads back');
for (const m of [0, 2]) {
  const t = seen(run(rom, m, 24).shots, G);
  check(t.has(0x33) && t.has(0x44), `the global list runs on submap ${m} (${[...t].map((v) => hx(v)).join(' ')})`);
}
{
  const t = seen(run(rom, 1, 24).shots, G), y = seen(run(rom, 1, 24).shots, T);
  check(t.has(0x33) && t.has(0x44) && y.has(0x11) && y.has(0x22), 'Yoshi\'s Island runs both lists');
}

// ---- the settings ----
setSubmapAnimSettings(rom, 2, NO_GLOBAL_LIST);
setSubmapAnimSettings(rom, 1, NO_LEVEL_LIST);
{
  const t2 = seen(run(rom, 2, 24).shots, G), a = run(rom, 1, 24), t1 = seen(a.shots, T), g1 = seen(a.shots, G);
  check(!t2.has(0x33) && !t2.has(0x44), 'Vanilla Dome with the global list off: not run there');
  check(!t1.has(0x11) && !t1.has(0x22) && g1.has(0x33) && g1.has(0x44), 'Yoshi\'s Island with its list off: only the global list runs');
}
setSubmapAnimSettings(rom, 1, 0);
setSubmapAnimSettings(rom, 2, 0);
// the game's tile animation (the tiles it uploads from $0AF6 to VRAM $0750 on) and the level dots' colors 6D and 7D
const gameTiles = (x: Shot) => x.vram.slice(0x0ea0, 0x0ea0 + 0x160).join();
const dots = (x: Shot) => `${color(x.cgram, 0x6d)} ${color(x.cgram, 0x7d)}`;
{
  const a = run(rom, 1, 64);
  check(new Set(a.shots.map(gameTiles)).size > 1 && new Set(a.shots.map(dots)).size > 1, 'Yoshi\'s Island: the game\'s tiles and the level dots animate');
  setSubmapAnimSettings(rom, 1, NO_GAME_TILES | NO_DOT_COLORS);
  check(submapAnimSettings(rom, 1) === (NO_GAME_TILES | NO_DOT_COLORS), 'the settings read back');
  const b = run(rom, 1, 64), t = seen(b.shots, T);
  check(new Set(b.shots.map(gameTiles)).size === 1 && new Set(b.shots.map(dots)).size === 1, 'game tiles and level dots off: they stand still');
  check(t.has(0x11) && t.has(0x22), 'the submap\'s list still runs');
  const c = run(rom, 2, 64);
  check(new Set(c.shots.map(gameTiles)).size > 1 && new Set(c.shots.map(dots)).size > 1, 'Vanilla Dome keeps them');
  setSubmapAnimSettings(rom, 1, 0);
}
// the lightning (color 47): the game's mask at $04F709, the bytes Lunar Magic 3.71 writes (ROMs it saved: F7 the game's,
// FF with the Valley of Bowser's off, 7F with only the main map's on, 77 with both, 75 with Star Road's too)
{
  const flashes = (r: Rom, m: number) => new Set(run(r, m, 900).shots.map((x) => color(x.cgram, 0x47))).size;
  const mask = () => rom.r8(LIGHTNING_MASK);
  check(mask() === 0xf7 && Array.from({ length: SUBMAP_LISTS }, (_, m) => submapLightning(rom, m) === (m === 4)).every(Boolean),
    'the lightning on the Valley of Bowser only, as in the game (F7)');
  const before = flashes(rom, 4);
  setSubmapLightning(rom, 4, false);
  const after = flashes(rom, 4);
  check(mask() === 0xff && !submapLightning(rom, 4), `the Valley of Bowser's off: FF (${hx(mask())})`);
  check(before > 1 && after === 1, `Valley of Bowser: color 47 flashes (${before} colors in 900 frames), with the lightning off not (${after})`);
  const main0 = flashes(rom, 0);
  setSubmapLightning(rom, 0, true);
  check(mask() === 0x7f, `only the main map's on: 7F (${hx(mask())})`);
  setSubmapLightning(rom, 4, true);
  check(mask() === 0x77, `the main map's on too: 77 (${hx(mask())})`);
  setSubmapLightning(rom, 6, true);
  check(mask() === 0x75, `and Star Road's: 75 (${hx(mask())})`);
  setSubmapLightning(rom, 6, false);
  const main1 = flashes(rom, 0);
  check(main0 === 1 && main1 > 1, `the main map: color 47 stands still (${main0}), with the lightning on it flashes (${main1} colors)`);
  setSubmapLightning(rom, 0, false);
  check(mask() === 0xf7, 'back: F7');
}

// ---- an event trigger: Event Manual 8 (trigger 01), its event set by the list's Trigger Init ----
const EV = 0x0b;
const ev: ExList = emptyList();
ev.manual.set(8, EV);
ev.manual.set(0xd, EV); // (trigger 06: Event Manual D)
ev.slots.set(0, { type: 0x01, trigger: 0x01, framesLess1: 0, dest: 0x8000 | T, frames: [0x80, 0xa0] }); // 55… / 66…
const E = charWord + 0x42 * 16;
ev.slots.set(1, { type: 0x01, trigger: 0x06, framesLess1: 0, dest: 0x8000 | E, frames: [0xc0, 0xe0] }); // 77… / 88…: 06 too
writeSubmapList(rom, 3, ev);
check(readSubmapList(rom, 3)?.slots.get(1)?.frames.length === 2, 'an overworld list: trigger 06 has a second set');
{
  // (the frames after each slot ran once since the event was set)
  const off = run(rom, 3, 24), on = run(rom, 3, 24, (w) => { w[RAM.owEvents + (EV >> 3)] |= 0x80 >> (EV & 7); });
  const late = (x: { shots: Shot[] }) => x.shots.slice(8);
  const a = seen(late(off), T), b = seen(late(on), T), a2 = seen(late(off), E), b2 = seen(late(on), E);
  check(a.has(0x55) && !a.has(0x66) && b.has(0x66) && !b.has(0x55), `Event Manual 8 = event ${hx(EV)}: the first set (${[...a].map((v) => hx(v)).join(' ')}), once passed the second (${[...b].map((v) => hx(v)).join(' ')})`);
  check(a2.has(0x77) && b2.has(0x88) && !b2.has(0x77), `trigger 06 (Event Manual D, the same event) alike on the overworld (${[...a2].map((v) => hx(v)).join(' ')} / ${[...b2].map((v) => hx(v)).join(' ')})`);
}
writeSubmapList(rom, 3, null);

// ---- a color rotation: the submap's palette only ----
{
  const r: ExList = emptyList();
  r.slots.set(0, { type: 0x18, trigger: 0, framesLess1: 0, dest: 0x21 | (3 << 8), frames: [] });
  writeSubmapList(rom, 5, r);
  const a = run(rom, 5, 32), b = run(clean, 5, 32);
  const row = (x: Shot) => [0x21, 0x22, 0x23, 0x24].map((c) => color(x.cgram, c)).join();
  const first = [0x21, 0x22, 0x23, 0x24].map((c) => color(b.load.cgram, c));
  const rows = new Set(a.shots.map(row));
  const copy = (x: Shot) => x.wram.slice(0x905, 0xaf6).join();
  check(rows.size === 4 && a.shots.every((x) => [0x21, 0x22, 0x23, 0x24].map((c) => color(x.cgram, c)).sort().join() === [...first].sort().join()), `Special World: colors 21–24 rotate (${rows.size} orders)`);
  check(a.shots.every((x, f) => copy(x) === copy(b.shots[f])), 'the RAM after the palette ($0905 on) stays the clean game\'s');
  writeSubmapList(rom, 5, null);
}

// ---- the data ----
{
  const all = exanimDataRanges(rom), owr = owExanimDataRanges(rom), od = overworldDataRanges(rom);
  const inside = (rs: [number, number][], [a, b]: [number, number]) => rs.some(([x, y]) => x <= a && y >= b);
  check(owr.length >= 4 && owr.every((r) => inside(all, r) && inside(od, r)), `the overworld's animation data (${owr.length} ranges) is ExAnimation data and overworld data`);
  writeSubmapList(rom, 1, null);
  writeOwGlobalList(rom, null);
  check(!readSubmapList(rom, 1) && !readOwGlobalList(rom), 'lists removed');
}

if (bad) { console.log(`\n${bad} FAILED`); process.exit(1); }
console.log('\nall ok');
