// The pixel editor's model (CONTEXT.md: pixel editor, pixel selection, float): a graphics file's pixels as a sheet
// 16 tiles wide, the tiles of it the pixel editor shows (its area), the pixel selection, the float and the clipboard,
// and what the tools do to them. Without a DOM and without a ROM: an operation changes the pixels in memory and
// answers what changed – the rectangle to draw again and, when it is an edit to store, the edit's name (Change.label).
// Storing it, asking whether the file may be drawn on and reading the file again are the caller's.
//
// The rules that are here and nowhere else: pen, eraser and fill reach only the pixel selection, else the area; the
// float lies over the file for everything that reads (the picture, the pipette, a copy);
// a float and a new pixel selection stay inside the area; lifting leaves transparent pixels behind, dropping a float
// puts them back; Del on a pasted float drops it; only a square is rotated.

import type { GfxFile } from './gfxfiles.ts';

export interface Rect { x: number; y: number; w: number; h: number }
// what an operation changed: the pixels of `rect` (sheet pixels) to draw again; with a label: an edit to store under it
export interface Change { rect: Rect; label?: string }
export interface Pixels { w: number; h: number; pix: Uint8Array }
// pixels held over the file; pasted: not from the file (nothing is left behind where it lies)
export interface Float extends Rect { pix: Uint8Array; pasted: boolean }

export const SHEET_W = 128; // pixels: 16 tiles
const inside = (r: Rect, x: number, y: number) => x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;
const union = (a: Rect, b: Rect): Rect => {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};

export class PixelSheet {
  file: GfxFile | null = null;
  area: Rect = { x: 0, y: 0, w: 1, h: 1 }; // the tiles the pixel editor shows (kept inside the file by open)
  sel: Rect | null = null; // the pixel selection
  private fl: (Float & { label: string; under: Pixels | null; from: Rect }) | null = null;
  private clip: Pixels | null = null;
  private last: { x: number; y: number } | null = null; // where the pen was last, for a line to the next point

  get width(): number { return SHEET_W; }
  get height(): number { return Math.ceil((this.file?.tiles ?? 128) / 16) * 8; }
  get float(): Float | null { return this.fl; }
  get copied(): boolean { return !!this.clip; }

  // The file to edit (also the same file read again: the selection and a float stay). Another file than before: the
  // pen's last point is forgotten.
  open(file: GfxFile): void {
    if (file.num !== this.file?.num) this.last = null;
    this.file = file;
    // (a lifted float's pixels are in the file as read again: nothing to put back when it is dropped)
    if (this.fl) this.fl.under = null;
    this.clampArea();
  }

  private clampArea(): void {
    const rows = this.height >> 3, a = this.area;
    const w = Math.max(1, Math.min(16, a.w)), h = Math.max(1, Math.min(rows, a.h));
    this.area = { x: Math.max(0, Math.min(16 - w, a.x)), y: Math.max(0, Math.min(rows - h, a.y)), w, h };
  }
  // the area in pixels
  areaRect(): Rect {
    const a = this.area;
    return { x: a.x * 8, y: a.y * 8, w: a.w * 8, h: a.h * 8 };
  }
  // what pen, eraser and fill reach
  limit(): Rect { return this.sel ?? this.areaRect(); }
  // what copy, clear and a transform work on
  target(): Rect { return this.fl ?? this.sel ?? this.areaRect(); }

