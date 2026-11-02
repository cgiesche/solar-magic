// The Game workspace: what belongs to the whole game rather than a level or the overworld. So far the title
// screen's layer 3 tilemap (titlescreen.ts): its picture as the game draws it, painted with layer 3's 8x8 tiles;
// a stroke is one ROM edit when the mouse is released.

import type { App } from './app.ts';
import { h, toast } from './dom.ts';
import { LevelEmulator } from '../core/levelemu.ts';
import { TileCache } from '../core/render.ts';
import { TITLE_COLS, TITLE_ROWS, TITLE_SHOWN_ROWS, titleTilemap, titlePicture, writeTitleScreen, type TitlePicture } from '../core/titlescreen.ts';
import { layer3WordText } from '../core/layer3map.ts';
import { layer3Picker } from './l3picker.ts';
import { fillPixels, hidePickerPreview } from './pickerview.ts';
import type { Brush } from './app.ts';

export type GameTab = 'title';
const GAP = 4; // pixels between the screen and the row below it
const W = 256, H = TITLE_SHOWN_ROWS * 8 + GAP + 8;

export class GameView {
  root: HTMLDivElement;
  side: HTMLDivElement;
  bar: HTMLDivElement;
  left: HTMLDivElement;
  tab: GameTab = 'title';
  private app: App;
  private emu: LevelEmulator | null = null;
  private saved: Uint16Array | null = null; // the tilemap as in the ROM
  private map: Uint16Array | null = null; // with the stroke being painted
  private pic: TitlePicture | null = null;
  private canvas = h('canvas', { class: 'game-canvas', width: W, height: H });
  private status = h('span', { class: 'status-text' });
  private pickPanel = h('div', { class: 'panel game-pick' });
  private pickPixels = 0; // the screen pixels per pixel the tile sheet is drawn at (0: none shown)
  private error = ''; // why there is no title screen to edit
  private frame = 0; // a picture to draw at the next animation frame (painting)
  private zoom = 3;
  private brush: Brush = { w: 1, h: 1, tiles: [0x38fc] };
  private hover: { x: number; y: number } | null = null;
  private drag: { kind: 'paint' | 'pick'; x0: number; y0: number; x1: number; y1: number } | null = null;

  constructor(app: App) {
    this.app = app;
    this.bar = h('div', { class: 'ctxbar' }, h('span', { class: 'level-title' }, 'Title screen'),
      h('span', { class: 'sep' }),
      h('button', { title: 'Zoom out', onclick: () => this.setZoom(this.zoom - 1) }, '−'),
      h('button', { title: 'Zoom in', onclick: () => this.setZoom(this.zoom + 1) }, '+'));
    this.left = h('div', { class: 'left' }, h('div', { class: 'panel levels' }, h('div', { class: 'panel-title' }, 'Game'),
      h('div', { class: 'level-list' }, h('div', { class: 'level-item active', title: 'The title screen\'s layer 3: the logo, the frame and the copyright line' }, 'Title screen'))));
    const scroller = h('div', { class: 'level-scroller game-scroller' }, this.canvas);
    this.root = h('div', { class: 'center' }, h('div', { class: 'level-view' }, scroller), h('div', { class: 'statusbar' }, this.status));
    this.side = h('div', { class: 'ow-side' }, this.pickPanel);
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    this.canvas.addEventListener('mousedown', (e) => this.onDown(e));
    this.canvas.addEventListener('mousemove', (e) => this.onMove(e));
    this.canvas.addEventListener('mouseleave', () => { this.hover = null; this.paint(); });
    window.addEventListener('mouseup', () => this.onUp());
    // a ROM edit, undo or redo: shown as in the ROM (a stroke being painted is dropped)
    app.on('rom-change', () => { if (this.root.isConnected) { this.drag = null; this.sync(); } });
    // the sheet follows the panel's width, drawn anew when it needs other screen pixels per pixel
    new ResizeObserver(() => requestAnimationFrame(() => { if (this.pickPixels && fillPixels(this.pickPanel.clientWidth, 128) !== this.pickPixels) this.buildPicker(); })).observe(this.pickPanel);
    this.setZoom(this.zoom);
  }

