// The name of the selected level tile in the overworld's layer 1 mode (#369, level tiles as objects there: ADR 0012),
// and of a selected star or pipe 5B with a translevel of its own (owstars.ts, the status bar's name while Mario stands
// on it): a label under the tile, display only (#422) – the name is edited in the tile's properties
// (levelnamefield.ts, which shows it in the map's font as the border has it). Drawn in the UI's font, small, in screen
// pixels so it is sharp at every zoom, and kept inside the part of the map in view: shifted sideways at its edges,
// above the tile where there is no room below.

import type { OverworldView } from './overworld.ts';
import { l1XY, owShownAt } from '../core/overworld.ts';
import { levelName, hasLevelName, levelNamePatch } from '../core/levelnames.ts';
import { ownsTranslevel } from '../core/owstars.ts';
import type { Rect } from '../core/owevents.ts';

// where a label w × h goes for the tile at `tile` with the map in view `view` (all in screen pixels), gap pixels from
// the tile: under it, centred; shifted sideways to stay in view; above it where there is no room below (neither: in
// view at the bottom). null: the tile is out of view (no label at an edge for a tile not seen)
export function placeLabel(tile: Rect, w: number, h: number, view: Rect, gap: number): { x: number; y: number } | null {
  const vr = view.x + view.w, vb = view.y + view.h;
  if (tile.x + tile.w <= view.x || tile.x >= vr || tile.y + tile.h <= view.y || tile.y >= vb) return null;
  const x = Math.max(view.x, Math.min(vr - w, tile.x + tile.w / 2 - w / 2));
  const below = tile.y + tile.h + gap, above = tile.y - gap - h;
  const y = below + h <= vb ? below : above >= view.y ? above : Math.max(view.y, vb - h);
  return { x: Math.round(x), y: Math.round(y) };
}

const FONT = 11, PAD_X = 4, PAD_Y = 2, GAP = 2; // CSS pixels

export class LevelNameLabel {
  private view: OverworldView;
  constructor(view: OverworldView) { this.view = view; }

  // the selected level tile, star or pipe and its translevel (null: none, another mode, no level names in the ROM)
  private target(): { i: number; tl: number } | null {
    const v = this.view, i = v.selected;
    if (v.mode !== 'l1' || i < 0 || (i >= 0x400) !== (v.region === 1) || !levelNamePatch(v.app.rom)) return null;
    const tl = v.tls[i], t = v.levelL1()[i];
    if (!tl) return null;
    return v.isLevelTile(t) || (v.pathKinds() && ownsTranslevel(t)) ? { i, tl } : null;
  }

  // drawn on the view's canvas in its own pixels (the transform reset, the canvas' alpha kept): map the shown 512x512
  // map's place on the canvas, dpr screen pixels per CSS pixel
  paint(ctx: CanvasRenderingContext2D, map: Rect, dpr: number): void {
    const t = this.target();
    if (!t) return;
    const z = map.w / 512, { x, y } = l1XY(t.i), at = owShownAt(this.view.region, x * 16, y * 16);
    const tile = { x: map.x + at.x * z, y: map.y + at.y * z, w: 16 * z, h: 16 * z };
    // (the map in view: where it covers the canvas)
    const c = ctx.canvas, x0 = Math.max(0, map.x), y0 = Math.max(0, map.y);
    const view = { x: x0, y: y0, w: Math.min(c.width, map.x + map.w) - x0, h: Math.min(c.height, map.y + map.h) - y0 };
    const rom = this.view.app.rom, named = hasLevelName(rom, t.tl), text = levelName(rom, t.tl), size = Math.round(FONT * dpr);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.font = `${size}px ${getComputedStyle(c).fontFamily || 'sans-serif'}`; // (the UI's font: the canvas inherits it)
    ctx.textBaseline = 'middle';
    const w = Math.ceil(ctx.measureText(text).width) + 2 * Math.round(PAD_X * dpr), h = size + 2 * Math.round(PAD_Y * dpr);
    const p = placeLabel(tile, w, h, view, Math.round(GAP * dpr));
    if (p) {
      ctx.fillStyle = 'rgba(0,0,0,0.8)';
      ctx.fillRect(p.x, p.y, w, h);
      ctx.strokeStyle = '#4cc2ff';
      const lw = Math.max(1, Math.round(dpr));
      ctx.lineWidth = lw;
      ctx.strokeRect(p.x + lw / 2, p.y + lw / 2, w - lw, h - lw);
      ctx.fillStyle = !named ? 'rgba(255,255,255,0.6)' : '#fff';
      ctx.fillText(text, p.x + Math.round(PAD_X * dpr), p.y + Math.round(h / 2));
    }
    ctx.restore();
  }
}
