// Where Map16 tiles, GFX files and sprites are used across the ROM's levels ("Used in levels …", like
// Lunar Magic's "Analyze Resources in Levels", LM help: file_analyze_levels.htm), and what is defined or
// inserted but used nowhere.
// - The Map16 tiles a level places are learned by loading it in the emulator (an emulated result): its
//   layer 1/2 tiles with the object that put each there (object, Direct Map16, structure) and the tiles
//   of its BG tilemap. Kept in the result cache per level, valid while the ROM bytes the load read and
//   the level's data (fed to the load as an overlay, see LevelOverride) are unchanged.
// - Links of a tile outside the levels: tiles acting like it, structures holding it, blocks on it.
// - GFX slots (gfxslots.ts) and sprites are read from the ROM.

import { snesToPc, type Rom } from './rom.ts';
import type { ResultCache } from './romdeps.ts';
import type { LevelEmulator, LevelRender, LevelOverride } from './levelemu.ts';
import { OV_L1, OV_L2, MAP_BASE } from './levelemu.ts';
import {
  L1_PTRS, loadLevel, serializeLayer1, serializeLayer2, levelRows, parsePrimaryHeader, spriteId, type Level, type LevelObject, type PrimaryHeader,
} from './level.ts';
import { layerGeom } from './render.ts';
import { bgFromWram, BG_SIZE } from './bg.ts';
import { map16Tile } from './ram.ts';
import { flagBytes, usedFlags, structTiles } from './cdm16.ts';
import { DM16_EXT, VANILLA_GFX, GFX_FILES, gfxEntry } from './patches.ts';
import { STRUCT_EXT, listStructures } from './structs.ts';
import { EXT_FIRST, EXT_TILES, actsLike, extTileWords, DEFAULT_ACTS } from './map16ext.ts';
import { loadBlockProject } from './blocks.ts';
import { levelSlots, type GfxSlot } from './gfxslots.ts';

// levels with data of their own: the game's (000-024, 101-13B) and those whose layer 1 data was moved
// into the expanded ROM
export function usedLevels(rom: Rom): number[] {
  const out: number[] = [];
  for (let i = 0; i < 512; i++) if (i <= 0x24 || (i >= 0x101 && i <= 0x13b) || snesToPc(rom.r24(L1_PTRS + i * 3)) >= 0x80000) out.push(i);
  return out;
}

// ---------- Map16 tiles in levels (emulated) ----------

export type TileSource = 'object' | 'direct' | 'structure';
export const TILE_SOURCES: Record<TileSource, string> = { object: 'object', direct: 'Direct Map16', structure: 'structure' };
// a tile placed in a layer by one kind of object: how often, and its first place (level tile, columns first)
export interface TileUse { tile: number; layer: 1 | 2; source: TileSource; count: number; x: number; y: number }
// a tile of the BG tilemap (32×27 tiles)
export interface BgTileUse { tile: number; count: number; x: number; y: number }
export interface LevelTiles {
  level: number;
  tileset: number; // tiles 073-0FF are the tileset's (shared with others, see tilesets.ts)
  ok: boolean; // false: the level did not load
  fg: TileUse[];
  bg: BgTileUse[];
}

const sourceOf = (o: LevelObject | undefined): TileSource =>
  o?.num === 0 && o.ext === DM16_EXT ? 'direct' : o?.num === 0 && o.ext === STRUCT_EXT ? 'structure' : 'object';

// The tiles of a level from its emulated load, which was given the level's objects with their owners
// (LevelOverride.byteOwner: layer 1 object index, layer 2 0x8000 | index). Tiles no object wrote are left out.
export function levelTilesOf(rom: Rom, lv: Level, r: LevelRender): LevelTiles {
  const fg = new Map<string, TileUse>(), bg = new Map<number, BgTileUse>();
  const rows = levelRows(lv.secondary);
  ([[1, lv.objects], [2, lv.layer2Objects]] as const).forEach(([layer, objs]) => {
    if (!objs) return;
    const g = layerGeom(rom, layer - 1, lv.header.mode, lv.header.screens, rows);
    for (let x = 0; x < g.width; x++) for (let y = 0; y < g.height; y++) {
      const a = g.addr(x, y);
      const k = a < 0 ? -1 : r.owner[a - MAP_BASE];
      if (k < 0 || (k >= 0x8000 ? 2 : 1) !== layer) continue;
      const tile = map16Tile(r.wram, a), source = sourceOf(objs[k & 0x7fff]);
      const id = `${tile}:${layer}:${source}`;
      const u = fg.get(id);
      if (u) u.count++; else fg.set(id, { tile, layer, source, count: 1, x, y });
    }
  });
  if (!lv.layer2Objects) {
    const map = bgFromWram(r.wram);
    for (let o = 0; o < BG_SIZE; o++) {
      const u = bg.get(map[o]);
      if (u) u.count++; else bg.set(map[o], { tile: map[o], count: 1, x: Math.floor(o / 0x1b0) * 16 + (o & 15), y: (o % 0x1b0) >> 4 });
    }
  }
  return { level: lv.number, tileset: lv.header.tileset, ok: r.ok, fg: [...fg.values()], bg: [...bg.values()] };
}

