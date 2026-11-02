// Search by tile number (hex) on the Map16 sheets (palette, Map16 tab, behavior picker), or by part of the
// file of the custom block on a tile, of the tile's name or of what it does (its emulated behavior, as the
// tooltips say it): the tiles that do not match are dimmed, a single match is framed and taken with Enter.

import { hex } from '../core/names.ts';
import { EXT_FIRST, map16Ext, actsLike, blockOf } from '../core/map16ext.ts';
import type { Rom } from '../core/rom.ts';

// tiles 0..count-1 matching the typed number, null for an empty input. A leading zero or all digits compare
// from the left of the full number, otherwise the number as typed is the start ("25" is 025 and 250–25F,
// "025" only 025). Also the tiles one of whose `texts` (block file, name … per tile) holds the input,
// case-insensitively.
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

// the tile whose block probe tells what FG tile t does (the tooltips and the searches): t itself below 200, with a
// custom block or without the extension, else the tile it acts like (the game runs that tile's code for it, so they
// share one probe instead of one for each of the 3584 extended tiles; testtilesearch.ts checks by emulation that
// both say the same)
export function behaviorTile(rom: Rom, t: number): number {
  if (t < EXT_FIRST) return t;
  const e = map16Ext(rom);
  if (!e) return t;
  return e.blocks && blockOf(rom, t) ? t : actsLike(rom, t);
}

export interface Behaviors {
  texts: Map<number, string>; // what each tile does, of those already determined
  pending: number; // how many tiles are still being determined (those whose probes tell the others: the work left)
}
export const NO_BEHAVIORS: Behaviors = { texts: new Map(), pending: 0 };

// the behavior texts of tiles 0..count-1: `probeOf` a tile, the tile whose probe tells it (-1: none), `text` of that
// probe, undefined while it is still being determined
export function behaviorTexts(count: number, probeOf: (t: number) => number, text: (probe: number) => string | undefined): Behaviors {
  const texts = new Map<number, string>(), byProbe = new Map<number, string | undefined>();
  for (let t = 0; t < count; t++) {
    const b = probeOf(t);
    if (b < 0) continue;
    if (!byProbe.has(b)) byProbe.set(b, text(b));
    const x = byProbe.get(b);
    if (x !== undefined) texts.set(t, x);
  }
  return { texts, pending: [...byProbe.values()].filter((x) => x === undefined).length };
}

export interface Map16Match { tile: number; text: string; file: string | undefined }

// the central search's Map16 tiles 0..count-1 (Ctrl+F): those where every term is part of the tile's number (as
// tileMatches has it), of what it does (`behaviors`) or of the file of its custom block (`files`), with those texts
export function map16Matches(terms: string[], count: number, behaviors: Map<number, string>, files: Map<number, string>): Map16Match[] {
  const nums = terms.map((t) => new Set(tileMatches(t, count) ?? []));
  const out: Map16Match[] = [];
  for (let t = 0; t < count; t++) {
    const text = behaviors.get(t) ?? '', file = files.get(t);
    const low = `${text} ${file ?? ''}`.toLowerCase();
    if (terms.every((x, i) => nums[i].has(t) || low.includes(x))) out.push({ tile: t, text, file });
  }
  return out;
}

// the hint while a search by behavior is not final yet ('' once it is)
export function pendingHint(pending: number): string {
  return pending ? `${pending} tile${pending === 1 ? '' : 's'} still being determined …` : '';
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
