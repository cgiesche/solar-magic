// The pickers' canvases of tiles follow an animation (AnimSource): the level editor's Map16 pages, BG sheet, object
// and prefab thumbnails the level's (App: TileAnimation, render.ts), the overworld's layer 1 and 2 sheets and pieces the
// map's (owanim.ts OwAnimPlayer: owanimsteps.ts OwTileAnimation). On every step the tiles that step changes are drawn
// anew on the canvas, then what shows it (a sheet drawn larger with its marks, copies of a thumbnail) is updated. Only
// canvases in sight are, the others catch up once they are back in sight; when the animation stops, all go back to
// the still picture. A canvas is dropped once it is no longer shown.
import type { AnimStep, PictureAnimation, TilePixels } from '../core/render.ts';

// what plays an animation: its step shown now (null: none, the still picture), what draws its steps on pixels drawn
// with the still picture now (another one once that is drawn anew), 'anim-frame' when the next step is shown or it
// stops
export interface AnimSource {
  animStep(): AnimStep | null;
  tileAnimation(): PictureAnimation;
  on(ev: 'anim-frame', fn: () => void): void;
}

interface Entry {
  canvas: HTMLCanvasElement;
  cells: number[];
  bg: boolean;
  back: number;
  backAt?: (x: number, y: number) => number;
  pixels: TilePixels | null; // its pixels, read from the canvas once it is first drawn anew
  anim: PictureAnimation; // the still picture it is drawn with
  step: AnimStep | null; // what it is drawn with (null: the still picture)
  shown?: () => void;
  alive: () => boolean;
  on: () => HTMLElement[]; // the elements showing it
}

const entries = new Map<AnimSource, Set<Entry>>();
const swept = new WeakMap<Set<Entry>, number>(); // the entries left by the last sweep

function follow(src: AnimSource, e: Entry): void {
  const step = src.animStep(), anim = src.tileAnimation();
  if (step === e.step && anim === e.anim) return;
  if (!e.pixels) {
    const { width: w, height: h } = e.canvas;
    e.pixels = { px: new Uint32Array(e.canvas.getContext('2d')!.getImageData(0, 0, w, h).data.buffer), w, h, cells: e.cells, bg: e.bg, back: e.back, backAt: e.backAt };
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

// canvas (one pixel per pixel, drawn with the still picture of `src`) shows tiles at cells (x, y of a tile's top left
// pixel and its number, one after the other, see TilePixels; bg: the second layer's); from now on it follows src's
// animation.
// It is shown either by one element `on` (the canvas itself, or one it is drawn into by shown()), alive while
// that is in the page, or by its copies (cloneCanvas), drawn again when it changes, alive while alive() holds.
// back: the pixel where a tile draws none (backAt: where it varies). It is drawn anew from the next step on, once in
// sight.
export function animateTiles(src: AnimSource, canvas: HTMLCanvasElement, cells: number[], o: { bg?: boolean; back?: number; backAt?: (x: number, y: number) => number } & ({ on: HTMLElement; shown?: () => void } | { alive: () => boolean })): void {
  if (!cells.length) return;
  let all = entries.get(src);
  if (!all) {
    const set = all = new Set();
    entries.set(src, set);
    src.on('anim-frame', () => {
      // stopped: back to the still picture, also where out of sight (no step comes to catch up)
      const stopped = !src.animStep();
      for (const e of set) {
        if (!e.alive()) drop(set, e);
        else if (stopped || e.on().some(inSight)) follow(src, e);
      }
    });
  }
  // (canvases of rebuilt pickers are dropped here too while no animation runs)
  if (all.size > 2 * (swept.get(all) ?? 0) + 64) sweep(all);
  const e: Entry = { canvas, cells, bg: o.bg ?? false, back: o.back ?? 0, backAt: o.backAt, pixels: null, anim: src.tileAnimation(), step: null, alive: () => false, on: () => [] };
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

// ---------------- in sight ----------------
// whether an element is in sight (in the part of the page shown), as reported for it since it was first asked
// about (until then not)
const inSightNow = new WeakMap<Element, boolean>();
let observer: IntersectionObserver | null = null;
function inSight(el: Element): boolean {
  if (!el.isConnected) { forget(el); return false; }
  const v = inSightNow.get(el);
  if (v !== undefined) return v;
  observer ??= new IntersectionObserver((es) => { for (const x of es) if (inSightNow.has(x.target)) inSightNow.set(x.target, x.isIntersecting); });
  observer.observe(el);
  inSightNow.set(el, false);
  return false;
}
function forget(el: Element): void {
  if (inSightNow.delete(el)) observer?.unobserve(el);
}
