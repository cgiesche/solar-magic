// Search by tile number (hex) on the Map16 sheets (palette, Map16 tab, behavior picker), or by part of the
// file of the custom block on a tile, of the tile's name or of what it does (its emulated behavior, as the
// tooltips say it): the tiles that do not match are dimmed, a single match is framed and taken with Enter.

import { hex } from '../core/names.ts';
import { EXT_FIRST, map16Ext, actsLike, blockOf } from '../core/map16ext.ts';
import { probeText } from '../core/blockprobe.ts';
import type { Rom } from '../core/rom.ts';
import type { App } from './app.ts';

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

// the tile whose block probe tells what FG tile t does: t itself below 200 or with a custom block, else the
// tile it acts like (the game runs that tile's code for it); -1 for an extended tile without the extension
export function behaviorTile(rom: Rom, t: number): number {
  if (t < EXT_FIRST) return t;
  const e = map16Ext(rom);
  if (!e) return -1;
  return e.blocks && blockOf(rom, t) ? t : actsLike(rom, t);
}

export interface Behaviors {
  texts: Map<number, string>; // what each tile does, of those already determined
  pending: number; // how many tiles are still being determined
}

// the behavior texts of tiles 0..count-1; `text` of a tile: undefined while still being determined, null when it
// has none
export function behaviorTexts(count: number, text: (t: number) => string | null | undefined): Behaviors {
  const texts = new Map<number, string>();
  let pending = 0;
  for (let t = 0; t < count; t++) {
    const x = text(t);
    if (x === undefined) pending++;
    else if (x !== null) texts.set(t, x);
  }
  return { texts, pending };
}

// what FG tiles 0..count-1 do, as the tooltips say it (the emulation's block probes, behaviorTile's; those not
// done yet are asked for, 'probes' says when they are)
export function tileBehaviors(app: App, count: number): Behaviors {
  const byProbe = new Map<number, string | undefined>();
  return behaviorTexts(count, (t) => {
    const b = behaviorTile(app.rom, t);
    if (b < 0) return null;
    if (!byProbe.has(b)) { const p = app.probes.block(b); byProbe.set(b, p && probeText(p)); }
    return byProbe.get(b);
  });
}

// fn whenever more tiles' behavior may be known: when the probes are done, and as they go on (the busy count of
// the block probes) at most once a second; returns what stops it
export function onBehaviorProgress(app: App, fn: () => void): () => void {
  let timer = 0;
  const now = () => { clearTimeout(timer); timer = 0; fn(); };
  const offDone = app.on('probes', now);
  const offBusy = app.on('busy', () => { if (!timer) timer = window.setTimeout(now, 1000); });
  return () => { clearTimeout(timer); offDone(); offBusy(); };
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
