// Level graphics placement (see CONTEXT.md): graphics parts – FG and BG Map16 tiles, ExGFX files,
// palettes, animation frames – brought into a level. The level setup of a package (pkgplan.ts), a level
// import (bgpack.ts) and a sample level (packages.ts) all place them here, by one set of rules:
// - planning: which Map16 tiles and ExGFX numbers are free (the author's when free, else the next free
//   ones), where a .map16 was exported from, what a palette covers, where animation frames come from;
// - the ROM side: Map16 tiles with their acts like moved along, ExGFX files under their numbers;
// - the level side: ExGFX in its graphics slots (gfxslots.ts), ExAnimation slots with their frames in its
//   Anim graphic (ADR 0003), masked colors in its palette – never a palette made up without the level's colors.

import type { Rom } from './rom.ts';
import { RAM } from './ram.ts';
import { loadBlockProject } from './blocks.ts';
import { map16Targets, romTileWords, romActsLike, ROM_MAP16_TILES, type Map16File, type RomMap16 } from './map16file.ts';
import { importGfxFile } from './gfxfiles.ts';
import { EXT_FIRST, EXT_TILES, DEFAULT_ACTS, extTileWords, actsLike, setExtTileWords, setActsLike } from './map16ext.ts';
import { BG_EXT_FIRST, BG_EXT_TILES, bgExtTileWords, vanillaBgWords, setBgExtTileWords } from './bgmap16.ts';
import {
  gfxEntry, gfxHex, freeGfx, gfxRangeFor, gfxNumberProblem, type GfxFileKind, customPalette, setCustomPalette,
} from './patches.ts';
import { sampleTiles } from './mwl.ts';
import { LT3_SLOT, LT3_DESTS, LT3_SIZES, levelLayer3, type Lt3Place } from './layer3gfx.ts';
import { assignSlot, GFX_SLOTS } from './gfxslots.ts';
import { usesAltFile, addLevelSlots, localizeFrames, levelAltFile, altFileName, kindOf, AN2_FRAMES, AN2_FRAMES_END, ALT_FILE_MAX, type ExList, type ExSlot } from './exanim.ts';

const base = (f: string) => f.slice(f.lastIndexOf('/') + 1);
const stem = (f: string) => f.replace(/\.[^./]*$/, '').toLowerCase();
const hx = (v: number, d: number) => v.toString(16).toUpperCase().padStart(d, '0');

// ---------- planning ----------

// the slot an 8x8 tile number (tile word bits 0-9) is loaded from: 80 tiles per slot in VRAM order
// (BG2/BG3 with the VRAM patch, patches.ts)
export const VRAM_SLOTS = ['FG1', 'FG2', 'BG1', 'FG3', 'BG2', 'BG3'];
export const slotOfWord = (w: number) => VRAM_SLOTS[(w & 0x3ff) >> 7] ?? null;

// the number the ExGFX file `f` is stored as: the author's (`want`, Lunar Magic's numbering up to FFF)
// when it may hold the file, is free and not `taken`, else the next free one in the file's range
// (gfxRangeFor: a 3bpp file numbered E00-FFF goes to 80-DFF); added to `taken`
export function gfxNumber(rom: Rom, want: number | null, taken: Set<number>, f: GfxFileKind = {}): number {
  const keep = want !== null && !gfxNumberProblem(want, f) && !taken.has(want) && !gfxEntry(rom, want);
  const num = keep ? want : freeGfx(rom, taken, gfxRangeFor(f));
  if (num < 0) throw new Error('No free ExGFX number left');
  taken.add(num);
  return num;
}

// FG Map16 tiles the ROM already uses: outside 200-FFF, a block of the block project on it, or graphics
// / acts like other than an empty tile's (`blank`: its tile words)
export function usedFgTiles(rom: Rom, blank: number[]): (t: number) => boolean {
  const blocks = new Set((loadBlockProject(rom)?.list ?? []).map((b) => b.tile));
  return (t) => {
    if (t < EXT_FIRST || t >= EXT_TILES) return true;
    if (blocks.has(t)) return true;
    const w = extTileWords(rom, t);
    return !!w && (w.some((v, k) => v !== blank[k]) || actsLike(rom, t) !== DEFAULT_ACTS);
  };
}

