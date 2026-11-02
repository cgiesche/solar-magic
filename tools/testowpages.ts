// The overworld's layer 1 Map16 expanded to 0x200 tiles (#90), in Lunar Magic's format: a ROM Lunar Magic saved with
// the expansion (resources_local, skipped without it) reads in the editor as the game shows it – its tiles' high bytes
// and their Map16 – and has the editor's code of the hijack byte for byte (the operands aside); the editor's ROM gets
// the expansion (tiles 00–C0 as the game's, C1–1FF as tile 00, every high byte 0), a tile 1xx painted and set in the
// Map16 is drawn by the game (loaded on the main map and a submap, made by a silent event step), the path kinds, shapes, reveals and
// destroys of the tiles 1xx are those of xx (the game reads the low byte there), the high bytes' map keeps its block.
import { existsSync, readFileSync } from 'node:fs';
import { Rom, snesToPc } from '../src/core/rom.ts';
import { RomEditSession } from '../src/core/romedit.ts';
import {
  OverworldEmulator, gameL1, l1Index, readL1, writeL1, readTranslevels, owTileWords, setOwTileWords, owTileAddr, hasL1HighMap, hasOwMap16Ext,
  hasTranslevelTable, overworldDataRanges, revealedTile, readRevealList, destroyEffects, OW_L1_TILES, type OwRender,
} from '../src/core/overworld.ts';
import { readEvents, writeEvents } from '../src/core/owevents.ts';
import { map16Pointer, RAM } from '../src/core/ram.ts';
import { FLIP_X } from '../src/core/quarters.ts';
import { PATH_TILES_END, NO_SHAPE } from '../src/core/owpaths.ts';
import { editorImage, cleanImage, pathKinds, pathShapes } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const same = (a: ArrayLike<number>, b: ArrayLike<number>) => a.length === b.length && Array.from(a).every((v, i) => v === b[i]);
const hx = (v: number, d = 3) => v.toString(16).toUpperCase().padStart(d, '0');

// the four words of the 16x16 cell (x, y) of the BG1 tilemap (64x64 entries in four 32x32 screens)
function shownWords(r: OwRender, x: number, y: number): number[] {
  const base = (r.ppuRegs[0x07] & 0xfc) << 9;
  const at = (tx: number, ty: number) => {
    const k = ((ty >> 5) * 2 + (tx >> 5)) * 0x400 + (ty & 31) * 32 + (tx & 31), a = base + k * 2;
    return r.vram[a] | (r.vram[a + 1] << 8);
  };
  return [at(x * 2, y * 2), at(x * 2, y * 2 + 1), at(x * 2 + 1, y * 2), at(x * 2 + 1, y * 2 + 1)];
}
// the cells of map region `region` the game draws other than their tile's Map16 says (on the loaded map's region)
function misdrawn(rom: Rom, r: OwRender, region: number): string[] {
  const l1 = gameL1(r), out: string[] = [];
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
    const t = l1[l1Index(region, x, y)];
    if (!same(shownWords(r, x, y), owTileWords(rom, t))) out.push(`${x},${y}: ${hx(t)}`);
  }
  return out;
}
// the operands of the hijack's two long pointers (translevels, high bytes) and their banks
const OPERANDS = [0x04d803, 0x04d804, 0x04d808, 0x04d822, 0x04d823, 0x04d827];

const editor = new Rom(await editorImage()), clean = new Rom(cleanImage());

