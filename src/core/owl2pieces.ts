// The overworld layer 2 "pieces on this map" (#337, CONTEXT.md "Map piece"): what the map is made of – water, grass,
// shores, hills – are 16x16 map pieces, 2x2 blocks of layer 2 tilemap entries (each with its palette and flips) on the
// 16-pixel grid. A submap's pieces are those of its view on the region (the main map: all of region 0), from the map
// before events (the ROM's layer 2), each once, the most used first.
import { l2Index } from './overworld.ts';
import type { Rect } from './owevents.ts';

export interface L2Piece {
  entries: number[]; // top left, top right, bottom left, bottom right (a 2x2 brush's order)
  count: number; // how often it is on the map
}

const REGION_CELLS = 64; // a region's layer 2: 64x64 8x8 tiles (l2Index)

// the number of pieces in a row of the pieces sheet (16 pixels each: as wide as the 8x8 sheet)
export const PIECE_COLS = 8;

// the 2x2 block of entries at cell (x, y) of region `region`'s layer 2 `l2`, in a 2x2 brush's order
export function l2Block(l2: ArrayLike<number>, region: number, x: number, y: number): number[] {
  return [l2[l2Index(region, x, y)], l2[l2Index(region, x + 1, y)], l2[l2Index(region, x, y + 1)], l2[l2Index(region, x + 1, y + 1)]];
}

// the pieces on the 16-pixel grid in `view` (8x8 tiles of the region, wrapping around its edges as the submaps' views
// do – Yoshi's Island's starts at -2,-5; the grid cells it overlaps, each once) of region `region`'s layer 2 `l2`
// (l2Index order), most used first (equal counts: the one met first, row by row)
export function mapPieces(l2: ArrayLike<number>, region: number, view: Rect): L2Piece[] {
  const wrap = (v: number) => ((v % REGION_CELLS) + REGION_CELLS) % REGION_CELLS;
  const span = (a: number, n: number) => {
    const out: number[] = [];
    for (let v = a & ~1; v < a + n && out.length < REGION_CELLS / 2; v += 2) out.push(wrap(v));
    return out;
  };
  const xs = span(view.x, view.w), ys = span(view.y, view.h);
  const seen = new Map<string, L2Piece>();
  for (const y of ys) for (const x of xs) {
    const entries = l2Block(l2, region, x, y), key = entries.join();
    const p = seen.get(key);
    if (p) p.count++;
    else seen.set(key, { entries, count: 1 });
  }
  return [...seen.values()].sort((a, b) => b.count - a.count); // (stable: first met first)
}
