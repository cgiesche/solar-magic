// Lunar Magic graphics packages as found on SMWCentral (the graphics section's submission format): a
// sample level (.mwl), the Map16 tiles it uses (.map16, FG and/or BG), the ExGFX files of its graphics
// slots and palettes as .pal with a .palmask telling which colors belong to the package. Taken over
// into a level: the BG tilemap with its BG Map16 tiles, the FG Map16 tiles (to place them), the
// graphics slots those tiles use, the masked colors. The sample level's layer 1 and sprites stay out.
// Which .map16 is which comes from the file (Map16File.origin), what a palette covers from its mask.
//
// .mwl (as far as needed here): "LM" magic, at 0x40 a table of (offset, size) pairs (u32). Sections
// 1-4 start with 8 bytes of their own (flags, source address in the ROM it was exported from):
//  - 2: layer 2; a BG tilemap is 0x800 bytes = 0x400 tile words, two halves of 16 columns x 32 rows
//    (of which the game uses 27);
//  - 4: palette, 256 colors (BGR555) followed by the back area color;
//  - 7 (no header): ExGFX numbers of the 16 GFX slots, in Lunar Magic's order (LM_SLOTS); LT3 is a
//    layer 3 tilemap file, LG1-LG4 the layer 3 graphics (vanilla 28-2B).
// .palmask: 256 bytes, nonzero = the color is the package's, byte 256 = the back area color is.

import { Rom } from './rom.ts';
import { type Level, hasLayer2Objects } from './level.ts';
import { BG_SIZE } from './bg.ts';
import { parseMap16File, map16Targets, exgfxName, importGfxFile, type Map16File } from './map16file.ts';
import { BG_EXT_FIRST, BG_EXT_TILES, bgExtTileWords, vanillaBgWords, setBgExtTileWords, installBgMap16Ext, bgTileWords } from './bgmap16.ts';
import { EXT_FIRST, EXT_TILES, DEFAULT_ACTS, extTileWords, actsLike, setExtTileWords, setActsLike } from './map16ext.ts';
import {
  gfxEntry, hasEditorPatch, VANILLA_GFX, levelGfx, setLevelGfx, levelExtGfx, setLevelExtGfx, GFX_SLOT_NAMES,
  EXT_GFX_SLOT_NAMES, extGfxAvailable, customPalette, setCustomPalette, setLevelAn2,
} from './patches.ts';
import { mwlExAnim } from './mwl.ts';
import { slotTiles, usesAltFile, framesPastAn2, addLevelSlots, type ExSlot } from './exanim.ts';
import { RAM } from './ram.ts';
import { installVramPatch } from './vrampatch.ts';

export const LM_SLOTS = ['AN2', 'LT3', 'BG3', 'BG2', 'FG3', 'BG1', 'FG2', 'FG1', 'SP4', 'SP3', 'SP2', 'SP1', 'LG4', 'LG3', 'LG2', 'LG1'];
const LAYER3_SLOTS = ['LT3', 'LG1', 'LG2', 'LG3', 'LG4'];
// the slot an 8x8 tile number (tile word bits 0-9) is loaded from: 80 tiles per slot in VRAM order
// (BG2/BG3 with the VRAM patch, patches.ts)
const VRAM_SLOTS = ['FG1', 'FG2', 'BG1', 'FG3', 'BG2', 'BG3'];
export const slotOfWord = (w: number) => VRAM_SLOTS[(w & 0x3ff) >> 7] ?? null;

export interface MwlLevel {
  bg: Uint16Array | null; // BG tiles in the editor's layout (bg.ts); null: layer 2 is not a BG tilemap
  palette: Uint16Array; // 256 colors
  back: number; // back area color
  gfx: Map<string, number>; // slot name → ExGFX number (Lunar Magic numbering, up to FFF)
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
  if (list && list.length >= 32) LM_SLOTS.forEach((s, i) => gfx.set(s, (list[i * 2] | (list[i * 2 + 1] << 8)) & 0xfff));
  return { bg, palette, back, gfx };
}

export type PackPart = 'fg' | 'bg';

export interface BgPackGfx {
  file: string | null; // file in the package, null = a GFX file the ROM already has (vanilla number)
  slot: string; // FG1..BG3, AN2 (ExAnimation's frames)
  lmNum: number; // number in the package
  num: number; // ExGFX number it is stored as (00-FE)
  parts: PackPart[]; // the parts whose tiles use the slot
}

export interface PackPalette {
  file: string; // .pal
  mask: string; // .palmask
  colors: number[]; // palette indices the mask gives (not 0)
  back: boolean; // the mask includes the back area color
  pal: Uint16Array; // the file's colors
  layer3: boolean; // only colors 0-31, the 2bpp palettes of layer 3
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
  layer3: string[]; // the package's layer 3 files (not taken over)
  exanim: { slot: ExSlot; parts: PackPart[] }[]; // ExAnimation slots writing tiles of the taken-over parts
  notes: string[];
}

