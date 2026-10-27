// How pickers draw their pictures: at whole numbers of screen pixels per pixel only (no uneven pixels, also on a
// screen scaled by 125 % or 150 %), fixed grids as large as the picker's width allows, single images at most 2×
// in their box; below 3× the hovered entry is shown enlarged beside the picker (showPickerPreview), on the
// level's side so the picker stays free. Sizes are in CSS pixels per pixel, a whole number of screen pixels.
import { h } from './dom.ts';

// pickers below this size get the hover preview
export const PREVIEW_BELOW = 3;

const dpr = () => window.devicePixelRatio || 1;

// screen pixels per pixel at a size
export const screenPixels = (scale: number) => Math.max(1, Math.round(scale * dpr()));

// the largest size of a grid `native` pixels wide in `avail` pixels (at least one screen pixel per pixel)
export function wholeScale(avail: number, native: number): number {
  return Math.max(1, Math.floor((avail * dpr()) / native)) / dpr();
}

// the size of a w×h image in a maxW×maxH box: up to `max`, or 1/2, 1/3 … of a screen pixel when it is larger
export function fitScale(w: number, h: number, maxW: number, maxH: number, max = 2): number {
  const d = dpr();
  for (let k = Math.floor(max * d + 1e-6); k >= 1; k--) if (w * k <= maxW * d && h * k <= maxH * d) return k / d;
  return 1 / Math.ceil(Math.max((w * d) / maxW, (h * d) / maxH)) / d;
}

// the canvas shown at that size (c's pixels per pixel times `scale`), pixels kept sharp
export function sized<T extends HTMLCanvasElement>(c: T, scale: number): T {
  c.style.width = `${Math.max(1, Math.round(c.width * scale))}px`;
  c.style.height = `${Math.max(1, Math.round(c.height * scale))}px`;
  c.style.imageRendering = 'pixelated';
  return c;
}

// the w×h rectangle of `sheet` at (x, y) as a canvas of its own
export function crop(sheet: CanvasImageSource, x: number, y: number, w: number, hh: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w; c.height = hh;
  c.getContext('2d')!.drawImage(sheet, x, y, w, hh, 0, 0, w, hh);
  return c;
}

// ---------------- hover preview ----------------
const BOX = 256; // the largest the enlarged image gets
let pop: { root: HTMLElement; img: HTMLElement; text: HTMLElement } | null = null;
let owner: HTMLElement | null = null;

// 4× (an 8x8 tile 8×, as large as a 16x16 one), smaller where that does not fit the box
function previewScale(w: number, hh: number): number {
  return Math.max(w, hh) <= 8 ? 8 : fitScale(w, hh, BOX, BOX, 4);
}

// shows `image` enlarged with its lines of text left of the side panel `from` is in, at the mouse's height
export function showPickerPreview(from: HTMLElement, e: MouseEvent, image: HTMLCanvasElement | null, lines: string[]): void {
  if (!pop) {
    const img = h('div', { class: 'pick-pop-img' }), text = h('div', { class: 'pick-pop-text' });
    pop = { root: h('div', { class: 'pick-pop' }, img, text), img, text };
  }
  if (!pop.root.isConnected) document.body.append(pop.root);
  owner = from;
  pop.img.replaceChildren(...(image ? [sized(image, previewScale(image.width, image.height))] : []));
  pop.img.hidden = !image;
  pop.text.replaceChildren(...lines.filter(Boolean).map((l, i) => h('div', { class: i ? '' : 'pick-pop-head' }, l)));
  const side = (from.closest('.right') ?? from).getBoundingClientRect();
  const w = pop.root.offsetWidth, hh = pop.root.offsetHeight;
  const x = Math.max(4, side.left - 8 - w);
  const y = Math.max(4, Math.min(innerHeight - 4 - hh, e.clientY - hh / 2));
  pop.root.style.transform = `translate(${x}px, ${y}px)`;
}

// hides it (only when `from` showed it, if given)
export function hidePickerPreview(from?: HTMLElement): void {
  if (from && owner && from !== owner && !owner.contains(from) && !from.contains(owner)) return;
  pop?.root.remove();
  owner = null;
}

