// The overworld editor's layer 1 paint sheet (ui/overworld.ts l1Palette): which tiles are free – folded into one row
// instead of shown as black cells – and what the hover popup says about a tile. Pure: the ROM is read, nothing drawn.
//
// An empty tile is one drawn as tile 000 (its Map16 quarters the same) that no map has: not on layer 1 as in the ROM
// (before events) and not put there by an event (its layer 1 tiles, a reveal). The editor's Map16 extension
// (overworld.ts installOwMap16Patch) makes the tiles past the game's (C1–1FF) such copies of 000. A free tile is an
// empty one that also does what 000 does where Mario walks (owpaths.ts): an invisible path or level tile is no free
// one, even unused. While the path kinds are learned no tile is free (nothing is folded until they are known).
// Level tiles are no brush tiles (ADR 0012: placed in the Levels mode): shown hatched in the sheet, left out of a brush.
import type { Rom } from './rom.ts';
import { OW_L1_TILES, owTileWords, readL1, revealedTile } from './overworld.ts';
import { readEvents } from './owevents.ts';
import type { PathKind, PathShapes, LevelTileTest } from './owpaths.ts';
import { pathTileText } from './owpathshape.ts';
import { hex } from './names.ts';

export const SHEET_COLS = 16;
export const PAGE_TILES = 0x100;

// the tiles some map has: layer 1 as in the ROM, the tiles events put there (their layer 1 tiles, the reveal list's)
export function tilesOnMaps(rom: Rom): Set<number> {
  const out = new Set<number>(readL1(rom));
  for (const s of readEvents(rom).silent.flat()) if (s.layer === 1) out.add(s.tile);
  // (a tile on a map revealed: the tile it becomes)
  for (const t of [...out]) { const r = revealedTile(rom, t); if (r >= 0) out.add(r); }
  return out;
}

// per layer 1 tile 000–1FF whether it is empty (drawn as 000, on no map); 000 itself never is
export function emptyL1Tiles(rom: Rom): boolean[] {
  const zero = owTileWords(rom, 0), used = tilesOnMaps(rom);
  return Array.from({ length: OW_L1_TILES }, (_, t) => t > 0 && !used.has(t) && owTileWords(rom, t).every((w, q) => w === zero[q]));
}

// per tile whether it is free: empty and of tile 000's path kind (none while the kinds are learned)
export function freeL1Tiles(empty: readonly boolean[], kinds: readonly PathKind[] | null): boolean[] {
  return empty.map((e, t) => !!kinds && e && kinds[t] === kinds[0]);
}

// a page of the sheet (0: 000–0FF, 1: 100–1FF): its rows shown (from its first; the rows after them are folded), the
// free tiles and the other tiles folded with them, and the page's first free tile (-1 none). The rows after the last
// tile not free hold free tiles only. Page 1 is folded whole while none of its tiles is the ROM's own (every one
// empty) – unless open1: then shown as page 0 is (its invisible path and level tiles acting as page 0's among them).
export interface SheetPage { page: number; first: number; rows: number; folded: number; hidden: number; firstFree: number }
export function sheetPages(empty: readonly boolean[], free: readonly boolean[], open1 = false): SheetPage[] {
  return [0, 1].map((page) => {
    const first = page * PAGE_TILES, tiles = Array.from({ length: PAGE_TILES }, (_, k) => first + k);
    const own = tiles.filter((t) => !free[t]);
    const rows = page && !open1 && tiles.every((t) => empty[t]) ? 0 : own.length ? Math.floor((own[own.length - 1] - first) / SHEET_COLS) + 1 : 0;
    const past = tiles.slice(rows * SHEET_COLS), frees = tiles.filter((t) => free[t]);
    return { page, first, rows, folded: past.filter((t) => free[t]).length, hidden: past.filter((t) => !free[t]).length, firstFree: frees.length ? frees[0] : -1 };
  });
}
// a layer 1 tile's number as the editor writes it (2 digits on page 0, 3 on page 1)
export const l1Hex = (t: number): string => hex(t, t > 0xff ? 3 : 2);
export const KINDS_LEARNING = 'What the tile does is being learned…';
export const LEVEL_TILE_LINE = 'Level tile: placed, moved and removed in the Levels mode (3)';

// an entry of a layer 1 brush that paints nothing (where a level tile was picked: level tiles are not painted)
export const NO_TILE = -1;
// the entries of a layer 1 brush taken from the sheet or the map: level tiles left out (NO_TILE: painted nowhere –
// they are placed in the Levels mode, ADR 0012); null when nothing is left
export function l1BrushEntries(tiles: readonly number[], isLevelTile: LevelTileTest): number[] | null {
  const out = tiles.map((t) => (isLevelTile(t) ? NO_TILE : t));
  return out.some((t) => t !== NO_TILE) ? out : null;
}
// what the popup says about layer 1 tile t below its number: what it does (kinds: the path kinds, null while
// learned; a path tile's shape in words, owpathshape.ts pathTileText: shapes null while learned), on page 1 the tile of
// page 0 it acts like, whether it is free
export function l1TileLines(t: number, kinds: readonly PathKind[] | null, free: boolean, shapes: PathShapes | null): string[] {
  const k = kinds?.[t];
  return [
    !kinds || !k ? KINDS_LEARNING
      : k === 'level' ? LEVEL_TILE_LINE
        : k === 'none' ? 'No path: Mario doesn\'t go there' : pathTileText(t, k, shapes),
    t >= PAGE_TILES ? `Acts like tile ${l1Hex(t & 0xff)} where Mario walks` : '',
    free ? `Free: drawn as tile ${l1Hex(0)}, on no map` : '',
  ].filter(Boolean);
}
