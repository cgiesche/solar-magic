// Level tiles as objects on top of layer 1 (the overworld editor's Levels mode, ADR 0012): moved, removed and placed
// as a whole – the tile with its translevel – each one ROM edit of layer 1 and the translevel table, the map before
// events. A level tile moved swaps with the tile where it is dropped (a level moved along a path leaves the path
// whole; two level tiles swap with their translevels); one removed leaves the stop tile (Mario stops there, enters no
// level), its level keeping its settings (CONTEXT.md "Level tile"); one placed gets a look and the translevel chosen.
// Which tiles are level tiles and stop tiles the game's code decides (owpaths.ts path kinds), passed in.
//
// With an event chosen (in the playthrough strip, LevelTileEvent) the edits are layer 1 changes of that event instead
// (owevents.ts paintEventL1, as layer 1 painted into an event): the level tile appears, moves or goes from the event
// on, the map before events stays. The translevel table is per cell for every event progress: a cell entering one
// level on another map (before events, before the event, by another event or a reveal) can't enter another one after
// the event – refused – and keeps its translevel when the event takes its level tile away.

import type { Rom } from './rom.ts';
import {
  readL1, writeL1, readTranslevels, writeTranslevels, owTileWords, l1Index, l1XY, hasDestroyPatch, readDestroyList, writeDestroyList, destroySettingAt,
  revealedTile, translevelToLevel, MAX_TRANSLEVEL, OW_L1_TILES, NO_EVENT, MAP_NAMES,
} from './overworld.ts';
import { readEvents, writeEvents, paintEventL1, submapOf, type Rect } from './owevents.ts';
import type { PathKind, LevelTileTest } from './owpaths.ts';
import { OwRefusal, type OwRefusalData } from './owrefusal.ts';

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