// an entry of a picker (a cell, a row) previews its image while hovered when shown below PREVIEW_BELOW;
// its title is then the preview's text instead of a tooltip
export function previewOnHover(el: HTMLElement, shown: number, image: () => HTMLCanvasElement | null, lines: () => string[]): void {
  if (shown >= PREVIEW_BELOW) return;
  el.removeAttribute('title');
  el.addEventListener('mousemove', (e) => showPickerPreview(el, e, image(), lines()));
  el.addEventListener('mouseleave', () => hidePickerPreview(el));
}

// a sheet of cells (cols × rows, each `cell` native pixels) drawn at `shown`: previews the hovered cell, or the
// rectangle dragged from where the left button went down, with what describe() says about it
export function previewSheet(c: HTMLCanvasElement, sheet: () => CanvasImageSource, cols: number, rows: number, cell: number, shown: number,
  describe: (r: { x: number; y: number; w: number; h: number }) => string[]): void {
  if (shown >= PREVIEW_BELOW) return;
  let down: { x: number; y: number } | null = null;
  const cellAt = (e: MouseEvent) => {
    const rc = c.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(cols - 1, Math.floor((e.clientX - rc.left) / (rc.width / cols)))),
      y: Math.max(0, Math.min(rows - 1, Math.floor((e.clientY - rc.top) / (rc.height / rows)))),
    };
  };
  const show = (e: MouseEvent) => {
    const a = cellAt(e), b = down ?? a;
    const r = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x) + 1, h: Math.abs(a.y - b.y) + 1 };
    showPickerPreview(c, e, crop(sheet(), r.x * cell, r.y * cell, r.w * cell, r.h * cell), describe(r));
  };
  c.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || e.ctrlKey || e.metaKey) return;
    down = cellAt(e);
    const up = () => { down = null; window.removeEventListener('mouseup', up); if (!c.matches(':hover')) hidePickerPreview(c); };
    window.addEventListener('mouseup', up);
  });
  c.addEventListener('mousemove', show);
  c.addEventListener('mouseleave', () => { if (!down) hidePickerPreview(c); });
}

// ---------------- side panel width ----------------
const SIDE_W = 'side-width-'; // + workspace (localStorage)
const SIDE_MIN = 330;
// by default as wide as a Map16 page at 2× (rounded up to whole screen pixels) needs with the panel's padding and
// scroll bar, while the level keeps most of the window
const sideDefault = () => Math.max(SIDE_MIN, Math.min(Math.ceil((256 * Math.ceil(2 * dpr() - 1e-6)) / dpr()) + 34, Math.round(innerWidth * 0.35)));
const sideMax = () => Math.max(SIDE_MIN, innerWidth - 190 - 360);

// the handle at the side panel's left edge of `layout` (a grid whose last column is the side panel, its width
// --side-w): dragging it changes the width, kept per workspace; use(ws) switches to that workspace's width
export function sideSplitter(layout: HTMLElement): { root: HTMLElement; use: (ws: string) => void } {
  let ws = '', w = 0;
  const apply = () => layout.style.setProperty('--side-w', `${Math.min(w, sideMax())}px`);
  const use = (next: string) => {
    ws = next;
    w = sideDefault();
    try { const v = Number(localStorage.getItem(SIDE_W + ws)); if (v >= SIDE_MIN) w = v; } catch { /* no storage */ }
    apply();
  };
  const root = h('div', { class: 'side-split', title: 'Drag: width of the side panel' });
  root.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const x0 = e.clientX, w0 = Math.min(w, sideMax());
    document.body.classList.add('col-resizing');
    const move = (ev: MouseEvent) => { w = Math.round(Math.max(SIDE_MIN, Math.min(sideMax(), w0 - (ev.clientX - x0)))); apply(); };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.classList.remove('col-resizing');
      try { localStorage.setItem(SIDE_W + ws, String(w)); } catch { /* no storage */ }
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
  // a double click goes back to the default width
  root.addEventListener('dblclick', () => {
    w = sideDefault();
    apply();
    try { localStorage.removeItem(SIDE_W + ws); } catch { /* no storage */ }
  });
  window.addEventListener('resize', apply);
  return { root, use };
}
