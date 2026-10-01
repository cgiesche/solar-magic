// Background packages as found on SMWCentral: a Lunar Magic level (.mwl) whose layer 2 is a BG
// tilemap, a .map16 file with its BG Map16 tiles (usually pages 2+), the ExGFX files of its BG slots and
// a .pal with a .palmask telling which colors belong to the background. Only the background is taken
// over into a level: tilemap, BG Map16 tiles (extended BG Map16, bgmap16.ts), GFX slots, masked colors.
//
// .mwl (as far as needed here): "LM" magic, at 0x40 a table of (offset, size) pairs (u32). Sections
// 1-4 start with 8 bytes of their own (flags, source address in the ROM it was exported from):
//  - 2: layer 2; a BG tilemap is 0x800 bytes = 0x400 tile words, two halves of 16 columns x 32 rows
//    (of which the game uses 27);
//  - 4: palette, 256 colors (BGR555) followed by the back area color;
//  - 7 (no header): ExGFX numbers of the 16 GFX slots, in Lunar Magic's order (LM_SLOTS).
// .palmask: 256 bytes, nonzero = the color is the package's, byte 256 = the back area color is.

import { Rom } from './rom.ts';
import { type Level, hasLayer2Objects } from './level.ts';
import { BG_SIZE } from './bg.ts';
import { parseMap16File, exgfxName, importGfxFile, type Map16File } from './map16file.ts';
import { BG_EXT_FIRST, BG_EXT_TILES, bgExtTileWords, vanillaBgWords, setBgExtTileWords, installBgMap16Ext } from './bgmap16.ts';
import {
  gfxEntry, hasEditorPatch, VANILLA_GFX, levelGfx, setLevelGfx, levelExtGfx, setLevelExtGfx, GFX_SLOT_NAMES,
  EXT_GFX_SLOT_NAMES, extGfxAvailable, customPalette, setCustomPalette,
} from './patches.ts';

export const LM_SLOTS = ['AN2', 'LT3', 'BG3', 'BG2', 'FG3', 'BG1', 'FG2', 'FG1', 'SP4', 'SP3', 'SP2', 'SP1', 'LG4', 'LG3', 'LG2', 'LG1'];
// slots taken over from the package (graphics of the level's FG/BG tiles; sprites and layer 3 stay)
const TILE_SLOTS = ['FG1', 'FG2', 'FG3', 'BG1', 'BG2', 'BG3'];

export interface MwlBackground {
  bg: Uint16Array; // BG tiles in the editor's layout (bg.ts)
  palette: Uint16Array; // 256 colors
  back: number; // back area color
  gfx: Map<string, number>; // slot name → ExGFX number (Lunar Magic numbering, up to FFF)
}