// "Also used by the tile on Vanilla Dome": the other level tiles entering a level (l1Index), by the map each is on
// (views: the submaps' views), "" when none
export function alsoUsedBy(others: number[], views: Rect[]): string {
  if (!others.length) return '';
  const n = new Map<number, number>();
  for (const k of others) { const m = submapOf(views, k); n.set(m, (n.get(m) ?? 0) + 1); }
  const on = [...n].sort((a, b) => a[0] - b[0]).map(([m, c]) => `${c === 1 ? 'the tile' : `the ${c} tiles`} on ${m ? MAP_NAMES[m] : 'the main map'}`);
  return `Also used by ${on.length > 1 ? `${on.slice(0, -1).join(', ')} and ${on[on.length - 1]}` : on[0]}`;
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
export function moveLevelTile(rom: Rom, from: number, to: number, ev: LevelTileEvent | null = null): void {
  if (ev) {
    editInEvent(rom, ev, moveCells(readTranslevels(rom), ev, from, to));
    return;
  }
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
export function removeLevelTile(rom: Rom, i: number, stop: number, ev: LevelTileEvent | null = null): void {
  if (ev) editInEvent(rom, ev, [[i, stop, 0]]);
  else editMaps(rom, (l1, tls) => { l1[i] = stop; tls[i] = 0; });
}

// a level tile of look `look` entering translevel tl placed at i (or a level tile's look changed: its own translevel)
export function placeLevelTile(rom: Rom, i: number, look: number, tl: number, ev: LevelTileEvent | null = null): void {
  if (ev) editInEvent(rom, ev, [[i, look, tl]]);
  else editMaps(rom, (l1, tls) => { l1[i] = look; tls[i] = tl; });
}

// ---- where a level tile can go (#348: the cells hatched while one is dragged or placed) ----
// why the level tile at `from` can't be moved to each cell (null: it can) – in an event a cell entering another level
// on another map; the ROM read once
export function moveLevelTileCheck(rom: Rom, from: number, ev: LevelTileEvent | null): (to: number) => OwRefusalData | null {
  return cellsCheck(rom, ev, (tls, ev, to) => (to === from ? [] : moveCells(tls, ev, from, to)));
}
// why a level tile of look `look` entering translevel tl can't be placed at each cell (null: it can), as moveLevelTileCheck
export function placeLevelTileCheck(rom: Rom, look: number, tl: number, ev: LevelTileEvent | null): (i: number) => OwRefusalData | null {
  return cellsCheck(rom, ev, (_, __, i) => [[i, look, tl]]);
}
// why the cells an edit at cell i sets as after the event can't be (eventCellsRefusal); before events nothing is refused
function cellsCheck(rom: Rom, ev: LevelTileEvent | null, cells: (tls: Uint8Array, ev: LevelTileEvent, i: number) => [number, number, number][]): (i: number) => OwRefusalData | null {
  if (!ev) return () => null;
  const tls = readTranslevels(rom), held = heldElsewhere(rom, ev);
  return (i) => eventCellsRefusal(ev, held, tls, cells(tls, ev, i));
}

// ---- in an event ----
// the cells a level tile moved from `from` to `to` sets as after the event ([cell, tile, translevel])
function moveCells(tls: ArrayLike<number>, ev: LevelTileEvent, from: number, to: number): [number, number, number][] {
  const a = ev.after[from], b = ev.after[to];
  return [[to, a, tls[from]], [from, b, ev.isLevelTile(b) ? tls[to] : 0]];
}
// why cells set as after the event can't be (null: they can): a level tile on a cell entering another level on
// another map (held: heldElsewhere; tls: the translevels as in the ROM)
function eventCellsRefusal(ev: LevelTileEvent, held: (i: number) => boolean, tls: ArrayLike<number>, cells: [number, number, number][]): OwRefusalData | null {
  for (const [i, tile, tl] of cells) {
    if (!ev.isLevelTile(tile) || !held(i) || !tls[i] || tls[i] === tl) continue;
    return { kind: 'levelTileHeld', cell: i, tl: tls[i] };
  }
  return null;
}
// the event the edits go into: layer 1 as after it (`after`, as the game shows it) and as after it without its layer 1
// changes (`without`, owevents.ts layer1Without), which tiles are level tiles
export interface LevelTileEvent { event: number; after: ArrayLike<number>; without: ArrayLike<number>; isLevelTile: LevelTileTest }

// cells set as after event ev.event ([cell, tile, translevel]; the translevel only where the tile is a level tile):
// layer 1 changes of the event, the translevel table with them. Throws (nothing written) where a cell would enter
// another level than it does on another map (heldElsewhere)
function editInEvent(rom: Rom, ev: LevelTileEvent, cells: [number, number, number][]): void {
  const after = Uint16Array.from(ev.after), tls = readTranslevels(rom), held = heldElsewhere(rom, ev);
  const why = eventCellsRefusal(ev, held, tls, cells);
  if (why) throw new OwRefusal(why);
  for (const [i, tile, tl] of cells) {
    after[i] = tile;
    if (!ev.isLevelTile(tile)) { if (!held(i)) tls[i] = 0; continue; }
    tls[i] = tl;
  }
  writeEvents(rom, paintEventL1(readEvents(rom), ev.event, after, ev.without, new Set(cells.map(([i]) => i))));
  writeTranslevels(rom, tls);
}
// whether cell i's translevel is used on another map than the one after the event: a level tile there before events
// (or one the reveal list turns it into), before the event (without its layer 1 changes) or put there by another event
function heldElsewhere(rom: Rom, ev: LevelTileEvent): (i: number) => boolean {
  const l1 = readL1(rom), lv = ev.isLevelTile, others = new Set<number>();
  readEvents(rom).silent.forEach((steps, e) => { if (e !== ev.event) for (const s of steps) if (s.layer === 1 && lv(s.tile)) others.add(s.loc); });
  return (i) => lv(l1[i]) || lv(revealedTile(rom, l1[i])) || lv(ev.without[i]) || others.has(i);
}
