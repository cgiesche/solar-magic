// The quarters of a rectangle of Map16 tiles as one grid (two columns and two rows of quarters per tile),
// marked as a set: edits apply to every marked quarter, a flip mirrors the marked quarters as one picture, a block of 8x8 tiles is stamped onto it where it
// lies, acts-like applies to the wholly marked 16x16 tiles. Words of the tiles in the selection's order
// (row by row), each in the quarter order TL, BL, TR, BR.

export const FLIP_X = 0x4000, FLIP_Y = 0x8000, PRIO = 0x2000;
const PAL = 0x1c00, NUM = 0x3ff;

export type QuarterRect = { x: number; y: number; w: number; h: number };
// 'set' replaces the marks, 'add' and 'remove' change them (Ctrl)
export type MarkMode = 'set' | 'add' | 'remove';
// how the marked quarters agree on a bit
export type BitState = 'on' | 'off' | 'mixed';

export class QuarterGrid {
  readonly w: number;
  readonly h: number;
  readonly cols: number;
  readonly rows: number;
  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.cols = w * 2;
    this.rows = h * 2;
  }
  key(x: number, y: number): number { return y * this.cols + x; }
  pos(key: number): { x: number; y: number } { return { x: key % this.cols, y: Math.floor(key / this.cols) }; }
  // the tile (index in the selection) and the word of a quarter
  at(x: number, y: number): { tile: number; q: number } {
    return { tile: (y >> 1) * this.w + (x >> 1), q: (x & 1) * 2 + (y & 1) };
  }
  locate(key: number): { tile: number; q: number } { const { x, y } = this.pos(key); return this.at(x, y); }
  all(): Set<number> {
    return new Set(Array.from({ length: this.cols * this.rows }, (_, i) => i));
  }
  // the four quarters of the 16x16 tile a quarter is in
  wholeTile(key: number): Set<number> {
    const { x, y } = this.pos(key), x0 = x & ~1, y0 = y & ~1;
    return new Set([this.key(x0, y0), this.key(x0 + 1, y0), this.key(x0, y0 + 1), this.key(x0 + 1, y0 + 1)]);
  }
}

// the marks after marking a rectangle (cut to the grid); a new set
export function markRect(g: QuarterGrid, marks: Set<number>, r: QuarterRect, mode: MarkMode): Set<number> {
  const out = mode === 'set' ? new Set<number>() : new Set(marks);
  for (let y = Math.max(0, r.y); y < Math.min(g.rows, r.y + r.h); y++) {
    for (let x = Math.max(0, r.x); x < Math.min(g.cols, r.x + r.w); x++) {
      if (mode === 'remove') out.delete(g.key(x, y)); else out.add(g.key(x, y));
    }
  }
  return out;
}

export const setPalette = (p: number) => (w: number) => (w & ~PAL) | ((p & 7) << 10);
export const setBit = (bit: number, on: boolean) => (w: number) => (on ? w | bit : w & ~bit);
// another 8x8 tile, palette, flips and priority kept
export const setTileNum = (n: number) => (w: number) => (w & ~NUM) | (n & NUM);

// the tiles' words after changing every marked quarter (new arrays) and the tiles that changed
export interface QuarterEdit { words: number[][]; changed: number[] }
export function editMarked(g: QuarterGrid, words: number[][], marks: Set<number>, fn: (w: number) => number): QuarterEdit {
  const out = words.map((ws) => [...ws]);
  for (const k of marks) {
    const { tile, q } = g.locate(k);
    out[tile][q] = fn(out[tile][q]);
  }
  return { words: out, changed: changedTiles(words, out) };
}

// the marked quarters mirrored as one picture (bit FLIP_X: left to right across the marks' bounding box,
// FLIP_Y: top to bottom): each takes the word of its mirror quarter with the flip toggled, across tile
// borders; a single quarter just toggles its flip. null when the marks are not symmetric to that axis
export function mirror(g: QuarterGrid, words: number[][], marks: Set<number>, bit: number): QuarterEdit | null {
  const ps = [...marks].map((k) => g.pos(k));
  const lo = Math.min(...ps.map((p) => (bit === FLIP_X ? p.x : p.y))), hi = Math.max(...ps.map((p) => (bit === FLIP_X ? p.x : p.y)));
  const other = (p: { x: number; y: number }) => (bit === FLIP_X ? { x: lo + hi - p.x, y: p.y } : { x: p.x, y: lo + hi - p.y });
  if (ps.some((p) => { const o = other(p); return !marks.has(g.key(o.x, o.y)); })) return null;
  const out = words.map((ws) => [...ws]);
  for (const p of ps) {
    const { tile, q } = g.at(p.x, p.y), o = other(p), from = g.at(o.x, o.y);
    out[tile][q] = words[from.tile][from.q] ^ bit;
  }
  return { words: out, changed: changedTiles(words, out) };
}

// a block of 8x8 tile numbers (rows, -1: none) with its top-left corner on a quarter: the tile numbers are
// set and the flips cleared, palette and priority stay; cut: the block's 8x8 tiles outside the grid
export function stamp(g: QuarterGrid, words: number[][], at: { x: number; y: number }, block: number[][]): QuarterEdit & { cut: number } {
  const out = words.map((ws) => [...ws]);
  let cut = 0;
  block.forEach((row, dy) => row.forEach((n, dx) => {
    const x = at.x + dx, y = at.y + dy;
    if (x < 0 || y < 0 || x >= g.cols || y >= g.rows) { cut++; return; }
    if (n < 0) return;
    const { tile, q } = g.at(x, y);
    out[tile][q] = (out[tile][q] & (PAL | PRIO)) | (n & NUM);
  }));
  return { words: out, changed: changedTiles(words, out), cut };
}

function changedTiles(before: number[][], after: number[][]): number[] {
  return after.flatMap((ws, i) => (ws.some((w, q) => w !== before[i][q]) ? [i] : []));
}

// what the marked quarters have: every palette in use, each bit on, off or mixed
export interface QuarterSummary { pals: Set<number>; flipX: BitState; flipY: BitState; prio: BitState }
export function summary(g: QuarterGrid, words: number[][], marks: Set<number>): QuarterSummary {
  const ws = [...marks].map((k) => { const { tile, q } = g.locate(k); return words[tile][q]; });
  const bit = (b: number): BitState => {
    const on = ws.filter((w) => w & b).length;
    return on === 0 ? 'off' : on === ws.length ? 'on' : 'mixed';
  };
  return { pals: new Set(ws.map((w) => (w >> 10) & 7)), flipX: bit(FLIP_X), flipY: bit(FLIP_Y), prio: bit(PRIO) };
}

// the tiles (indices in the selection) acts-like applies to: those marked, when each is marked whole;
// null when nothing is marked or a tile is marked in part
export function wholeTiles(g: QuarterGrid, marks: Set<number>): number[] | null {
  const count = new Map<number, number>();
  for (const k of marks) { const t = g.locate(k).tile; count.set(t, (count.get(t) ?? 0) + 1); }
  if (!count.size || [...count.values()].some((n) => n < 4)) return null;
  return [...count.keys()].sort((a, b) => a - b);
}

// a tile's words with every quarter that shows one of the 8x8 `tiles` (numbers) in palette p (an
// animation's target drawn in the palette chosen for it); null when they all have it already
export function paletteOn(words: number[], tiles: Set<number>, p: number): number[] | null {
  let changed = false;
  const out = words.map((w) => { if (!tiles.has(w & NUM) || ((w & PAL) >> 10) === p) return w; changed = true; return setPalette(p)(w); });
  return changed ? out : null;
}
