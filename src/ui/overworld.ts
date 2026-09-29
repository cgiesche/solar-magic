// Overworld editor view.

import type { App } from './app.ts';
import { h, clear, toast, select, attachPanZoom } from './dom.ts';
import {
  OverworldEmulator, type OwRender, readL1, writeL1, readL2, writeL2, l1Index, l2Index, translevels, isLevelTile,
  translevelToLevel, levelName, nameCode, setNameCode, splitNameCode, joinNameCode, nameWord, NAME_PART_COUNTS, MAP_NAMES,
} from '../core/overworld.ts';
import { TileCache, blit8 } from '../core/render.ts';
import { hex } from '../core/names.ts';

type Brush = { kind: 'l1'; tile: number } | { kind: 'l2'; w: number; h: number; entries: number[] };

export class OverworldView {
  app: App;
  root: HTMLDivElement;
  side: HTMLDivElement;
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
  brush: Brush = { kind: 'l1', tile: 0x56 };
  l2Pal = 0;
  hover: { x: number; y: number } | null = null;
  painting = false;
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
    this.root = h('div', { class: 'center' }, h('div', { class: 'level-view' }, this.scroller), this.status);
    this.scroller.addEventListener('scroll', () => this.paint());
    new ResizeObserver(() => this.layout()).observe(this.scroller);
    this.scroller.addEventListener('contextmenu', (e) => e.preventDefault());
    this.scroller.addEventListener('mousedown', (e) => this.onDown(e));
    window.addEventListener('mousemove', (e) => this.onMove(e));
    window.addEventListener('mouseup', () => { if (this.painting) { this.painting = false; } });
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
    if (this.hover) {
      ctx.strokeStyle = 'rgba(255,255,0,0.9)';
      ctx.lineWidth = lw;
      if (this.mode === 'l1') ctx.strokeRect(this.hover.x * 16, this.hover.y * 16, 16, 16);
      else {
        const b = this.brush.kind === 'l2' ? this.brush : { w: 1, h: 1 };
        ctx.strokeRect(this.hover.x * 8, this.hover.y * 8, b.w * 8, b.h * 8);
      }
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

  onDown(e: MouseEvent): void {
    if (e.target !== this.scroller && e.target !== this.canvas) return;
    const rc = this.scroller.getBoundingClientRect();
    if (e.clientX - rc.left > this.scroller.clientWidth || e.clientY - rc.top > this.scroller.clientHeight) return;
    const c = this.cell(e);
    if (e.button === 2) { this.pick(c.x, c.y); return; }
    if (e.button !== 0) return;
    if (e.altKey || (this.mode === 'l1' && e.ctrlKey)) { this.info(c.x, c.y); return; }
    if (this.showEvents && this.mode === 'l1') { toast('Im Event-Modus ist Layer 1 schreibgeschützt (zeigt den Zustand nach allen Events).'); return; }
    this.pushUndo();
    this.painting = true;
    this.paintAt(c.x, c.y);
  }

  onMove(e: MouseEvent): void {
    const inside = e.target === this.scroller || e.target === this.canvas;
    if (!inside && !this.painting) return;
    const c = this.cell(e);
    if (!this.hover || this.hover.x !== c.x || this.hover.y !== c.y) {
      this.hover = c;
      this.updateStatus();
      if (this.painting) this.paintAt(c.x, c.y);
      else this.paint();
    }
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
    if (this.mode === 'l1' && b.kind === 'l1') {
      if (x < 0 || y < 0 || x >= 32 || y >= 32) return;
      const i = l1Index(this.region, x, y);
      if (this.l1[i] === b.tile) return;
      this.l1[i] = b.tile;
    } else if (this.mode === 'l2' && b.kind === 'l2') {
      for (let dy = 0; dy < b.h; dy++) for (let dx = 0; dx < b.w; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= 64 || yy >= 64) continue;
        this.l2[l2Index(this.region, xx, yy)] = b.entries[dy * b.w + dx];
      }
    } else return;
    this.dirty = true;
    this.redrawMap();
  }

  pick(x: number, y: number): void {
    if (this.mode === 'l1') {
      if (x < 0 || y < 0 || x >= 32 || y >= 32) return;
      const src = this.showEvents ? this.render().wram.subarray(0xc800, 0xd000) : this.l1;
      this.brush = { kind: 'l1', tile: src[l1Index(this.region, x, y)] };
    } else {
      // pick the aligned 2x2 block (16x16)
      const bx = x & ~1, by = y & ~1;
      const entries: number[] = [];
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) entries.push(this.l2[l2Index(this.region, bx + dx, by + dy)]);
      this.brush = { kind: 'l2', w: 2, h: 2, entries };
    }
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

