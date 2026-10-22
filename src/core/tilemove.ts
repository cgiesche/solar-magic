// Moving Map16 tiles to other numbers with every use (beyond Lunar Magic, which only offers the remaps
// below), and rewriting the uses alone: Lunar Magic's "Remap Direct Map16" (its Edit menu, LM help:
// edit_remap_dm16.htm) and "Remap Background Tiles" (its BG dialog, LM help: level_bg_offset.htm), e.g.
// after a .map16 was imported to another page than the levels expect. A tile map says what each tile number
// becomes; its sources are the numbers before (swaps work). One ROM edit each (the caller's).
// The uses, all read from the data:
// - FG: Direct Map16 objects of both layers. Each fills its rectangle with one tile, so matching that tile
//   moves the whole object (Lunar Magic matches the upper-left tile). With "always show" the object shows
//   its tile + 100 while its flag is on (cdm16.ts), so a move takes both along or neither. A move also
//   rewrites the structures' tiles and the custom blocks' list.txt (assembled again).
// - BG: the levels' BG tilemaps. Each tile of a BG the editor stores carries its page (bg.ts), so unlike in
//   Lunar Magic there is no BG bank to change and tiles of several pages share a BG. A game BG (pages 0-1
//   only) is known from its load (`gameBg`); rewritten, it is stored by the editor.
// Only tiles 200-FFF move: 000-1FF are the game's, placed by its objects and backgrounds. Tiles placed by
// code (custom objects, as the usage index levelusage.ts knows them) can't be rewritten: moving one is refused.

import type { Rom } from './rom.ts';
import { hex } from './names.ts';
import { L2_PTRS, loadLevel, type Level, type LevelObject } from './level.ts';
import { saveLevel } from './save.ts';
import { bgBank } from './patches.ts';
import { decodeBg } from './bg.ts';
import { isDm16, structTiles, COND_ADD } from './cdm16.ts';
import { listStructures, writeStructure, type Structure } from './structs.ts';
import { EXT_FIRST, EXT_TILES, DEFAULT_ACTS, extTileWords, setExtTileWords, actsLike, setActsLike, blockOf, setBlock } from './map16ext.ts';
import { BG_EXT_FIRST, BG_EXT_TILES, bgExtTileWords, setBgExtTileWords, vanillaBgWords } from './bgmap16.ts';
import { loadBlockProject, saveBlockProject } from './blocks.ts';
import type { LevelTiles } from './levelusage.ts';

export type Layer = 'fg' | 'bg';
export type TileMap = Map<number, number>; // tile before → after

// the levels to look at; a level as edited (the open one; default: as saved); a game BG from the level's load
export interface LevelSource {
  levels: number[];
  level?: (n: number) => Level;
  gameBg?: (n: number) => Uint16Array | null;
}
export interface MoveSource extends LevelSource {
  blank: number[]; // the words of an empty FG tile (025), for the tiles moved away from
  index?: LevelTiles[]; // the usage index: tiles placed by objects' code
}

// the uses rewritten: per level its Direct Map16 objects and BG tiles; the structures; the tiles with a block
// (moved, or overwritten)
export interface LevelChange { level: number; objects: number; bg: number }
export interface UsesPlan { levels: LevelChange[]; structures: number[]; blocks: number[] }
export interface MovePlan extends UsesPlan {
  map: TileMap;
  problems: string[]; // why the move can't be done
  overwrite: number[]; // destinations with contents of their own (graphics, acts-like, a block): ask first
}

const hex3 = (n: number) => hex(n, 3);
const list = (ns: number[]) => ns.slice(0, 8).map(hex3).join(', ') + (ns.length > 8 ? ' …' : '');

// a w×h rectangle of tiles (16 a row) from `from` to `to`
export function rectMap(from: number, w: number, h: number, to: number): TileMap {
  const m: TileMap = new Map();
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) m.set(from + y * 16 + x, to + y * 16 + x);
  return m;
}

// the BG tilemap the editor stored for a level (null: none, or the level's pointer was changed since)
export function storedBg(rom: Rom, lv: Level): Uint16Array | null {
  const bank = bgBank(rom, lv.number), ptr = rom.r24(L2_PTRS + lv.number * 3);
  if (!bank || lv.layer2Objects || lv.layer2Pointer !== ptr) return null;
  const a = (bank << 16) | (ptr & 0xffff);
  return decodeBg(rom.bytes(a, Math.min(0x1000, 0x10000 - (a & 0xffff))));
}

// a level's BG tilemap as edited, stored or (when `game`) the game's; null: none (layer 2 objects) or not known
function levelBg(rom: Rom, lv: Level, src: LevelSource, game: boolean): Uint16Array | null {
  if (lv.layer2Objects) return null;
  return lv.bg ?? storedBg(rom, lv) ?? (game && !bgBank(rom, lv.number) ? src.gameBg?.(lv.number) ?? null : null);
}