// The tiles a level can place: loaded with its conditional Direct Map16 flags off and, when it has any (cdm16.ts),
// once more with them all on – every conditional object shown in both of its states (`ov`: levelOverride's)
export function levelTilesAll(rom: Rom, lv: Level, load: (ov: LevelOverride) => LevelRender, ov: LevelOverride): LevelTiles {
  const off = levelTilesOf(rom, lv, load({ ...ov, cdm16Flags: flagBytes([]) }));
  const flags = usedFlags(rom, lv);
  return flags.size ? mergeTiles(off, levelTilesOf(rom, lv, load({ ...ov, cdm16Flags: flagBytes(flags.keys()) }))) : off;
}
// the uses of both (of a use in both, the first's, with the larger count)
export function mergeTiles(a: LevelTiles, b: LevelTiles): LevelTiles {
  const key = (u: TileUse) => `${u.tile}:${u.layer}:${u.source}`;
  const fg = new Map(a.fg.map((u) => [key(u), { ...u }]));
  for (const u of b.fg) { const v = fg.get(key(u)); if (v) v.count = Math.max(v.count, u.count); else fg.set(key(u), u); }
  return { ...a, ok: a.ok && b.ok, fg: [...fg.values()] };
}

// the level's objects as the emulator loads them, with their owners
export function levelOverride(rom: Rom, lv: Level): LevelOverride {
  const owners1: number[] = [], owners2: number[] = [];
  const l1 = serializeLayer1(rom, lv, owners1), l2 = serializeLayer2(rom, lv, owners2);
  const byteOwner = new Int32Array(0x10000).fill(-1);
  owners1.forEach((o, i) => (byteOwner[OV_L1 + i] = o));
  owners2.forEach((o, i) => (byteOwner[OV_L2 + i] = o < 0 ? -1 : 0x8000 | o));
  return { layer1: l1, layer2: l2 ?? undefined, layer2Pointer: l2 ? undefined : lv.layer2Pointer, byteOwner };
}

// the level data a load is given, as a 64-bit hash (two 32-bit ones)
function hashOf(ov: LevelOverride): string {
  let a = 0x811c9dc5, c = 0x2545f491;
  const add = (v: number) => { a = Math.imul(a ^ v, 0x01000193); c = Math.imul(c ^ v, 0xc2b2ae35) ^ (c >>> 13); };
  for (const b of [ov.layer1, ov.layer2, Uint8Array.of(ov.layer2Pointer ?? 0, (ov.layer2Pointer ?? 0) >> 8, (ov.layer2Pointer ?? 0) >> 16)]) {
    if (!b) { add(0x100); continue; }
    for (let i = 0; i < b.length; i++) add(b[i]);
    add(0x200 | (b.length & 0xff)); add(b.length >> 8);
  }
  return `${(a >>> 0).toString(16)}.${(c >>> 0).toString(16)}`;
}

export const levelTilesKey = (n: number) => `lu1:${n}`;
interface Stored { data: string; tiles: LevelTiles } // data: the hash of the level data it was learned from

// The tiles of the ROM's levels as saved, learned a level at a time (scan) and kept in the result cache.
export class LevelUses {
  private rom: Rom;
  private results: ResultCache;
  private emu: () => LevelEmulator;
  private inputs = { gen: -1, of: new Map<number, { lv: Level; data: string } | null>() };

  constructor(rom: Rom, results: ResultCache, emu: () => LevelEmulator) {
    this.rom = rom;
    this.results = results;
    this.emu = emu;
  }

