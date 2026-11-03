// The overworld editor's layer 1 paint sheet (ui/overworld.ts l1Palette): which tiles are free – folded into one row
// instead of shown as black cells – and what the hover popup says about a tile. Pure: the ROM is read, nothing drawn.
//
// An empty tile is one drawn as tile 000 (its Map16 quarters the same) that no map has: not on layer 1 as in the ROM
// (before events) and not put there by an event (its layer 1 tiles, a reveal). The editor's Map16 extension
// (overworld.ts installOwMap16Patch) makes the tiles past the game's (C1–1FF) such copies of 000. A free tile is an
// empty one that also does what 000 does where Mario walks (owpaths.ts): an invisible path or level tile is no free
// one, even unused. While the path kinds are learned an empty tile counts as free.
import type { Rom } from './rom.ts';
import { OW_L1_TILES, owTileWords, readL1, revealedTile } from './overworld.ts';
import { readEvents } from './owevents.ts';
import { PATH_KIND_NAMES, type PathKind } from './owpaths.ts';
import { hex } from './names.ts';

export const SHEET_COLS = 16;
export const PAGE_TILES = 0x100;

// the tiles some map has: layer 1 as in the ROM, the tiles events put there (their layer 1 tiles, the reveal list's)
function tilesOnMaps(rom: Rom): Set<number> {
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

// per tile whether it is free: empty and (when known) of tile 000's path kind
export function freeL1Tiles(empty: readonly boolean[], kinds: readonly PathKind[] | null): boolean[] {
  return empty.map((e, t) => e && (!kinds || kinds[t] === kinds[0]));
}

// a page of the sheet (0: 000–0FF, 1: 100–1FF): its rows shown (from its first; the rows after them hold free tiles
// only and are folded), its free tiles and the first of them (-1 none). Page 1 is folded whole (rows 0) while none
// of its tiles is the ROM's own (every one empty).
export interface SheetPage { page: number; first: number; rows: number; free: number; firstFree: number }
export function sheetPages(empty: readonly boolean[], free: readonly boolean[]): SheetPage[] {
  return [0, 1].map((page) => {
    const first = page * PAGE_TILES, tiles = Array.from({ length: PAGE_TILES }, (_, k) => first + k);
    const own = tiles.filter((t) => !free[t]);
    const rows = page && tiles.every((t) => empty[t]) ? 0 : own.length ? Math.floor((own[own.length - 1] - first) / SHEET_COLS) + 1 : 0;
    const frees = tiles.filter((t) => free[t]);
    return { page, first, rows, free: frees.length, firstFree: frees.length ? frees[0] : -1 };
  });
}

// the tile number as the editor writes it (2 digits on page 0, 3 on page 1)
const tileHex = (t: number): string => hex(t, t > 0xff ? 3 : 2);

export const KINDS_LEARNING = 'What the tile does is being learned…';
// what the popup says about layer 1 tile t below its number: what it does (kinds: the path kinds, null while
// learned), on page 1 the tile of page 0 it acts like, whether it is free
export function l1TileLines(t: number, kinds: readonly PathKind[] | null, free: boolean): string[] {
  const k = kinds?.[t];
  return [
    !kinds || !k ? KINDS_LEARNING
      : k === 'level' ? 'Level tile: enters a level – gets a free translevel when painted'
        : k === 'none' ? 'No path: Mario doesn\'t go there' : PATH_KIND_NAMES[k],
    t >= PAGE_TILES ? `Acts like tile ${tileHex(t & 0xff)} where Mario walks` : '',
    free ? `Free: drawn as tile ${tileHex(0)}, on no map` : '',
  ].filter(Boolean);
}