  // ---------------- side panel ----------------
  buildSide(): void {
    const side = this.side;
    clear(side);
    const tog = (label: string, get: () => boolean, set: (v: boolean) => void) => {
      const cb = h('input', { type: 'checkbox', checked: get() });
      cb.addEventListener('change', () => { set(cb.checked); this.redrawMap(); this.buildSide(); });
      return h('label', { class: 'toggle' }, cb, label);
    };
    side.append(
      h('div', { class: 'panel-title' }, 'Overworld'),
      h('div', { class: 'prop' }, h('label', null, 'Karte'), select(MAP_NAMES.map((n, i) => [i, n] as [number, string]), this.map, (v) => { this.map = v; this.selectedTl = -1; this.redrawMap(); this.buildSide(); })),
      h('div', { class: 'tabs' },
        h('button', { class: this.mode === 'l1' ? 'active' : '', onclick: () => { this.mode = 'l1'; if (this.brush.kind !== 'l1') this.brush = { kind: 'l1', tile: 0x56 }; this.buildSide(); this.paint(); } }, 'Layer 1 (Wege/Level)'),
        h('button', { class: this.mode === 'l2' ? 'active' : '', onclick: () => { this.mode = 'l2'; if (this.brush.kind !== 'l2') this.brush = { kind: 'l2', w: 1, h: 1, entries: [0] }; this.buildSide(); this.paint(); } }, 'Layer 2 (Gelände)'),
      ),
      h('div', { class: 'row' }, tog('L1', () => this.showL1, (v) => (this.showL1 = v)), tog('L2', () => this.showL2, (v) => (this.showL2 = v)),
        tog('Events', () => this.showEvents, (v) => (this.showEvents = v)), tog('Raster', () => this.showGrid, (v) => (this.showGrid = v))),
      h('div', { class: 'row' },
        h('button', { class: 'primary', onclick: () => this.save() }, 'Overworld speichern'),
        h('button', { onclick: () => this.undoOnce(), title: 'Rückgängig (Strg+Z)' }, '↶'),
        h('button', { onclick: () => { this.invalidate(); this.redrawMap(); this.buildSide(); } }, 'Neu laden')),
      h('div', { class: 'hint' }, 'Linksklick/Ziehen: malen · Rechtsklick: Pipette · Alt+Klick (Layer 1): Level-Info. "Events" zeigt den Zustand nach allen Events (nur Ansicht).'),
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

  l1Palette(): HTMLElement {
    const r = this.render();
    const tc = new TileCache(r.vram, r.cgram, 0);
    const c = document.createElement('canvas');
    c.width = 256; c.height = 256;
    const ctx = c.getContext('2d')!;
    const id = ctx.createImageData(256, 256);
    const px = new Uint32Array(id.data.buffer);
    px.fill(0xff181818);
    for (let t = 0; t < 256; t++) this.drawL1Tile(px, tc, r, t, (t & 15) * 16, (t >> 4) * 16, 256, 256);
    ctx.putImageData(id, 0, 0);
    const b = this.brush;
    if (b.kind === 'l1') {
      ctx.strokeStyle = '#4cc2ff'; ctx.lineWidth = 2;
      ctx.strokeRect((b.tile & 15) * 16 + 1, (b.tile >> 4) * 16 + 1, 14, 14);
    }
    c.className = 'ow-pal';
    c.addEventListener('mousedown', (e) => {
      const rc = c.getBoundingClientRect();
      const x = Math.floor((e.clientX - rc.left) / (rc.width / 16)), y = Math.floor((e.clientY - rc.top) / (rc.height / 16));
      this.brush = { kind: 'l1', tile: y * 16 + x };
      this.buildSide();
    });
    return h('div', null, h('div', { class: 'hint' }, `Tile ${b.kind === 'l1' ? hex(b.tile, 2) : ''} · Level-Tiles: 56–80`), c);
  }

  l2Palette(): HTMLElement {
    const r = this.render();
    const tc = new TileCache(r.vram, r.cgram, 0);
    const c = document.createElement('canvas');
    c.width = 128; c.height = 512;
    const ctx = c.getContext('2d')!;
    const id = ctx.createImageData(128, 512);
    const px = new Uint32Array(id.data.buffer);
    px.fill(0xff181818);
    for (let t = 0; t < 1024; t++) blit8(px, 128, 512, tc.get(t | (this.l2Pal << 10)), (t & 15) * 8, (t >> 4) * 8);
    ctx.putImageData(id, 0, 0);
    c.className = 'ow-pal8';
    c.addEventListener('mousedown', (e) => {
      const rc = c.getBoundingClientRect();
      const x = Math.floor((e.clientX - rc.left) / (rc.width / 16)), y = Math.floor((e.clientY - rc.top) / (rc.height / 64));
      this.brush = { kind: 'l2', w: 1, h: 1, entries: [(y * 16 + x) | (this.l2Pal << 10)] };
      this.buildSide();
    });
    const b = this.brush;
    const brushInfo = b.kind === 'l2' ? `Pinsel ${b.w}×${b.h}: ${b.entries.map((v) => hex(v, 4)).join(' ')}` : '';
    const flip = (bit: number, label: string) => h('button', {
      onclick: () => { if (this.brush.kind === 'l2') { this.brush.entries = this.brush.entries.map((v) => v ^ bit); if (this.brush.w === 2 && bit === 0x4000) { const e = this.brush.entries; this.brush.entries = [e[1], e[0], e[3], e[2]]; } if (this.brush.h === 2 && bit === 0x8000) { const e = this.brush.entries; this.brush.entries = [e[2], e[3], e[0], e[1]]; } this.buildSide(); } },
    }, label);
    return h('div', null,
      h('div', { class: 'prop' }, h('label', null, 'Palette'), select(Array.from({ length: 8 }, (_, i) => [i, String(i)] as [number, string]), this.l2Pal, (v) => { this.l2Pal = v; this.buildSide(); })),
      h('div', { class: 'row' }, flip(0x4000, 'X-Flip'), flip(0x8000, 'Y-Flip'), flip(0x2000, 'Priorität')),
      h('div', { class: 'hint mono' }, brushInfo),
      h('div', { class: 'ow-pal-scroll' }, c));
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
