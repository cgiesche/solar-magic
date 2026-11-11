// Painting with a brush of cells on a picture, the way every brush editor does it (ADR 0011): left click/drag picks
// cells into the brush, right click or Shift+click paints, a right drag paints on on the brush's grid from the first
// cell; the hover frame (yellow, around the whole brush) and the pick rectangle (blue, filled) are drawn one screen
// pixel wide, whatever the zoom; Esc cancels a stroke or pick in progress.
//
// BrushDrag is the drag itself, without the DOM: the level's BG and layer 3 modes and the overworld's layers 1 and 2
// drive it from their own mouse handlers (their scrolled maps also drag other things) and draw its frame
// (drawBrushFrame) with their maps; BrushSurface puts it on a picture canvas with an overlay for the frames (the Game
// workspace's title screen and overworld border).

import type { CellRect } from './dom.ts';
import { MARK, rgba } from './marks.ts';

const HOVER_STROKE = 'rgba(255,255,0,0.9)', PICK_STROKE = MARK.select, PICK_FILL = rgba(MARK.select, 0.15);
// (a selection kept on the picture, as the overworld's layer 2 one "Replace piece…" works in: the pick's colour, dashed)
export const PAINT_HINT = 'Click/drag picks up tiles · Right click/Shift+click paints';
export const PAINT_TITLE = 'Right click/Shift+click paints';

// the cells from (x0, y0) to (x1, y1), corners in any order
export function pickRect(x0: number, y0: number, x1: number, y1: number): CellRect {
  return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0) + 1, h: Math.abs(y1 - y0) + 1 };
}
// where a stroke begun at cell (x0, y0) with a w×h brush stamps it when the mouse is at cell (x, y): on the brush's grid
export function brushGridCell(x0: number, y0: number, w: number, h: number, x: number, y: number): { x: number; y: number } {
  return { x: x0 + Math.floor((x - x0) / w) * w, y: y0 + Math.floor((y - y0) / h) * h };
}

// whether a mouse button paints: the right, or Shift+left without Ctrl (else the left picks)
export const paintButton = (e: { button: number; shiftKey: boolean; ctrlKey: boolean }) => e.button === 2 || (e.button === 0 && e.shiftKey && !e.ctrlKey);

type Cell = { x: number; y: number };
type Drag = { kind: 'paint'; x0: number; y0: number; lastX: number; lastY: number } | { kind: 'pick'; x0: number; y0: number; x1: number; y1: number };

// what a drag asks of its editor
export interface BrushDragHooks {
  brush: () => { w: number; h: number };
  stamp: (x: number, y: number) => boolean; // the brush put at cell (x, y); whether anything changed
  end: () => void; // the stroke ended: saved
  cancel: () => void; // the stroke cancelled (Esc): what it painted dropped
  pick: (r: CellRect) => void; // the cells taken as the brush
  changed?: () => void; // a stamp changed something: to draw again
}

// a stroke or a pick on cells: begun by the editor (startPaint / startPick at the cell under the mouse), moved, ended
export class BrushDrag {
  private d: Drag | null = null;
  private h: BrushDragHooks;
  constructor(h: BrushDragHooks) { this.h = h; }
  get active(): boolean { return !!this.d; }
  get painting(): boolean { return this.d?.kind === 'paint'; }
  get picking(): boolean { return this.d?.kind === 'pick'; }
  startPaint(c: Cell): void {
    this.d = { kind: 'paint', x0: c.x, y0: c.y, lastX: c.x, lastY: c.y };
    if (this.h.stamp(c.x, c.y)) this.h.changed?.();
  }
  startPick(c: Cell): void {
    this.d = { kind: 'pick', x0: c.x, y0: c.y, x1: c.x, y1: c.y };
  }
  // the mouse at cell c: a stroke stamps on the brush's grid, a pick's rectangle follows; whether the frame changed
  move(c: Cell): boolean {
    const d = this.d;
    if (d?.kind === 'paint') {
      const b = this.h.brush(), g = brushGridCell(d.x0, d.y0, b.w, b.h, c.x, c.y);
      if (g.x !== d.lastX || g.y !== d.lastY) { d.lastX = g.x; d.lastY = g.y; if (this.h.stamp(g.x, g.y)) this.h.changed?.(); }
      return false;
    }
    if (d?.kind !== 'pick' || (d.x1 === c.x && d.y1 === c.y)) return false;
    d.x1 = c.x; d.y1 = c.y;
    return true;
  }
  // the button released: the stroke saved, or the cells picked
  up(): void {
    const d = this.d;
    if (!d) return;
    this.d = null;
    if (d.kind === 'pick') this.h.pick(pickRect(d.x0, d.y0, d.x1, d.y1));
    else this.h.end();
  }
  // Esc: a stroke (cancelled) or pick (dropped) in progress; whether there was one
  cancel(): boolean {
    const d = this.d;
    if (!d) return false;
    this.d = null;
    if (d.kind === 'paint') this.h.cancel();
    return true;
  }
  // dropped without anything said (what it painted on was replaced)
  drop(): void { this.d = null; }
  // the rectangle being picked (null: none)
  pickFrame(): CellRect | null {
    const d = this.d;
    return d?.kind === 'pick' ? pickRect(d.x0, d.y0, d.x1, d.y1) : null;
  }
  // the cells the brush covers at cell `at` (clipped to `cells`)
  hoverFrame(at: Cell, cells?: { w: number; h: number }): CellRect {
    const b = this.h.brush();
    return { x: at.x, y: at.y, w: cells ? Math.min(b.w, cells.w - at.x) : b.w, h: cells ? Math.min(b.h, cells.h - at.y) : b.h };
  }
}

