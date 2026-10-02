// Overworld editor view.

import type { App } from './app.ts';
import { h, clear, toast, select, attachPanZoom, attachRectPick } from './dom.ts';
import {
  OverworldEmulator, type OwRender, readL1, writeL1, readL2, writeL2, l1Index, l2Index, translevels, isLevelTile,
  translevelToLevel, levelName, nameCode, setNameCode, splitNameCode, joinNameCode, nameWord, NAME_PART_COUNTS, MAP_NAMES,
} from '../core/overworld.ts';
import { TileCache, blit8 } from '../core/render.ts';
import { hex } from '../core/names.ts';
import { menuButton } from './menu.ts';

// a w×h block of L1 tiles (16x16) or L2 tilemap entries (8x8), row-major
type Brush = { kind: 'l1' | 'l2'; w: number; h: number; entries: number[] };
type Drag =
  | { kind: 'paint'; x0: number; y0: number; lastX: number; lastY: number } // brush stamped on a grid from (x0, y0)
  | { kind: 'pick'; x0: number; y0: number; x1: number; y1: number }; // map cells taken into the brush

export class OverworldView {
  app: App;
  root: HTMLDivElement;
  side: HTMLDivElement;
  bar: HTMLDivElement;
  canvas: HTMLCanvasElement;
  scroller: HTMLDivElement;
  sizer: HTMLDivElement;
  status: HTMLDivElement;
  emu: OverworldEmulator;
  map = 0;
  renders = new Map<string, OwRender>();
  l1: Uint8Array;
  l2: Uint16Array;
  dirty = false;
  mode: 'l1' | 'l2' = 'l1';
  showL1 = true;
  showL2 = true;
  showEvents = false;
  showGrid = false;
  zoom = 2;
  brush: Brush = { kind: 'l1', w: 1, h: 1, entries: [0x56] };
  l2Pal = 0;
  hover: { x: number; y: number } | null = null;
  drag: Drag | null = null;
  selectedTl = -1;
  mapCanvas = document.createElement('canvas');
  undo: { l1: Uint8Array; l2: Uint16Array }[] = [];

  constructor(app: App) {
    this.app = app;
    this.emu = new OverworldEmulator(app.rom);
    this.l1 = readL1(app.rom);
    this.l2 = readL2(app.rom);
    this.canvas = h('canvas', { class: 'level-canvas' });
    this.sizer = h('div', { class: 'level-sizer' });
    this.scroller = h('div', { class: 'level-scroller', tabIndex: 0 }, this.canvas, this.sizer);
    this.status = h('div', { class: 'statusbar' });
    this.side = h('div', { class: 'panel ow-side' });
    this.bar = h('div', { class: 'ctxbar' });
    this.root = h('div', { class: 'center' }, h('div', { class: 'level-view' }, this.scroller), this.status);
    this.scroller.addEventListener('scroll', () => this.paint());
    new ResizeObserver(() => this.layout()).observe(this.scroller);
    this.scroller.addEventListener('contextmenu', (e) => e.preventDefault());
    this.scroller.addEventListener('mousedown', (e) => this.onDown(e));
    window.addEventListener('mousemove', (e) => this.onMove(e));
    window.addEventListener('mouseup', () => this.onUp());
    attachPanZoom(this.scroller, () => this.zoom, (z, ax, ay) => {
      const lx = (this.scroller.scrollLeft + ax) / this.zoom, ly = (this.scroller.scrollTop + ay) / this.zoom;
      this.zoom = z;
      this.layout();
      this.scroller.scrollLeft = lx * z - ax;
      this.scroller.scrollTop = ly * z - ay;
    }, 1, 4);
  }

  get region(): number {
    return this.map > 0 ? 1 : 0;
  }

  render(): OwRender {
    const key = `${this.map}-${this.showEvents ? 1 : 0}`;
    let r = this.renders.get(key);
    if (!r) {
      r = this.emu.load(this.map, this.showEvents);
      this.renders.set(key, r);
    }
    return r;
  }
  invalidate(): void {
    this.renders.clear();
    this.emu.titleState = null;
  }

