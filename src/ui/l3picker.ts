// The picker of layer 3's 8x8 tiles (2bpp, as in VRAM) as a brush, with palette, priority and flips (tilemap
// word bits 10-12, 13, 14-15); a brush taken from the picture keeps each tile's own. Shared by the level's layer 3
// (panels.ts) and the title screen (gameview.ts).

import type { Brush } from './app.ts';
import { h, attachRectPick } from './dom.ts';
import { fitScale, sized, previewSheet } from './pickerview.ts';
import { TileCache } from '../core/render.ts';
import { blankTile, l3Palette, withL3Palette, L3_TILE, L3_PAL, L3_PRIO, L3_FLIP_X, L3_FLIP_Y } from '../core/layer3map.ts';
import { hex3 } from '../core/names.ts';
import { antsRect, onAntsTick } from './ants.ts';

// layer 3's graphics and colors as shown
export interface L3Graphics { vram: Uint8Array; cgram: Uint8Array; charBase: number }

export interface L3PickerOptions {
  pixels: number; // screen pixels per pixel the sheet is drawn at
  shown: number; // its shown size per pixel
  from: string; // where a brush not on the sheet was taken from ("the level")
  hint: string; // after the brush's description
}

// appends the picker to `body`
export function layer3Picker(body: HTMLElement, g: L3Graphics, b: Brush, setBrush: (b: Brush) => void, o: L3PickerOptions): void {
  const w0 = b.tiles[0], attr = w0 & ~L3_TILE, pal = l3Palette(w0);
  const tc = new TileCache(g.vram, g.cgram, g.charBase);
  const each = (f: (w: number) => number) => setBrush({ ...b, tiles: b.tiles.map(f) });
  const draw = (px: Uint32Array, width: number, word: number, x: number, y: number) => {
    const t = tc.get(word, 2);
    for (let k = 0; k < 64; k++) px[(y + (k >> 3)) * width + x + (k & 7)] = t[k] || 0xff282828;
  };
  // a brush that is a rectangle of the sheet (one palette, priority, no flips) is outlined there
  const onSheet = !(attr & (L3_FLIP_X | L3_FLIP_Y)) && (w0 & L3_TILE) < 0x200 && (w0 & 15) + b.w <= 16
    && b.tiles.every((t, i) => t === w0 + Math.floor(i / b.w) * 16 + (i % b.w));
  const S = o.pixels, scale = o.shown;
  const c = h('canvas', { width: 128 * S, height: 256 * S, class: 'm16-pick sheet-fill', title: 'Click/drag: tile(s) as brush' });
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  const sheet = document.createElement('canvas');
  sheet.width = 128; sheet.height = 256;
  const sctx = sheet.getContext('2d')!, img = sctx.createImageData(128, 256), px = new Uint32Array(img.data.buffer);
  for (let t = 0; t < 0x200; t++) draw(px, 128, t | (pal << 10), (t & 15) * 8, (t >> 4) * 8);
  sctx.putImageData(img, 0, 0);
  let shown: [number, number, number, number] = [-1, 0, 0, 0];
  const show = (x: number, y: number, w: number, hh: number) => {
    shown = [x, y, w, hh];
    ctx.drawImage(sheet, 0, 0, c.width, c.height);
    if (x < 0) return;
    ctx.lineWidth = 2;
    antsRect(ctx, x * 8 * S, y * 8 * S, w * 8 * S, hh * 8 * S, '#4cc2ff');
  };
  onAntsTick(c, () => show(...shown));
  if (onSheet) show(w0 & 15, (w0 & L3_TILE) >> 4, b.w, b.h); else show(-1, 0, 0, 0);
  attachRectPick(c, 16, 32, (q) => show(q.x, q.y, q.w, q.h), (q) =>
    setBrush({ w: q.w, h: q.h, tiles: Array.from({ length: q.w * q.h }, (_, i) => ((q.y + Math.floor(i / q.w)) * 16 + q.x + (i % q.w)) | (attr & (L3_PAL | L3_PRIO))) }));
  previewSheet(c, () => sheet, 16, 32, 8, scale, (q) => [q.w * q.h > 1 ? `Block ${q.w}×${q.h} from tile ${hex3(q.y * 16 + q.x)}` : `Tile ${hex3(q.y * 16 + q.x)}`]);
  const palSel = h('select', { title: 'Palette (colors 4 × n – 4 × n + 3)' }, Array.from({ length: 8 }, (_, i) => h('option', { value: String(i), selected: i === pal }, `Palette ${i}`)));
  palSel.addEventListener('change', () => { const p = Number(palSel.value); each((w) => withL3Palette(w, p)); });
  const prio = h('input', { type: 'checkbox', checked: !!(w0 & L3_PRIO) }) as HTMLInputElement;
  prio.addEventListener('change', () => each((w) => (prio.checked ? w | L3_PRIO : w & ~L3_PRIO)));
  const flip = (bit: number) => setBrush({
    w: b.w, h: b.h,
    tiles: b.tiles.map((_, i) => {
      const x = i % b.w, y = Math.floor(i / b.w);
      return b.tiles[bit === L3_FLIP_X ? y * b.w + (b.w - 1 - x) : (b.h - 1 - y) * b.w + x] ^ bit;
    }),
  });
  const what = b.tiles.length > 1 ? `Block ${b.w}×${b.h}${onSheet ? ` from tile ${hex3(w0 & L3_TILE)}` : ` from ${o.from}`}` : `Tile ${hex3(w0 & L3_TILE)}`;
  body.append(
    h('div', { class: 'row' }, palSel, h('label', { class: 'row small', title: 'In front of layers 1 and 2 (tilemap priority)' }, prio, 'Priority'),
      h('button', { title: 'Mirror the brush horizontally', onclick: () => flip(L3_FLIP_X) }, 'Flip X'),
      h('button', { title: 'Mirror the brush vertically', onclick: () => flip(L3_FLIP_Y) }, 'Flip Y'),
      h('button', { title: 'Paint with a tile without visible pixels', onclick: () => setBrush({ w: 1, h: 1, tiles: [blankTile(g.vram, g.charBase)] }) }, 'Erase')),
    h('div', { class: 'hint' }, `Brush: ${what} – ${o.hint}`));
  if (!onSheet) {
    const p = h('canvas', { width: b.w * 8, height: b.h * 8, class: 'bg-brush' });
    const pc = p.getContext('2d')!, pimg = pc.createImageData(b.w * 8, b.h * 8), ppx = new Uint32Array(pimg.data.buffer);
    b.tiles.forEach((w, i) => draw(ppx, b.w * 8, w, (i % b.w) * 8, Math.floor(i / b.w) * 8));
    pc.putImageData(pimg, 0, 0);
    sized(p, fitScale(p.width, p.height, 128 * scale, 128 * scale, scale));
    body.append(h('div', { class: 'row' }, p));
  }
  body.append(c);
}
