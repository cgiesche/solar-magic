// Overworld editor view.

import type { App } from './app.ts';
import { h, toast, select, attachPanZoom, zoomControl, ZOOM_MIN, ZOOM_MAX, attachRectPick, choose, emptyState } from './dom.ts';
import {
  OverworldEmulator, type OwRender, readL1, writeL1, readL2, writeL2, l1Index, l2Index, translevels, isLevelTile,
  translevelToLevel, nameCode, setNameCode, splitNameCode, joinNameCode, nameWord, NAME_PART_COUNTS, MAP_NAMES,
} from '../core/overworld.ts';
import { TileCache, blit8 } from '../core/render.ts';
import { hex } from '../core/names.ts';
import { menuButton } from './menu.ts';
import { RAM, map16Pointer } from '../core/ram.ts';
import type { Rom } from '../core/rom.ts';

// a w×h block of L1 tiles (16x16) or L2 tilemap entries (8x8), row-major
type Brush = { kind: 'l1' | 'l2'; w: number; h: number; entries: number[] };
type Drag =
  | { kind: 'paint'; x0: number; y0: number; lastX: number; lastY: number } // brush stamped on a grid from (x0, y0)
  | { kind: 'pick'; x0: number; y0: number; x1: number; y1: number }; // map cells taken into the brush

type Snapshot = { l1: Uint8Array; l2: Uint16Array; names: Map<number, number> };

// the 512x512 image of a map region (0 the main map, 1 the submaps): layer 2 (`l2`), then layer 1 (`l1`, null: the
// state after the events in `r`); undefined leaves a layer out
export function drawOwMap(rom: Rom, r: OwRender, region: number, l1: Uint8Array | null | undefined, l2: Uint16Array | undefined): Uint32Array {
  const W = 512;
  const img = new Uint32Array(W * W);
  const tc = new TileCache(r.vram, r.cgram, 0);
  if (l2) for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) blit8(img, W, W, tc.get(l2[l2Index(region, x, y)]), x * 8, y * 8);
  if (l1 !== undefined) {
    const src = l1 ?? r.wram.subarray(RAM.owLayer1, RAM.owLayer1End);
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) drawL1Tile(rom, img, tc, r, src[l1Index(region, x, y)], x * 16, y * 16);
  }
  return img;
}
export function putImage(canvas: HTMLCanvasElement, img: Uint32Array, W = 512): void {
  canvas.width = W; canvas.height = img.length / W;
  const ctx = canvas.getContext('2d')!;
  const id = ctx.createImageData(W, img.length / W);
  const px = new Uint32Array(id.data.buffer);
  for (let i = 0; i < px.length; i++) px[i] = img[i] || 0xff000000;
  ctx.putImageData(id, 0, 0);
}
function drawL1Tile(rom: Rom, img: Uint32Array, tc: TileCache, r: OwRender, t: number, px: number, py: number, W = 512, H = 512): void {
  const p = map16Pointer(r.wram, t);
  const w = [0, 1, 2, 3].map((q) => rom.r16(0x050000 | (p + q * 2)));
  blit8(img, W, H, tc.get(w[0]), px, py);
  blit8(img, W, H, tc.get(w[1]), px, py + 8);
  blit8(img, W, H, tc.get(w[2]), px + 8, py);
  blit8(img, W, H, tc.get(w[3]), px + 8, py + 8);
}