  // shown: the title screen as in the ROM
  show(): void {
    this.sync();
  }

  private sync(): void {
    if (!this.emu || this.emu.rom !== this.app.rom) { this.emu = new LevelEmulator(this.app.rom); this.emu.adoptBoot(this.app.emu); }
    try {
      this.saved = titleTilemap(this.emu);
      this.map = this.saved.slice();
      this.pic = titlePicture(this.emu, this.map);
      this.error = '';
    } catch (e) {
      this.saved = this.map = this.pic = null;
      this.error = `The game does not reach its title screen: ${e instanceof Error ? e.message : e}`;
    }
    this.paint();
    this.updateStatus();
    this.buildPicker();
  }

  private setZoom(z: number): void {
    this.zoom = Math.max(1, Math.min(6, z));
    this.canvas.style.width = `${W * this.zoom}px`;
    this.canvas.style.height = `${H * this.zoom}px`;
  }

  // the picture as the game draws it with the tilemap as painted (once per animation frame while painting)
  private redraw(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      if (!this.emu || !this.map) return;
      try { this.pic = titlePicture(this.emu, this.map); } catch (e) { toast(String(e instanceof Error ? e.message : e), 'error'); }
      this.paint();
    });
  }

  private paint(): void {
    const ctx = this.canvas.getContext('2d')!;
    ctx.fillStyle = '#1b1d22';
    ctx.fillRect(0, 0, W, H);
    const p = this.pic, map = this.map;
    if (!p || !map) return;
    const img = ctx.createImageData(W, H), px = new Uint32Array(img.data.buffer);
    px.fill(0xff22201b);
    px.set(p.frame, 0);
    const tc = new TileCache(p.vram, p.cgram, p.charBase), y0 = TITLE_SHOWN_ROWS * 8 + GAP;
    for (let x = 0; x < TITLE_COLS; x++) {
      const t = tc.get(map[(TITLE_ROWS - 1) * TITLE_COLS + x], 2);
      for (let k = 0; k < 64; k++) if (t[k]) px[(y0 + (k >> 3)) * W + x * 8 + (k & 7)] = t[k];
    }
    ctx.putImageData(img, 0, 0);
    const r = this.drag?.kind === 'pick' ? this.rect(this.drag) : this.hover ? { x: this.hover.x, y: this.hover.y, w: this.brush.w, h: this.brush.h } : null;
    if (r) {
      ctx.strokeStyle = this.drag?.kind === 'pick' ? '#4cc2ff' : 'rgba(255,255,0,0.9)';
      ctx.lineWidth = 1;
      for (let dy = 0; dy < r.h; dy++) for (let dx = 0; dx < r.w; dx++) {
        const c = this.cellY(r.y + dy);
        if (c >= 0 && r.x + dx < TITLE_COLS) ctx.strokeRect((r.x + dx) * 8 + 0.5, c + 0.5, 7, 7);
      }
    }
  }

  // the canvas's pixel y of a tilemap row (-1: none)
  private cellY(row: number): number {
    return row < TITLE_SHOWN_ROWS ? row * 8 : row === TITLE_ROWS - 1 ? TITLE_SHOWN_ROWS * 8 + GAP : -1;
  }

  private cellAt(e: MouseEvent): { x: number; y: number } | null {
    const rc = this.canvas.getBoundingClientRect();
    const px = (e.clientX - rc.left) / this.zoom, py = (e.clientY - rc.top) / this.zoom;
    const x = Math.floor(px / 8);
    if (x < 0 || x >= TITLE_COLS || py < 0) return null;
    if (py < TITLE_SHOWN_ROWS * 8) return { x, y: Math.floor(py / 8) };
    const below = TITLE_SHOWN_ROWS * 8 + GAP;
    return py >= below && py < below + 8 ? { x, y: TITLE_ROWS - 1 } : null;
  }

  private rect(d: { x0: number; y0: number; x1: number; y1: number }) {
    return { x: Math.min(d.x0, d.x1), y: Math.min(d.y0, d.y1), w: Math.abs(d.x1 - d.x0) + 1, h: Math.abs(d.y1 - d.y0) + 1 };
  }

  private stamp(cx: number, cy: number): boolean {
    const b = this.brush, map = this.map!;
    let changed = false;
    b.tiles.forEach((w, k) => {
      const x = cx + (k % b.w), y = cy + Math.floor(k / b.w);
      if (x >= TITLE_COLS || y >= TITLE_ROWS || map[y * TITLE_COLS + x] === w) return;
      map[y * TITLE_COLS + x] = w;
      changed = true;
    });
    return changed;
  }

  // left: paint the brush (a stroke), right: take tiles of the screen as the brush
  private onDown(e: MouseEvent): void {
    const c = this.cellAt(e);
    if (!c || !this.map) return;
    e.preventDefault();
    if (e.button === 2) { this.drag = { kind: 'pick', x0: c.x, y0: c.y, x1: c.x, y1: c.y }; this.paint(); return; }
    if (e.button !== 0) return;
    this.drag = { kind: 'paint', x0: c.x, y0: c.y, x1: c.x, y1: c.y };
    if (this.stamp(c.x, c.y)) this.redraw();
  }

  private onMove(e: MouseEvent): void {
    const c = this.cellAt(e);
    this.hover = c;
    if (c && this.drag && (c.x !== this.drag.x1 || c.y !== this.drag.y1)) {
      this.drag.x1 = c.x; this.drag.y1 = c.y;
      if (this.drag.kind === 'paint' && this.stamp(c.x, c.y)) this.redraw();
    }
    this.paint();
    this.updateStatus();
  }

  private onUp(): void {
    const d = this.drag, map = this.map;
    if (!d || !map) return;
    this.drag = null;
    if (d.kind === 'pick') {
      const r = this.rect(d);
      this.brush = { w: r.w, h: r.h, tiles: Array.from({ length: r.w * r.h }, (_, k) => map[(r.y + Math.floor(k / r.w)) * TITLE_COLS + r.x + (k % r.w)]) };
      this.buildPicker();
      this.paint();
      return;
    }
    if (!this.saved || map.every((w, i) => w === this.saved![i])) return;
    try {
      this.app.romEdit('Title screen painted', () => writeTitleScreen(this.app.rom, map.slice()));
    } catch (e) {
      toast(String(e instanceof Error ? e.message : e), 'error');
      this.sync();
    }
  }

  private updateStatus(): void {
    const c = this.hover;
    if (!c || !this.map) { this.status.textContent = this.error; return; }
    const w = this.map[c.y * TITLE_COLS + c.x];
    this.status.textContent = `Column ${c.x}, row ${c.y}${c.y === TITLE_ROWS - 1 ? ' (below the screen)' : ''}: tile ${layer3WordText(w)} – click: paint, right drag: take tiles as the brush`;
  }

  // layer 3's 8x8 tiles as the brush (l3picker.ts), as on the title screen
  private buildPicker(): void {
    const p = this.pic;
    hidePickerPreview(this.pickPanel);
    this.pickPanel.replaceChildren(h('div', { class: 'panel-title' }, 'Layer 3 tiles'));
    this.pickPixels = 0;
    if (!p) return;
    const w = this.pickPanel.clientWidth;
    layer3Picker(this.pickPanel, p, this.brush, (nb) => { this.brush = nb; this.buildPicker(); }, {
      pixels: this.pickPixels = fillPixels(w, 128), shown: w / 128, from: 'the screen',
      hint: 'click or drag on the title screen to paint, right drag there takes its tiles. The graphics are layer 3\'s as the title screen\'s level has them; the row under the screen is written too (as Lunar Magic does), the game\'s scroll does not show it.',
    });
  }
}
