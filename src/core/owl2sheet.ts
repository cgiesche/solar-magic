// The overworld layer 2 sheet: the 1024 8x8 tiles of layer 2's graphics, 16 a row, in one palette (0–7), without
// flips. A brush is a block of layer 2 tilemap entries (tile number, palette, flips, priority); one picked from the
// map takes the map's palettes and flips, so where it is in the sheet has to be found (#336):
// - its palette: the sheet shows the brush's palette when all its entries share one (l2BrushPalettes);
// - as a rectangle of the sheet: its entries are a w×h block of the sheet in that palette, mirrored as a whole (X, Y or
//   both: every entry carries the block's flips) – the priority bit does not matter;
// - else its 8x8 tiles one by one (whatever their palettes and flips).

export const L2_TILE = 0x3ff, L2_PRIORITY = 0x2000, L2_FLIP_X = 0x4000, L2_FLIP_Y = 0x8000;
export const L2_FLIPS = L2_FLIP_X | L2_FLIP_Y;
export const L2_SHEET_COLS = 16, L2_SHEET_ROWS = 64;

export const l2Palette = (v: number) => (v >> 10) & 7;

// the sheet's entry at cell (x, y) in palette pal
export const l2SheetEntry = (x: number, y: number, pal: number) => (y * L2_SHEET_COLS + x) | (pal << 10);

// the palettes a brush's entries use, in order
export function l2BrushPalettes(entries: readonly number[]): number[] {
  return [...new Set(entries.map(l2Palette))].sort((a, b) => a - b);
}

// the bits (flips, priority) every entry of a brush has
export function l2SharedBits(entries: readonly number[]): number {
  return entries.reduce((m, v) => m & v, L2_FLIPS | L2_PRIORITY);
}

export type SheetMark =
  | { kind: 'rect'; x: number; y: number; w: number; h: number; flip: number } // flip: the block's L2_FLIP_X/L2_FLIP_Y
  | { kind: 'tiles'; cells: { x: number; y: number }[] }; // its 8x8 tiles one by one (each once)

// where a w×h brush is in the sheet shown in palette pal
export function findL2Brush(b: { w: number; h: number; entries: readonly number[] }, pal: number): SheetMark {
  const e = b.entries, flip = e[0] & L2_FLIPS;
  if (e.length && e.every((v) => (v & L2_FLIPS) === flip && l2Palette(v) === pal)) {
    // the sheet's cell of entry (i, j) is (x + i', y + j'), i'/j' mirrored by the block's flips
    const sx = (i: number) => (flip & L2_FLIP_X ? b.w - 1 - i : i), sy = (j: number) => (flip & L2_FLIP_Y ? b.h - 1 - j : j);
    const t0 = e[0] & L2_TILE, x = (t0 % L2_SHEET_COLS) - sx(0), y = Math.floor(t0 / L2_SHEET_COLS) - sy(0);
    if (x >= 0 && y >= 0 && x + b.w <= L2_SHEET_COLS && y + b.h <= L2_SHEET_ROWS
      && e.every((v, k) => (v & L2_TILE) === (y + sy(Math.floor(k / b.w))) * L2_SHEET_COLS + x + sx(k % b.w))) {
      return { kind: 'rect', x, y, w: b.w, h: b.h, flip };
    }
  }
  const tiles = [...new Set(e.map((v) => v & L2_TILE))];
  return { kind: 'tiles', cells: tiles.map((t) => ({ x: t % L2_SHEET_COLS, y: Math.floor(t / L2_SHEET_COLS) })) };
}