// ---- a ROM Lunar Magic saved with the expansion ----
const LM = 'resources_local/Journey to Kaizo v1.1 (LM rom).smc';
if (!existsSync(LM)) console.log(`skip (no ${LM}): a ROM Lunar Magic saved`);
else {
  const raw = readFileSync(LM), lm = new Rom(new Uint8Array(raw.subarray(raw.length % 0x8000)));
  check(hasTranslevelTable(lm) && hasL1HighMap(lm) && hasOwMap16Ext(lm), 'Lunar Magic\'s ROM: the translevel table, the high bytes\' map and the moved Map16 are found');
  const diff = Array.from({ length: 0x04d837 - 0x04d7f2 }, (_, k) => 0x04d7f2 + k).filter((a) => !OPERANDS.includes(a) && lm.r8(a) !== editor.r8(a));
  check(!diff.length, `the hijack's code to the high bytes' decompression ($04D7F2–$04D836) as Lunar Magic's, its operands aside${diff.length ? `: differs at ${diff.map((a) => hx(a, 6)).join(' ')}` : ''}`);
  const emu = new OverworldEmulator(lm), r = emu.load(0, 0), l1 = readL1(lm);
  const pages = l1.filter((t) => t >= 0x100).length;
  check(r.ok && same(gameL1(r), l1) && pages > 0, `its layer 1 as the game loads it, ${pages} tiles of page 1`);
  const bank = lm.r8(0x058b22) << 16;
  check(Array.from({ length: OW_L1_TILES }, (_, t) => (bank | map16Pointer(r.wram, t)) === owTileAddr(lm, t)).every(Boolean), 'the game\'s Map16 pointers of tiles 000–1FF are where the editor reads the tiles');
  const bad0 = misdrawn(lm, r, 0);
  check(!bad0.length, `every tile of the main map drawn as the editor reads its Map16${bad0.length ? `: not ${bad0.slice(0, 8).join('; ')}` : ''}`);
  const r1 = emu.load(1, 0), bad1 = misdrawn(lm, r1, 1);
  check(r1.ok && !bad1.length, `…and of the submaps (on Yoshi's Island)${bad1.length ? `: not ${bad1.slice(0, 8).join('; ')}` : ''}`);
}

// ---- the editor's ROM ----
check(hasL1HighMap(editor) && hasOwMap16Ext(editor), 'the editor\'s ROM has the expansion');
const cl1 = clean.bytes(0x0cf7df, 0x800);
check(same(readL1(editor), cl1), 'its layer 1 as the game\'s, every high byte 0');
check(Array.from({ length: 0xc1 }, (_, t) => same(owTileWords(editor, t), owTileWords(clean, t))).every(Boolean), 'tiles 00–C0 as the game\'s');
check(Array.from({ length: OW_L1_TILES - 0xc1 }, (_, k) => same(owTileWords(editor, 0xc1 + k), owTileWords(editor, 0))).every(Boolean), 'tiles C1–1FF as tile 00');
const ranges = overworldDataRanges(editor), inData = (snes: number, n: number) => ranges.some(([a, b]) => a <= snesToPc(snes) && b >= snesToPc(snes) + n);
check(inData(owTileAddr(editor, 0), OW_L1_TILES * 8), 'the Map16 is overworld data');
{
  const emu = new OverworldEmulator(editor), r = emu.load(0, 0);
  check(r.ok && !misdrawn(editor, r, 0).length && same(gameL1(r), cl1), 'the game loads the main map as before');
}

// a tile 1A5 (tile 82 mirrored, palette 7) painted on the main map and on a submap: one ROM edit
const T = 0x1a5, w82 = owTileWords(editor, 0x82);
const ws = [w82[2] ^ FLIP_X, w82[3] ^ FLIP_X, w82[0] ^ FLIP_X, w82[1] ^ FLIP_X].map((w) => (w & ~0x1c00) | (7 << 10));
const rom = new Rom(editor.data.slice()), s = new RomEditSession(rom), before = rom.data.slice(), tlsBefore = readTranslevels(rom);
const onMain = l1Index(0, 5, 5), onSub = l1Index(1, 8, 20);
s.edit('tile 1A5', () => {
  setOwTileWords(rom, T, ws);
  const l1 = readL1(rom);
  l1[onMain] = T; l1[onSub] = T;
  writeL1(rom, l1);
});
check(s.history.undoStack.length === 1, 'painted with its Map16 set: one undo step');
const l1 = readL1(rom);
check(l1[onMain] === T && l1[onSub] === T && l1.filter((t) => t >> 8).length === 2 && same(readTranslevels(rom), tlsBefore), 'read back: two tiles of page 1, the translevels kept');
check(inData(rom.r16(0x04d822) | (rom.r8(0x04d827) << 16), 8), 'the high bytes\' map is overworld data');
{
  const emu = new OverworldEmulator(rom), r0 = emu.load(0, 0);
  check(r0.ok && gameL1(r0)[onMain] === T && same(shownWords(r0, 5, 5), ws), 'the game loads it on the main map and draws it with its Map16');
  check(!misdrawn(rom, r0, 0).length, 'every other tile of the main map as before');
  const tl = r0.wram.subarray(RAM.owTranslevels, RAM.owTranslevelsEnd), cf = new OverworldEmulator(clean).load(0, 0).wram;
  check(same(tl, tlsBefore) && same(r0.wram.subarray(RAM.owTileFlags, RAM.owTileFlagsEnd), cf.subarray(RAM.owTileFlags, RAM.owTileFlagsEnd)), 'the game\'s translevels and initial flags per tile as before');
  const r1 = emu.load(1, 0);
  check(r1.ok && gameL1(r1)[onSub] === T && !misdrawn(rom, r1, 1).length, 'on Yoshi\'s Island too (a submap)');
}