const u32 = (d: Uint8Array, o: number) => (o + 4 <= d.length ? (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0 : 0);

export function parseMwl(d: Uint8Array): MwlBackground {
  if (d.length < 0x80 || d[0] !== 0x4c || d[1] !== 0x4d) throw new Error('Keine Lunar-Magic-Leveldatei (.mwl)');
  const section = (i: number, header: number): Uint8Array | null => {
    const off = u32(d, 0x40 + i * 8), size = u32(d, 0x44 + i * 8);
    if (!off || size <= header || off + size > d.length) return null;
    return d.subarray(off + header, off + size);
  };
  const l2 = section(2, 8);
  if (!l2 || l2.length !== 0x800) throw new Error('Das Level der .mwl hat keinen BG-Hintergrund (Layer 2 ist keine BG-Tilemap)');
  const bg = new Uint16Array(BG_SIZE);
  for (let half = 0; half < 2; half++) for (let y = 0; y < 27; y++) for (let x = 0; x < 16; x++) {
    const w = half * 0x200 + y * 16 + x;
    bg[half * 0x1b0 + y * 16 + x] = l2[w * 2] | (l2[w * 2 + 1] << 8);
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

export interface BgPackGfx {
  file: string | null; // file in the package, null = a GFX file the ROM already has (vanilla number)
  slot: string; // FG1..BG3
  lmNum: number; // number in the package
  num: number; // ExGFX number it is stored as (00-FE)
}

export interface BgPackPlan {
  name: string;
  mwl: string;
  bg: MwlBackground;
  map16: { file: string; data: Map16File; from: number } | null; // from: first BG tile the file stands for
  used: number[]; // BG tiles >= 200 the tilemap uses
  gfx: BgPackGfx[];
  colors: number[] | null; // palette indices from the .palmask
  back: boolean; // the mask includes the back area color
  pal: Uint16Array; // the package's colors (.pal, else the .mwl palette)
  at: number; // suggested first BG tile for the .map16 tiles
  notes: string[];
}

export function isBgPackage(files: Map<string, Uint8Array>): boolean {
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

// first ExGFX number that is free and not taken by `taken`
function freeGfx(rom: Rom, taken: Set<number>): number {
  const free = (i: number) => !taken.has(i) && (!hasEditorPatch(rom) || !gfxEntry(rom, i));
  for (let i = 0x80; i < 0xff; i++) if (free(i)) return i;
  for (let i = VANILLA_GFX; i < 0x80; i++) if (free(i)) return i;
  return -1;
}

export function planBgPack(rom: Rom, name: string, files: Map<string, Uint8Array>): BgPackPlan {
  const keys = [...files.keys()];
  const mwl = keys.find((f) => /\.mwl$/i.test(f));
  if (!mwl) throw new Error('Keine .mwl-Datei im Paket');
  const bg = parseMwl(files.get(mwl)!);
  const notes: string[] = [];
  const used = [...new Set(bg.bg)].filter((t) => t >= BG_EXT_FIRST).sort((a, b) => a - b);
  if (used.some((t) => t >= BG_EXT_TILES)) throw new Error('Die BG-Tilemap benutzt Tiles ab 1000 – das unterstützt der Editor nicht');
  const mf = keys.find((f) => /\.map16$/i.test(f));
  let map16: BgPackPlan['map16'] = null;
  if (mf) {
    const data = parseMap16File(files.get(mf)!);
    const from = used.length ? used[0] & ~0xf : BG_EXT_FIRST;
    map16 = { file: mf, data, from };
    const outside = used.filter((t) => t < from || t >= from + data.height * 16);
    if (outside.length) notes.push(`${outside.length} BG-Tile(s) der Tilemap liegen nicht in der .map16`);
  } else if (used.length) notes.push('Keine .map16 im Paket – die BG-Tiles ab 200 bleiben leer');
  // ExGFX: the package's files by number, assigned to the slots the .mwl names
  const bins = new Map<number, string>();
  for (const f of keys) if (/\.bin$/i.test(f)) { const n = exgfxName(f.split('/').pop()!).num; if (n !== null) bins.set(n, f); }
  const gfx: BgPackGfx[] = [];
  const taken = new Set<number>();
  const byNum = new Map<number, number>(); // package number → stored number
  for (const slot of TILE_SLOTS) {
    const lmNum = bg.gfx.get(slot);
    if (lmNum === undefined) continue;
    const file = bins.get(lmNum) ?? null;
    if (!file) {
      // not in the package: only the BG slots matter, and only if the ROM has that file
      if (slot.startsWith('BG') && lmNum !== 0x7f && lmNum <= 0xff && gfxEntry(rom, lmNum)) gfx.push({ file: null, slot, lmNum, num: lmNum });
      continue;
    }
    let num = byNum.get(lmNum);
    if (num === undefined) {
      num = lmNum < 0xff && lmNum >= VANILLA_GFX && (!hasEditorPatch(rom) || !gfxEntry(rom, lmNum)) && !taken.has(lmNum) ? lmNum : freeGfx(rom, taken);
      if (num < 0) throw new Error('Keine freie ExGFX-Nummer mehr');
      taken.add(num);
      byNum.set(lmNum, num);
    }
    gfx.push({ file, slot, lmNum, num });
  }
  const unused = [...bins].filter(([n]) => !byNum.has(n)).map(([, f]) => f.split('/').pop());
  if (unused.length) notes.push(`Nicht benutzt (kein Grafik-Slot im Level): ${unused.join(', ')}`);
  // colors
  const pf = keys.find((f) => /\.pal$/i.test(f)), mk = keys.find((f) => /\.palmask$/i.test(f));
  const pal = bg.palette.slice();
  const pd = pf ? files.get(pf)! : null;
  if (pd && pd.length >= 768) for (let i = 0; i < 256; i++) pal[i] = (pd[i * 3] >> 3) | ((pd[i * 3 + 1] >> 3) << 5) | ((pd[i * 3 + 2] >> 3) << 10);
  let colors: number[] | null = null, back = false;
  if (mk) {
    const m = files.get(mk)!;
    colors = Array.from({ length: 256 }, (_, i) => i).filter((i) => i > 0 && m[i]);
    back = m.length > 256 && m[256] !== 0;
  } else notes.push('Keine .palmask im Paket – die Palette bleibt, wie sie ist');
  let at = map16 ? map16.from : BG_EXT_FIRST;
  const n = map16 ? map16.data.height * 16 : 0;
  if (n && !freeBgTiles(rom, at, n)) {
    at = -1;
    for (let a = BG_EXT_FIRST; a + n <= BG_EXT_TILES && at < 0; a += 16) if (freeBgTiles(rom, a, n)) at = a;
    if (at < 0) at = map16!.from;
  }
  return { name, mwl, bg, map16, used, gfx, colors, back, pal, at, notes };
}

export interface BgPackOptions {
  at?: number; // first BG tile for the .map16 tiles (default: the plan's)
  palette?: boolean; // take over the masked colors (default true)
  cgram: Uint8Array; // the level's current colors (512 bytes), base for a new own palette
}

export interface BgPackResult { ok: boolean; errors: string[]; notes: string[]; bg: Uint16Array | null }

export function applyBgPack(rom: Rom, lv: Level, files: Map<string, Uint8Array>, plan: BgPackPlan, opt: BgPackOptions): BgPackResult {
  const snapshot = rom.data.slice();
  const notes: string[] = [];
  const lvl = lv.number, hx = (v: number, d: number) => v.toString(16).toUpperCase().padStart(d, '0');
  try {
    if (lv.layer2Objects || hasLayer2Objects(lv.header.mode)) throw new Error(`Level ${hx(lvl, 3)} hat Layer-2-Objekte statt eines BG-Hintergrunds`);
    const at = opt.at ?? plan.at;
    // 1. BG Map16 tiles, the tilemap moved along
    const bg = plan.bg.bg.slice();
    if (plan.map16) {
      const m = plan.map16;
      if (at < BG_EXT_FIRST || at + m.data.height * 16 > BG_EXT_TILES || (at & 15) + Math.min(16, m.data.width) > 16) throw new Error(`Die ${m.data.tiles.length} BG-Tiles passen ab ${hx(at, 3)} nicht auf die Seiten 2–F`);
      installBgMap16Ext(rom);
      m.data.tiles.forEach((ws, i) => setBgExtTileWords(rom, at + Math.floor(i / m.data.width) * 16 + (i % m.data.width), ws));
      const end = m.from + m.data.height * 16;
      for (let o = 0; o < bg.length; o++) if (bg[o] >= m.from && bg[o] < end) bg[o] = bg[o] - m.from + at;
      notes.push(`${m.data.tiles.length} BG-Tiles ab ${hx(at, 3)}`);
    } else if (plan.used.length) installBgMap16Ext(rom);
    // 2. graphics and the level's slots
    const std = levelGfx(rom, lvl), ext = levelExtGfx(rom, lvl);
    let extSet = false;
    const stored = new Map<string, number>();
    for (const g of plan.gfx) {
      if (g.file && !stored.has(g.file)) {
        const what = importGfxFile(rom, g.num, files.get(g.file)!);
        stored.set(g.file, g.num);
        notes.push(`${g.file.split('/').pop()} als ExGFX ${hx(g.num, 2)} (${what})`);
      }
      const e = EXT_GFX_SLOT_NAMES.indexOf(g.slot), s = GFX_SLOT_NAMES.indexOf(g.slot);
      if (e >= 0) {
        if (!extGfxAvailable(rom)) { notes.push(`${g.slot}-Slot nicht verfügbar (VRAM-Patch fehlt) – Grafik ${hx(g.num, 2)} wird noch nicht geladen`); continue; }
        ext[e] = g.num; extSet = true;
      } else if (s >= 0) std[s] = g.num;
    }
    if (plan.gfx.some((g) => GFX_SLOT_NAMES.includes(g.slot))) setLevelGfx(rom, lvl, std);
    if (extSet) setLevelExtGfx(rom, lvl, ext);
    const slots = plan.gfx.filter((g) => (g.slot !== 'BG2' && g.slot !== 'BG3') || extSet).map((g) => `${g.slot} = ${hx(g.num, 2)}`);
    if (slots.length) notes.push(`Grafik-Slots: ${slots.join(', ')}`);
    // 3. colors: the level's own palette, the package's colors where the mask says so
    if (plan.colors && opt.palette !== false && (plan.colors.length || plan.back)) {
      const own = customPalette(rom, lvl);
      const pal = own ? rom.bytes(own, 512).slice() : opt.cgram.slice(0, 512);
      const put = (i: number, c: number) => { pal[i * 2] = c & 0xff; pal[i * 2 + 1] = c >> 8; };
      for (const i of plan.colors) put(i, plan.pal[i]);
      if (plan.back) put(0, plan.bg.back);
      setCustomPalette(rom, lvl, pal);
      notes.push(`${plan.colors.length} Farbe(n)${plan.back ? ' und die Hintergrundfarbe' : ''} übernommen`);
    }
    return { ok: true, errors: [], notes: [...notes, ...plan.notes], bg };
  } catch (e) {
    rom.data = snapshot;
    return { ok: false, errors: [e instanceof Error ? e.message : String(e)], notes, bg: null };
  }
}
