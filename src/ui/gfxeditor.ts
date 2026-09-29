// GFX file viewer with PNG export / import (LZ2 recompression into free space).

import type { App } from './app.ts';
import { h, modal, clear, toast, downloadBytes, pickFile, select } from './dom.ts';
import { lz2Decompress, lz2Compress } from '../core/lz2.ts';
import { decodeTile, encodeTile, cgramToRGBA } from '../core/gfx.ts';
import { snesToPc } from '../core/rom.ts';
import { hex } from '../core/names.ts';

export const GFX_COUNT = 0x32;

export function gfxPointer(app: App, i: number): number {
  const r = app.rom;
  return r.r8(0x00b992 + i) | (r.r8(0x00b9c4 + i) << 8) | (r.r8(0x00b9f6 + i) << 16);
}
function setGfxPointer(app: App, i: number, p: number): void {
  const r = app.rom;
  r.w8(0x00b992 + i, p & 0xff);
  r.w8(0x00b9c4 + i, (p >> 8) & 0xff);
  r.w8(0x00b9f6 + i, (p >> 16) & 0xff);
}
function defaultBpp(i: number, size: number): number {
  if ((i >= 0x28 && i <= 0x2b) || i === 0x2f) return 2;
  if (size % 24 === 0 && size % 32 !== 0) return 3;
  if (size === 0xc00 || size === 0x600) return 3;
  return 4;
}

export function openGfxEditor(app: App): void {
  let cur = 0;
  let palRow = 0;
  let bppOverride: number | null = null;
  const Z = 3;
  const list = h('div', { class: 'gfx-list' });
  const canvas = h('canvas', { class: 'gfx-canvas' });
  const info = h('div', { class: 'gfx-info' });

  const load = (i: number) => {
    const p = gfxPointer(app, i);
    const { data, size } = lz2Decompress(app.rom.data, snesToPc(p));
    const bpp = bppOverride ?? defaultBpp(i, data.length);
    return { p, data, size, bpp, tiles: Math.floor(data.length / (bpp * 8)) };
  };

  const palette = (bpp: number): Uint32Array => {
    const all = cgramToRGBA(app.render.cgram);
    const n = 1 << bpp;
    const out = new Uint32Array(n);
    for (let k = 0; k < n; k++) out[k] = k === 0 ? 0 : all[(palRow * 16 + k) & 0xff];
    return out;
  };

  const draw = () => {
    const g = load(cur);
    const rows = Math.ceil(g.tiles / 16);
    const W = 128, H = rows * 8;
    const off = document.createElement('canvas');
    off.width = W; off.height = H;
    const octx = off.getContext('2d')!;
    const img = octx.createImageData(W, H);
    const px = new Uint32Array(img.data.buffer);
    const pal = palette(g.bpp);
    const idx = new Uint8Array(64);
    for (let t = 0; t < g.tiles; t++) {
      decodeTile(g.data, t * g.bpp * 8, g.bpp, idx);
      const bx = (t & 15) * 8, by = (t >> 4) * 8;
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) px[(by + y) * W + bx + x] = pal[idx[y * 8 + x]] || 0xff303030;
    }
    octx.putImageData(img, 0, 0);
    canvas.width = W * Z; canvas.height = H * Z;
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(off, 0, 0, W * Z, H * Z);
    clear(info);
    info.append(
      h('div', { class: 'prop-title' }, `GFX${hex(cur, 2)}`),
      h('div', { class: 'prop' }, h('label', null, 'Adresse'), h('span', { class: 'mono' }, `$${hex(g.p, 6)}`)),
      h('div', { class: 'prop' }, h('label', null, 'Größe'), h('span', null, `${g.data.length} Bytes entpackt, ${g.size} gepackt, ${g.tiles} Tiles`)),
      h('div', { class: 'prop' }, h('label', null, 'Format'), select([[2, '2bpp'], [3, '3bpp'], [4, '4bpp']], g.bpp, (v) => { bppOverride = v; draw(); })),
      h('div', { class: 'prop' }, h('label', null, 'Anzeige-Palette'), select(Array.from({ length: 16 }, (_, k) => [k, `Zeile ${hex(k, 1)}`] as [number, string]), palRow, (v) => { palRow = v; draw(); })),
      h('p', { class: 'hint' }, 'Export/Import als PNG (128 Pixel breit, 16 Tiles pro Zeile). Beim Import werden Farben auf die gewählte Palettenzeile abgebildet; transparente Pixel = Farbe 0. Die Datei wird neu LZ2-komprimiert und in freien ROM-Speicher geschrieben.'),
    );
    return { g, off };
  };

  const buildList = () => {
    clear(list);
    for (let i = 0; i < GFX_COUNT; i++) {
      list.appendChild(h('div', { class: `level-item${i === cur ? ' current' : ''}`, onclick: () => { cur = i; bppOverride = null; buildList(); draw(); } }, `GFX${hex(i, 2)}`));
    }
  };

  const exportPng = () => {
    const { off } = draw();
    off.toBlob(async (b) => { if (b) downloadBytes(`GFX${hex(cur, 2)}.png`, new Uint8Array(await b.arrayBuffer()), 'image/png'); }, 'image/png');
  };

  const importPng = async () => {
    const f = await pickFile('.png,image/png');
    if (!f) return;
    const bmp = await createImageBitmap(f);
    const g = load(cur);
    if (bmp.width !== 128) { toast('Bild muss 128 Pixel breit sein', 'error'); return; }
    const tiles = Math.floor(bmp.height / 8) * 16;
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(bmp, 0, 0);
    const px = new Uint32Array(ctx.getImageData(0, 0, c.width, c.height).data.buffer);
    const pal = palette(g.bpp);
    const nearest = (v: number) => {
      if (((v >>> 24) & 255) < 128) return 0;
      let best = 1, bd = 1e9;
      for (let k = 1; k < pal.length; k++) {
        const p = pal[k];
        const dr = (p & 255) - (v & 255), dg = ((p >> 8) & 255) - ((v >> 8) & 255), db = ((p >> 16) & 255) - ((v >> 16) & 255);
        const d = dr * dr + dg * dg + db * db;
        if (d < bd) { bd = d; best = k; }
      }
      return best;
    };
    const out = new Uint8Array(tiles * g.bpp * 8);
    const tile = new Uint8Array(64);
    for (let t = 0; t < tiles; t++) {
      const bx = (t & 15) * 8, by = (t >> 4) * 8;
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) tile[y * 8 + x] = nearest(px[(by + y) * 128 + bx + x]);
      encodeTile(tile, 0, g.bpp, out, t * g.bpp * 8);
    }
    const comp = lz2Compress(out);
    app.rom.freeAt(g.p);
    const addr = app.rom.allocWrite(comp);
    setGfxPointer(app, cur, addr);
    app.emu.syncRom();
    app.refresh();
    app.palettesChanged();
    app.persist();
    draw();
    toast(`GFX${hex(cur, 2)} importiert: ${out.length} Bytes → ${comp.length} Bytes @ $${hex(addr, 6)}`);
  };

  buildList();
  draw();
  modal('Grafiken (GFX-Dateien)', h('div', { class: 'gfx-editor' }, list, h('div', { class: 'gfx-view' }, canvas), info), [
    { label: 'PNG exportieren', onClick: () => { exportPng(); return false; } },
    { label: 'PNG importieren', onClick: () => { void importPng(); return false; } },
    { label: 'Schließen', primary: true },
  ]);
}