// a silent layer 1 step of event 0 makes tile 1A6 (as 1A5): shown after it
{
  const r2 = new Rom(rom.data.slice());
  setOwTileWords(r2, T + 1, ws);
  const d = readEvents(r2), at = l1Index(0, 7, 5), silent = d.silent.slice();
  silent[0] = [...silent[0], { layer: 1, tile: T + 1, loc: at }];
  writeEvents(r2, { ...d, silent });
  const emu = new OverworldEmulator(r2), before0 = emu.load(0, 0), after = emu.load(0, 1);
  check(gameL1(before0)[at] !== T + 1 && gameL1(after)[at] === T + 1 && same(shownWords(after, 7, 5), ws), 'an event\'s silent step to tile 1A6: shown after the event');
}

s.undo();
check(same(rom.data, before), 'undone');
// back to page 0: the high bytes' map stays in its block
{
  const r3 = new Rom(rom.data.slice()), ptr = () => r3.r16(0x04d822) | (r3.r8(0x04d827) << 16), p0 = ptr();
  const l = readL1(r3);
  l[onMain] = T;
  writeL1(r3, l);
  l[onMain] = 0x82;
  writeL1(r3, l);
  check(ptr() === p0 && readL1(r3)[onMain] === 0x82, 'painted on and off page 1: the map stays in its block');
}
// the clean game (no expansion) takes no tile of page 1
{
  const c = new Rom(cleanImage()), l = readL1(c);
  let threw = false;
  l[onMain] = T;
  try { writeL1(c, l); } catch { threw = true; }
  check(threw && !hasL1HighMap(c) && same(readL1(c).subarray(0, 0x10), cl1.subarray(0, 0x10)), 'the clean game: no high bytes, a tile of page 1 refused');
}

// the game reads the low byte where Mario walks, levels are entered, tiles revealed and destroyed: a tile 1xx is xx
{
  const t0 = performance.now(), kinds = pathKinds(editor);
  console.log(`     kinds learned in ${Math.round(performance.now() - t0)} ms`);
  const off = Array.from({ length: 0x100 }, (_, t) => t).filter((t) => kinds[0x100 + t] !== kinds[t]);
  check(kinds.length === OW_L1_TILES && !off.length, `path kinds of 100–1FF as of 00–FF${off.length ? `: not ${off.map((t) => hx(t, 2)).join(' ')}` : ''}`);
  const sh = pathShapes(editor), k = (t: number, d: number) => (t * 4 + d) * 2;
  const offS = Array.from({ length: PATH_TILES_END - 1 }, (_, i) => i + 1).filter((t) => [0, 1, 2, 3].some((d) =>
    sh.first[k(t, d)] !== sh.first[k(0x100 + t, d)] || sh.walk[k(t, d)] !== sh.walk[k(0x100 + t, d)] || sh.walk[k(t, d) + 1] !== sh.walk[k(0x100 + t, d) + 1]));
  check(sh.walk.some((v) => v !== NO_SHAPE) && !offS.length, `path shapes of 101–155 as of 01–55${offS.length ? `: not ${offS.map((t) => hx(t, 2)).join(' ')}` : ''}`);
  const p = readRevealList(editor)[0x15];
  check(revealedTile(editor, 0x100 | p.from) === (0x100 | p.to), `revealed, tile ${hx(0x100 | p.from)} becomes ${hx(0x100 | p.to)}`);
  const fx = destroyEffects(editor), offD = Array.from({ length: 0x100 }, (_, t) => t).filter((t) => fx[0x100 + t].length !== fx[t].length);
  check(fx.length === OW_L1_TILES && fx.some((e) => e.length) && !offD.length, `destroying a tile 1xx changes as many tiles as xx${offD.length ? `: not ${offD.map((t) => hx(t, 2)).join(' ')}` : ''}`);
}

console.log(bad ? `${bad} FAILED` : 'all ok');
process.exit(bad ? 1 : 0);