  // the level as saved and its data's hash (null: it can't be read), once per ROM state
  private input(n: number): { lv: Level; data: string } | null {
    if (this.inputs.gen !== this.rom.gen) this.inputs = { gen: this.rom.gen, of: new Map() };
    let v = this.inputs.of.get(n);
    if (v === undefined) {
      const reads = this.rom.reads;
      this.rom.reads = null; // (reading the level isn't part of an emulated result: its data is checked by the hash)
      try { const lv = loadLevel(this.rom, n); v = { lv, data: hashOf(levelOverride(this.rom, lv)) }; } catch { v = null; } finally { this.rom.reads = reads; }
      this.inputs.of.set(n, v);
    }
    return v;
  }

  // level n's tiles while they hold; undefined: not known (scan)
  tiles(n: number): LevelTiles | undefined {
    const i = this.input(n);
    if (!i) return { level: n, tileset: 0, ok: false, fg: [], bg: [] };
    const s = this.results.get<Stored>(levelTilesKey(n));
    return s?.data === i.data ? s.tiles : undefined;
  }

  // the levels whose tiles are not known
  missing(levels: Iterable<number>): number[] {
    return [...levels].filter((n) => this.tiles(n) === undefined);
  }

  // loads level n in the emulator and keeps what it placed
  scan(n: number): LevelTiles {
    const i = this.input(n);
    if (!i) return this.tiles(n)!;
    const emu = this.emu(), ov = levelOverride(this.rom, i.lv), gen = this.rom.gen;
    // (a level that can't be taken apart counts as not loading: kept too, so it isn't tried again and again)
    const run = emu.tracked(() => { try { return levelTilesAll(this.rom, i.lv, (o) => emu.load(n, o), ov); } catch (e) { console.error(e); return null; } });
    // the load's temporary ROM patches are undone, so the levels read before still hold
    if (this.inputs.gen === gen) this.inputs.gen = this.rom.gen;
    const tiles = run.result ?? { level: n, tileset: i.lv.header.tileset, ok: false, fg: [], bg: [] };
    this.results.set(levelTilesKey(n), { data: i.data, tiles } satisfies Stored, this.results.fp.deps(run.reads));
    return tiles;
  }
}

export interface TileUser { level: number; uses: TileUse[] }
export const isTilesetTile = (t: number) => t >= 0x073 && t < 0x100;

// levels placing FG Map16 tile t; tiles 073-0FF count in levels of `tilesets` only, those sharing the tile's
// data (sharingTilesets)
export function fgTileUsers(levels: Iterable<LevelTiles>, t: number, tilesets: number[]): TileUser[] {
  const out: TileUser[] = [];
  for (const l of levels) {
    if (isTilesetTile(t) && !tilesets.includes(l.tileset)) continue;
    const uses = l.fg.filter((u) => u.tile === t);
    if (uses.length) out.push({ level: l.level, uses });
  }
  return out;
}

// levels whose BG tilemap has BG Map16 tile t
export function bgTileUsers(levels: Iterable<LevelTiles>, t: number): (BgTileUse & { level: number })[] {
  const out: (BgTileUse & { level: number })[] = [];
  for (const l of levels) { const u = l.bg.find((b) => b.tile === t); if (u) out.push({ level: l.level, ...u }); }
  return out;
}

// what refers to FG tile t outside the levels: tiles acting like it, structures holding it, custom blocks on it
export function tileLinks(rom: Rom, t: number): { actsLike: number[]; structures: number[]; blocks: string[] } {
  const acts: number[] = [];
  for (let x = 0; x < EXT_TILES; x++) if (x !== t && actsLike(rom, x) === t) acts.push(x);
  const structures = [...listStructures(rom)].filter(([, s]) => structTiles(s).includes(t)).map(([n]) => n);
  const blocks = (loadBlockProject(rom)?.list ?? []).filter((b) => b.tile === t).map((b) => b.file);
  return { actsLike: acts, structures, blocks };
}

// Map16 tiles of the ROM's own (200-FFF) that are defined – graphics or acts like other than the empty
// tile's (`blank`: its tile words), or a block on them – but placed in no level and held by no structure
// (acts like only reaches the game's tiles 000-1FF)
export function unusedFgTiles(rom: Rom, levels: Iterable<LevelTiles>, blank: number[]): number[] {
  const used = new Set<number>();
  for (const l of levels) for (const u of l.fg) used.add(u.tile);
  for (const [, s] of listStructures(rom)) for (const t of structTiles(s)) used.add(t);
  const blocks = new Set((loadBlockProject(rom)?.list ?? []).map((b) => b.tile));
  const out: number[] = [];
  for (let t = EXT_FIRST; t < EXT_TILES; t++) {
    if (used.has(t)) continue;
    const w = extTileWords(rom, t);
    if (blocks.has(t) || (!!w && (w.some((v, k) => v !== blank[k]) || actsLike(rom, t) !== DEFAULT_ACTS))) out.push(t);
  }
  return out;
}