// the first position from `want` on (then from 200) where all `offsets` (relative tiles) are free and
// stay in their rows; `want` itself when it fits, -1 when nothing does
export function freeRun(want: number, offsets: number[], used: (t: number) => boolean, width: number): number {
  const fits = (at: number) => (at & 15) + width <= 16 && offsets.every((o) => !used(at + o));
  if (fits(want)) return want;
  for (let at = EXT_FIRST; at < EXT_TILES; at++) if (fits(at)) return at;
  return -1;
}

// the tile an FG .map16 was exported from (its top left), null when the file does not say: the row from
// its header, the column from the tiles the level file (`mwl`) places in those rows
export function fgOrigin(rom: Rom, f: Map16File, mwl: Uint8Array | null): number | null {
  if (!f.origin || f.origin.bg) return null;
  let from = f.origin.tile;
  if (mwl && f.width < 16) {
    let tiles: number[] = [];
    try { tiles = sampleTiles(rom, mwl).filter((t) => t >= from && t < from + f.height * 16); } catch { /* no level data */ }
    const col = Math.min(...tiles.map((t) => t & 15));
    if (tiles.length && tiles.every((t) => (t & 15) - col < f.width)) from += col;
  }
  return from;
}

// where the FG .map16 goes: `want` when free, else the next free run (-1: no room)
export function fgPlace(rom: Rom, f: Map16File, want: number, blank: number[]): number {
  return freeRun(Math.max(want, EXT_FIRST), map16Targets(f, 0), usedFgTiles(rom, blank), Math.min(16, f.width));
}

// BG Map16 tiles the ROM already uses: outside 200-FFF or holding other than the fill tile
export function usedBgTiles(rom: Rom): (t: number) => boolean {
  const fill = vanillaBgWords(rom, 0x025);
  return (t) => {
    if (t < BG_EXT_FIRST || t >= BG_EXT_TILES) return true;
    const w = bgExtTileWords(rom, t);
    return !!w && w.some((v, k) => v !== fill[k]);
  };
}

// tiles at..at+n-1 of the extended BG Map16 still hold the fill tile
function freeBgTiles(rom: Rom, at: number, n: number): boolean {
  const fill = vanillaBgWords(rom, 0x025);
  for (let t = at; t < at + n; t++) {
    if (t >= BG_EXT_TILES) return false;
    const w = bgExtTileWords(rom, t);
    if (w && w.some((v, k) => v !== fill[k])) return false;
  }
  return true;
}

// where the BG .map16 goes: `want` when its rows are free, else the next free rows from `first` on
// (`want` when there are none)
export function bgPlace(rom: Rom, f: Map16File, want: number, first: number): number {
  const n = f.height * 16;
  if (freeBgTiles(rom, want, n)) return want;
  for (let a = first; a + n <= BG_EXT_TILES; a += 16) if (freeBgTiles(rom, a, n)) return a;
  return want;
}

// a whole-ROM .map16 (map16file.ts parseRomMap16) placed: its tiles that differ from the clean game,
// file tile → tile here (FG and BG); shift: by how much each of its FG pages moved
export interface RomMap16Place { fg: Map<number, number>; bg: Map<number, number>; shift: Map<number, number> }

// the key most of `keys` have
function mostCommon(keys: string[]): string {
  const n = new Map<string, number>();
  for (const k of keys) n.set(k, (n.get(k) ?? 0) + 1);
  return [...n].reduce((m, e) => (e[1] > m[1] ? e : m))[0];
}