export function isLevelImport(files: Map<string, Uint8Array>): boolean {
  return [...files.keys()].some((f) => /\.mwl$/i.test(f));
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

// tiles of an extended FG Map16 block (width x height from `at`) are still empty
function freeFgTiles(rom: Rom, f: Map16File, at: number, blank: number[]): boolean {
  if ((at & 15) + Math.min(16, f.width) > 16) return false;
  return map16Targets(f, at).every((t) => {
    if (t < EXT_FIRST || t >= EXT_TILES) return false;
    const w = extTileWords(rom, t);
    return !w || (w.every((v, k) => v === blank[k]) && actsLike(rom, t) === DEFAULT_ACTS);
  });
}

// first ExGFX number that is free and not taken by `taken`
function freeGfx(rom: Rom, taken: Set<number>): number {
  const free = (i: number) => !taken.has(i) && (!hasEditorPatch(rom) || !gfxEntry(rom, i));
  for (let i = 0x80; i < 0xff; i++) if (free(i)) return i;
  for (let i = VANILLA_GFX; i < 0x80; i++) if (free(i)) return i;
  return -1;
}

const base = (f: string) => f.split('/').pop()!;
const stem = (f: string) => f.replace(/\.[^./]*$/, '').toLowerCase();

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
  const fg: BgPackPlan['fg'] = fgMap ? { file: fgMap.file, data: fgMap.data, from: fgMap.data.origin?.tile ?? EXT_FIRST } : null;
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
      if (own.length && lmNum !== 0x7f && lmNum <= 0xff && gfxEntry(rom, lmNum)) gfx.push({ file: null, slot, lmNum, num: lmNum, parts: own });
      continue;
    }
    let num = byNum.get(lmNum);
    if (num === undefined) {
      num = lmNum < 0xff && lmNum >= VANILLA_GFX && (!hasEditorPatch(rom) || !gfxEntry(rom, lmNum)) && !taken.has(lmNum) ? lmNum : freeGfx(rom, taken);
      if (num < 0) throw new Error('No free ExGFX number left');
      taken.add(num);
      byNum.set(lmNum, num);
    }
    gfx.push({ file, slot, lmNum, num, parts: [...parts] });
  }
  // ExAnimation: the level file's slots writing tiles the taken-over parts draw from, and its AN2 file
  // they take frames from
  const exanim: BgPackPlan['exanim'] = [];
  const drawn = { bg: new Set<number>(), fg: new Set<number>() };
  if (level.bg) {
    for (const t of new Set(level.bg)) if (t < BG_EXT_FIRST) for (const w of bgTileWords(rom, t)) drawn.bg.add(w & 0x3ff);
    for (const ws of map16?.data.tiles ?? []) for (const w of ws) drawn.bg.add(w & 0x3ff);
  }
  for (const ws of fg?.data.tiles ?? []) for (const w of ws) drawn.fg.add(w & 0x3ff);
  for (const e of mwlExAnim(files.get(mwl)!)?.slots.values() ?? []) {
    const parts = (['bg', 'fg'] as PackPart[]).filter((p) => slotTiles(e).some((t) => drawn[p].has(t)));
    if (!parts.length) continue;
    if (usesAltFile(e)) { notes.push('An ExAnimation slot takes its frames from an alternative file (ExGFX 60-63) – not taken over'); continue; }
    if (framesPastAn2(e)) notes.push('An ExAnimation slot takes frames past the first 3 KB of AN2 – the editor keeps the BG tilemap there, so they show something else');
    exanim.push({ slot: e, parts });
  }
  const an2 = level.gfx.get('AN2');
  const an2File = an2 !== undefined ? bins.get(an2) : undefined;
  if (exanim.length && an2 !== undefined && an2File) {
    let num = byNum.get(an2);
    if (num === undefined) {
      num = an2 < 0xff && an2 >= VANILLA_GFX && (!hasEditorPatch(rom) || !gfxEntry(rom, an2)) && !taken.has(an2) ? an2 : freeGfx(rom, taken);
      if (num < 0) throw new Error('No free ExGFX number left');
      taken.add(num);
      byNum.set(an2, num);
    }
    if (files.get(an2File)!.length !== 0x1000) notes.push(`${base(an2File)} cannot be AN2: only uncompressed 4bpp files (4 KB) can`);
    else gfx.push({ file: an2File, slot: 'AN2', lmNum: an2, num, parts: [...new Set(exanim.flatMap((x) => x.parts))] });
  }
  // layer 3 (a tilemap file and its graphics, Lunar Magic's layer 3 bypass): not taken over
  const layer3 = [...new Set(LAYER3_SLOTS.map((s) => bins.get(level.gfx.get(s) ?? -1)).filter((f): f is string => !!f))];
  const unused = [...bins].filter(([n, f]) => !byNum.has(n) && !layer3.includes(f)).map(([, f]) => base(f));
  if (unused.length) notes.push(`Not used (no graphics slot of the taken-over tiles): ${unused.join(', ')}`);
  const palettes = packPalettes(files, keys.filter((f) => /\.pal$/i.test(f)), keys.filter((f) => /\.palmask$/i.test(f)), notes);
  let at = map16 ? map16.from : BG_EXT_FIRST;
  const n = map16 ? map16.data.height * 16 : 0;
  if (n && !freeBgTiles(rom, at, n)) {
    at = -1;
    for (let a = BG_EXT_FIRST; a + n <= BG_EXT_TILES && at < 0; a += 16) if (freeBgTiles(rom, a, n)) at = a;
    if (at < 0) at = map16!.from;
  }
  let fgAt = fg ? fg.from : EXT_FIRST;
  if (fg && !freeFgTiles(rom, fg.data, fgAt, blank)) {
    let a = EXT_FIRST;
    while (a + fg.data.height * 16 <= EXT_TILES && !freeFgTiles(rom, fg.data, a, blank)) a += 16;
    if (a + fg.data.height * 16 <= EXT_TILES) fgAt = a;
  }
  return { name, mwl, level, map16, fg, used, gfx, palettes, at, fgAt, layer3, exanim, notes };
}

