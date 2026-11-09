// Hovering a palette previews the image recolored with it (#418): the Map16 tab's palette dots, the Graphics tab's
// palette rows. A button entered with no mouse button held shows its palette at once; leaving it, pressing a button
// (the click then shows the real result) or the buttons being built again ends the preview. Keys never preview.

import { editMarked, setPalette, type QuarterGrid } from '../core/quarters.ts';

export class PaletteHover {
  private cur: number | null = null;
  private readonly on: (p: number | null) => void;
  // on: the preview changed (the palette hovered, null: none)
  constructor(on: (p: number | null) => void) { this.on = on; }
  get value(): number | null { return this.cur; }
  // a button choosing palette p
  bind(el: HTMLElement, p: number): void {
    el.addEventListener('mouseenter', (e) => { if (!e.buttons) this.set(p); });
    // (a leave arriving after the next button's enter keeps that one's preview)
    el.addEventListener('mouseleave', () => { if (this.cur === p) this.set(null); });
    el.addEventListener('mousedown', () => this.set(null));
  }
  // the buttons are built again (the one under the mouse gone without a leave)
  reset(): void { this.set(null); }
  private set(p: number | null): void {
    if (p === this.cur) return;
    this.cur = p;
    this.on(p);
  }
}

// the Map16 tab's builder and 8x8 graphics while palette `hover` is hovered: the marked quarters in it, the 8x8
// graphics in it, the fills over the image (marked quarters' tint, remap's tiles) hidden. Not hovering or nothing
// marked: the words as given, the palette the graphics follow (focusPal), the fills shown
export interface Map16Preview { words: number[][]; gfxPal: number; fills: boolean; preview: boolean }
export function map16Preview(g: QuarterGrid, words: number[][], marks: Set<number>, focusPal: number, hover: number | null): Map16Preview {
  if (hover === null || !marks.size) return { words, gfxPal: focusPal, fills: true, preview: false };
  return { words: editMarked(g, words, marks, setPalette(hover)).words, gfxPal: hover, fills: false, preview: true };
}

// the Graphics tab's palette row shown: the hovered one, else the chosen one
export const previewRow = (hover: number | null, row: number): number => hover ?? row;