// The tiles of a whole-ROM .map16 that differ from the clean game: on FG pages 02-7F those holding other
// than the file's fill (the tile most of them hold, Lunar Magic's for unused tiles) and other than an
// empty tile (`blank`, acting like air), on BG pages 82-FF likewise. Each page stays together: on its
// own tiles when they – and `also`, tiles of it the package needs as well (its blocks') – are free, else
// on the next free ones of 200-FFF, its rows kept. Pages 00-01 of the tilesets and BG pages 80-81 are the
// game's: the tiles differing from this ROM's (`tilesets`: its words of tiles 000-1FF per tileset, when
// known) go into `notes`, not taken over. Throws when a page finds no room.
export function placeRomMap16(rom: Rom, m: RomMap16, blank: number[], usedFg: (t: number) => boolean, also: number[], tilesets: number[][][] | undefined, notes: string[]): RomMap16Place {
  const range = (a: number, b: number) => Array.from({ length: b - a }, (_, i) => a + i);
  const fgKey = (t: number) => `${romTileWords(m.fg, t).join()}:${m.acts[t]}`;
  const fgFill = mostCommon(range(EXT_FIRST, ROM_MAP16_TILES).map(fgKey)), empty = `${blank.join()}:${DEFAULT_ACTS}`;
  const fg = range(EXT_FIRST, ROM_MAP16_TILES).filter((t) => { const k = fgKey(t); return k !== fgFill && k !== empty; });
  const bgKey = (t: number) => romTileWords(m.bg, t).join();
  const bgFill = mostCommon(range(BG_EXT_FIRST, ROM_MAP16_TILES).map(bgKey)), bgEmpty = vanillaBgWords(rom, 0x025).join();
  const bg = range(BG_EXT_FIRST, ROM_MAP16_TILES).filter((t) => { const k = bgKey(t); return k !== bgFill && k !== bgEmpty; });
  const fgPlace = placePages(fg, also, usedFg, 'FG', notes);
  const bgPlace = placePages(bg, [], usedBgTiles(rom), 'BG', notes);

  const differing = new Set<number>();
  m.tilesets.forEach((ts, i) => { for (let t = 0; t < EXT_FIRST; t++) if (tilesets?.[i] && romTileWords(ts, t).join() !== tilesets[i][t].join()) differing.add(t); });
  if (differing.size) notes.push(`Tiles ${[...differing].sort((a, b) => a - b).map((t) => hx(t, 3)).join(', ')} of the tilesets' pages 00–01 differ from this ROM's – not taken over`);
  const bgDiffering = range(0, BG_EXT_FIRST).filter((t) => bgKey(t) !== vanillaBgWords(rom, t).join());
  if (bgDiffering.length) notes.push(`BG tiles ${bgDiffering.map((t) => hx(t, 3)).join(', ')} (pages 80–81) differ from this ROM's – not taken over`);
  return { fg: fgPlace.to, bg: bgPlace.to, shift: fgPlace.shift };
}

// tiles placed page by page (see placeRomMap16): first the pages that stay on their own tiles, then the
// others; freeRun's range 200-FFF is the BG's too
function placePages(tiles: number[], also: number[], used: (t: number) => boolean, what: string, notes: string[]): { to: Map<number, number>; shift: Map<number, number> } {
  const taken = new Set<number>();
  const isUsed = (t: number) => used(t) || taken.has(t);
  const pages = [...new Set(tiles.map((t) => t >> 8))].map((p) => {
    const own = tiles.filter((t) => t >> 8 === p);
    return { p, first: p << 8, own, offsets: [...new Set([...own, ...also.filter((t) => t >> 8 === p)])].map((t) => t - (p << 8)) };
  });
  const at = new Map<number, number>();
  const put = (x: (typeof pages)[number], a: number) => { at.set(x.p, a); for (const o of x.offsets) taken.add(a + o); };
  for (const x of pages) if (x.offsets.every((o) => !isUsed(x.first + o))) put(x, x.first);
  for (const x of pages.filter((x) => !at.has(x.p))) {
    const a = freeRun(x.first, x.offsets, isUsed, 16);
    if (a < 0) throw new Error(`No room for the ${x.own.length} tiles of ${what} Map16 page ${hx(x.p, 2)}`);
    notes.push(`${what} Map16 page ${hx(x.p, 2)} from ${hx(a, 3)} (${x.first >= EXT_TILES ? 'the editor has tiles up to FFF' : `${hx(x.first, 3)} is taken`})`);
    put(x, a);
  }
  const to = new Map<number, number>(), shift = new Map<number, number>();
  for (const x of pages) {
    const d = at.get(x.p)! - x.first;
    shift.set(x.p, d);
    for (const t of x.own) to.set(t, t + d);
  }
  return { to, shift };
}

export interface PackPalette {
  file: string; // .pal
  mask: string; // .palmask
  colors: number[]; // palette indices the mask gives (not 0)
  back: boolean; // the mask includes the back area color
  pal: Uint16Array; // the file's colors
  layer3: boolean; // only colors 0-31, the 2bpp palettes of layer 3
}

