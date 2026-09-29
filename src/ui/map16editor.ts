// Map16 editor: 16x16 tile definitions (four 8x8 tiles each) for the current tileset.

import type { App } from './app.ts';
import { h, modal, clear, hexInput } from './dom.ts';
import { TileCache } from '../core/render.ts';
import { hex } from '../core/names.ts';

export function openMap16Editor(app: App, initialTile = 0): void {
  let page: 'fg' | 'bg' = 'fg';
  let sel = initialTile & 0x1ff;
  let quad = 0;
  let pickPal = 0;
  const r = () => app.render;
  const tileAddr = (t: number): number => {
    if (page === 'bg') return 0x0d9100 + t * 8;
    const w = r().wram;
    return 0x0d0000 | (w[0x0fbe + t * 2] | (w[0x0fbf + t * 2] << 8));
  };
  const words = (t: number) => { const a = tileAddr(t); return [0, 1, 2, 3].map((q) => app.rom.r16(a + q * 2)); };
  const Z = 2;

  const tilesCanvas = h('canvas', { width: 256 * Z, height: 512 * Z, class: 'm16-tiles' });
  const gfxCanvas = h('canvas', { width: 128 * Z, height: 512 * Z, class: 'm16-gfx' });
  const detail = h('div', { class: 'm16-detail' });
  const pageSel = h('div', { class: 'tabs' });

  const tc = () => new TileCache(r().vram, r().cgram, (r().ppuRegs[0x0b] & 0x0f) << 13);

  const drawTiles = () => {
    const ctx = tilesCanvas.getContext('2d')!;
    const img = ctx.createImageData(256, 512);
    const px = new Uint32Array(img.data.buffer);
    px.fill(0xff202020);
    const cache = tc();
    for (let t = 0; t < 512; t++) {
      const w = words(t);
      const bx = (t & 15) * 16, by = (t >> 4) * 16;
      const pos = [[0, 0], [0, 8], [8, 0], [8, 8]];
      for (let q = 0; q < 4; q++) {
        const tile = cache.get(w[q]);
        for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
          const c = tile[y * 8 + x];
          if (c) px[(by + pos[q][1] + y) * 256 + bx + pos[q][0] + x] = c;
        }
      }
    }
    const off = document.createElement('canvas');
    off.width = 256; off.height = 512;
    off.getContext('2d')!.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(off, 0, 0, 256 * Z, 512 * Z);
    ctx.strokeStyle = '#4cc2ff';
    ctx.lineWidth = 2;
    ctx.strokeRect((sel & 15) * 16 * Z, (sel >> 4) * 16 * Z, 16 * Z, 16 * Z);
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.font = '11px monospace';
    for (let row = 0; row < 32; row += 1) if (row % 4 === 0) ctx.fillText(hex(row * 16, 3), 2, row * 16 * Z + 11);
  };

  const drawGfx = () => {
    const ctx = gfxCanvas.getContext('2d')!;
    const img = ctx.createImageData(128, 512);
    const px = new Uint32Array(img.data.buffer);
    px.fill(0xff202020);
    const cache = tc();
    for (let t = 0; t < 1024; t++) {
      const tile = cache.get(t | (pickPal << 10));
      const bx = (t & 15) * 8, by = (t >> 4) * 8;
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) { const c = tile[y * 8 + x]; if (c) px[(by + y) * 128 + bx + x] = c; }
    }
    const off = document.createElement('canvas');
    off.width = 128; off.height = 512;
    off.getContext('2d')!.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(off, 0, 0, 128 * Z, 512 * Z);
    const cur = words(sel)[quad] & 0x3ff;
    ctx.strokeStyle = '#ffb000';
    ctx.lineWidth = 2;
    ctx.strokeRect((cur & 15) * 8 * Z, (cur >> 4) * 8 * Z, 8 * Z, 8 * Z);
  };

  const writeWord = (q: number, v: number) => {
    app.rom.w16(tileAddr(sel) + q * 2, v);
    app.emu.syncRom();
    redraw();
  };

  const buildDetail = () => {
    clear(detail);
    const w = words(sel);
    const quadNames = ['oben links', 'unten links', 'oben rechts', 'unten rechts'];
    const preview = h('canvas', { width: 16, height: 16, class: 'm16-preview' });
    const pctx = preview.getContext('2d')!;
    const img = pctx.createImageData(16, 16);
    const px = new Uint32Array(img.data.buffer);
    const cache = tc();
    const pos = [[0, 0], [0, 8], [8, 0], [8, 8]];
    for (let q = 0; q < 4; q++) {
      const tile = cache.get(w[q]);
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) px[(pos[q][1] + y) * 16 + pos[q][0] + x] = tile[y * 8 + x] || 0xff202020;
    }
    pctx.putImageData(img, 0, 0);
    const quads = h('div', { class: 'm16-quads' }, [0, 2, 1, 3].map((q) => h('button', { class: quad === q ? 'active' : '', onclick: () => { quad = q; buildDetail(); drawGfx(); } }, quadNames[q])));
    const v = w[quad];
    const cb = (label: string, bit: number) => {
      const c = h('input', { type: 'checkbox', checked: (v & bit) !== 0 });
      c.addEventListener('change', () => writeWord(quad, c.checked ? v | bit : v & ~bit));
      return h('label', { class: 'toggle' }, c, label);
    };
    detail.append(
      h('div', { class: 'prop-title' }, `${page === 'fg' ? 'FG' : 'BG'}-Tile ${hex(sel, 3)}`),
      h('div', { class: 'hint' }, `ROM $${hex(tileAddr(sel), 6)}`),
      preview,
      quads,
      h('div', { class: 'prop' }, h('label', null, '8x8-Tile'), hexInput(v & 0x3ff, 3, (n) => writeWord(quad, (v & ~0x3ff) | n), 0x3ff)),
      h('div', { class: 'prop' }, h('label', null, 'Palette'), hexInput((v >> 10) & 7, 1, (n) => writeWord(quad, (v & ~0x1c00) | (n << 10)), 7)),
      h('div', { class: 'row' }, cb('X-Flip', 0x4000), cb('Y-Flip', 0x8000), cb('Priorität', 0x2000)),
      h('div', { class: 'prop' }, h('label', null, 'Rohwert'), hexInput(v, 4, (n) => writeWord(quad, n), 0xffff)),
      h('div', { class: 'prop' }, h('label', null, 'Anzeige-Palette'), hexInput(pickPal, 1, (n) => { pickPal = n; drawGfx(); }, 7)),
      h('p', { class: 'hint' }, 'Rechts ein 8x8-Tile anklicken, um es dem gewählten Viertel zuzuweisen (mit dessen Palette). Tiles 073–0FF sind Tileset-spezifisch. Das Verhalten ("acts like") ist in Vanilla-SMW an die Tilenummer gebunden.'),
    );
  };

  const redraw = () => {
    clear(pageSel);
    pageSel.append(
      h('button', { class: page === 'fg' ? 'active' : '', onclick: () => { page = 'fg'; redraw(); } }, 'FG (Seiten 0–1)'),
      h('button', { class: page === 'bg' ? 'active' : '', onclick: () => { page = 'bg'; redraw(); } }, 'BG'),
    );
    drawTiles();
    drawGfx();
    buildDetail();
  };

  tilesCanvas.addEventListener('mousedown', (e) => {
    const rc = tilesCanvas.getBoundingClientRect();
    const x = Math.floor((e.clientX - rc.left) / (16 * Z * rc.width / (256 * Z))), y = Math.floor((e.clientY - rc.top) / (16 * Z * rc.height / (512 * Z)));
    sel = Math.max(0, Math.min(511, y * 16 + x));
    redraw();
  });
  gfxCanvas.addEventListener('mousedown', (e) => {
    const rc = gfxCanvas.getBoundingClientRect();
    const x = Math.floor((e.clientX - rc.left) / (8 * Z * rc.width / (128 * Z))), y = Math.floor((e.clientY - rc.top) / (8 * Z * rc.height / (512 * Z)));
    const t = y * 16 + x;
    const v = words(sel)[quad];
    writeWord(quad, (v & 0xe000) | (pickPal << 10) | t);
  });

  redraw();
  modal(`Map16 – Tileset ${hex(app.level.header.tileset, 1)}`, h('div', { class: 'm16-editor' },
    h('div', { class: 'm16-col' }, pageSel, h('div', { class: 'm16-scroll' }, tilesCanvas)),
    h('div', { class: 'm16-col' }, h('div', { class: 'hint' }, 'Grafik (VRAM)'), h('div', { class: 'm16-scroll' }, gfxCanvas)),
    detail,
  ), [{ label: 'Schließen', primary: true, onClick: () => { app.refresh(); app.palettesChanged(); app.persist(); } }]);
}