export class OverworldView {
  app: App;
  root: HTMLDivElement;
  side: HTMLDivElement;
  bar: HTMLDivElement;
  left: HTMLDivElement;
  canvas: HTMLCanvasElement;
  scroller: HTMLDivElement;
  sizer: HTMLDivElement;
  status: HTMLDivElement;
  private statusText = h('span', { class: 'status-text' });
  private statusStats = h('span', { class: 'status-stats' });
  private palPanel = h('div', { class: 'panel ow-pal-panel' });
  private props = h('div', { class: 'panel props' });
  private tlList = h('div', { class: 'level-list' });
  private tlCount = h('span', { class: 'hint' });
  private roBadge = h('div', { class: 'ow-badge' }, 'Layer 1: view only (state after all events)');
  emu: OverworldEmulator;
  map = 0;
  renders = new Map<string, OwRender>();
  l1: Uint8Array;
  l2: Uint16Array;
  // level name codes edited here, written to the ROM on save
  names = new Map<number, number>();
  dirty = false;
  mode: 'l1' | 'l2' = 'l1';
  showL1 = true;
  showL2 = true;
  showEvents = false;
  showGrid = false;
  zoom = 2;
  private zoomCtl = zoomControl(() => this.zoom, (z) => this.setZoom(z));
  brush: Brush = { kind: 'l1', w: 1, h: 1, entries: [0x56] };
  l2Pal = 0;
  hover: { x: number; y: number } | null = null;
  drag: Drag | null = null;
  selectedTl = -1;
  mapCanvas = document.createElement('canvas');
  undoStack: Snapshot[] = [];
  redoStack: Snapshot[] = [];
  private pending: Snapshot | null = null;
  private warnedTl = false;
  // set by the host: dirty/undo state changed, open a level in the level editor
  onChange: () => void = () => {};
  onOpenLevel: (n: number) => void = () => {};
  onNav: () => void = () => {};

  constructor(app: App) {
    this.app = app;
    this.emu = new OverworldEmulator(app.rom);
    this.l1 = readL1(app.rom);
    this.l2 = readL2(app.rom);
    this.canvas = h('canvas', { class: 'level-canvas' });
    this.sizer = h('div', { class: 'level-sizer' });
    this.scroller = h('div', { class: 'level-scroller', tabIndex: 0 }, this.canvas, this.sizer);
    this.status = h('div', { class: 'statusbar' }, this.statusText, this.statusStats);
    this.side = h('div', { class: 'ow-side' }, this.palPanel, this.props);
    this.bar = h('div', { class: 'ctxbar' });
    this.left = h('div', { class: 'left' }, h('div', { class: 'panel levels' },
      h('div', { class: 'panel-title' }, 'Level tiles', this.tlCount), this.tlList));
    this.root = h('div', { class: 'center' }, h('div', { class: 'level-view' }, this.scroller, this.roBadge), this.status);
    this.scroller.addEventListener('scroll', () => this.paint());
    new ResizeObserver(() => this.layout()).observe(this.scroller);
    this.scroller.addEventListener('contextmenu', (e) => e.preventDefault());
    this.scroller.addEventListener('mousedown', (e) => this.onDown(e));
    this.scroller.addEventListener('mouseleave', () => { if (!this.drag) { this.hover = null; this.updateStatus(); this.paint(); } });
    window.addEventListener('mousemove', (e) => this.onMove(e));
    window.addEventListener('mouseup', () => this.onUp());
    attachPanZoom(this.scroller, () => this.zoom, (z, ax, ay) => this.setZoom(z, ax, ay));
  }

  setZoom(z: number, ax = this.scroller.clientWidth / 2, ay = this.scroller.clientHeight / 2): void {
    z = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
    const lx = (this.scroller.scrollLeft + ax) / this.zoom, ly = (this.scroller.scrollTop + ay) / this.zoom;
    this.zoom = z;
    this.layout();
    this.scroller.scrollLeft = lx * z - ax;
    this.scroller.scrollTop = ly * z - ay;
    this.zoomCtl.update();
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
  }

  // ---------------- drawing ----------------
  redrawMap(): void {
    const img = drawOwMap(this.app.rom, this.render(), this.region, this.showL1 ? (this.showEvents ? null : this.l1) : undefined, this.showL2 ? this.l2 : undefined);
    putImage(this.mapCanvas, img);
    this.paint();
  }