// a frame drawn: the box [x, y, w, h] in the context's units, lw: one screen pixel in them
export function drawBrushFrame(ctx: CanvasRenderingContext2D, kind: 'pick' | 'hover' | 'selection', box: [number, number, number, number], lw: number): void {
  ctx.lineWidth = lw;
  if (kind === 'pick') { ctx.fillStyle = PICK_FILL; ctx.fillRect(...box); ctx.strokeStyle = PICK_STROKE; } else ctx.strokeStyle = kind === 'selection' ? PICK_STROKE : HOVER_STROKE;
  if (kind === 'selection') ctx.setLineDash([4 * lw, 3 * lw]);
  ctx.strokeRect(...box);
  ctx.setLineDash([]);
}

export interface BrushSurfaceOptions {
  cells: { w: number; h: number }; // the picture's cells
  cellAt: (px: number, py: number) => { x: number; y: number } | null; // the cell at picture pixel (px, py)
  box: (r: CellRect) => CellRect | null; // the cells' rectangle in picture pixels (null: not shown)
  brush: () => { w: number; h: number };
  whyNot?: (x: number, y: number) => string; // why a stroke may not start at cell (x, y) ('' it may)
  stamp: (x: number, y: number) => boolean; // the brush put at cell (x, y); whether anything changed
  end: () => void; // the stroke ended: saved
  cancel: () => void; // the stroke cancelled: what it painted dropped
  pick: (r: CellRect) => void; // the cells taken as the brush
  tell?: (why: string) => void; // told why a stroke didn't start
  changed: () => void; // the picture to draw again (painted)
  moved: (cell: { x: number; y: number } | null) => void; // the cell under the mouse (status bar)
}

// a picture canvas painted with a brush: the mouse on it and the frames on an overlay of the same size
export class BrushSurface {
  root: HTMLDivElement;
  private hover: Cell | null = null;
  private drag: BrushDrag;
  private over: HTMLCanvasElement;
  private o: BrushSurfaceOptions;
  private canvas: HTMLCanvasElement;
  constructor(canvas: HTMLCanvasElement, o: BrushSurfaceOptions) {
    this.canvas = canvas;
    this.o = o;
    this.drag = new BrushDrag(o);
    this.over = document.createElement('canvas');
    this.over.className = 'brush-over';
    this.root = document.createElement('div');
    this.root.className = 'brush-surface';
    this.root.append(canvas, this.over);
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('mousedown', (e) => this.down(e));
    canvas.addEventListener('mousemove', (e) => this.move(e));
    canvas.addEventListener('mouseleave', () => { this.hover = null; this.o.moved(null); this.frames(); });
    window.addEventListener('mouseup', (e) => { if (e.button !== 1) this.up(); }); // (the middle button pans)
  }

  get painting(): boolean { return this.drag.painting; }

  private cell(e: MouseEvent): { x: number; y: number } | null {
    const rc = this.canvas.getBoundingClientRect();
    return this.o.cellAt((e.clientX - rc.left) / rc.width * this.canvas.width, (e.clientY - rc.top) / rc.height * this.canvas.height);
  }
  private down(e: MouseEvent): void {
    if (e.button === 1) return; // (panning)
    const c = this.cell(e);
    if (!c) return;
    e.preventDefault();
    if (paintButton(e)) {
      const no = this.o.whyNot?.(c.x, c.y);
      if (no) { this.o.tell?.(no); return; }
      this.drag.startPaint(c);
      return;
    }
    if (e.button !== 0) return;
    this.drag.startPick(c);
    this.frames();
  }
  private move(e: MouseEvent): void {
    const c = this.cell(e);
    this.hover = c;
    if (c) this.drag.move(c);
    this.o.moved(c);
    this.frames();
  }
  private up(): void {
    if (!this.drag.active) return;
    this.drag.up();
    this.frames();
  }
  // Esc: a stroke or pick in progress cancelled; whether there was one
  key(e: KeyboardEvent): boolean {
    if (e.key !== 'Escape' || !this.drag.cancel()) return false;
    this.frames();
    return true;
  }
  // a stroke in progress dropped without being saved (the picture changed under it)
  drop(): void { this.drag.drop(); this.frames(); }

  // the hover frame or the pick rectangle, one screen pixel wide on the overlay
  frames(): void {
    if (!this.canvas.isConnected) return; // (laid out when shown)
    const rc = this.canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    const W = Math.max(1, Math.round(rc.width * dpr)), H = Math.max(1, Math.round(rc.height * dpr));
    if (this.over.width !== W || this.over.height !== H) { this.over.width = W; this.over.height = H; }
    this.over.style.width = `${rc.width}px`;
    this.over.style.height = `${rc.height}px`;
    const ctx = this.over.getContext('2d')!;
    ctx.clearRect(0, 0, W, H);
    const pick = this.drag.pickFrame(), r = pick ?? (this.hover && this.drag.hoverFrame(this.hover, this.o.cells)), box = r && this.o.box(r);
    if (!box) return;
    const sx = W / this.canvas.width, sy = H / this.canvas.height;
    drawBrushFrame(ctx, pick ? 'pick' : 'hover', [Math.round(box.x * sx) + 0.5, Math.round(box.y * sy) + 0.5, Math.round(box.w * sx) - 1, Math.round(box.h * sy) - 1], 1);
  }
}
