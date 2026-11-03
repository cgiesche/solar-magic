// Level tiles as objects on top of layer 1 (the overworld editor's Levels mode, ADR 0012): moved, removed and placed
// as a whole – the tile with its translevel – each one ROM edit of layer 1 and the translevel table, the map before
// events. A level tile moved swaps with the tile where it is dropped (a level moved along a path leaves the path
// whole; two level tiles swap with their translevels); one removed leaves the stop tile (Mario stops there, enters no
// level), its level keeping its settings (CONTEXT.md "Level tile"); one placed gets a look and the translevel chosen.
// Which tiles are level tiles and stop tiles the game's code decides (owpaths.ts path kinds), passed in.

import type { Rom } from './rom.ts';
import { readL1, writeL1, readTranslevels, writeTranslevels, owTileWords, MAX_TRANSLEVEL, OW_L1_TILES } from './overworld.ts';
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

// the level tile at `from` (l1Index) moved to `to`: the two cells swap their tiles and translevels
export function moveLevelTile(rom: Rom, from: number, to: number): void {
  editMaps(rom, (l1, tls) => {
    [l1[from], l1[to]] = [l1[to], l1[from]];
    [tls[from], tls[to]] = [tls[to], tls[from]];
  });
}

// the level tile at i removed: the stop tile (stopTile) in its place, no translevel
export function removeLevelTile(rom: Rom, i: number, stop: number): void {
  editMaps(rom, (l1, tls) => { l1[i] = stop; tls[i] = 0; });
}

// a level tile of look `look` entering translevel tl placed at i (or a level tile's look changed: its own translevel)
export function placeLevelTile(rom: Rom, i: number, look: number, tl: number): void {
  editMaps(rom, (l1, tls) => { l1[i] = look; tls[i] = tl; });
}