  drawL1Tile(img: Uint32Array, tc: TileCache, r: OwRender, t: number, px: number, py: number, W = 512, H = 512): void {
    drawL1Tile(this.app.rom, img, tc, r, t, px, py, W, H);
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
      if (this.readOnly()) { toast('Layer 1 shows the state after all events and is view only here – turn off “After all events” in the View menu.'); return; }
      this.begin();
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
    else this.commit();
  }

  // the picked rectangle, clamped to the map (32x32 L1 tiles, 64x64 L2 tiles)
  pickRect(d: { x0: number; y0: number; x1: number; y1: number }): { x: number; y: number; w: number; h: number } {
    const n = this.mode === 'l1' ? 32 : 64;
    const cl = (v: number) => Math.max(0, Math.min(n - 1, v));
    const x0 = cl(Math.min(d.x0, d.x1)), x1 = cl(Math.max(d.x0, d.x1)), y0 = cl(Math.min(d.y0, d.y1)), y1 = cl(Math.max(d.y0, d.y1));
    return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }

  // ---------------- history (L1, L2, level names) ----------------
  private snapshot(): Snapshot {
    return { l1: this.l1.slice(), l2: this.l2.slice(), names: new Map(this.names) };
  }
  private restore(sn: Snapshot): void {
    this.l1 = sn.l1; this.l2 = sn.l2; this.names = sn.names;
  }
  // an edit starts: commit() records it when something changed
  begin(): void {
    this.pending = this.snapshot();
  }
  commit(): void {
    const p = this.pending;
    this.pending = null;
    if (!p) return;
    const same = p.l1.every((v, i) => v === this.l1[i]) && p.l2.every((v, i) => v === this.l2[i])
      && p.names.size === this.names.size && [...p.names].every(([k, v]) => this.names.get(k) === v);
    if (same) return;
    this.undoStack.push(p);
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
    this.dirty = true;
    this.onChange();
  }
  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }
  undo(): void { this.step(this.undoStack, this.redoStack); }
  redo(): void { this.step(this.redoStack, this.undoStack); }
  private step(from: Snapshot[], to: Snapshot[]): void {
    const sn = from.pop();
    if (!sn) return;
    to.push(this.snapshot());
    this.restore(sn);
    this.dirty = true;
    this.redrawMap();
    this.buildSide();
    this.buildLeft();
    this.onChange();
  }

  readOnly(): boolean {
    return this.showEvents && this.mode === 'l1';
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
        if (this.l1[i] === v) continue;
        if (!this.warnedTl && (isLevelTile(this.l1[i]) || isLevelTile(v))) {
          this.warnedTl = true;
          toast('Note: level tiles (56–80) get their translevel number in scan order – adding or removing level tiles shifts the numbers of all following ones.');
        }
        this.l1[i] = v; changed = true;
      } else {
        const i = l2Index(this.region, xx, yy);
        if (this.l2[i] !== v) { this.l2[i] = v; changed = true; }
      }
    }
    if (!changed) return;
    this.redrawMap();
    if (this.mode === 'l1') this.buildLeft();
  }

  pick(r: { x: number; y: number; w: number; h: number }): void {
    const src = this.mode === 'l2' ? this.l2 : this.showEvents ? this.render().wram.subarray(RAM.owLayer1, RAM.owLayer1End) : this.l1;
    const idx = this.mode === 'l2' ? l2Index : l1Index;
    const entries = Array.from({ length: r.w * r.h }, (_, i) => src[idx(this.region, r.x + (i % r.w), r.y + Math.floor(i / r.w))]);
    this.brush = { kind: this.mode, w: r.w, h: r.h, entries };
    this.buildSide();
    this.paint();
  }

  info(x: number, y: number): void {
    if (this.mode !== 'l1') { toast('Level info is available on layer 1 (paths/levels)'); return; }
    const tl = translevels(this.l1)[l1Index(this.region, x, y)];
    if (!tl) toast('Not a level tile');
    this.selectTl(tl || -1, false);
  }

  // selects a translevel (list, Alt/Ctrl+click); center: scroll the map to its tile
  selectTl(tl: number, center: boolean): void {
    this.selectedTl = tl;
    if (center && tl > 0) {
      const t = translevels(this.l1);
      for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
        if (t[l1Index(this.region, x, y)] !== tl) continue;
        this.scroller.scrollLeft = (x * 16 + 8) * this.zoom - this.scroller.clientWidth / 2;
        this.scroller.scrollTop = (y * 16 + 8) * this.zoom - this.scroller.clientHeight / 2;
      }
    }
    this.buildProps();
    this.buildLeft();
    this.paint();
  }

  nameCodeOf(tl: number): number {
    return this.names.get(tl) ?? nameCode(this.app.rom, tl);
  }
  nameOf(tl: number): string {
    const [a, b, c] = splitNameCode(this.nameCodeOf(tl));
    const rom = this.app.rom;
    return (nameWord(rom, 0, a) + nameWord(rom, 1, b) + nameWord(rom, 2, c)).replace(/\s+/g, ' ').trim();
  }

  updateStatus(): void {
    const c = this.hover;
    const b = this.brush;
    this.statusStats.textContent = b.kind === this.mode ? `Brush ${b.w}×${b.h}` : '';
    if (!c) {
      this.statusText.textContent = this.readOnly() ? 'Layer 1 view only – turn off “After all events” to edit'
        : 'Click/drag picks up tiles · Right click/Shift+click paints · Alt/Ctrl+click: level info';
      return;
    }
    let t = `X ${hex(c.x, 2)}  Y ${hex(c.y, 2)}`;
    if (this.mode === 'l1') {
      if (c.x >= 0 && c.y >= 0 && c.x < 32 && c.y < 32) {
        const i = l1Index(this.region, c.x, c.y);
        t += `  ·  Tile ${hex(this.l1[i], 2)}`;
        const tl = translevels(this.l1)[i];
        if (tl) t += `  ·  Translevel ${hex(tl, 2)} → Level ${hex(translevelToLevel(tl), 3)} “${this.nameOf(tl)}”`;
      }
    } else if (c.x >= 0 && c.y >= 0 && c.x < 64 && c.y < 64) t += `  ·  Entry ${hex(this.l2[l2Index(this.region, c.x, c.y)], 4)}`;
    this.statusText.textContent = t;
  }

  setMap(n: number): void {
    if (n === this.map) return;
    this.map = n;
    this.selectedTl = -1;
    this.redrawMap();
    this.buildBar();
    this.buildSide();
    this.buildLeft();
    this.onNav();
  }

  // ---------------- context bar (map, layer, view, zoom) ----------------
  buildBar(): void {
    const setMode = (m: 'l1' | 'l2') => {
      if (this.mode === m) return;
      this.mode = m;
      if (this.brush.kind !== m) this.brush = { kind: m, w: 1, h: 1, entries: [m === 'l1' ? 0x56 : 0] };
      this.buildBar();
      this.buildSide();
      this.updateStatus();
      this.paint();
    };
    const view = (label: string, get: () => boolean, set: (v: boolean) => void, title?: string, shortcut?: string) =>
      ({ label, title, shortcut, checked: get, onToggle: (v: boolean) => { set(v); this.redrawMap(); this.updateStatus(); } });
    this.zoomCtl.update();
    this.bar.replaceChildren(
      h('label', { class: 'row' }, 'Map ', select(MAP_NAMES.map((n, i) => [i, n] as [number, string]), this.map, (v) => this.setMap(v))),
      h('span', { class: 'sep' }),
      h('div', { class: 'btn-group' },
        h('button', { class: this.mode === 'l1' ? 'active' : '', title: 'Layer 1 (1)', onclick: () => setMode('l1') }, 'Layer 1 (paths/levels)'),
        h('button', { class: this.mode === 'l2' ? 'active' : '', title: 'Layer 2 (2)', onclick: () => setMode('l2') }, 'Layer 2 (terrain)')),
      h('span', { class: 'sep' }),
      menuButton({ label: 'View', items: [
        { heading: 'Layers' },
        view('Layer 1', () => this.showL1, (v) => (this.showL1 = v)),
        view('Layer 2', () => this.showL2, (v) => (this.showL2 = v)),
        { heading: 'Guides' },
        view('Grid', () => this.showGrid, (v) => (this.showGrid = v), undefined, 'G'),
        { heading: 'Game state' },
        view('After all events', () => this.showEvents, (v) => (this.showEvents = v), 'State after all events (view only, layer 1 then not editable)'),
      ] }),
      h('span', { class: 'sep' }),
      this.zoomCtl.root,
      h('span', { class: 'spacer' }),
      h('button', { onclick: () => void this.reload(), title: 'Reload the overworld from the ROM (discards unsaved changes)' }, 'Reload'),
    );
  }

  // keys while the overworld is shown; false: not handled
  key(e: KeyboardEvent): boolean {
    const k = e.key.toLowerCase(), ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && k === 'z') { if (e.shiftKey) this.redo(); else this.undo(); return true; }
    if (ctrl && k === 'y') { this.redo(); return true; }
    if (ctrl && k === 's') { this.save(); return true; }
    if (ctrl || e.altKey) return false;
    if (k === 'g') { this.showGrid = !this.showGrid; this.paint(); return true; }
    if (k === '1' || k === '2') { (this.bar.querySelectorAll('.btn-group button')[k === '1' ? 0 : 1] as HTMLButtonElement).click(); return true; }
    return false;
  }

  // ---------------- left: level tiles of the map ----------------
  buildLeft(): void {
    const t = translevels(this.l1);
    const seen = new Set<number>();
    const items: HTMLElement[] = [];
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
      const tl = t[l1Index(this.region, x, y)];
      if (!tl || seen.has(tl)) continue;
      seen.add(tl);
      const lvl = translevelToLevel(tl), name = this.nameOf(tl);
      const cur = tl === this.selectedTl;
      const el = h('div', { class: `level-item${cur ? ' current' : ''}`, title: `${name}\nClick: select · Double click: open in the level editor`,
        onclick: () => this.selectTl(tl, true), ondblclick: () => this.onOpenLevel(lvl) },
        hex(lvl, 3), h('span', { class: 'lname' }, ` ${name}`));
      items.push(el);
      if (cur) setTimeout(() => el.scrollIntoView({ block: 'nearest' }), 0);
    }
    this.tlCount.textContent = String(items.length);
    this.tlList.replaceChildren(...(items.length ? items : [emptyState('This map has no level tiles (56–80).')]));
  }

  // ---------------- right: palette, properties ----------------
  buildSide(): void {
    const scroll = this.palPanel.scrollTop;
    this.palPanel.replaceChildren(
      h('div', { class: 'panel-title' }, 'Paint', h('span', { class: 'hint' }, 'Right click/Shift+click paints')),
      this.mode === 'l1' ? this.l1Palette() : this.l2Palette());
    this.palPanel.scrollTop = scroll;
    this.roBadge.classList.toggle('show', this.readOnly());
    this.scroller.classList.toggle('readonly', this.readOnly());
    this.buildProps();
  }

  buildProps(): void {
    const tl = this.selectedTl;
    this.props.replaceChildren(h('div', { class: 'panel-title' }, 'Properties'),
      tl > 0 ? this.levelInfo(tl) : emptyState('Select a level tile in the list on the left or with Alt/Ctrl+click on the map.'));
  }

  levelInfo(tl: number): HTMLElement {
    const rom = this.app.rom;
    const parts = splitNameCode(this.nameCodeOf(tl));
    const sel = (k: number) => select(Array.from({ length: NAME_PART_COUNTS[k] }, (_, i) => [i, `${hex(i, 2)}: ${nameWord(rom, k, i).trim() || '(empty)'}`] as [number, string]), parts[k], (v) => {
      parts[k] = v;
      this.begin();
      this.names.set(tl, joinNameCode(parts));
      this.commit();
      this.buildProps();
      this.buildLeft();
    });
    const lvl = translevelToLevel(tl);
    return h('div', { class: 'ow-info' },
      h('div', { class: 'prop-title' }, `Translevel ${hex(tl, 2)} → Level ${hex(lvl, 3)}`),
      h('div', null, `“${this.nameOf(tl)}”`),
      h('div', { class: 'prop' }, h('label', null, 'Name part 1'), sel(0)),
      h('div', { class: 'prop' }, h('label', null, 'Name part 2'), sel(1)),
      h('div', { class: 'prop' }, h('label', null, 'Name part 3'), sel(2)),
      h('div', { class: 'row' }, h('button', { onclick: () => this.onOpenLevel(lvl), title: 'Open in the level editor (also by double click in the list)' }, `Edit level ${hex(lvl, 3)}`)),
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
      out.append(h('div', { class: 'hint' }, `Brush ${b.w}×${b.h}:`), h('div', { class: 'row' }, p));
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
      h('div', { class: 'hint' }, `${one ? `Tile ${hex(b.entries[0], 2)}` : b.kind === 'l1' ? `Block ${b.w}×${b.h}` : ''} · Level tiles: 56–80`),
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
    const brushInfo = b.kind === 'l2' ? `Brush ${b.w}×${b.h}: ${b.entries.slice(0, 16).map((v) => hex(v, 4)).join(' ')}${b.entries.length > 16 ? ' …' : ''}` : '';
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
      h('div', { class: 'row' }, flip(0x4000, 'X-Flip'), flip(0x8000, 'Y-Flip'), flip(0x2000, 'Priority')),
      h('div', { class: 'hint mono' }, brushInfo),
      pal);
  }

  save(): void {
    const rom = this.app.rom;
    try {
      // not a ROM undo step: the overworld editor has its own undo
      const n = this.app.romEdit('Overworld saved', () => {
        const n = writeL2(rom, this.l2);
        writeL1(rom, this.l1);
        for (const [tl, code] of this.names) setNameCode(rom, tl, code);
        return n;
      }, { record: false });
      this.names.clear();
      this.dirty = false;
      this.invalidate();
      this.redrawMap();
      this.onChange();
      toast(`Overworld saved (layer 2: ${n} bytes RLE).`);
    } catch (e) {
      toast(`Overworld not saved: ${e instanceof Error ? e.message : e}`, 'error');
    }
  }

  // drops unsaved changes (they are re-read from the ROM)
  discard(): void {
    this.l1 = readL1(this.app.rom);
    this.l2 = readL2(this.app.rom);
    this.names.clear();
    this.undoStack = [];
    this.redoStack = [];
    this.dirty = false;
    this.onChange();
  }

  async reload(): Promise<void> {
    if (this.dirty && (await choose('Reload overworld', 'Discard unsaved changes to the overworld?', [{ label: 'Cancel' }, { label: 'Discard', danger: true }])) !== 1) return;
    this.show();
    toast('Overworld reloaded');
  }

  // leaving: save, discard or stay; false = stay
  async confirmLeave(): Promise<boolean> {
    if (!this.dirty) return true;
    const r = await choose('Leave overworld', 'The overworld has unsaved changes.', [{ label: 'Cancel' }, { label: 'Discard' }, { label: 'Save', primary: true }]);
    if (r === 2) { this.save(); return !this.dirty; }
    if (r === 1) { this.discard(); return true; }
    return false;
  }

  show(): void {
    this.emu.rom = this.app.rom;
    this.discard();
    this.invalidate();
    if (this.selectedTl > 0 && !translevels(this.l1).includes(this.selectedTl)) this.selectedTl = -1;
    this.buildBar();
    this.buildSide();
    this.buildLeft();
    this.redrawMap();
    this.layout();
    this.updateStatus();
  }
}

export { isLevelTile };
