// The pickers' canvases of Map16 tiles (the Map16 pages, the BG sheet, object and prefab thumbnails) follow the
// level's animation: on every step of the level view's animation the tiles that step changes are drawn anew on
// the canvas (TileAnimation, render.ts), then what shows it (a sheet drawn larger with its marks, copies of a
// thumbnail) is updated. Only canvases on the screen are, the others catch up once they are back on it; when
// the animation stops, all go back to the level as rendered. A canvas is dropped once it is no longer shown.
import type { App } from './app.ts';
import type { AnimStep, TileAnimation, TilePixels } from '../core/render.ts';

interface Entry {
  canvas: HTMLCanvasElement;
  cells: number[];
  bg: boolean;
  back: number;
  pixels: TilePixels | null; // its pixels, read from the canvas once it is first drawn anew
  anim: TileAnimation; // the render it is drawn with
  step: AnimStep | null; // what it is drawn with (null: the level as rendered)
  shown?: () => void;
  alive: () => boolean;
  on: () => HTMLElement[]; // the elements showing it
}

const entries = new Map<App, Set<Entry>>();
const swept = new WeakMap<Set<Entry>, number>(); // the entries left by the last sweep

function follow(app: App, e: Entry): void {
  const step = app.animStep(), anim = app.tileAnimation();
  if (step === e.step && anim === e.anim) return;
  if (!e.pixels) {
    const { width: w, height: h } = e.canvas;
    e.pixels = { px: new Uint32Array(e.canvas.getContext('2d')!.getImageData(0, 0, w, h).data.buffer), w, h, cells: e.cells, bg: e.bg, back: e.back };
  }
  // a canvas of an earlier render is drawn whole with this one
  const drew = anim.redraw(e.pixels, e.step, step, e.anim !== anim);
  e.step = step;
  e.anim = anim;
  if (!drew) return;
  const ctx = e.canvas.getContext('2d')!;
  const id = ctx.createImageData(e.pixels.w, e.pixels.h);
  new Uint32Array(id.data.buffer).set(e.pixels.px);
  ctx.putImageData(id, 0, 0);
  e.shown?.();
}

function drop(all: Set<Entry>, e: Entry): void {
  all.delete(e);
  for (const el of e.on()) forget(el);
  copies.delete(e.canvas);
}

function sweep(all: Set<Entry>): void {
  for (const e of all) if (!e.alive()) drop(all, e);
  swept.set(all, all.size);
}

// canvas (one pixel per pixel, drawn with the level as rendered) shows Map16 tiles at cells (x, y of a tile's
// top left pixel and its number, one after the other, see TilePixels); from now on it follows the animation.
// It is shown either by one element `on` (the canvas itself, or one it is drawn into by shown()), alive while
// that is in the page, or by its copies (cloneCanvas), drawn again when it changes, alive while alive() holds.
// back: the pixel where a tile draws none. It is drawn anew from the next step on, once on the screen.
export function animateTiles(app: App, canvas: HTMLCanvasElement, cells: number[], o: { bg?: boolean; back?: number } & ({ on: HTMLElement; shown?: () => void } | { alive: () => boolean })): void {
  if (!cells.length) return;
  let all = entries.get(app);
  if (!all) {
    const set = all = new Set();
    entries.set(app, set);
    app.on('anim-frame', () => {
      // stopped: back to the level as rendered, also where not on the screen (no step comes to catch up)
      const stopped = !app.animStep();
      for (const e of set) {
        if (!e.alive()) drop(set, e);
        else if (stopped || e.on().some(onScreen)) follow(app, e);
      }
    });
  }
  // (canvases of rebuilt pickers are dropped here too while no animation runs)
  if (all.size > 2 * (swept.get(all) ?? 0) + 64) sweep(all);
  const e: Entry = { canvas, cells, bg: o.bg ?? false, back: o.back ?? 0, pixels: null, anim: app.tileAnimation(), step: null, alive: () => false, on: () => [] };
  if ('on' in o) {
    const on = o.on;
    Object.assign(e, { shown: o.shown, alive: () => on.isConnected, on: () => [on] });
  } else {
    copies.set(canvas, []);
    Object.assign(e, { shown: () => redrawCopies(canvas), alive: o.alive, on: () => copies.get(canvas) ?? [] });
  }
  all.add(e);
}

// ---------------- copies ----------------
// the copies made of a canvas shown by its copies: drawn again when it changes. One out of the page is dropped
// when the canvas is drawn again or once there are many (not at once: a copy is shown a moment after it is made).
const copies = new WeakMap<HTMLCanvasElement, HTMLCanvasElement[]>();
const MANY_COPIES = 8;

// a copy of `of` was made (cloneCanvas)
export function noteCopy(of: HTMLCanvasElement, copy: HTMLCanvasElement): void {
  const l = copies.get(of);
  if (!l) return;
  l.push(copy);
  if (l.length > MANY_COPIES) copies.set(of, shownCopies(l));
}

function shownCopies(l: HTMLCanvasElement[]): HTMLCanvasElement[] {
  return l.filter((c) => c.isConnected || (forget(c), false));
}

function redrawCopies(of: HTMLCanvasElement): void {
  const l = copies.get(of);
  if (!l) return;
  const shown = shownCopies(l);
  copies.set(of, shown);
  for (const n of shown) {
    const ctx = n.getContext('2d')!;
    ctx.clearRect(0, 0, n.width, n.height);
    ctx.drawImage(of, 0, 0);
  }
}

// ---------------- on the screen ----------------
// whether an element is on the screen, as reported for it since it was first asked about (until then not)
const onScreenNow = new WeakMap<Element, boolean>();
let observer: IntersectionObserver | null = null;
function onScreen(el: Element): boolean {
  if (!el.isConnected) { forget(el); return false; }
  const v = onScreenNow.get(el);
  if (v !== undefined) return v;
  observer ??= new IntersectionObserver((es) => { for (const x of es) if (onScreenNow.has(x.target)) onScreenNow.set(x.target, x.isIntersecting); });
  observer.observe(el);
  onScreenNow.set(el, false);
  return false;
}
function forget(el: Element): void {
  if (onScreenNow.delete(el)) observer?.unobserve(el);
}