  private idx(x: number, y: number): number { return ((y >> 3) * 16 + (x >> 3)) * 64 + (y & 7) * 8 + (x & 7); }
  // the color shown at a pixel: the float's where it lies and isn't transparent, else the file's
  get(x: number, y: number): number {
    const f = this.file, fl = this.fl;
    if (!f || x < 0 || y < 0 || x >= SHEET_W) return 0;
    if (fl && inside(fl, x, y)) return fl.pix[(y - fl.y) * fl.w + x - fl.x];
    const i = this.idx(x, y);
    return i < f.pix.length ? f.pix[i] : 0;
  }
  private set(x: number, y: number, v: number): void {
    const f = this.file!;
    if (x < 0 || y < 0 || x >= SHEET_W || y >= this.height) return;
    const i = this.idx(x, y);
    if (i < f.pix.length) f.pix[i] = v;
  }
  // the pixels shown in a rectangle
  private read(r: Rect): Uint8Array {
    const pix = new Uint8Array(r.w * r.h);
    for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) pix[y * r.w + x] = this.get(r.x + x, r.y + y);
    return pix;
  }
  // pixels into the file at (x, y); without pixels: the rectangle transparent
  private write(x0: number, y0: number, p: Pixels | Rect): void {
    const pix = 'pix' in p ? p.pix : null;
    for (let y = 0; y < p.h; y++) for (let x = 0; x < p.w; x++) this.set(x0 + x, y0 + y, pix ? pix[y * p.w + x] : 0);
  }

  // ---------- pen, eraser, fill ----------
  private paint(x: number, y: number, v: number): void {
    if (inside(this.limit(), x, y)) this.set(x, y, v);
  }
  // one pixel painted; the stroke's edit is stored by the caller when it ends
  dot(x: number, y: number, v: number): Change {
    this.paint(x, y, v);
    this.last = { x, y };
    return { rect: { x, y, w: 1, h: 1 } };
  }
  // a line from the pen's last point (none: one pixel)
  lineTo(x: number, y: number, v: number): Change {
    const a = this.last;
    if (!a) return this.dot(x, y, v);
    const dx = Math.abs(x - a.x), dy = Math.abs(y - a.y), n = Math.max(dx, dy, 1);
    for (let i = 0; i <= n; i++) this.paint(Math.round(a.x + ((x - a.x) * i) / n), Math.round(a.y + ((y - a.y) * i) / n), v);
    this.last = { x, y };
    return { rect: { x: Math.min(a.x, x), y: Math.min(a.y, y), w: dx + 1, h: dy + 1 } };
  }
  // the pixels of one color connected to (x, y), inside what the tools reach
  fill(x: number, y: number, v: number): Change {
    const r = this.limit(), from = this.get(x, y);
    if (from !== v) {
      const st = [[x, y]];
      while (st.length) {
        const [cx, cy] = st.pop()!;
        if (!inside(r, cx, cy) || this.get(cx, cy) !== from) continue;
        this.set(cx, cy, v);
        // (a pixel outside the file can't be set: not to be looked at again)
        if (this.get(cx, cy) === from) continue;
        st.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
      }
    }
    return { rect: r, label: 'Fill' };
  }

  // ---------- the sheet's brush ----------
  // the area's pixels, to stamp
  brush(): Pixels {
    const r = this.areaRect();
    return { w: r.w, h: r.h, pix: this.read(r) };
  }
  // a brush with its top left at tile (tx, ty), cut at the sheet's right edge and the file's end
  stamp(b: Pixels, tx: number, ty: number): Change {
    this.write(tx * 8, ty * 8, b);
    return { rect: { x: tx * 8, y: ty * 8, w: b.w, h: b.h } };
  }
  // the file's pixels as they are, and put back (a stroke cancelled)
  snapshot(): Uint8Array { return this.file!.pix.slice(); }
  restore(pix: Uint8Array): void { this.file!.pix.set(pix); }

  // ---------- pixel selection and float ----------
  private clampTo(x: number, y: number, w: number, h: number): { x: number; y: number } {
    const r = this.areaRect();
    return { x: Math.max(r.x, Math.min(r.x + r.w - w, x)), y: Math.max(r.y, Math.min(r.y + r.h - h, y)) };
  }
  // whether a pixel is on the float, else on the pixel selection: a drag from there moves it
  grabs(x: number, y: number): boolean {
    const r = this.fl ?? this.sel;
    return !!r && inside(r, x, y);
  }
  // a new pixel selection from one pixel to another, both kept inside the area
  select(ax: number, ay: number, bx: number, by: number): void {
    const a = this.clampTo(ax, ay, 1, 1), b = this.clampTo(bx, by, 1, 1);
    this.sel = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x) + 1, h: Math.abs(a.y - b.y) + 1 };
  }
  // The pixel selection's pixels lifted into a float: where they were is transparent. `label`: the edit's name when
  // the float is put down. null: nothing selected, or a float is there already.
  lift(label: string): Change | null {
    const s = this.sel;
    if (!s || this.fl) return null;
    const pix = this.read(s);
    this.write(s.x, s.y, s);
    this.fl = { ...s, pix, pasted: false, label, under: { w: s.w, h: s.h, pix: pix.slice() }, from: { ...s } };
    return { rect: { ...s } };
  }
  // the float with its top left at (x, y), kept inside the area
  moveFloat(x: number, y: number): Change | null {
    const fl = this.fl;
    if (!fl) return null;
    const was = { x: fl.x, y: fl.y, w: fl.w, h: fl.h }, at = this.clampTo(x, y, fl.w, fl.h);
    fl.x = at.x; fl.y = at.y;
    return { rect: union(was, fl) };
  }
  // The float put down: its pixels into the file, it becomes the pixel selection. The edit
  // to store. null: no float.
  drop(): Change | null {
    const fl = this.fl;
    if (!fl) return null;
    this.fl = null;
    this.write(fl.x, fl.y, fl);
    this.sel = { x: fl.x, y: fl.y, w: fl.w, h: fl.h };
    return { rect: union(fl.from, this.sel), label: fl.label };
  }
  // The float dropped, with the pixel selection: what it was lifted from is back, nothing to store. null: no float.
  cancel(): Change | null {
    const fl = this.fl;
    if (!fl) return null;
    this.fl = null;
    this.sel = null;
    if (fl.under) this.write(fl.from.x, fl.from.y, fl.under);
    return { rect: union(fl.from, fl) };
  }

  // the float, the pixel selection or else the area into the clipboard; its size
  copy(): { w: number; h: number } {
    const r = this.target();
    this.clip = { w: r.w, h: r.h, pix: this.read(r) };
    return { w: r.w, h: r.h };
  }
  // whether clear only drops what was pasted (nothing of the file changes)
  get clearDrops(): boolean { return !!this.fl?.pasted; }
  // Del: the pixel selection (else the area) transparent; a pasted float is dropped (nothing to store), a lifted one
  // is gone and leaves where it came from transparent
  clear(): Change {
    const fl = this.fl;
    if (fl?.pasted) return this.cancel()!;
    if (fl) {
      this.fl = null;
      this.sel = null;
      return { rect: union(fl.from, fl), label: 'Erase' };
    }
    const r = this.limit();
    this.write(r.x, r.y, r);
    return { rect: r, label: 'Erase' };
  }
  // The clipboard as a float at the pixel selection, else the area's top left; the area grows to hold it (the pixel
  // selection then ends). A float there before is to be put down first (drop). null: nothing copied.
  paste(): Change | null {
    const c = this.clip;
    if (!c || this.fl) return null;
    const a = this.area;
    if (c.w > a.w * 8 || c.h > a.h * 8) {
      this.area = { ...a, w: Math.max(a.w, Math.ceil(c.w / 8)), h: Math.max(a.h, Math.ceil(c.h / 8)) };
      this.clampArea();
      this.sel = null;
    }
    const at = this.sel ?? this.areaRect(), p = this.clampTo(at.x, at.y, c.w, c.h);
    this.fl = { ...p, w: c.w, h: c.h, pix: c.pix.slice(), pasted: true, label: 'Pasted', under: null, from: { ...p, w: c.w, h: c.h } };
    return { rect: { ...p, w: c.w, h: c.h } };
  }

  // whether what a transform works on can be rotated: a square
  get rotates(): boolean { const r = this.target(); return r.w === r.h; }
  // The float, the pixel selection or else the area flipped ('h', 'v') or rotated by 90° ('r'), and put down: the edit
  // to store. Without a float or a pixel selection before there is none after. null: 'r' of what is not a square.
  transform(kind: 'h' | 'v' | 'r'): Change | null {
    if (kind === 'r' && !this.rotates) return null;
    const had = !!(this.sel || this.fl);
    if (!this.fl) { this.sel = this.target(); this.lift(''); }
    const fl = this.fl!;
    fl.label = kind === 'r' ? 'Rotated' : 'Flipped';
    const out = new Uint8Array(fl.pix.length);
    for (let y = 0; y < fl.h; y++) for (let x = 0; x < fl.w; x++) {
      const v = fl.pix[y * fl.w + x];
      if (kind === 'h') out[y * fl.w + (fl.w - 1 - x)] = v;
      else if (kind === 'v') out[(fl.h - 1 - y) * fl.w + x] = v;
      else out[x * fl.w + (fl.w - 1 - y)] = v;
    }
    fl.pix = out;
    const c = this.drop()!;
    if (!had) this.sel = null;
    return c;
  }
}
