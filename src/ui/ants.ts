// Running selection outlines ("marching ants") in picker sheets of densely packed graphics (Map16 pages, BG, layer 3,
// the overworld's tile sheets, the graphics column …), where a plain outline is easily missed among the tiles. They
// are drawn on an overlay over the sheet (AntsOverlay), in device pixels: one look on every sheet whatever its scaling
// – a line of whole device pixels (antsLook) in ANTS_DARK, the mark's colour dashed over it, the rectangles' edges on
// whole device pixels. One central ticker at 10 fps keeps them all in phase (not the level animation tick); a tick
// redraws only an overlay, never its sheet, and only while it shows a running outline and is on the screen. The switch
// "Animate selection outlines" (animateAnts; off by default under prefers-reduced-motion): off, the dashes stand still.

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

// the line width and dash in device pixels at a devicePixelRatio: whole pixels, the same on every sheet – a screen
// pixel wide but at least 2 (the two tones need it), dashes of 4 screen pixels
export function antsLook(dpr: number): { lw: number; dash: number } {
  return { lw: Math.max(2, Math.round(dpr)), dash: Math.max(2, Math.round(DASH * dpr)) };
}

// a marking: the rectangle x, y, w, h in the sheet's units (cells or pixels, AntsOverlay's space), outlined inside it
// (out: around it, inside where it reaches the overlay's edge)
export interface AntsMark { x: number; y: number; w: number; h: number; color: string; out?: boolean }

// where a mark's line runs on an overlay of W×H device pixels over a sheet of sw×sh units, line lw wide: the path's
// rectangle, the mark's edges on whole device pixels and the line covering whole pixels inside (or outside) them
export function antsBox(m: AntsMark, W: number, H: number, sw: number, sh: number, lw: number): [number, number, number, number] {
  let x0 = Math.round((m.x * W) / sw), x1 = Math.round(((m.x + m.w) * W) / sw);
  let y0 = Math.round((m.y * H) / sh), y1 = Math.round(((m.y + m.h) * H) / sh);
  if (m.out) { x0 = Math.max(0, x0 - lw); y0 = Math.max(0, y0 - lw); x1 = Math.min(W, x1 + lw); y1 = Math.min(H, y1 + lw); }
  const d = lw / 2;
  return [x0 + d, y0 + d, Math.max(0, x1 - x0 - lw), Math.max(0, y1 - y0 - lw)];
}

// the marks drawn on an overlay's context (no transform, W×H device pixels) over a sheet of sw×sh units: per colour
// one path stroked in ANTS_DARK, the colour's dashes over it (phase: in screen pixels, standing still: 0)
export function drawAnts(ctx: CanvasRenderingContext2D, marks: readonly AntsMark[], W: number, H: number, sw: number, sh: number, dpr: number, phase: number): void {
  ctx.clearRect(0, 0, W, H);
  if (!marks.length || W <= 0 || H <= 0 || sw <= 0 || sh <= 0) return;
  const { lw, dash } = antsLook(dpr);
  ctx.lineWidth = lw;
  for (const color of new Set(marks.map((m) => m.color))) {
    ctx.beginPath();
    for (const m of marks) if (m.color === color) ctx.rect(...antsBox(m, W, H, sw, sh, lw));
    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;
    ctx.strokeStyle = ANTS_DARK;
    ctx.stroke();
    ctx.setLineDash([dash, dash]);
    ctx.lineDashOffset = -Math.round((phase * dash) / DASH);
    ctx.strokeStyle = color;
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.lineDashOffset = 0;
}

// ---------------- the ticker ----------------
type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;
// (weakly: a sheet's canvas built anew lets the old one go)
const repaints = new WeakMap<AnyCanvas, () => void>();
const registered = new Set<WeakRef<AnyCanvas>>(); // (to repaint them all when the switch changes)
const wanted = new Set<AnyCanvas>(); // stroked ants since the last tick
let timer: ReturnType<typeof setTimeout> | null = null;

const doc = (): Document | undefined => (globalThis as { document?: Document }).document;
// whether a canvas is on the screen – scrolled into its panel, the panel shown – as the page's IntersectionObserver
// says (before it has: shown by its style)
const onScreen = new WeakMap<AnyCanvas, boolean>();
const parked = new WeakSet<AnyCanvas>(); // off the screen when it was to be repainted: repainted when back on it
let observer: IntersectionObserver | null | undefined;
const offscreen = (c: AnyCanvas): c is OffscreenCanvas => typeof OffscreenCanvas !== 'undefined' && c instanceof OffscreenCanvas;
function observe(c: AnyCanvas): void {
  if (observer === undefined) {
    const IO = (globalThis as { IntersectionObserver?: typeof IntersectionObserver }).IntersectionObserver;
    observer = IO ? new IO((entries) => {
      for (const e of entries) {
        const t = e.target as HTMLCanvasElement;
        onScreen.set(t, e.isIntersecting);
        if (!e.isIntersecting || !parked.has(t)) continue;
        parked.delete(t);
        repaints.get(t)?.();
      }
    }) : null;
  }
  if (observer && !offscreen(c)) observer.observe(c);
}
function visible(c: AnyCanvas): boolean {
  const e = c as HTMLCanvasElement & { checkVisibility?: () => boolean };
  if (e.isConnected === false) return false;
  return onScreen.get(c) ?? e.checkVisibility?.() ?? true;
}
// repainted now when on the screen, else once back on it
function repaintOrPark(c: AnyCanvas, repaint: () => void): void {
  if (visible(c)) repaint(); else parked.add(c);
}

// the sheet of `canvas` repainted on the ticks while its paint strokes ants and it is on the screen; returns:
// taking it off
export function onAntsTick(canvas: AnyCanvas, repaint: () => void): () => void {
  if (!repaints.has(canvas)) { registered.add(new WeakRef(canvas)); observe(canvas); }
  repaints.set(canvas, repaint);
  return () => {
    if (repaints.get(canvas) !== repaint) return;
    repaints.delete(canvas);
    wanted.delete(canvas);
    parked.delete(canvas);
    if (observer && !offscreen(canvas)) observer.unobserve(canvas);
  };
}

// a canvas registered with onAntsTick showed running ants: repainted on the next tick
export function antsDrawn(c: AnyCanvas): void {
  if (!repaints.has(c) || !animateAnts.get()) return;
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
    if (repaint) repaintOrPark(c, repaint);
  }
}
doc()?.addEventListener('visibilitychange', schedule);

