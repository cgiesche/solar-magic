// The level view's overlays that a level's image (levelimages.ts) draws too: grid, screen boundaries, exits.

import type { App } from './app.ts';
import { hex2, hex3 } from '../core/names.ts';
import { screenRect, type LayerGeom } from '../core/render.ts';
import type { Level } from '../core/level.ts';
import { exitTarget } from '../core/exitgraph.ts';
import { overworldExitText } from '../core/owteleport.ts';
import { SCREEN_PX } from '../core/levelimage.ts';

// lw: a line's width, px: a screen pixel (labels), both in level pixels

export function paintGrid(ctx: CanvasRenderingContext2D, width: number, height: number, lw: number): void {
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.lineWidth = lw;
  ctx.beginPath();
  for (let x = 0; x <= width; x += 16) { ctx.moveTo(x, 0); ctx.lineTo(x, height); }
  for (let y = 0; y <= height; y += 16) { ctx.moveTo(0, y); ctx.lineTo(width, y); }
  ctx.stroke();
}

// dashed lines between the screens and each screen's number
export function paintScreens(ctx: CanvasRenderingContext2D, width: number, height: number, vertical: boolean, screens: number, lw: number, px: number): void {
  ctx.strokeStyle = 'rgba(255,255,255,0.45)';
  ctx.setLineDash([4 * lw, 4 * lw]);
  ctx.lineWidth = lw;
  ctx.beginPath();
  if (vertical) for (let y = SCREEN_PX; y < height; y += SCREEN_PX) { ctx.moveTo(0, y); ctx.lineTo(width, y); }
  else for (let x = SCREEN_PX; x < width; x += SCREEN_PX) { ctx.moveTo(x, 0); ctx.lineTo(x, height); }
  ctx.stroke();
  ctx.setLineDash([]);
  // on a dark box like the exit labels, readable on light backgrounds too
  ctx.font = `${11 * px}px sans-serif`;
  for (let s = 0; s < screens; s++) {
    const x = vertical ? 0 : s * SCREEN_PX, y = vertical ? s * SCREEN_PX : 0, txt = hex2(s);
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(x, y, ctx.measureText(txt).width + 4 * px, 14 * px);
    ctx.fillStyle = '#fff';
    ctx.fillText(txt, x + 2 * px, y + 11 * px);
  }
}

// the screens with an exit, tinted (selected: the exit panel's), and where each leads
export function paintExits(ctx: CanvasRenderingContext2D, app: App, lv: Level, geom: LayerGeom, px: number, selected = -1): void {
  const g = app.entrances.graph();
  for (const ex of lv.exits) {
    const { x, y, w, h: rh } = screenRect(geom, ex.screen);
    ctx.fillStyle = selected === ex.screen ? 'rgba(255,200,0,0.25)' : 'rgba(255,160,0,0.08)';
    ctx.fillRect(x, y, w, rh);
    const t = exitTarget(app.rom, lv.number, ex);
    const ok = t.entrance < 0 || t.overworld || g.entrancesOf(t.to).includes(t.entrance);
    ctx.font = `bold ${12 * px}px sans-serif`;
    const line = (txt: string, i: number) => {
      const ty = y + (12 + i * 14) * px;
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(x + 18 * px, ty - 11 * px, ctx.measureText(txt).width + 4 * px, 14 * px);
      ctx.fillStyle = ok ? '#ffb000' : '#ff5050';
      ctx.fillText(txt, x + 20 * px, ty);
    };
    line(t.overworld ? 'Exit → Overworld' : `Exit → ${g.label(t.to)}`, 0);
    if (t.overworld) line(overworldExitText(app.rom, app.entrances.get(t.entrance).overworld!), 1);
    else if (t.entrance >= 0) line(ok ? `via sec. entrance ${hex3(t.entrance)}` : `sec. entrance ${hex3(t.entrance)} missing`, 1);
  }
}
