// Level graphics placement (see CONTEXT.md): graphics parts – FG and BG Map16 tiles, ExGFX files,
// palettes, animation frames – brought into a level. The level setup of a package (pkgplan.ts), a level
// import (bgpack.ts) and a sample level (packages.ts) all place them here, by one set of rules:
// - planning: which Map16 tiles and ExGFX numbers are free (the author's when free, else the next free
//   ones), where a .map16 was exported from, what a palette covers, where animation frames come from;
// - the ROM side: Map16 tiles with their acts like moved along, ExGFX files under their numbers;
// - the level side: ExGFX in its graphics slots, ExAnimation slots with their frames in its Anim graphic
//   (ADR 0003), masked colors in its palette – never a palette made up without the level's colors.

import type { Rom } from './rom.ts';
import { RAM } from './ram.ts';
import { loadBlockProject } from './blocks.ts';
import { map16Targets, importGfxFile, type Map16File } from './map16file.ts';
import { EXT_FIRST, EXT_TILES, DEFAULT_ACTS, extTileWords, actsLike, setExtTileWords, setActsLike } from './map16ext.ts';
import { BG_EXT_TILES, bgExtTileWords, vanillaBgWords, setBgExtTileWords } from './bgmap16.ts';
import {
  gfxEntry, VANILLA_GFX, levelGfx, setLevelGfx, levelExtGfx, setLevelExtGfx, GFX_SLOT_NAMES,
  EXT_GFX_SLOT_NAMES, customPalette, setCustomPalette,
} from './patches.ts';
import { sampleTiles } from './mwl.ts';
import { LAYER3_SLOT_NAMES, LG_SLOT_NAMES, LT3_SLOT, LT3_DESTS, LT3_SIZES, levelLayer3, setLevelLayer3 } from './layer3gfx.ts';
import { usesAltFile, addLevelSlots, localizeFrames, levelAltFile, altFileName, kindOf, AN2_FRAMES, AN2_FRAMES_END, ALT_FILE_MAX, type ExList, type ExSlot } from './exanim.ts';

const base = (f: string) => f.slice(f.lastIndexOf('/') + 1);
const stem = (f: string) => f.replace(/\.[^./]*$/, '').toLowerCase();
const hx = (v: number, d: number) => v.toString(16).toUpperCase().padStart(d, '0');

// ---------- planning ----------

// the slot an 8x8 tile number (tile word bits 0-9) is loaded from: 80 tiles per slot in VRAM order
// (BG2/BG3 with the VRAM patch, patches.ts)
export const VRAM_SLOTS = ['FG1', 'FG2', 'BG1', 'FG3', 'BG2', 'BG3'];
export const slotOfWord = (w: number) => VRAM_SLOTS[(w & 0x3ff) >> 7] ?? null;
// the slots ExGFX can go in: the level's GFX bypass, the BG2/BG3 slots of the VRAM patch and layer 3's
// (layer3gfx.ts)
export const GFX_SLOTS = [...GFX_SLOT_NAMES, ...EXT_GFX_SLOT_NAMES, ...LAYER3_SLOT_NAMES];

// first ExGFX number that is free and not taken by `taken` (80-FE first, as Lunar Magic suggests; FF is
// a level slot's "none"), -1: none left
export function freeGfx(rom: Rom, taken: Set<number>): number {
  const free = (i: number) => !taken.has(i) && !gfxEntry(rom, i);
  for (let i = 0x80; i < 0xff; i++) if (free(i)) return i;
  for (let i = VANILLA_GFX; i < 0x80; i++) if (free(i)) return i;
  return -1;
}

// the number an ExGFX file is stored as: the author's (`want`) when free and not `taken`, else the next
// free one; added to `taken`
export function gfxNumber(rom: Rom, want: number | null, taken: Set<number>): number {
  const num = want !== null && want >= VANILLA_GFX && want < 0xff && !taken.has(want) && !gfxEntry(rom, want) ? want : freeGfx(rom, taken);
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
    prints.push(`${base(g.file)} as ExGFX ${hx(g.num, 2)} (${importGfxFile(rom, g.num, files.get(g.file)!)})`);
  }
  return prints;
}

// ---------- the level side ----------

// what goes into a level
export interface LevelGraphics {
  slots: { slot: string | null; num: number }[]; // ExGFX for graphics slots (null, or a slot not in GFX_SLOTS: none)
  lt3?: { dest: number; size: number } | null; // where an LT3 file goes in the layer 3 tilemap (default: the level's)
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
  const std = levelGfx(rom, level), ext = levelExtGfx(rom, level), l3 = levelLayer3(rom, level);
  let stdSet = false, extSet = false, l3Set = false;
  const slots: string[] = [];
  for (const { slot, num } of g.slots) {
    const e = slot ? EXT_GFX_SLOT_NAMES.indexOf(slot) : -1, s = slot ? GFX_SLOT_NAMES.indexOf(slot) : -1, k = slot ? LG_SLOT_NAMES.indexOf(slot) : -1;
    if (e >= 0) { ext[e] = num; extSet = true; } else if (s >= 0) { std[s] = num; stdSet = true; } else if (k >= 0) { l3.lg[k] = num; l3Set = true; }
    else if (slot === LT3_SLOT) {
      l3.lt3 = num; l3Set = true;
      if (g.lt3) { l3.dest = g.lt3.dest; l3.size = g.lt3.size; }
      slots.push(`${slot} = ${hx(num, 2)} (${LT3_DESTS[l3.dest].toLowerCase()}, ${hx(LT3_SIZES[l3.size], 4)} bytes)`);
      continue;
    } else continue;
    slots.push(`${slot} = ${hx(num, 2)}`);
  }
  if (stdSet) setLevelGfx(rom, level, std);
  if (extSet) setLevelExtGfx(rom, level, ext);
  if (l3Set) setLevelLayer3(rom, level, l3);
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