// palettes: each .pal with the .palmask of the same name (or the only ones there are); what is not
// taken over goes into `notes`
export function packPalettes(files: Map<string, Uint8Array>, pals: string[], masks: string[], notes: string[]): PackPalette[] {
  const palettes: PackPalette[] = [];
  for (const pf of pals) {
    const mk = masks.find((m) => stem(m) === stem(pf)) ?? (pals.length === 1 && masks.length === 1 ? masks[0] : undefined);
    const pd = files.get(pf)!;
    if (!mk) { notes.push(`${base(pf)} has no .palmask – its colors are not taken over`); continue; }
    if (pd.length < 768) { notes.push(`${base(pf)} is not a 256-color palette – not taken over`); continue; }
    const m = files.get(mk)!;
    const pal = new Uint16Array(256);
    for (let i = 0; i < 256; i++) pal[i] = (pd[i * 3] >> 3) | ((pd[i * 3 + 1] >> 3) << 5) | ((pd[i * 3 + 2] >> 3) << 10);
    const colors = Array.from({ length: 256 }, (_, i) => i).filter((i) => i > 0 && m[i]);
    const back = m.length > 256 && m[256] !== 0;
    if (colors.length || back) palettes.push({ file: pf, mask: mk, colors, back, pal, layer3: colors.every((i) => i < 32) && !back });
  }
  if (!pals.length && masks.length) notes.push('.palmask without a .pal – colors not taken over');
  return palettes;
}

// the files a level file's ExAnimation takes frames from: the one in its AN2 slot (Lunar Magic keeps it in
// RAM from $7EAD00, where RAM frames point) and its list's alternative file (ExGFX 60-63). Not ExGFX:
// the placement copies the frames into the level's Anim graphic (levelFrames).
export interface FrameSources { an2: Uint8Array | null; alt: Uint8Array | null }
export function frameSources(files: Map<string, Uint8Array>, list: ExList | null, an2File: string | undefined, altFile: string | undefined, notes: string[]): FrameSources {
  const pick = (f: string | undefined) => {
    if (!f) return null;
    const d = files.get(f)!;
    if (d.length & 31 || d.length > ALT_FILE_MAX) { notes.push(`${base(f)} is not uncompressed 4bpp graphics – the animation frames from it are left out`); return null; }
    return d;
  };
  const tiles = [...(list?.slots.values() ?? [])].filter((e) => kindOf(e.type) === 'tiles');
  return {
    an2: tiles.some((e) => !usesAltFile(e) && e.frames.some((f) => f >= AN2_FRAMES && f < AN2_FRAMES_END)) ? pick(an2File) : null,
    alt: tiles.some(usesAltFile) ? pick(altFile) : null,
  };
}

// the level's colors as a custom palette would hold them: CGRAM, color 0 = back area color ($0701)
export function levelColors(r: { cgram: Uint8Array; wram: Uint8Array }): Uint8Array {
  const pal = r.cgram.slice(0, 512);
  pal[0] = r.wram[RAM.backdrop]; pal[1] = r.wram[RAM.backdrop + 1] & 0x7f;
  return pal;
}

// ---------- the ROM side ----------

// the FG .map16's tiles from `at` on; acts like pointing into the .map16 itself (exported from `from`)
// moves along. Tiles in `keepActs` keep theirs (a block on them gives it).
export function putFgTiles(rom: Rom, f: Map16File, from: number, at: number, keepActs: Set<number> = new Set()): number[] {
  const targets = map16Targets(f, at), src = map16Targets(f, from);
  targets.forEach((t, i) => {
    setExtTileWords(rom, t, f.tiles[i]);
    const a = f.acts?.[i];
    if (a !== undefined && !keepActs.has(t)) { const k = src.indexOf(a); setActsLike(rom, t, k >= 0 ? targets[k] : a); }
  });
  return targets;
}

// a whole-ROM .map16's tiles where `place` puts them, acting like the tile of pages 00–01 their acts like
// leads to (the editor's acts like is one of them). Tiles in `keepActs` keep theirs (a block on them
// gives it).
export function putRomMap16(rom: Rom, m: RomMap16, place: Pick<RomMap16Place, 'fg' | 'bg'>, keepActs: Set<number> = new Set()): void {
  for (const [f, t] of place.fg) {
    setExtTileWords(rom, t, romTileWords(m.fg, f));
    if (!keepActs.has(t)) setActsLike(rom, t, romActsLike(m, f) ?? DEFAULT_ACTS);
  }
  for (const [f, t] of place.bg) setBgExtTileWords(rom, t, romTileWords(m.bg, f));
}