// the level's colors as a custom palette would hold them: CGRAM, color 0 = back area color ($0701)
export function levelColors(r: { cgram: Uint8Array; wram: Uint8Array }): Uint8Array {
  const pal = r.cgram.slice(0, 512);
  pal[0] = r.wram[RAM.backdrop]; pal[1] = r.wram[RAM.backdrop + 1] & 0x7f;
  return pal;
}

export interface BgPackOptions {
  bg?: boolean; // take over the background (default: if the package has one)
  fg?: boolean; // take over the FG Map16 tiles (default: if the package has them)
  at?: number; // first BG tile for the BG .map16 tiles (default: the plan's)
  fgAt?: number; // first tile for the FG .map16 tiles (default: the plan's)
  palettes?: boolean[]; // per plan palette: take over its colors (default: all but layer 3 ones)
  cgram: Uint8Array; // the level's current colors (levelColors), base for a new own palette
  blank: number[]; // tile words of an empty FG Map16 tile
}

export interface BgPackResult { ok: boolean; errors: string[]; notes: string[]; bg: Uint16Array | null }

const hx = (v: number, d: number) => v.toString(16).toUpperCase().padStart(d, '0');

// A level import (see CONTEXT.md): what the plan takes from a Lunar Magic level file into level `lv` –
// background, FG Map16 tiles, graphics slots, colors. Installs the VRAM patch first when it uses the
// BG2/BG3 slots. All or nothing; it changes a level and is never recorded as a package.
export function importLevelFile(rom: Rom, lv: Level, files: Map<string, Uint8Array>, plan: BgPackPlan, opt: BgPackOptions): BgPackResult {
  const before = rom.snapshot();
  if ((plan.gfx.some((g) => g.slot === 'BG2' || g.slot === 'BG3') || plan.exanim.some((x) => slotTiles(x.slot).some((t) => t >= 0x200 && t < 0x300))) && !extGfxAvailable(rom)) {
    const v = installVramPatch(rom);
    if (!v.ok) return { ok: false, errors: v.errors, notes: [], bg: null };
  }
  const r = applyBgPack(rom, lv, files, plan, opt);
  if (!r.ok) rom.restore(before);
  return r;
}