const dm16Objects = (lv: Level): LevelObject[] => [...lv.objects, ...(lv.layer2Objects ?? [])].filter(isDm16);
// the tiles an object shows: its own, with "always show" also + 100
const shown = (o: LevelObject): number[] => (o.cond?.always ? [o.tile!, o.tile! + COND_ADD] : [o.tile!]);
const moves = (map: TileMap, t: number) => map.has(t) && map.get(t) !== t;

// level n's uses of the map's tiles rewritten (`write`: in lv, else only counted)
function rewriteLevel(rom: Rom, lv: Level, layer: Layer, map: TileMap, src: LevelSource, write: boolean): LevelChange {
  const c: LevelChange = { level: lv.number, objects: 0, bg: 0 };
  if (layer === 'fg') {
    for (const o of dm16Objects(lv)) if (moves(map, o.tile!)) { c.objects++; if (write) o.tile = map.get(o.tile!); }
    return c;
  }
  const bg = levelBg(rom, lv, src, [...map.keys()].some((t) => t < BG_EXT_FIRST));
  if (!bg) return c;
  const out = bg.map((t) => (moves(map, t) ? (c.bg++, map.get(t)!) : t));
  if (write && c.bg) lv.bg = out;
  return c;
}

const levelOf = (rom: Rom, src: LevelSource, n: number): Level | null => {
  try { return src.level?.(n) ?? loadLevel(rom, n); } catch { return null; }
};
function changedLevels(rom: Rom, layer: Layer, map: TileMap, src: LevelSource): LevelChange[] {
  const out: LevelChange[] = [];
  for (const n of src.levels) {
    const lv = levelOf(rom, src, n);
    const c = lv && rewriteLevel(rom, lv, layer, map, src, false);
    if (c && (c.objects || c.bg)) out.push(c);
  }
  return out;
}

// ---------- the uses alone (Remap Direct Map16 / Background Tiles) ----------

export function planRemap(rom: Rom, layer: Layer, map: TileMap, src: LevelSource): UsesPlan {
  return { levels: changedLevels(rom, layer, map, src), structures: [], blocks: [] };
}

// rewrites the levels as saved (an open level with changes is saved before, by the ROM edit)
export function applyRemap(rom: Rom, layer: Layer, map: TileMap, src: LevelSource): UsesPlan {
  const plan = planRemap(rom, layer, map, { ...src, level: undefined });
  for (const c of plan.levels) {
    const lv = loadLevel(rom, c.level);
    rewriteLevel(rom, lv, layer, map, src, true);
    saveLevel(rom, lv);
  }
  return plan;
}

// ---------- moving tiles ----------

interface TileData { words: number[]; acts: number | null; block: { addr: number; wall: boolean } | null }
function tileData(rom: Rom, layer: Layer, t: number): TileData {
  return layer === 'fg'
    ? { words: extTileWords(rom, t)!, acts: actsLike(rom, t), block: blockOf(rom, t) }
    : { words: bgExtTileWords(rom, t)!, acts: null, block: null };
}
function setTileData(rom: Rom, layer: Layer, t: number, d: TileData): void {
  if (layer === 'bg') { setBgExtTileWords(rom, t, d.words); return; }
  setExtTileWords(rom, t, d.words);
  setActsLike(rom, t, d.acts ?? DEFAULT_ACTS);
  setBlock(rom, t, d.block?.addr ?? 0, d.block?.wall ?? false);
}
const emptyTile = (rom: Rom, layer: Layer, blank: number[]): TileData =>
  ({ words: layer === 'fg' ? blank : vanillaBgWords(rom, 0x025), acts: layer === 'fg' ? DEFAULT_ACTS : null, block: null });

const mappedStructure = (s: Structure, map: TileMap): Structure => ({ ...s, tiles: s.tiles.map((t) => (t >= 0 && map.has(t) ? map.get(t)! : t)) });

