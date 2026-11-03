// Level tiles as objects on top of layer 1 (the overworld editor's Levels mode, ADR 0012): moved, removed and placed
// as a whole – the tile with its translevel – each one ROM edit of layer 1 and the translevel table, the map before
// events. A level tile moved swaps with the tile where it is dropped (a level moved along a path leaves the path
// whole; two level tiles swap with their translevels); one removed leaves the stop tile (Mario stops there, enters no
// level), its level keeping its settings (CONTEXT.md "Level tile"); one placed gets a look and the translevel chosen.
// Which tiles are level tiles and stop tiles the game's code decides (owpaths.ts path kinds), passed in.

import type { Rom } from './rom.ts';
import {
  readL1, writeL1, readTranslevels, writeTranslevels, owTileWords, l1Index, l1XY, hasDestroyPatch, readDestroyList, writeDestroyList, destroySettingAt,
  MAX_TRANSLEVEL, OW_L1_TILES, NO_EVENT,
} from './overworld.ts';
import type { PathKind } from './owpaths.ts';

// the stop tile of the clean game ("Mario stops, enters no level") and its first level tile
export const STOP_TILE = 0x81;
export const DEFAULT_LOOK = 0x56;

// the looks a level tile can have: the visible tiles (not drawn as tile 000) the path kinds call "level" – 56–80
// without 5B and 5F in the clean game, those drawn there (the others drawn on layer 2: invisibleLevelTile)
export function levelTileLooks(rom: Rom, kinds: readonly PathKind[]): number[] {
  const invisible = drawnAs000(rom);
  return levelTiles(kinds).filter((t) => !invisible(t));
}
// the look of a level tile drawn on layer 2 (a castle, the clean game's 57): the first level tile drawn as 000 (-1 none)
export function invisibleLevelTile(rom: Rom, kinds: readonly PathKind[]): number {
  return levelTiles(kinds).find(drawnAs000(rom)) ?? -1;
}
// the layer 1 tiles 000–1FF the path kinds call "level"
const levelTiles = (kinds: readonly PathKind[]): number[] => Array.from({ length: OW_L1_TILES }, (_, t) => t).filter((t) => kinds[t] === 'level');
// whether a layer 1 tile is drawn as tile 000 (000 itself not: it is no level tile)
function drawnAs000(rom: Rom): (t: number) => boolean {
  const zero = owTileWords(rom, 0).join();
  return (t) => t > 0 && owTileWords(rom, t).join() === zero;
}
// the look a level tile placed without choosing one gets: 56 while it is one, else the first look
export const defaultLook = (looks: readonly number[]): number => (looks.includes(DEFAULT_LOOK) || !looks.length ? DEFAULT_LOOK : looks[0]);
// the tile a removed level tile leaves: 81 while Mario stops on it, else the first tile he stops on (81 when he stops
// on none)
export function stopTile(kinds: readonly PathKind[]): number {
  if (kinds[STOP_TILE] === 'stop') return STOP_TILE;
  const k = kinds.indexOf('stop');
  return k >= 0 ? k : STOP_TILE;
}

// the translevels (1–5F) no tile on any map holds (tls: each layer 1 tile's translevel) – a tile holding one that is
// not a level tile before events (one an event reveals as a level tile, the game's 5F cells) counts as its tile
export function levelsWithoutTile(tls: ArrayLike<number>): number[] {
  const held = new Set(Array.from(tls));
  return Array.from({ length: MAX_TRANSLEVEL }, (_, k) => k + 1).filter((tl) => !held.has(tl));
}

// layer 1 and the translevels as in the ROM, changed by `f` and written back
function editMaps(rom: Rom, f: (l1: Uint16Array, tls: Uint8Array) => void): void {
  const l1 = readL1(rom), tls = readTranslevels(rom);
  f(l1, tls);
  writeL1(rom, l1);
  writeTranslevels(rom, tls);
}

// the level tile at `from` (l1Index) moved to `to`: the two cells swap their tiles and translevels. A castle moves
// whole: the tile whose destroy changes the level tile (its top above it, destroySettingAt) swaps with the cell as far
// from the target – unless that is off the map or holds a level tile or a destroyed tile (another castle's top only
// when the two castles swap) – and the destroys set on the level tile and its top move with them (a castle collapsing
// is its level). Reveals stay with the cells (they belong to the path).
export function moveLevelTile(rom: Rom, from: number, to: number): void {
  const l1 = readL1(rom), tls = readTranslevels(rom), list = hasDestroyPatch(rom) ? readDestroyList(rom) : [];
  const destroyed = new Set(list.filter((d) => d.event !== NO_EVENT).map((d) => d.tile));
  // the tile whose destroy changes level tile i when another cell (its castle's top), -1 none
  const topOf = (i: number) => { const at = list.length ? destroySettingAt(rom, l1, l1, i).at : -1; return at === i ? -1 : at; };
  // the cells swapped so far: which cell's original tile each holds, and where a cell's original tile is now
  const origin = new Map<number, number>(), originOf = (c: number) => origin.get(c) ?? c;
  const cellOf = (o: number) => { for (const [c, v] of origin) if (v === o) return c; return o; };
  const swap = (a: number, b: number) => {
    [l1[a], l1[b]] = [l1[b], l1[a]];
    [tls[a], tls[b]] = [tls[b], tls[a]];
    const oa = originOf(a);
    origin.set(a, originOf(b)).set(b, oa);
  };
  const tops = [topOf(from), topOf(to)];
  swap(from, to);
  for (const [level, target, top] of [[from, to, tops[0]], [to, from, tops[1]]]) {
    if (top < 0) continue;
    const dest = shifted(top, level, target), now = cellOf(top);
    if (dest < 0 || dest === now) continue;
    const there = originOf(dest);
    if (tls[dest] || (destroyed.has(there) && !tops.includes(there))) continue;
    swap(now, dest);
  }
  writeL1(rom, l1);
  writeTranslevels(rom, tls);
  const owned = new Set([from, to, ...tops.filter((t) => t >= 0)]);
  const moved = list.map((d) => (d.event !== NO_EVENT && owned.has(d.tile) ? { ...d, tile: cellOf(d.tile) } : d));
  if (moved.some((d, k) => d.tile !== list[k].tile)) writeDestroyList(rom, moved);
}
// cell i moved by as much as cell `a` to `b` (on b's map), -1 where that leaves the map
function shifted(i: number, a: number, b: number): number {
  const p = l1XY(i), pa = l1XY(a), pb = l1XY(b), x = p.x + pb.x - pa.x, y = p.y + pb.y - pa.y;
  return x < 0 || y < 0 || x >= 32 || y >= 32 ? -1 : l1Index(b >= 0x400 ? 1 : 0, x, y);
}

// the level tile at i removed: the stop tile (stopTile) in its place, no translevel
export function removeLevelTile(rom: Rom, i: number, stop: number): void {
  editMaps(rom, (l1, tls) => { l1[i] = stop; tls[i] = 0; });
}

// a level tile of look `look` entering translevel tl placed at i (or a level tile's look changed: its own translevel)
export function placeLevelTile(rom: Rom, i: number, look: number, tl: number): void {
  editMaps(rom, (l1, tls) => { l1[i] = look; tls[i] = tl; });
}