export function applyBgPack(rom: Rom, lv: Level, files: Map<string, Uint8Array>, plan: BgPackPlan, opt: BgPackOptions): BgPackResult {
  const snapshot = rom.snapshot();
  const notes: string[] = [];
  const lvl = lv.number;
  try {
    const withBg = !!plan.level.bg && opt.bg !== false, withFg = !!plan.fg && opt.fg !== false;
    if (!withBg && !withFg) throw new Error('Nothing to take over');
    if (withBg && (lv.layer2Objects || hasLayer2Objects(lv.header.mode))) throw new Error(`Level ${hx(lvl, 3)} has layer 2 objects instead of a BG background`);
    // 1. BG Map16 tiles, the tilemap moved along
    let bg: Uint16Array | null = null;
    if (withBg) {
      bg = plan.level.bg!.slice();
      const at = opt.at ?? plan.at;
      if (plan.map16) {
        const m = plan.map16;
        if (at < BG_EXT_FIRST || at + m.data.height * 16 > BG_EXT_TILES || (at & 15) + Math.min(16, m.data.width) > 16) throw new Error(`The ${m.data.tiles.length} BG tiles do not fit on pages 2–F from ${hx(at, 3)} on`);
        installBgMap16Ext(rom);
        m.data.tiles.forEach((ws, i) => setBgExtTileWords(rom, at + Math.floor(i / m.data.width) * 16 + (i % m.data.width), ws));
        const end = m.from + m.data.height * 16;
        for (let o = 0; o < bg.length; o++) if (bg[o] >= m.from && bg[o] < end) bg[o] = bg[o] - m.from + at;
        notes.push(`${m.data.tiles.length} BG tiles from ${hx(at, 3)}`);
      } else if (plan.used.length) installBgMap16Ext(rom);
    }
    // 2. FG Map16 tiles (acts like pointing into the block moved along)
    if (withFg) {
      const f = plan.fg!, at = opt.fgAt ?? plan.fgAt;
      if (!f.data.tiles.length) throw new Error('The FG .map16 has no tiles');
      if (at < EXT_FIRST || at + f.data.height * 16 > EXT_TILES || (at & 15) + Math.min(16, f.data.width) > 16) throw new Error(`The ${f.data.tiles.length} FG tiles do not fit from ${hx(at, 3)} on (tiles 200–FFF)`);
      const targets = map16Targets(f.data, at), from = map16Targets(f.data, f.from);
      targets.forEach((t, i) => {
        setExtTileWords(rom, t, f.data.tiles[i], opt.blank);
        const a = f.data.acts?.[i];
        if (a !== undefined) { const k = from.indexOf(a); setActsLike(rom, t, k >= 0 ? targets[k] : a, opt.blank); }
      });
      notes.push(`${f.data.tiles.length} FG Map16 tiles from ${hx(at, 3)}`);
    }
    // 3. graphics and the level's slots
    const std = levelGfx(rom, lvl), ext = levelExtGfx(rom, lvl);
    let stdSet = false, extSet = false;
    const stored = new Map<string, number>();
    const slots: string[] = [];
    for (const g of plan.gfx) {
      if (!g.parts.some((p) => (p === 'bg' ? withBg : withFg))) continue;
      if (g.file && !stored.has(g.file)) {
        const what = importGfxFile(rom, g.num, files.get(g.file)!);
        stored.set(g.file, g.num);
        notes.push(`${base(g.file)} as ExGFX ${hx(g.num, 2)} (${what})`);
      }
      const e = EXT_GFX_SLOT_NAMES.indexOf(g.slot), s = GFX_SLOT_NAMES.indexOf(g.slot);
      if (e >= 0) {
        if (!extGfxAvailable(rom)) { notes.push(`${g.slot} slot not available (VRAM patch missing) – graphics ${hx(g.num, 2)} not loaded yet`); continue; }
        ext[e] = g.num; extSet = true;
      } else if (s >= 0) { std[s] = g.num; stdSet = true; } else if (g.slot === 'AN2') setLevelAn2(rom, lvl, g.num);
      slots.push(`${g.slot} = ${hx(g.num, 2)}`);
    }
    const anim = plan.exanim.filter((x) => x.parts.some((p) => (p === 'bg' ? withBg : withFg))).map((x) => x.slot);
    if (anim.length) notes.push(`ExAnimation slot(s) ${addLevelSlots(rom, lvl, anim).map((k) => hx(k, 2)).join(', ')}`);
    if (stdSet) setLevelGfx(rom, lvl, std);
    if (extSet) setLevelExtGfx(rom, lvl, ext);
    if (slots.length) notes.push(`Graphics slots: ${slots.join(', ')}`);
    // 4. colors: the level's own palette, each chosen package palette where its mask says so
    const chosen = plan.palettes.filter((p, i) => opt.palettes?.[i] ?? !p.layer3);
    if (chosen.length) {
      const own = customPalette(rom, lvl);
      const pal = own ? rom.bytes(own, 512).slice() : opt.cgram.slice(0, 512);
      const put = (i: number, c: number) => { pal[i * 2] = c & 0xff; pal[i * 2 + 1] = c >> 8; };
      for (const p of chosen) {
        for (const i of p.colors) put(i, p.pal[i]);
        if (p.back) put(0, plan.level.back);
        notes.push(`${p.colors.length} color(s)${p.back ? ' and the background color' : ''} from ${base(p.file)}`);
      }
      setCustomPalette(rom, lvl, pal);
    }
    return { ok: true, errors: [], notes: [...notes, ...plan.notes], bg };
  } catch (e) {
    rom.restore(snapshot);
    return { ok: false, errors: [e instanceof Error ? e.message : String(e)], notes, bg: null };
  }
}