  // ---------------- drawing ----------------
  redrawMap(): void {
    const r = this.render();
    const W = 512;
    const img = new Uint32Array(W * W);
    const pal0 = r.cgram[0] | (r.cgram[1] << 8);
    void pal0;
    const tc = new TileCache(r.vram, r.cgram, 0);
    if (this.showL2) {
      for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) blit8(img, W, W, tc.get(this.l2[l2Index(this.region, x, y)]), x * 8, y * 8);
    }
    if (this.showL1) {
      const src = this.showEvents ? r.wram.subarray(0xc800, 0xd000) : this.l1;
      for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) this.drawL1Tile(img, tc, r, src[l1Index(this.region, x, y)], x * 16, y * 16);
    }
    this.mapCanvas.width = W; this.mapCanvas.height = W;
    const ctx = this.mapCanvas.getContext('2d')!;
    const id = ctx.createImageData(W, W);
    const px = new Uint32Array(id.data.buffer);
    for (let i = 0; i < px.length; i++) px[i] = img[i] || 0xff000000;
    ctx.putImageData(id, 0, 0);
    this.paint();
  }

  l1Words(r: OwRender, t: number): number[] {
    const p = r.wram[0x0fbe + t * 2] | (r.wram[0x0fbf + t * 2] << 8);
    return [0, 1, 2, 3].map((q) => this.app.rom.r16(0x050000 | (p + q * 2)));
  }
  drawL1Tile(img: Uint32Array, tc: TileCache, r: OwRender, t: number, px: number, py: number, W = 512, H = 512): void {
    const w = this.l1Words(r, t);
    blit8(img, W, H, tc.get(w[0]), px, py);
    blit8(img, W, H, tc.get(w[1]), px, py + 8);
    blit8(img, W, H, tc.get(w[2]), px + 8, py);
    blit8(img, W, H, tc.get(w[3]), px + 8, py + 8);
  }

  layout(): void {
    const z = this.zoom;
    this.sizer.style.width = `${512 * z}px`;
    this.sizer.style.height = `${512 * z}px`;
    const dpr = window.devicePixelRatio || 1;
    const w = this.scroller.clientWidth, hh = this.scroller.clientHeight;
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${hh}px`;
    this.canvas.width = Math.floor(w * dpr);
    this.canvas.height = Math.floor(hh * dpr);
    this.paint();
  }

  paint(): void {
    const ctx = this.canvas.getContext('2d')!;
    const dpr = window.devicePixelRatio || 1;
    const z = this.zoom * dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#1b1d22';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.imageSmoothingEnabled = false;
    ctx.setTransform(z, 0, 0, z, -this.scroller.scrollLeft * dpr, -this.scroller.scrollTop * dpr);
    ctx.drawImage(this.mapCanvas, 0, 0);
    const lw = 1 / z;
    if (this.showGrid) {
      const step = this.mode === 'l1' ? 16 : 8;
      ctx.strokeStyle = 'rgba(255,255,255,0.12)';
      ctx.lineWidth = lw;
      ctx.beginPath();
      for (let i = 0; i <= 512; i += step) { ctx.moveTo(i, 0); ctx.lineTo(i, 512); ctx.moveTo(0, i); ctx.lineTo(512, i); }
      ctx.stroke();
    }
    // level tile labels
    const tl = translevels(this.l1);
    ctx.font = `bold ${8}px monospace`;
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
      const i = l1Index(this.region, x, y);
      if (!tl[i]) continue;
      const sel = tl[i] === this.selectedTl;
      ctx.fillStyle = sel ? 'rgba(76,194,255,0.85)' : 'rgba(0,0,0,0.6)';
      ctx.fillRect(x * 16, y * 16 + 10, 16, 7);
      ctx.fillStyle = '#fff';
      ctx.fillText(hex(translevelToLevel(tl[i]), 3), x * 16 + 1, y * 16 + 16);
    }
    const s = this.mode === 'l1' ? 16 : 8;
    if (this.drag?.kind === 'pick') {
      const r = this.pickRect(this.drag);
      ctx.strokeStyle = '#4cc2ff';
      ctx.fillStyle = 'rgba(76,194,255,0.15)';
      ctx.lineWidth = lw;
      ctx.fillRect(r.x * s, r.y * s, r.w * s, r.h * s);
      ctx.strokeRect(r.x * s, r.y * s, r.w * s, r.h * s);
    } else if (this.hover) {
      // the area the brush would paint
      ctx.strokeStyle = 'rgba(255,255,0,0.9)';
      ctx.lineWidth = lw;
      ctx.strokeRect(this.hover.x * s, this.hover.y * s, this.brush.w * s, this.brush.h * s);
    }
  }

  // ---------------- interaction ----------------
  cell(e: MouseEvent): { x: number; y: number } {
    const rc = this.scroller.getBoundingClientRect();
    const px = (e.clientX - rc.left + this.scroller.scrollLeft) / this.zoom;
    const py = (e.clientY - rc.top + this.scroller.scrollTop) / this.zoom;
    const s = this.mode === 'l1' ? 16 : 8;
    return { x: Math.floor(px / s), y: Math.floor(py / s) };
  }

  // same buttons as in the level editor: click/drag takes tiles into the brush, right-click/Shift+click paints
  onDown(e: MouseEvent): void {
    if (e.target !== this.scroller && e.target !== this.canvas) return;
    const rc = this.scroller.getBoundingClientRect();
    if (e.clientX - rc.left > this.scroller.clientWidth || e.clientY - rc.top > this.scroller.clientHeight) return;
    const c = this.cell(e);
    if (e.button === 2 || (e.button === 0 && e.shiftKey && !e.ctrlKey)) {
      if (this.showEvents && this.mode === 'l1') { toast('Im Event-Modus ist Layer 1 schreibgeschützt (zeigt den Zustand nach allen Events).'); return; }
      this.pushUndo();
      this.drag = { kind: 'paint', x0: c.x, y0: c.y, lastX: c.x, lastY: c.y };
      this.paintAt(c.x, c.y);
      return;
    }
    if (e.button !== 0) return;
    if (e.altKey || (this.mode === 'l1' && e.ctrlKey)) { this.info(c.x, c.y); return; }
    this.drag = { kind: 'pick', x0: c.x, y0: c.y, x1: c.x, y1: c.y };
    this.paint();
  }

  onMove(e: MouseEvent): void {
    const inside = e.target === this.scroller || e.target === this.canvas;
    const d = this.drag;
    if (!inside && !d) return;
    const c = this.cell(e);
    if (this.hover && this.hover.x === c.x && this.hover.y === c.y) return;
    this.hover = c;
    this.updateStatus();
    if (d?.kind === 'paint') {
      const x = d.x0 + Math.floor((c.x - d.x0) / this.brush.w) * this.brush.w, y = d.y0 + Math.floor((c.y - d.y0) / this.brush.h) * this.brush.h;
      if (x !== d.lastX || y !== d.lastY) { d.lastX = x; d.lastY = y; this.paintAt(x, y); return; }
    } else if (d?.kind === 'pick') { d.x1 = c.x; d.y1 = c.y; }
    this.paint();
  }

  onUp(): void {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    if (d.kind === 'pick') this.pick(this.pickRect(d));
  }

  // the picked rectangle, clamped to the map (32x32 L1 tiles, 64x64 L2 tiles)
  pickRect(d: { x0: number; y0: number; x1: number; y1: number }): { x: number; y: number; w: number; h: number } {
    const n = this.mode === 'l1' ? 32 : 64;
    const cl = (v: number) => Math.max(0, Math.min(n - 1, v));
    const x0 = cl(Math.min(d.x0, d.x1)), x1 = cl(Math.max(d.x0, d.x1)), y0 = cl(Math.min(d.y0, d.y1)), y1 = cl(Math.max(d.y0, d.y1));
    return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }

  pushUndo(): void {
    this.undo.push({ l1: this.l1.slice(), l2: this.l2.slice() });
    if (this.undo.length > 100) this.undo.shift();
  }
  undoOnce(): void {
    const u = this.undo.pop();
    if (!u) return;
    this.l1 = u.l1; this.l2 = u.l2; this.dirty = true;
    this.redrawMap();
    this.buildSide();
  }

  paintAt(x: number, y: number): void {
    const b = this.brush;
    if (b.kind !== this.mode) return;
    const n = this.mode === 'l1' ? 32 : 64;
    let changed = false;
    for (let dy = 0; dy < b.h; dy++) for (let dx = 0; dx < b.w; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= n || yy >= n) continue;
      const v = b.entries[dy * b.w + dx];
      if (this.mode === 'l1') {
        const i = l1Index(this.region, xx, yy);
        if (this.l1[i] !== v) { this.l1[i] = v; changed = true; }
      } else {
        const i = l2Index(this.region, xx, yy);
        if (this.l2[i] !== v) { this.l2[i] = v; changed = true; }
      }
    }
    if (!changed) return;
    this.dirty = true;
    this.redrawMap();
  }

  pick(r: { x: number; y: number; w: number; h: number }): void {
    const src = this.mode === 'l2' ? this.l2 : this.showEvents ? this.render().wram.subarray(0xc800, 0xd000) : this.l1;
    const idx = this.mode === 'l2' ? l2Index : l1Index;
    const entries = Array.from({ length: r.w * r.h }, (_, i) => src[idx(this.region, r.x + (i % r.w), r.y + Math.floor(i / r.w))]);
    this.brush = { kind: this.mode, w: r.w, h: r.h, entries };
    this.buildSide();
    this.paint();
  }

  info(x: number, y: number): void {
    if (this.mode !== 'l1') return;
    const tl = translevels(this.l1)[l1Index(this.region, x, y)];
    this.selectedTl = tl || -1;
    this.buildSide();
    this.paint();
  }

  updateStatus(): void {
    const c = this.hover;
    if (!c) return;
    let t = `${this.mode === 'l1' ? 'L1 16x16' : 'L2 8x8'}  X ${hex(c.x, 2)} Y ${hex(c.y, 2)}`;
    const lx = this.mode === 'l1' ? c.x : c.x >> 1, ly = this.mode === 'l1' ? c.y : c.y >> 1;
    if (lx >= 0 && ly >= 0 && lx < 32 && ly < 32) {
      const i = l1Index(this.region, lx, ly);
      const tile = this.l1[i];
      t += `  L1-Tile ${hex(tile, 2)}`;
      const tl = translevels(this.l1)[i];
      if (tl) t += `  · Translevel ${hex(tl, 2)} → Level ${hex(translevelToLevel(tl), 3)} "${levelName(this.app.rom, tl)}"`;
    }
    if (this.mode === 'l2' && c.x >= 0 && c.y >= 0 && c.x < 64 && c.y < 64) t += `  L2 ${hex(this.l2[l2Index(this.region, c.x, c.y)], 4)}`;
    this.status.textContent = t;
  }

  // ---------------- context bar (map, layer, view) ----------------
  buildBar(): void {
    const setMode = (m: 'l1' | 'l2') => {
      this.mode = m;
      if (this.brush.kind !== m) this.brush = { kind: m, w: 1, h: 1, entries: [m === 'l1' ? 0x56 : 0] };
      this.buildSide();
      this.paint();
    };
    const view = (label: string, get: () => boolean, set: (v: boolean) => void, title?: string) =>
      ({ label, title, checked: get, onToggle: (v: boolean) => { set(v); this.redrawMap(); } });
    this.bar.replaceChildren(
      h('label', { class: 'row' }, 'Karte ', select(MAP_NAMES.map((n, i) => [i, n] as [number, string]), this.map, (v) => { this.map = v; this.selectedTl = -1; this.redrawMap(); this.buildSide(); })),
      h('span', { class: 'sep' }),
      h('div', { class: 'btn-group' },
        h('button', { class: this.mode === 'l1' ? 'active' : '', onclick: () => setMode('l1') }, 'Layer 1 (Wege/Level)'),
        h('button', { class: this.mode === 'l2' ? 'active' : '', onclick: () => setMode('l2') }, 'Layer 2 (Gelände)')),
      h('span', { class: 'sep' }),
      menuButton({ label: 'Ansicht', items: [
        { heading: 'Ebenen' },
        view('Layer 1', () => this.showL1, (v) => (this.showL1 = v)),
        view('Layer 2', () => this.showL2, (v) => (this.showL2 = v)),
        { heading: 'Hilfen' },
        view('Raster', () => this.showGrid, (v) => (this.showGrid = v)),
        { heading: 'Spielzustand' },
        view('Nach allen Events', () => this.showEvents, (v) => (this.showEvents = v), 'Zustand nach allen Events (nur Ansicht)'),
      ] }),
      h('span', { class: 'sep' }),
      h('button', { onclick: () => { this.invalidate(); this.redrawMap(); this.buildSide(); }, title: 'Overworld neu aus der ROM laden' }, 'Neu laden'),
    );
  }

  // ---------------- side panel ----------------
  buildSide(): void {
    this.buildBar();
    const side = this.side;
    clear(side);
    side.append(
      h('div', { class: 'panel-title' }, this.mode === 'l1' ? 'Layer 1 (Wege/Level)' : 'Layer 2 (Gelände)'),
      h('div', { class: 'hint' }, 'Wie im Level-Editor: Klick nimmt ein Tile auf, Ziehen einen Block (auch in der Palette) · Rechtsklick/Shift+Klick malt, Ziehen malt weiter · Alt+Klick (Layer 1): Level-Info.'),
    );
    if (this.selectedTl > 0) side.append(this.levelInfo(this.selectedTl));
    side.append(this.mode === 'l1' ? this.l1Palette() : this.l2Palette());
  }

  levelInfo(tl: number): HTMLElement {
    const rom = this.app.rom;
    const parts = splitNameCode(nameCode(rom, tl));
    const sel = (k: number) => select(Array.from({ length: NAME_PART_COUNTS[k] }, (_, i) => [i, `${hex(i, 2)}: ${nameWord(rom, k, i).trim() || '(leer)'}`] as [number, string]), parts[k], (v) => {
      parts[k] = v;
      setNameCode(rom, tl, joinNameCode(parts));
      this.dirty = true;
      this.buildSide();
    });
    const lvl = translevelToLevel(tl);
    return h('div', { class: 'ow-info' },
      h('div', { class: 'prop-title' }, `Translevel ${hex(tl, 2)} → Level ${hex(lvl, 3)}`),
      h('div', null, `"${levelName(rom, tl)}"`),
      h('div', { class: 'prop' }, h('label', null, 'Name Teil 1'), sel(0)),
      h('div', { class: 'prop' }, h('label', null, 'Name Teil 2'), sel(1)),
      h('div', { class: 'prop' }, h('label', null, 'Name Teil 3'), sel(2)),
      h('button', { onclick: () => { this.app.emit('open-level-from-ow'); this.app.openLevel(lvl); this.app.emit('show-level-view'); } }, `Level ${hex(lvl, 3)} bearbeiten`),
      h('div', { class: 'hint' }, 'In Vanilla-SMW werden Translevel-Nummern in Scan-Reihenfolge der Level-Tiles vergeben – neue Level-Tiles verschieben die Nummern aller folgenden.'),
    );
  }

  // palette sheet with the brush outlined (when it is a rectangle of the sheet) and rectangle picking;
  // any other brush (taken from the map, flipped) is shown as a preview instead
  sheetPalette(sheet: HTMLCanvasElement, cls: string, cols: number, rows: number, cell: number, sheetValue: (x: number, y: number) => number,
    preview: (ctx: CanvasRenderingContext2D) => void): HTMLElement {
    const b = this.brush;
    const c = h('canvas', { width: sheet.width, height: sheet.height, class: cls });
    const ctx = c.getContext('2d')!;
    const draw = (r: { x: number; y: number; w: number; h: number } | null) => {
      ctx.drawImage(sheet, 0, 0);
      if (!r) return;
      ctx.strokeStyle = '#4cc2ff'; ctx.lineWidth = cell / 8;
      ctx.strokeRect(r.x * cell + ctx.lineWidth / 2, r.y * cell + ctx.lineWidth / 2, r.w * cell - ctx.lineWidth, r.h * cell - ctx.lineWidth);
    };
    let at: { x: number; y: number; w: number; h: number } | null = null;
    if (b.kind === this.mode) {
      for (let i = 0; i < cols * rows && !at; i++) {
        const x = i % cols, y = Math.floor(i / cols);
        if (x + b.w <= cols && y + b.h <= rows && b.entries.every((v, j) => v === sheetValue(x + (j % b.w), y + Math.floor(j / b.w)))) at = { x, y, w: b.w, h: b.h };
      }
    }
    draw(at);
    attachRectPick(c, cols, rows, draw, (r) => {
      this.brush = { kind: this.mode, w: r.w, h: r.h, entries: Array.from({ length: r.w * r.h }, (_, j) => sheetValue(r.x + (j % r.w), r.y + Math.floor(j / r.w))) };
      this.buildSide();
    });
    const out = h('div', null);
    if (!at && b.kind === this.mode) {
      const p = h('canvas', { width: b.w * cell, height: b.h * cell, class: 'ow-brush' });
      preview(p.getContext('2d')!);
      p.style.width = `${Math.min(b.w * cell * 2, 256)}px`;
      p.style.imageRendering = 'pixelated';
      out.append(h('div', { class: 'hint' }, `Pinsel ${b.w}×${b.h}:`), h('div', { class: 'row' }, p));
    }
    out.append(c);
    return out;
  }

  l1Palette(): HTMLElement {
    const r = this.render();
    const tc = new TileCache(r.vram, r.cgram, 0);
    const tiles = (list: number[], w: number, W: number, H: number) => {
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const ctx = c.getContext('2d')!;
      const id = ctx.createImageData(W, H);
      const px = new Uint32Array(id.data.buffer);
      px.fill(0xff181818);
      list.forEach((t, i) => this.drawL1Tile(px, tc, r, t, (i % w) * 16, Math.floor(i / w) * 16, W, H));
      ctx.putImageData(id, 0, 0);
      return c;
    };
    const sheet = tiles(Array.from({ length: 256 }, (_, t) => t), 16, 256, 256);
    const b = this.brush;
    const one = b.kind === 'l1' && b.entries.length === 1;
    return h('div', null,
      h('div', { class: 'hint' }, `${one ? `Tile ${hex(b.entries[0], 2)}` : b.kind === 'l1' ? `Block ${b.w}×${b.h}` : ''} · Level-Tiles: 56–80`),
      this.sheetPalette(sheet, 'ow-pal', 16, 16, 16, (x, y) => y * 16 + x,
        (ctx) => ctx.drawImage(tiles(b.entries, b.w, b.w * 16, b.h * 16), 0, 0)));
  }

  l2Palette(): HTMLElement {
    const r = this.render();
    const tc = new TileCache(r.vram, r.cgram, 0);
    const entries = (list: number[], w: number, W: number, H: number) => {
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const ctx = c.getContext('2d')!;
      const id = ctx.createImageData(W, H);
      const px = new Uint32Array(id.data.buffer);
      px.fill(0xff181818);
      list.forEach((v, i) => blit8(px, W, H, tc.get(v), (i % w) * 8, Math.floor(i / w) * 8));
      ctx.putImageData(id, 0, 0);
      return c;
    };
    const sheet = entries(Array.from({ length: 1024 }, (_, t) => t | (this.l2Pal << 10)), 16, 128, 512);
    const b = this.brush;
    const brushInfo = b.kind === 'l2' ? `Pinsel ${b.w}×${b.h}: ${b.entries.slice(0, 16).map((v) => hex(v, 4)).join(' ')}${b.entries.length > 16 ? ' …' : ''}` : '';
    // X-flip mirrors every row of the block, Y-flip the order of the rows
    const flip = (bit: number, label: string) => h('button', {
      onclick: () => {
        const br = this.brush;
        if (br.kind !== 'l2') return;
        const rows = Array.from({ length: br.h }, (_, y) => br.entries.slice(y * br.w, (y + 1) * br.w).map((v) => v ^ bit));
        if (bit === 0x4000) rows.forEach((row) => row.reverse());
        if (bit === 0x8000) rows.reverse();
        br.entries = rows.flat();
        this.buildSide();
      },
    }, label);
    const pal = h('div', { class: 'ow-pal-scroll' }, this.sheetPalette(sheet, 'ow-pal8', 16, 64, 8, (x, y) => (y * 16 + x) | (this.l2Pal << 10),
      (ctx) => ctx.drawImage(entries(b.entries, b.w, b.w * 8, b.h * 8), 0, 0)));
    return h('div', null,
      h('div', { class: 'prop' }, h('label', null, 'Palette'), select(Array.from({ length: 8 }, (_, i) => [i, String(i)] as [number, string]), this.l2Pal, (v) => { this.l2Pal = v; this.buildSide(); })),
      h('div', { class: 'row' }, flip(0x4000, 'X-Flip'), flip(0x8000, 'Y-Flip'), flip(0x2000, 'Priorität')),
      h('div', { class: 'hint mono' }, brushInfo),
      pal);
  }

  save(): void {
    try {
      writeL1(this.app.rom, this.l1);
      const n = writeL2(this.app.rom, this.l2);
      this.app.emu.syncRom();
      this.app.persist();
      this.dirty = false;
      this.invalidate();
      this.redrawMap();
      toast(`Overworld gespeichert (Layer 2: ${n} Bytes RLE).`);
    } catch (e) {
      toast(`Fehler: ${e}`, 'error');
    }
  }

  show(): void {
    this.l1 = readL1(this.app.rom);
    this.l2 = readL2(this.app.rom);
    this.emu.rom = this.app.rom;
    this.invalidate();
    this.buildSide();
    this.redrawMap();
    this.layout();
  }
}

export { isLevelTile };
