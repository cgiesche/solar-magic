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

// the cells of the 16-pixel grid `area` overlaps (8x8 tiles of the region, wrapping around its edges as the submaps'
// views do – Yoshi's Island's starts at -2,-5), each once by the top left 8x8 tile of its piece, row by row
export function pieceCells(area: Rect): { x: number; y: number }[] {
  const wrap = (v: number) => ((v % REGION_CELLS) + REGION_CELLS) % REGION_CELLS;
  const span = (a: number, n: number) => {
    const out: number[] = [];
    for (let v = a & ~1; v < a + n && out.length < REGION_CELLS / 2; v += 2) out.push(wrap(v));
    return out;
  };
  const xs = span(area.x, area.w), ys = span(area.y, area.h);
  return ys.flatMap((y) => xs.map((x) => ({ x, y })));
}

// the pieces on the 16-pixel grid in `view` (pieceCells) of region `region`'s layer 2 `l2` (l2Index order), most used
// first (equal counts: the one met first, row by row)
export function mapPieces(l2: ArrayLike<number>, region: number, view: Rect): L2Piece[] {
  const seen = new Map<string, L2Piece>();
  for (const { x, y } of pieceCells(view)) {
    const entries = l2Block(l2, region, x, y), key = entries.join();
    const p = seen.get(key);
    if (p) p.count++;
    else seen.set(key, { entries, count: 1 });
  }
  return [...seen.values()].sort((a, b) => b.count - a.count); // (stable: first met first)
}

// whether two pieces are the same (their 4 entries, palettes and flips included)
export const samePiece = (a: ArrayLike<number>, b: ArrayLike<number>): boolean => a.length === b.length && Array.prototype.every.call(a, (v: number, k: number) => v === b[k]);

// the cells of the 16-pixel grid wholly inside rectangle `r` (8x8 tiles), as a rectangle on the grid (null: none –
// narrower or lower than a piece there): a selection's pieces
export function gridInside(r: Rect): Rect | null {
  const x0 = (r.x + 1) & ~1, y0 = (r.y + 1) & ~1, x1 = (r.x + r.w) & ~1, y1 = (r.y + r.h) & ~1;
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

// where piece `entries` (a 2x2 brush's order, palettes and flips as on the map) is on the 16-pixel grid in `area`
// (pieceCells) of region `region`'s layer 2 `l2`
export function piecesAt(l2: ArrayLike<number>, region: number, area: Rect, entries: number[]): { x: number; y: number }[] {
  return pieceCells(area).filter(({ x, y }) => samePiece(l2Block(l2, region, x, y), entries));
}

// "Replace piece" (#370): every occurrence of piece `from` on the 16-pixel grid in `area` of region `region`'s layer 2
// `l2` becomes piece `to`, its 4 entries put with `put` (cell x, y of the region, the entry: a stroke's paint, so that
// the replacement is one ROM edit, in an event painted as the map after it); the number of pieces replaced
export function replacePiece(l2: ArrayLike<number>, region: number, area: Rect, from: number[], to: number[], put: (x: number, y: number, v: number) => void): number {
  if (samePiece(from, to)) return 0;
  const at = piecesAt(l2, region, area, from); // (all found before any is put: `put` may paint into `l2`)
  for (const { x, y } of at) to.forEach((v, k) => put(x + (k & 1), y + (k >> 1), v));
  return at.length;
}