// the switch changed (or, with nothing kept, the system's reduced motion): every sheet standing still or running again
function switched(): void {
  if (timer !== null) { clearTimeout(timer); timer = null; }
  wanted.clear();
  for (const ref of [...registered]) {
    const c = ref.deref(), repaint = c && repaints.get(c);
    if (!c || !repaint) { registered.delete(ref); continue; }
    repaintOrPark(c, repaint);
  }
}
animateAnts.onChange(switched);
try { globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').addEventListener('change', switched); } catch { /* none */ }

// ---------------- the overlay ----------------
// A transparent canvas over a sheet canvas, the size of the sheet's box on the page in device pixels (following it by
// a ResizeObserver), letting the mouse through: the sheet gives its marks as rectangles in its own units (`space`:
// the sheet's size in them, by default its canvas pixels), the overlay maps them to device pixels. root (the sheet and
// the overlay stacked) goes onto the page in place of the sheet.
const overlays = new WeakMap<Element, AntsOverlay>();
let resizer: ResizeObserver | null | undefined;
function watchSize(sheet: HTMLCanvasElement, o: AntsOverlay): void {
  overlays.set(sheet, o);
  if (resizer === undefined) {
    const RO = (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    resizer = RO ? new RO((entries) => {
      for (const e of entries) {
        const d = e.devicePixelContentBoxSize?.[0];
        overlays.get(e.target)?.layout(d ? { W: d.inlineSize, H: d.blockSize } : undefined);
      }
    }) : null;
  }
  if (!resizer) return;
  try { resizer.observe(sheet, { box: 'device-pixel-content-box' }); } catch { resizer.observe(sheet); }
}

export class AntsOverlay {
  readonly root: HTMLDivElement;
  readonly sheet: HTMLCanvasElement;
  private readonly over: HTMLCanvasElement;
  private readonly space: () => { w: number; h: number };
  private marks: readonly AntsMark[] = [];
  private dpr = 0; // (laid out at; 0: not yet)
  constructor(sheet: HTMLCanvasElement, space?: () => { w: number; h: number }) {
    this.sheet = sheet;
    this.space = space ?? (() => ({ w: sheet.width, h: sheet.height }));
    this.over = document.createElement('canvas');
    this.over.className = 'ants-over';
    this.over.width = this.over.height = 0;
    this.root = document.createElement('div');
    this.root.className = 'ants-host';
    this.root.append(sheet, this.over);
    onAntsTick(this.over, () => this.draw());
    watchSize(sheet, this);
  }
  // the marks shown (none: [])
  set(marks: readonly AntsMark[]): void {
    this.marks = marks;
    this.draw();
  }
  // the overlay sized and placed on the sheet's box (dev: its size in device pixels, as the ResizeObserver tells it)
  layout(dev?: { W: number; H: number }): void {
    const dpr = globalThis.devicePixelRatio || 1;
    this.dpr = dpr;
    const rc = this.sheet.getBoundingClientRect(), host = this.root.getBoundingClientRect();
    const W = dev?.W ?? Math.round(rc.width * dpr), H = dev?.H ?? Math.round(rc.height * dpr);
    if (this.over.width !== W || this.over.height !== H) { this.over.width = W; this.over.height = H; }
    const st = this.over.style;
    st.width = `${rc.width}px`;
    st.height = `${rc.height}px`;
    st.transform = `translate(${rc.left - host.left}px, ${rc.top - host.top}px)`;
    this.draw();
  }
  private draw(): void {
    if (this.dpr !== (globalThis.devicePixelRatio || 1)) { if (this.sheet.isConnected) this.layout(); return; } // (layout draws)
    const { width: W, height: H } = this.over;
    if (!W || !H) return;
    const on = animateAnts.get(), sp = this.space();
    drawAnts(this.over.getContext('2d')!, this.marks, W, H, sp.w, sp.h, this.dpr, on ? antsPhase(performance.now()) : 0);
    if (on && this.marks.length) antsDrawn(this.over);
  }
}