// the BG .map16's tiles from BG tile `at` on
export function putBgTiles(rom: Rom, f: Map16File, at: number): void {
  f.tiles.forEach((ws, i) => setBgExtTileWords(rom, at + Math.floor(i / f.width) * 16 + (i % f.width), ws));
}

// ExGFX files under their numbers (each file once)
export function storeGfx(rom: Rom, files: Map<string, Uint8Array>, gfx: { file: string | null; num: number }[]): string[] {
  const prints: string[] = [];
  const stored = new Set<string>();
  for (const g of gfx) {
    if (!g.file || stored.has(g.file)) continue;
    stored.add(g.file);
    prints.push(`${base(g.file)} as ExGFX ${gfxHex(g.num)} (${importGfxFile(rom, g.num, files.get(g.file)!)})`);
  }
  return prints;
}

// ---------- the level side ----------

// what goes into a level
export interface LevelGraphics {
  slots: { slot: string | null; num: number }[]; // ExGFX for graphics slots (null, or a slot not in GFX_SLOTS: none)
  lt3?: Lt3Place | null; // where an LT3 file goes in the layer 3 tilemap (default: the level's)
  palettes: PackPalette[]; // colors to take over
  back: number | null; // the back area color of the level file, for palettes whose mask has it
  exanim: ExSlot[]; // ExAnimation slots to add to the level's list
  frames: FrameSources; // where they take their frames from
}

// the level's colors before the placement and its WRAM after its load (RAM frames of animations come
// from it); null: not known
export interface LevelState { cgram: Uint8Array | null; wram?: Uint8Array | null }

export interface Placed { warnings: string[]; prints: string[] }

// ExAnimation slots with their frames copied into the Anim graphic of the level's list (ADR 0003); a slot
// whose frames do not fit is null
export function levelFrames(rom: Rom, level: number, slots: ExSlot[], frames: FrameSources, wram: Uint8Array | null | undefined): { slots: (ExSlot | null)[]; file: number; notes: string[] } {
  const file = levelAltFile(rom, level);
  return { ...localizeFrames(rom, slots, { ...frames, ram: wram ?? null }, file), file };
}

// the graphics in level `level`: ExGFX in its slots, the ExAnimation slots in its list, the colors in its
// own palette (made from `state.cgram` when it has none; neither: a warning, the colors stay)
export function placeInLevel(rom: Rom, level: number, g: LevelGraphics, state: LevelState): Placed {
  const warnings: string[] = [], prints: string[] = [];
  const lv = `Level ${hx(level, 3)}`;
  const slots: string[] = [];
  for (const { slot, num } of g.slots) {
    if (!slot || !GFX_SLOTS.includes(slot)) continue;
    assignSlot(rom, level, slot, num, g.lt3 ?? undefined);
    if (slot !== LT3_SLOT) { slots.push(`${slot} = ${hx(num, 2)}`); continue; }
    const l3 = levelLayer3(rom, level);
    slots.push(`${slot} = ${hx(num, 2)} (${LT3_DESTS[l3.dest].toLowerCase()}, 0x${hx(LT3_SIZES[l3.size], 4)} bytes)`);
  }
  if (slots.length) prints.push(`${lv}: ${slots.join(', ')}`);
  if (g.exanim.length) {
    const f = levelFrames(rom, level, g.exanim, g.frames, state.wram);
    warnings.push(...f.notes);
    const used = addLevelSlots(rom, level, f.slots.filter((e): e is ExSlot => !!e));
    if (used.length) prints.push(`${lv}: ExAnimation slot(s) ${used.map((k) => hx(k, 2)).join(', ')}, frames in ${altFileName(f.file)}`);
  }
  if (g.palettes.length) {
    const own = customPalette(rom, level);
    if (!own && !state.cgram) warnings.push(`Colors not set: the colors of level ${hx(level, 3)} are not known`);
    else {
      const pal = own ? rom.bytes(own, 512).slice() : state.cgram!.slice(0, 512);
      const put = (i: number, c: number) => { pal[i * 2] = c & 0xff; pal[i * 2 + 1] = c >> 8; };
      for (const p of g.palettes) {
        for (const i of p.colors) put(i, p.pal[i]);
        const back = p.back && g.back !== null;
        if (back) put(0, g.back!);
        prints.push(`${lv}: ${p.colors.length} color(s)${back ? ' and the background color' : ''} from ${base(p.file)}`);
      }
      setCustomPalette(rom, level, pal);
    }
  }
  return { warnings, prints };
}
