// Painting with a brush of cells on a picture, the way every brush editor does it (ADR 0011): left click/drag picks
// cells into the brush, right click or Shift+click paints, a right drag paints on on the brush's grid from the first
// cell; the hover frame (yellow, around the whole brush) and the pick rectangle (blue, filled) are drawn one screen
// pixel wide on an overlay over the picture, whatever its zoom; Esc cancels a stroke or pick in progress. Used by the
// Game workspace (the title screen, the overworld border); the level and the overworld editors keep their own (#332).

import type { CellRect } from './dom.ts';

const HOVER_STROKE = 'rgba(255,255,0,0.9)', PICK_STROKE = '#4cc2ff', PICK_FILL = 'rgba(76,194,255,0.15)';
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

type Drag = { kind: 'paint'; x0: number; y0: number; lastX: number; lastY: number } | { kind: 'pick'; x0: number; y0: number; x1: number; y1: number };

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
  private hover: { x: number; y: number } | null = null;
  private drag: Drag | null = null;
  private over: HTMLCanvasElement;
  private o: BrushSurfaceOptions;
  private canvas: HTMLCanvasElement;
  constructor(canvas: HTMLCanvasElement, o: BrushSurfaceOptions) {
    this.canvas = canvas;
    this.o = o;
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

  get painting(): boolean { return this.drag?.kind === 'paint'; }

  private cell(e: MouseEvent): { x: number; y: number } | null {
    const rc = this.canvas.getBoundingClientRect();
    return this.o.cellAt((e.clientX - rc.left) / rc.width * this.canvas.width, (e.clientY - rc.top) / rc.height * this.canvas.height);
  }
  private down(e: MouseEvent): void {
    if (e.button === 1) return; // (panning)
    const c = this.cell(e);
    if (!c) return;
    e.preventDefault();
    if (e.button === 2 || (e.button === 0 && e.shiftKey && !e.ctrlKey)) {
      const no = this.o.whyNot?.(c.x, c.y);
      if (no) { this.o.tell?.(no); return; }
      this.drag = { kind: 'paint', x0: c.x, y0: c.y, lastX: c.x, lastY: c.y };
      if (this.o.stamp(c.x, c.y)) this.o.changed();
      return;
    }
    if (e.button !== 0) return;
    this.drag = { kind: 'pick', x0: c.x, y0: c.y, x1: c.x, y1: c.y };
    this.frames();
  }
  private move(e: MouseEvent): void {
    const c = this.cell(e), d = this.drag;
    this.hover = c;
    if (c && d?.kind === 'paint') {
      const b = this.o.brush(), g = brushGridCell(d.x0, d.y0, b.w, b.h, c.x, c.y);
      if (g.x !== d.lastX || g.y !== d.lastY) { d.lastX = g.x; d.lastY = g.y; if (this.o.stamp(g.x, g.y)) this.o.changed(); }
    } else if (c && d?.kind === 'pick') { d.x1 = c.x; d.y1 = c.y; }
    this.o.moved(c);
    this.frames();
  }
  private up(): void {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    if (d.kind === 'pick') this.o.pick(pickRect(d.x0, d.y0, d.x1, d.y1));
    else this.o.end();
    this.frames();
  }
  // Esc: a stroke or pick in progress cancelled; whether there was one
  key(e: KeyboardEvent): boolean {
    if (e.key !== 'Escape' || !this.drag) return false;
    const d = this.drag;
    this.drag = null;
    if (d.kind === 'paint') this.o.cancel();
    this.frames();
    return true;
  }
  // a stroke in progress dropped without being saved (the picture changed under it)
  drop(): void { this.drag = null; this.frames(); }

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
    const d = this.drag, b = this.o.brush(), n = this.o.cells;
    const r = d?.kind === 'pick' ? pickRect(d.x0, d.y0, d.x1, d.y1) : this.hover ? { x: this.hover.x, y: this.hover.y, w: Math.min(b.w, n.w - this.hover.x), h: Math.min(b.h, n.h - this.hover.y) } : null;
    const box = r && this.o.box(r);
    if (!box) return;
    const sx = W / this.canvas.width, sy = H / this.canvas.height;
    const x = Math.round(box.x * sx) + 0.5, y = Math.round(box.y * sy) + 0.5, w = Math.round(box.w * sx) - 1, h = Math.round(box.h * sy) - 1;
    ctx.lineWidth = 1;
    if (d?.kind === 'pick') { ctx.fillStyle = PICK_FILL; ctx.fillRect(x, y, w, h); ctx.strokeStyle = PICK_STROKE; } else ctx.strokeStyle = HOVER_STROKE;
    ctx.strokeRect(x, y, w, h);
  }
}