// ---------- GFX files (from the ROM) ----------

// the header of level n as saved
export const savedHeader = (rom: Rom, n: number): PrimaryHeader => parsePrimaryHeader(rom.bytes(rom.r24(L1_PTRS + n * 3), 5));

export interface GfxUser { level: number; slots: string[] }
// file → the levels using it and in which slots (defaults included); `header`: a level's header when not
// the saved one (the open level)
export function gfxUsage(rom: Rom, levels: Iterable<number>, header: (n: number) => PrimaryHeader = (n) => savedHeader(rom, n)): Map<number, GfxUser[]> {
  const m = new Map<number, GfxUser[]>();
  for (const n of levels) {
    let hd;
    try { hd = header(n); } catch { continue; }
    for (const s of levelSlots(rom, n, hd)) {
      if (s.file === 0xff) continue;
      const l = m.get(s.file) ?? [];
      const u = l.find((x) => x.level === n);
      if (u) u.slots.push(s.name); else l.push({ level: n, slots: [s.name] });
      m.set(s.file, l);
    }
  }
  return m;
}

// Where a level's Map16 tiles drawing from a file were made for, after its slot `name` changed (before →
// now), when that is another layer slot: the ExGFX that left the slot is still in another one (moved), or
// the new ExGFX is in another slot in other levels (`levels`: how many, 0 when moved). Null: the tiles fit.
export interface SlotMove { file: number; from: GfxSlot; to: GfxSlot; levels: number }
export function slotMove(before: GfxSlot[], now: GfxSlot[], name: string, usage: Map<number, GfxUser[]>, level: number): SlotMove | null {
  const was = before.find((x) => x.name === name), is = now.find((x) => x.name === name);
  if (!was || !is) return null;
  const elsewhere = (file: number) => now.find((x) => x.map16 && x.name !== name && x.file === file);
  const moved = was.custom && was.file >= VANILLA_GFX ? elsewhere(was.file) : undefined;
  if (moved) return moved.first === was.first ? null : { file: was.file, from: was, to: moved, levels: 0 };
  if (is.file === 0xff || is.file < VANILLA_GFX || elsewhere(is.file)) return null;
  const count = new Map<string, number>();
  for (const u of usage.get(is.file) ?? []) if (u.level !== level) for (const n of u.slots) count.set(n, (count.get(n) ?? 0) + 1);
  const best = [...count.entries()].filter(([n]) => n !== name && now.some((x) => x.map16 && x.name === n)).sort((a, b) => b[1] - a[1])[0];
  const from = best && now.find((x) => x.name === best[0]);
  return from && from.first !== is.first ? { file: is.file, from, to: is, levels: best[1] } : null;
}

// ExGFX files in the ROM that no level's slot uses
export function unusedExGfx(rom: Rom, levels: Iterable<number>, usage = gfxUsage(rom, levels)): number[] {
  const out: number[] = [];
  for (let i = VANILLA_GFX; i < GFX_FILES; i++) if (gfxEntry(rom, i) && !usage.has(i)) out.push(i);
  return out;
}

// ---------- sprites (from the ROM) ----------

export interface SpriteUser { level: number; count: number; x: number; y: number } // x/y: the first one
// sprite id (spriteId) → the levels with it; `level`: a level when not the saved one (the open level)
export function spriteUsage(rom: Rom, levels: Iterable<number>, level: (n: number) => Level = (n) => loadLevel(rom, n)): Map<number, SpriteUser[]> {
  const m = new Map<number, SpriteUser[]>();
  for (const n of levels) {
    let lv;
    try { lv = level(n); } catch { continue; }
    const here = new Map<number, SpriteUser>();
    for (const s of lv.sprites) {
      const id = spriteId(s), u = here.get(id);
      if (u) u.count++; else here.set(id, { level: n, count: 1, x: s.x, y: s.y });
    }
    for (const [id, u] of here) { const l = m.get(id) ?? []; l.push(u); m.set(id, l); }
  }
  return m;
}
