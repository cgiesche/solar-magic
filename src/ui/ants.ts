// Running selection outlines ("marching ants") in picker sheets of densely packed graphics (Map16 pages, BG, layer 3,
// the overworld's tile sheets, the graphics column …), where a plain outline is easily missed among the tiles: the
// marking's path stroked in ANTS_DARK, its own colour dashed over it (dashes of 4 screen pixels whatever the zoom;
// the line width the context's). One central ticker at 10 fps keeps them all in phase (not the level animation
// tick). A canvas whose sheet registered its repaint (onAntsTick) is repainted on a tick only while its last paint
// stroked ants and it is visible; nothing ticks otherwise. A sheet costly to draw again keeps its picture and only
// draws the marks over it (AntsMarks). The switch "Animate selection outlines" (animateAnts; off by default under
// prefers-reduced-motion): off, the two-colour dashes stand still.

import { boolPref } from './prefs.ts';
import type { MenuItem } from './menu.ts';

export const ANTS_DARK = 'rgba(0,0,0,0.85)';
export const ANTS_PERIOD_MS = 100; // 10 fps
const DASH = 4; // screen pixels
const CYCLE = 2 * DASH; // a dash and its gap

const reducedMotion = (): boolean => {
  try { return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false; } catch { return false; }
};
export const animateAnts = boolPref('animate-selection-outlines', () => !reducedMotion());

// View → "Animate selection outlines", the same switch in the level editor's and the overworld's View menu
// (governing every picker sheet, in the graphics workspace too)
export function antsMenuItem(): Extract<MenuItem, { checked: () => boolean }> {
  return {
    label: 'Animate selection outlines', checked: () => animateAnts.get(), onToggle: (v) => animateAnts.set(v),
    title: 'The selection in the picker sheets (Map16, BG, layer 3, the overworld\'s tiles, the graphics) outlined in running two-coloured dashes; off: the dashes stand still (off by default when the system asks for reduced motion). Kept in the browser',
  };
}

// the phase (in screen pixels along the path) at a time (performance.now())
export function antsPhase(now: number): number {
  return Math.floor(now / ANTS_PERIOD_MS) % CYCLE;
}

// the dash pattern and offset in user units, at `unit` user units a screen pixel
export function antsDash(unit: number, phase: number): { dash: number[]; offset: number } {
  return { dash: [DASH * unit, DASH * unit], offset: -phase * unit };
}

// user units a screen (CSS) pixel of the context, by its transform and its canvas's size on the page
function unitOf(ctx: CanvasRenderingContext2D): number {
  const t = ctx.getTransform(), scale = Math.hypot(t.a, t.b) || 1;
  const c = ctx.canvas as HTMLCanvasElement | OffscreenCanvas;
  const css = 'clientWidth' in c && c.clientWidth > 0 && c.width > 0 ? c.clientWidth / c.width : 1 / (globalThis.devicePixelRatio || 1);
  return 1 / (scale * css);
}

// the current path stroked as running ants in `color` (phase: tests); the line dash put back
export function strokeAnts(ctx: CanvasRenderingContext2D, color: string, phase?: number): void {
  const keepDash = ctx.getLineDash(), keepOffset = ctx.lineDashOffset;
  const on = animateAnts.get();
  const { dash, offset } = antsDash(unitOf(ctx), on ? phase ?? antsPhase(performance.now()) : 0);
  ctx.setLineDash([]);
  ctx.strokeStyle = ANTS_DARK;
  ctx.stroke();
  ctx.setLineDash(dash);
  ctx.lineDashOffset = offset;
  ctx.strokeStyle = color;
  ctx.stroke();
  ctx.setLineDash(keepDash);
  ctx.lineDashOffset = keepOffset;
  if (on) wantTick(ctx.canvas);
}

export function antsRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string): void {
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  strokeAnts(ctx, color);
}

// ---------------- the ticker ----------------
type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;
// (weakly: a sheet's canvas built anew lets the old one go)
const repaints = new WeakMap<AnyCanvas, () => void>();
const registered = new Set<WeakRef<AnyCanvas>>(); // (to repaint them all when the switch changes)
const wanted = new Set<AnyCanvas>(); // stroked ants since the last tick
let timer: ReturnType<typeof setTimeout> | null = null;

const doc = (): Document | undefined => (globalThis as { document?: Document }).document;
function visible(c: AnyCanvas): boolean {
  const e = c as HTMLCanvasElement & { checkVisibility?: () => boolean };
  return e.isConnected !== false && (e.checkVisibility?.() ?? true);
}

// the sheet of `canvas` repainted on the ticks while its paint strokes ants; returns: taking it off
export function onAntsTick(canvas: AnyCanvas, repaint: () => void): () => void {
  if (!repaints.has(canvas)) registered.add(new WeakRef(canvas));
  repaints.set(canvas, repaint);
  return () => { if (repaints.get(canvas) === repaint) { repaints.delete(canvas); wanted.delete(canvas); } };
}

function wantTick(c: AnyCanvas): void {
  if (!repaints.has(c)) return;
  wanted.add(c);
  schedule();
}
function schedule(): void {
  if (timer !== null || !wanted.size || doc()?.hidden) return;
  timer = setTimeout(tick, ANTS_PERIOD_MS - (performance.now() % ANTS_PERIOD_MS) + 1);
}
function tick(): void {
  timer = null;
  if (doc()?.hidden) return; // kept wanted: the ticks go on when the page is shown again
  const now = [...wanted];
  wanted.clear();
  for (const c of now) {
    const repaint = repaints.get(c);
    if (repaint && visible(c)) repaint();
  }
}
doc()?.addEventListener('visibilitychange', schedule);

animateAnts.onChange(() => {
  if (timer !== null) { clearTimeout(timer); timer = null; }
  wanted.clear();
  // standing still, or running again
  for (const ref of [...registered]) {
    const c = ref.deref(), repaint = c && repaints.get(c);
    if (!c || !repaint) { registered.delete(ref); continue; }
    if (visible(c)) repaint();
  }
});

// A sheet whose picture is costly to draw again (a Map16 page, the graphics column): its paint ends in over(),
// which keeps the canvas as drawn so far and draws the marks on it – on the ticks only the marks again, over the
// kept picture. Every paint of the canvas ends in over() (marks drawing nothing when there are none), so a tick never
// brings back a picture painted over since.
export class AntsMarks {
  private readonly canvas: HTMLCanvasElement;
  private back: HTMLCanvasElement | null = null;
  private marks: ((ctx: CanvasRenderingContext2D) => void) | null = null;
  private transform: DOMMatrix | null = null;
  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    onAntsTick(canvas, () => this.redraw());
  }
  over(marks: (ctx: CanvasRenderingContext2D) => void): void {
    const c = this.canvas, ctx = c.getContext('2d')!;
    wanted.delete(c);
    this.back ??= document.createElement('canvas');
    if (this.back.width !== c.width || this.back.height !== c.height) { this.back.width = c.width; this.back.height = c.height; }
    const b = this.back.getContext('2d')!;
    b.clearRect(0, 0, c.width, c.height);
    b.drawImage(c, 0, 0);
    this.marks = marks;
    this.transform = ctx.getTransform();
    marks(ctx);
  }
  private redraw(): void {
    const c = this.canvas, back = this.back;
    if (!back || !this.marks || back.width !== c.width || back.height !== c.height) return;
    const ctx = c.getContext('2d')!;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.drawImage(back, 0, 0);
    ctx.restore();
    ctx.save();
    if (this.transform) ctx.setTransform(this.transform);
    this.marks(ctx);
    ctx.restore();
  }
}
