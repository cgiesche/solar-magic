// Hovering a palette previews the image recolored with it (#418): the Map16 tab's palette dots, the Graphics tab's
// palette rows. A button entered with no mouse button held shows its palette at once; leaving it or pressing a button
// (the click then shows the real result) ends the preview. Keys never preview. The buttons built again (a key, an undo,
// results arriving) keep the preview while the mouse stays on its palette: the next mouse move decides.

import { editMarked, setPalette, type QuarterGrid } from '../core/quarters.ts';

type Listen = { addEventListener(t: 'mousemove', f: (e: MouseEvent) => void, o: AddEventListenerOptions): void };

export class PaletteHover {
  private cur: number | null = null;
  private els = new Map<HTMLElement, number>(); // the buttons bound since the last reset
  private stale = false; // built again while previewing: the next mouse move checks the button under it
  private readonly on: (p: number | null) => void;
  private readonly doc: Listen | null;
  // on: the preview changed (the palette hovered, null: none); doc: where mouse moves are watched (the document)
  constructor(on: (p: number | null) => void, doc: Listen | null = typeof document === 'undefined' ? null : document) {
    this.on = on;
    this.doc = doc;
  }
  get value(): number | null { return this.cur; }
  // a button choosing palette p
  bind(el: HTMLElement, p: number): void {
    this.els.set(el, p);
    el.addEventListener('mouseenter', (e) => { if (!e.buttons) this.set(p); });
    // (a leave arriving after the next button's enter keeps that one's preview)
    el.addEventListener('mouseleave', () => { if (this.cur === p) this.set(null); });
    el.addEventListener('mousedown', () => this.set(null));
  }
  // the buttons are about to be built again: the preview stays until the next mouse move finds the mouse elsewhere
  // (the button under it is new, so no leave would end it)
  reset(): void {
    this.els.clear();
    if (this.cur === null || this.stale) return;
    if (!this.doc) { this.set(null); return; }
    this.stale = true;
    this.doc.addEventListener('mousemove', (e) => {
      if (!this.stale) return;
      this.stale = false;
      const t = e.target as Node | null;
      const over = [...this.els].find(([el]) => t && el.contains(t));
      this.set(over && !e.buttons ? over[1] : null);
    }, { once: true, capture: true });
  }
  private set(p: number | null): void {
    this.stale = false;
    if (p === this.cur) return;
    this.cur = p;
    this.on(p);
  }
}

// the Map16 tab's builder and 8x8 graphics while palette `hover` is hovered (preview): the marked quarters in it, the
// 8x8 graphics in it, the fills over the image (marked quarters' tint, remap's tiles) hidden. Not hovering or nothing
// marked: the words as given, the palette the graphics follow (focusPal)
export interface Map16Preview { words: number[][]; gfxPal: number; preview: boolean }
export function map16Preview(g: QuarterGrid, words: number[][], marks: Set<number>, focusPal: number, hover: number | null): Map16Preview {
  if (hover === null || !marks.size) return { words, gfxPal: focusPal, preview: false };
  return { words: editMarked(g, words, marks, setPalette(hover)).words, gfxPal: hover, preview: true };
}
