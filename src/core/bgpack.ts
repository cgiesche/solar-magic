// Lunar Magic graphics packages as found on SMWCentral (the graphics section's submission format): a
// sample level (.mwl), the Map16 tiles it uses (.map16, FG and/or BG), the ExGFX files of its graphics
// slots and palettes as .pal with a .palmask telling which colors belong to the package. Taken over
// into a level: the BG tilemap with its BG Map16 tiles, the FG Map16 tiles (to place them), the
// graphics slots those tiles use, the masked colors. The sample level's layer 1 and sprites stay out.
// Which .map16 is which comes from the file (Map16File.origin), what a palette covers from its mask.
// Where the graphics go is the level graphics placement's (levelgfx.ts), as for a package's level setup.
//
// .mwl (as far as needed here): "LM" magic, at 0x40 a table of (offset, size) pairs (u32). Sections
// 1-4 start with 8 bytes of their own (flags, source address in the ROM it was exported from):
//  - 2: layer 2; a BG tilemap is 0x800 bytes = 0x400 tile words, two halves of 16 columns x 32 rows
//    (of which the game uses 27);
//  - 4: palette, 256 colors (BGR555) followed by the back area color;
//  - 7 (no header): ExGFX numbers of the 16 GFX slots, in Lunar Magic's order (LM_SLOTS), 12 bits each;
//    LT3 is a layer 3 tilemap file, LG1-LG4 the layer 3 graphics (vanilla 28-2B). The words' high nibbles
//    are bypass settings: AN2's G3T- (the GFX, layer 3 GFX and layer 3 tilemap bypass on), LT3's DDFF
//    (destination and size of the tilemap, layer3gfx.ts); the others' are layer 3 settings not read here.
// .palmask: 256 bytes, nonzero = the color is the package's, byte 256 = the back area color is.

import { Rom } from './rom.ts';
import { type Level, hasLayer2Objects } from './level.ts';
import { BG_SIZE } from './bg.ts';
import { parseMap16File, exgfxName, type Map16File } from './map16file.ts';
import { BG_EXT_FIRST, BG_EXT_TILES, bgTileWords } from './bgmap16.ts';
import { EXT_FIRST, EXT_TILES } from './map16ext.ts';
import { gfxEntry, gfxDataSize } from './patches.ts';
import { LG_SLOT_NAMES, LT3_SLOT, GAME_LAYER3_GFX, fromLt3Nibble, type Lt3Place } from './layer3gfx.ts';
import { mwlExAnim } from './mwl.ts';
import { slotTiles, type ExSlot } from './exanim.ts';
import { isSongText } from './music.ts';
import {
  VRAM_SLOTS, slotOfWord, gfxNumber, fgOrigin, fgPlace, bgPlace, packPalettes, frameSources, putFgTiles, putBgTiles, storeGfx, placeInLevel,
  type PackPalette, type FrameSources,
} from './levelgfx.ts';

export const LM_SLOTS = ['AN2', 'LT3', 'BG3', 'BG2', 'FG3', 'BG1', 'FG2', 'FG1', 'SP4', 'SP3', 'SP2', 'SP1', 'LG4', 'LG3', 'LG2', 'LG1'];

export interface MwlLevel {
  bg: Uint16Array | null; // BG tiles in the editor's layout (bg.ts); null: layer 2 is not a BG tilemap
  palette: Uint16Array; // 256 colors
  back: number; // back area color
  gfx: Map<string, number>; // slot name → ExGFX number (Lunar Magic numbering, up to FFF)
  layer3: { gfx: boolean; map: boolean } & Lt3Place; // the layer 3 bypass: LG on, LT3 on, LT3's place
}

