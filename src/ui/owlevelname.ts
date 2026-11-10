// The name of the selected level tile in the overworld's layer 1 mode (#369, level tiles as objects there: ADR 0012),
// and of a selected star or pipe 5B with a translevel of its own (owstars.ts, the status bar's name while Mario stands
// on it): a label under the tile, display only (#422) – the name is edited in the tile's properties
// (levelnamefield.ts, which shows it in the map's font as the border has it). Drawn in the UI's font, small, in screen
// pixels so it is sharp at every zoom, and kept inside the part of the map in view: shifted sideways at its edges,
// above the tile where there is no room below. Under them, the same way, where the overworld links painted (owlinkview.ts
// offMap) lead on another map, each with a link symbol: a click on it shows the other end, selected.

import type { OverworldView } from './overworld.ts';
import { l1XY, owShownAt } from '../core/overworld.ts';
import { levelName, hasLevelName, levelNamePatch } from '../core/levelnames.ts';
import { ownsTranslevel } from '../core/owstars.ts';
import type { Rect } from '../core/owevents.ts';
import type { OffMapEnd } from './owlinkview.ts';

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

const FONT = 11, PAD_X = 4, PAD_Y = 2, GAP = 2, ICON_GAP = 4; // CSS pixels

// a label's box: its text (dim: a level without a name of its own), with a link symbol after it (its jump)
type Label = { text: string; dim?: boolean; jump?: OffMapEnd };

export class TileLabels {
  private view: OverworldView;
  // where the link symbols were painted (canvas pixels) and what a click on them shows
  private jumps: { x: number; y: number; w: number; h: number; end: OffMapEnd }[] = [];
  constructor(view: OverworldView) { this.view = view; }

  // the selected level tile, star or pipe and its translevel (null: none, another mode, no level names in the ROM)
  private target(): { i: number; tl: number } | null {
    const v = this.view, i = v.selected;
    if (v.mode !== 'l1' || i < 0 || (i >= 0x400) !== (v.region === 1) || !levelNamePatch(v.app.rom)) return null;
    const tl = v.tls[i], t = v.levelL1()[i];
    if (!tl) return null;
    return v.isLevelTile(t) || (v.pathKinds() && ownsTranslevel(t)) ? { i, tl } : null;
  }

  // the labels of each tile: the selected level's name, then where its links lead
  private labels(): Map<number, Label[]> {
    const out = new Map<number, Label[]>(), add = (i: number, l: Label) => { const a = out.get(i); if (a) a.push(l); else out.set(i, [l]); };
    const t = this.target(), rom = this.view.app.rom;
    if (t) add(t.i, { text: levelName(rom, t.tl), dim: !hasLevelName(rom, t.tl) });
    for (const e of this.view.links.offMap) add(e.i, { text: e.text, jump: e });
    return out;
  }

  // drawn on the view's canvas in its own pixels (the transform reset, the canvas' alpha kept): map the shown 512x512
  // map's place on the canvas, dpr screen pixels per CSS pixel
  paint(ctx: CanvasRenderingContext2D, map: Rect, dpr: number): void {
    this.jumps = [];
    const all = this.labels();
    if (!all.size) return;
    const z = map.w / 512, c = ctx.canvas, size = Math.round(FONT * dpr);
    // (the map in view: where it covers the canvas)
    const x0 = Math.max(0, map.x), y0 = Math.max(0, map.y);
    const view = { x: x0, y: y0, w: Math.min(c.width, map.x + map.w) - x0, h: Math.min(c.height, map.y + map.h) - y0 };
    const px = Math.round(PAD_X * dpr), h = size + 2 * Math.round(PAD_Y * dpr), gap = Math.round(GAP * dpr), lw = Math.max(1, Math.round(dpr));
    const icon = size, iconGap = Math.round(ICON_GAP * dpr);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.font = `${size}px ${getComputedStyle(c).fontFamily || 'sans-serif'}`; // (the UI's font: the canvas inherits it)
    ctx.textBaseline = 'middle';
    for (const [i, labels] of all) {
      const { x, y } = l1XY(i), at = owShownAt(this.view.region, x * 16, y * 16);
      // (each label under the one before: the tile with the labels placed so far)
      let tile = { x: map.x + at.x * z, y: map.y + at.y * z, w: 16 * z, h: 16 * z };
      for (const l of labels) {
        const tw = Math.ceil(ctx.measureText(l.text).width), w = tw + 2 * px + (l.jump ? iconGap + icon : 0);
        const p = placeLabel(tile, w, h, view, gap);
        if (!p) break;
        ctx.fillStyle = 'rgba(0,0,0,0.8)';
        ctx.fillRect(p.x, p.y, w, h);
        ctx.strokeStyle = '#4cc2ff';
        ctx.lineWidth = lw;
        ctx.strokeRect(p.x + lw / 2, p.y + lw / 2, w - lw, h - lw);
        ctx.fillStyle = l.dim ? 'rgba(255,255,255,0.6)' : '#fff';
        ctx.fillText(l.text, p.x + px, p.y + Math.round(h / 2));
        if (l.jump) {
          const ix = p.x + px + tw + iconGap, iy = p.y + Math.round((h - icon) / 2);
          linkSymbol(ctx, ix, iy, icon, lw, '#4cc2ff');
          this.jumps.push({ x: ix - iconGap / 2, y: p.y, w: icon + iconGap / 2 + px, h, end: l.jump });
        }
        const top = Math.min(tile.y, p.y), bottom = Math.max(tile.y + tile.h, p.y + h);
        tile = { ...tile, y: top, h: bottom - top };
      }
    }
    ctx.restore();
  }

  // the link end whose label's link symbol is at the client point (null: none)
  jumpAt(clientX: number, clientY: number): OffMapEnd | null {
    const c = this.view.canvas, rc = c.getBoundingClientRect();
    if (!rc.width || !rc.height) return null;
    const x = (clientX - rc.left) * (c.width / rc.width), y = (clientY - rc.top) * (c.height / rc.height);
    return this.jumps.find((j) => x >= j.x && x < j.x + j.w && y >= j.y && y < j.y + j.h)?.end ?? null;
  }
}

// a chain link s x s pixels at (x, y): two rounded links across each other, diagonally
function linkSymbol(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, lw: number, color: string): void {
  ctx.save();
  ctx.translate(x + s / 2, y + s / 2);
  ctx.rotate(-Math.PI / 4);
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(lw, s / 7);
  const lh = s * 0.36, ll = s * 0.6, r = lh / 2;
  for (const dx of [-s * 0.2, s * 0.2]) {
    ctx.beginPath();
    ctx.roundRect(dx - ll / 2, -lh / 2, ll, lh, r);
    ctx.stroke();
  }
  ctx.restore();
}