// What moving the tiles (map: from → to, both 200-FFF) rewrites, and why it can't be done. Refused: moving
// onto a tile something places (unless it moves away too), a tile placed by code, a conditional "always
// show" tile without its tile + 100 (or the other way round).
export function planMove(rom: Rom, layer: Layer, map: TileMap, src: MoveSource): MovePlan {
  const problems: string[] = [];
  const first = layer === 'fg' ? EXT_FIRST : BG_EXT_FIRST, end = layer === 'fg' ? EXT_TILES : BG_EXT_TILES;
  const outside = [...map].flat().filter((t) => t < first || t >= end);
  if (outside.length) problems.push(`Only tiles ${hex3(first)}–${hex3(end - 1)} can be moved: 000–1FF are the game's, placed by its ${layer === 'fg' ? 'objects' : 'backgrounds'}.`);
  const dests = [...map.values()];
  if (new Set(dests).size < dests.length) problems.push('Two tiles would move onto the same one.');
  // destinations that stay: what places them would show the moved tiles
  const onto = new Set(dests.filter((t) => !map.has(t)));
  const plan: MovePlan = { map, problems, overwrite: [], levels: [], structures: [], blocks: [] };
  if (outside.length) return plan;

  const placedOnto = new Map<number, string[]>(); // tile → what places it
  const place = (t: number, by: string) => { if (onto.has(t)) placedOnto.set(t, [...(placedOnto.get(t) ?? []), by]); };
  const pairs = new Set<string>(); // "always show" tiles whose tile + 100 doesn't move along, and where
  const pair = (t: number, by: string) => {
    const a = map.get(t) ?? t, b = map.get(t + COND_ADD) ?? t + COND_ADD;
    if (b !== a + COND_ADD) pairs.add(`${hex3(t)} and ${hex3(t + COND_ADD)} (${by})`);
  };
  for (const n of src.levels) {
    const lv = levelOf(rom, src, n);
    if (!lv) continue;
    const by = `level ${hex3(n)}`;
    if (layer === 'fg') {
      for (const o of dm16Objects(lv)) { for (const t of shown(o)) place(t, by); if (o.cond?.always) pair(o.tile!, by); }
    } else for (const t of new Set(levelBg(rom, lv, src, false) ?? [])) place(t, `${by}'s BG`);
    const c = rewriteLevel(rom, lv, layer, map, src, false);
    if (c.objects || c.bg) plan.levels.push(c);
  }
  if (layer === 'fg') {
    for (const [k, s] of listStructures(rom)) {
      for (const t of structTiles(s)) place(t, `structure ${hex(k, 2)}`);
      s.tiles.forEach((t, i) => { if (t >= 0 && s.conds?.[i]?.always) pair(t, `structure ${hex(k, 2)}`); });
      if (s.tiles.some((t) => t >= 0 && moves(map, t))) plan.structures.push(k);
    }
    for (const t of [...map.keys(), ...onto]) if (blockOf(rom, t)) plan.blocks.push(t);
    const code = new Map<number, number[]>();
    for (const l of src.index ?? []) for (const u of l.fg) {
      if (u.source === 'object' && (map.has(u.tile) || onto.has(u.tile))) code.set(u.tile, [...(code.get(u.tile) ?? []), l.level]);
    }
    for (const [t, ls] of code) problems.push(`Tile ${hex3(t)} is placed by an object's code in level${ls.length > 1 ? 's' : ''} ${list(ls)}: that can't be rewritten.`);
  }
  for (const [t, by] of placedOnto) problems.push(`Tile ${hex3(t)} is in use (${[...new Set(by)].slice(0, 4).join(', ')}${by.length > 4 ? ' …' : ''}): moving onto it would change ${by.length > 1 ? 'them' : 'it'}.`);
  if (pairs.size) problems.push(`"Always show" shows a tile + 100 while its flag is on: move both or neither – ${[...pairs].slice(0, 3).join('; ')}${pairs.size > 3 ? ' …' : ''}.`);
  const empty = emptyTile(rom, layer, src.blank);
  for (const t of onto) {
    const d = tileData(rom, layer, t);
    if (d.words.some((w, k) => w !== empty.words[k]) || (d.acts ?? DEFAULT_ACTS) !== DEFAULT_ACTS || d.block) plan.overwrite.push(t);
  }
  plan.overwrite.sort((a, b) => a - b);
  return plan;
}

// Moves the tiles of a plan without problems: graphics, acts-like and block to the new numbers, the tiles
// moved away from empty; every use rewritten (the levels as saved: the ROM edit saves an open level first).
export function applyMove(rom: Rom, layer: Layer, plan: MovePlan, src: MoveSource): void {
  if (plan.problems.length) throw new Error(plan.problems[0]);
  const { map } = plan;
  const data = new Map([...map.keys()].map((t) => [t, tileData(rom, layer, t)]));
  const empty = emptyTile(rom, layer, src.blank), dests = new Set(map.values());
  for (const t of map.keys()) if (!dests.has(t)) setTileData(rom, layer, t, empty);
  for (const [t, d] of map) setTileData(rom, layer, d, data.get(t)!);
  applyRemap(rom, layer, map, src);
  if (layer === 'bg') return;
  for (const [k, s] of listStructures(rom)) if (s.tiles.some((t) => t >= 0 && moves(map, t))) writeStructure(rom, k, mappedStructure(s, map));
  const p = plan.blocks.length ? loadBlockProject(rom) : null;
  if (p) {
    // (a destination's own block is overwritten)
    p.list = p.list.filter((b) => map.has(b.tile) || !dests.has(b.tile)).map((b) => (map.has(b.tile) ? { ...b, tile: map.get(b.tile)! } : b));
    const r = saveBlockProject(rom, p);
    if (!r.ok) throw new Error(`Custom blocks: ${r.errors.join(' ')}`);
  }
}