const u32 = (d: Uint8Array, o: number) => (o + 4 <= d.length ? (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0 : 0);

export function parseMwl(d: Uint8Array): MwlLevel {
  if (d.length < 0x80 || d[0] !== 0x4c || d[1] !== 0x4d) throw new Error('Not a Lunar Magic level file (.mwl)');
  const section = (i: number, header: number): Uint8Array | null => {
    const off = u32(d, 0x40 + i * 8), size = u32(d, 0x44 + i * 8);
    if (!off || size <= header || off + size > d.length) return null;
    return d.subarray(off + header, off + size);
  };
  const l2 = section(2, 8);
  let bg: Uint16Array | null = null;
  if (l2 && l2.length === 0x800) {
    bg = new Uint16Array(BG_SIZE);
    for (let half = 0; half < 2; half++) for (let y = 0; y < 27; y++) for (let x = 0; x < 16; x++) {
      const w = half * 0x200 + y * 16 + x;
      bg[half * 0x1b0 + y * 16 + x] = l2[w * 2] | (l2[w * 2 + 1] << 8);
    }
  }
  const pal = section(4, 8);
  const palette = new Uint16Array(256);
  let back = 0;
  if (pal && pal.length >= 512) {
    for (let i = 0; i < 256; i++) palette[i] = (pal[i * 2] | (pal[i * 2 + 1] << 8)) & 0x7fff;
    back = pal.length >= 514 ? (pal[512] | (pal[513] << 8)) & 0x7fff : palette[0];
  }
  const gfx = new Map<string, number>();
  const list = section(7, 0);
  const high = (s: string) => (list && list.length >= 32 ? list[LM_SLOTS.indexOf(s) * 2 + 1] >> 4 : 0);
  if (list && list.length >= 32) LM_SLOTS.forEach((s, i) => gfx.set(s, (list[i * 2] | (list[i * 2 + 1] << 8)) & 0xfff));
  const an2 = high('AN2');
  return { bg, palette, back, gfx, layer3: { gfx: !!(an2 & 4), map: !!(an2 & 2), ...fromLt3Nibble(high(LT3_SLOT)) } };
}

export type PackPart = 'fg' | 'bg' | 'layer3';

export interface BgPackGfx {
  file: string | null; // file in the package, null = a GFX file the ROM already has (vanilla number)
  slot: string; // FG1..BG3, LG1-LG4, LT3
  lmNum: number; // number in the package
  num: number; // ExGFX number it is stored as (the package's when free)
  parts: PackPart[]; // the parts whose tiles use the slot
  size?: number; // the file's size unpacked (gfxDataSize), with `file`
}

export interface BgPackPlan {
  name: string;
  mwl: string;
  level: MwlLevel;
  map16: { file: string; data: Map16File; from: number } | null; // BG Map16; from: first BG tile the file stands for
  fg: { file: string; data: Map16File; from: number } | null; // FG Map16; from: first tile it was exported from
  used: number[]; // BG tiles >= 200 the tilemap uses
  gfx: BgPackGfx[];
  palettes: PackPalette[];
  at: number; // suggested first BG tile for the BG Map16 tiles
  fgAt: number; // suggested first tile for the FG Map16 tiles
  layer3: Lt3Place | null; // layer 3 graphics or tilemap to take over, where LT3 goes
  exanim: { slot: ExSlot; parts: PackPart[] }[]; // ExAnimation slots writing tiles of the taken-over parts
  frames: FrameSources; // where they take their frames from
  notes: string[];
}

// a level import (see CONTEXT.md): an upload with a Lunar Magic level file (.mwl) and no code or songs
const dec = new TextDecoder();
export function isLevelImport(files: Map<string, Uint8Array>): boolean {
  const paths = [...files.keys()];
  return paths.some((f) => /\.mwl$/i.test(f)) && !paths.some((f) => /\.(asm|asar)$/i.test(f) || (/\.txt$/i.test(f) && isSongText(dec.decode(files.get(f)!))));
}

const base = (f: string) => f.split('/').pop()!;

// `blank`: tile words of an empty FG Map16 tile
export function planBgPack(rom: Rom, name: string, files: Map<string, Uint8Array>, blank: number[]): BgPackPlan {
  const keys = [...files.keys()];
  const mwl = keys.find((f) => /\.mwl$/i.test(f));
  if (!mwl) throw new Error('No .mwl file in the package');
  const level = parseMwl(files.get(mwl)!);
  const notes: string[] = [];
  const used = level.bg ? [...new Set(level.bg)].filter((t) => t >= BG_EXT_FIRST).sort((a, b) => a - b) : [];
  if (used.some((t) => t >= BG_EXT_TILES)) throw new Error('The BG tilemap uses tiles from 1000 on – the editor does not support that');
  // Map16 files: FG or BG as the file says; one that does not say is BG if the tilemap needs BG tiles
  const maps = keys.filter((f) => /\.map16$/i.test(f)).map((file) => ({ file, data: parseMap16File(files.get(file)!) }));
  let bgMap = level.bg ? maps.find((m) => m.data.origin?.bg) ?? null : null;
  let fgMap = maps.find((m) => m.data.origin && !m.data.origin.bg) ?? null;
  for (const m of maps) if (!m.data.origin) { if (!bgMap && used.length) bgMap = m; else if (!fgMap) fgMap = m; }
  const extra = maps.filter((m) => m !== bgMap && m !== fgMap);
  if (extra.length) notes.push(`Not used: ${extra.map((m) => base(m.file)).join(', ')}`);
  let map16: BgPackPlan['map16'] = null;
  if (bgMap) {
    const o = bgMap.data.origin?.tile;
    const from = o !== undefined && o >= BG_EXT_FIRST ? o : used.length ? used[0] & ~0xf : BG_EXT_FIRST;
    map16 = { file: bgMap.file, data: bgMap.data, from };
    const outside = used.filter((t) => t < from || t >= from + bgMap!.data.height * 16);
    if (outside.length) notes.push(`${outside.length} BG tile(s) of the tilemap are not in the .map16`);
  } else if (used.length) notes.push('No BG .map16 in the package – BG tiles from 200 on stay empty');
  const fg: BgPackPlan['fg'] = fgMap ? { file: fgMap.file, data: fgMap.data, from: fgOrigin(rom, fgMap.data, files.get(mwl)!) ?? EXT_FIRST } : null;
  // graphics slots: the ones the taken-over tiles use, with the package's file or the ROM's
  const need = new Map<string, Set<PackPart>>();
  const use = (w: number, p: PackPart) => { const s = slotOfWord(w); if (s) (need.get(s) ?? need.set(s, new Set()).get(s)!).add(p); };
  if (level.bg) {
    for (const t of new Set(level.bg)) if (t < BG_EXT_FIRST) for (const w of bgTileWords(rom, t)) use(w, 'bg');
    for (const ws of map16?.data.tiles ?? []) for (const w of ws) use(w, 'bg');
  }
  for (const ws of fg?.data.tiles ?? []) for (const w of ws) use(w, 'fg');
  const bins = new Map<number, string>();
  for (const f of keys) if (/\.bin$/i.test(f)) { const n = exgfxName(base(f)).num; if (n !== null) bins.set(n, f); }
  const gfx: BgPackGfx[] = [];
  const taken = new Set<number>();
  const byNum = new Map<number, number>(); // package number → stored number
  for (const slot of VRAM_SLOTS) {
    const lmNum = level.gfx.get(slot), parts = need.get(slot);
    if (lmNum === undefined || !parts) continue;
    const file = bins.get(lmNum) ?? null;
    if (!file) {
      // not in the package: the ROM's file, if it has it – only for the part's own slots (a background
      // does not change the level's FG graphics)
      const own = [...parts].filter((p) => slot.startsWith(p.toUpperCase()));
      if (own.length && lmNum !== 0x7f && gfxEntry(rom, lmNum)) gfx.push({ file: null, slot, lmNum, num: lmNum, parts: own });
      continue;
    }
    const size = gfxDataSize(files.get(file)!);
    let num = byNum.get(lmNum);
    if (num === undefined) {
      num = gfxNumber(rom, lmNum, taken, { slot, size });
      byNum.set(lmNum, num);
    }
    gfx.push({ file, slot, lmNum, num, parts: [...parts], size });
  }
  // ExAnimation: the level file's slots writing tiles the taken-over parts draw from, and the files they
  // take frames from
  const exanim: BgPackPlan['exanim'] = [];
  const drawn = { bg: new Set<number>(), fg: new Set<number>() };
  if (level.bg) {
    for (const t of new Set(level.bg)) if (t < BG_EXT_FIRST) for (const w of bgTileWords(rom, t)) drawn.bg.add(w & 0x3ff);
    for (const ws of map16?.data.tiles ?? []) for (const w of ws) drawn.bg.add(w & 0x3ff);
  }
  for (const ws of fg?.data.tiles ?? []) for (const w of ws) drawn.fg.add(w & 0x3ff);
  const list = mwlExAnim(files.get(mwl)!);
  for (const e of list?.slots.values() ?? []) {
    const parts = (['bg', 'fg'] as const).filter((p) => slotTiles(e).some((t) => drawn[p].has(t)));
    if (parts.length) exanim.push({ slot: e, parts });
  }
  const an2File = bins.get(level.gfx.get('AN2') ?? -1), altFile = list ? bins.get(0x60 + list.altFile) : undefined;
  const frames = exanim.length ? frameSources(files, list, an2File, altFile, notes) : { an2: null, alt: null };
  const sources = [an2File, altFile].filter((f) => f && exanim.length);
  // layer 3 (Lunar Magic's layer 3 bypass): the graphics files that are not the game's (LG1-LG4) and the
  // tilemap file (LT3), with the package's file or the ROM's
  const l3 = level.layer3;
  // (slot, the game's file there: none for LT3)
  const l3Slots = [...(l3.gfx ? LG_SLOT_NAMES.map((s, k) => [s, GAME_LAYER3_GFX + k] as const) : []), ...(l3.map ? [[LT3_SLOT, null] as const] : [])];
  for (const [slot, gameFile] of l3Slots) {
    const lmNum = level.gfx.get(slot);
    if (lmNum === undefined || lmNum === gameFile || lmNum === 0x7f) continue; // 7F: Lunar Magic's "no file"
    const file = bins.get(lmNum) ?? null;
    if (!file) { if (gfxEntry(rom, lmNum)) gfx.push({ file: null, slot, lmNum, num: lmNum, parts: ['layer3'] }); continue; }
    const size = gfxDataSize(files.get(file)!);
    let num = byNum.get(lmNum);
    if (num === undefined) { num = gfxNumber(rom, lmNum, taken, { slot, size }); byNum.set(lmNum, num); }
    gfx.push({ file, slot, lmNum, num, parts: ['layer3'], size });
  }
  const layer3 = gfx.some((g) => g.parts.includes('layer3')) ? { dest: l3.dest, size: l3.size } : null;
  const unused = [...bins].filter(([n, f]) => !byNum.has(n) && !sources.includes(f)).map(([, f]) => base(f));
  if (unused.length) notes.push(`Not used (no graphics slot of the taken-over tiles): ${unused.join(', ')}`);
  const palettes = packPalettes(files, keys.filter((f) => /\.pal$/i.test(f)), keys.filter((f) => /\.palmask$/i.test(f)), notes);
  const at = map16 ? bgPlace(rom, map16.data, map16.from, BG_EXT_FIRST) : BG_EXT_FIRST;
  const fgFree = fg ? fgPlace(rom, fg.data, fg.from, blank) : -1;
  if (fg && fgFree < 0) notes.push(`No free FG Map16 tiles for the ${fg.data.tiles.length} tiles of ${base(fg.file)} – the tiles from ${hx(fg.from, 3)} would be overwritten`);
  const fgAt = fgFree >= 0 ? fgFree : fg ? fg.from : EXT_FIRST;
  return { name, mwl, level, map16, fg, used, gfx, palettes, at, fgAt, layer3, exanim, frames, notes };
}

export interface BgPackOptions {
  bg?: boolean; // take over the background (default: if the package has one)
  layer3?: boolean; // take over the layer 3 graphics and tilemap (default: if the package has them)
  fg?: boolean; // take over the FG Map16 tiles (default: if the package has them)
  at?: number; // first BG tile for the BG .map16 tiles (default: the plan's)
  fgAt?: number; // first tile for the FG .map16 tiles (default: the plan's)
  palettes?: boolean[]; // per plan palette: take over its colors (default: all but layer 3 ones without layer 3)
  cgram: Uint8Array | null; // the level's current colors (levelColors), base for a new own palette (null: not known)
  wram?: Uint8Array; // the level's WRAM after its load: RAM frames of animations come along from it
  blank: number[]; // tile words of an empty FG Map16 tile
}

export interface BgPackResult { ok: boolean; errors: string[]; notes: string[]; bg: Uint16Array | null }

const hx = (v: number, d: number) => v.toString(16).toUpperCase().padStart(d, '0');

// A level import (see CONTEXT.md): what the plan takes from a Lunar Magic level file into level `lv` –
// background, FG Map16 tiles, graphics slots, colors. Ok false when it failed (run it in an edit session,
// romedit.ts, which puts the ROM back); it changes a level and is never recorded as a package.
export function importLevelFile(rom: Rom, lv: Level, files: Map<string, Uint8Array>, plan: BgPackPlan, opt: BgPackOptions): BgPackResult {
  return applyBgPack(rom, lv, files, plan, opt);
}

export function applyBgPack(rom: Rom, lv: Level, files: Map<string, Uint8Array>, plan: BgPackPlan, opt: BgPackOptions): BgPackResult {
  const notes: string[] = [];
  const lvl = lv.number;
  try {
    const withBg = !!plan.level.bg && opt.bg !== false, withFg = !!plan.fg && opt.fg !== false, withL3 = !!plan.layer3 && opt.layer3 !== false;
    if (!withBg && !withFg && !withL3) throw new Error('Nothing to take over');
    if (withBg && (lv.layer2Objects || hasLayer2Objects(lv.header.mode))) throw new Error(`Level ${hx(lvl, 3)} has layer 2 objects instead of a BG background`);
    // 1. BG Map16 tiles, the tilemap moved along
    let bg: Uint16Array | null = null;
    if (withBg) {
      bg = plan.level.bg!.slice();
      const at = opt.at ?? plan.at;
      if (plan.map16) {
        const m = plan.map16;
        if (at < BG_EXT_FIRST || at + m.data.height * 16 > BG_EXT_TILES || (at & 15) + Math.min(16, m.data.width) > 16) throw new Error(`The ${m.data.tiles.length} BG tiles do not fit on pages 2–F from ${hx(at, 3)} on`);
        putBgTiles(rom, m.data, at);
        const end = m.from + m.data.height * 16;
        for (let o = 0; o < bg.length; o++) if (bg[o] >= m.from && bg[o] < end) bg[o] = bg[o] - m.from + at;
        notes.push(`${m.data.tiles.length} BG tiles from ${hx(at, 3)}`);
      }
    }
    // 2. FG Map16 tiles (acts like pointing into the block moved along)
    if (withFg) {
      const f = plan.fg!, at = opt.fgAt ?? plan.fgAt;
      if (!f.data.tiles.length) throw new Error('The FG .map16 has no tiles');
      if (at < EXT_FIRST || at + f.data.height * 16 > EXT_TILES || (at & 15) + Math.min(16, f.data.width) > 16) throw new Error(`The ${f.data.tiles.length} FG tiles do not fit from ${hx(at, 3)} on (tiles 200–FFF)`);
      putFgTiles(rom, f.data, f.from, at);
      notes.push(`${f.data.tiles.length} FG Map16 tiles from ${hx(at, 3)}`);
    }
    // 3. graphics, then the level: its slots, animations and colors (each chosen package palette where
    // its mask says so)
    const taken = (parts: PackPart[]) => parts.some((p) => (p === 'bg' ? withBg : p === 'fg' ? withFg : withL3));
    const gfx = plan.gfx.filter((g) => taken(g.parts));
    notes.push(...storeGfx(rom, files, gfx));
    const placed = placeInLevel(rom, lvl, {
      slots: gfx,
      lt3: plan.layer3,
      palettes: plan.palettes.filter((p, i) => opt.palettes?.[i] ?? (!p.layer3 || withL3)),
      back: plan.level.back,
      exanim: plan.exanim.filter((x) => taken(x.parts)).map((x) => x.slot),
      frames: plan.frames,
    }, { cgram: opt.cgram, wram: opt.wram });
    notes.push(...placed.prints, ...placed.warnings);
    return { ok: true, errors: [], notes: [...notes, ...plan.notes], bg };
  } catch (e) {
    return { ok: false, errors: [e instanceof Error ? e.message : String(e)], notes, bg: null };
  }
}
