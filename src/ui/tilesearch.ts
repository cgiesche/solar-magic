// Search by tile number (hex) on the Map16 sheets (palette, Map16 tab, behavior picker), or by part of the
// file of the custom block on a tile or of the tile's name: the tiles that do not match are dimmed, a single
// match is framed and taken with Enter.

import { hex } from '../core/names.ts';

// tiles 0..count-1 matching the typed number, null for an empty input. A leading zero or all digits compare
// from the left of the full number, otherwise the number as typed is the start ("25" is 025 and 250–25F,
// "025" only 025). Also the tiles one of whose `texts` (block file, name … per tile) holds the input, in
// any case.
export function tileMatches(input: string, count: number, texts: Map<number, string>[] = []): number[] | null {
  const text = input.trim().toLowerCase();
  const q = text.toUpperCase().replace(/^(\$|0X)/, '');
  if (!q) return null;
  const digits = (count - 1).toString(16).length;
  const num = q.length <= digits && /^[0-9A-F]+$/.test(q);
  const padded = q.length === digits || q[0] === '0';
  const out: number[] = [];
  for (let t = 0; t < count; t++) {
    if ((num && (padded ? hex(t, digits) : t.toString(16).toUpperCase()).startsWith(q)) || texts.some((m) => m.get(t)?.toLowerCase().includes(text))) out.push(t);
  }
  return out;
}

// dims the tiles base..base+count-1 that are not in `match` and frames the single match; `size` is the drawn
// size of a tile, (x0, y0) the position of tile `base`, 16 tiles per row
export function drawTileMatches(ctx: CanvasRenderingContext2D, match: number[] | null, base: number, count: number, size: number, x0 = 0, y0 = 0): void {
  if (!match) return;
  const hit = new Set(match);
  ctx.fillStyle = 'rgba(0,0,0,0.75)';
  for (let i = 0; i < count; i++) if (!hit.has(base + i)) ctx.fillRect(x0 + (i & 15) * size, y0 + (i >> 4) * size, size, size);
  const i = match.length === 1 ? match[0] - base : -1;
  if (i < 0 || i >= count) return;
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2;
  ctx.strokeRect(x0 + (i & 15) * size + 3, y0 + (i >> 4) * size + 3, size - 6, size - 6);
}
