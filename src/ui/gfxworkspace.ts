// Graphics workspace: palettes, Map16 and GFX files as linked tabs next to a live preview of the level.
// Not a modal: the level list stays usable, edits show up in the preview right away and undo works.

import type { App } from './app.ts';
import { h } from './dom.ts';
import { hex } from '../core/names.ts';
import { PaletteTab } from './gfx/palettetab.ts';
import { Map16Tab } from './gfx/map16tab.ts';
import { GfxTab } from './gfx/gfxtab.ts';
import { AnimTab } from './gfx/animtab.ts';

export type WsTab = 'pal' | 'map16' | 'gfx' | 'anim';

export interface WsPanel {
  root: HTMLElement;
  show(): void; // became visible (redraw from the current state)
  hide?(): void;
  key?(e: KeyboardEvent): boolean; // true: handled
  // click into the level preview (pixel position in the level image)
  previewClick?(px: number, py: number, e: MouseEvent): void;
  previewHint?(): string;
}

// the current level image, scaled; marks every place of the highlighted Map16 tiles
export class LevelPreview {
  root: HTMLElement;
  private img = h('canvas', { class: 'ws-prev-img' });
  private over = h('canvas', { class: 'ws-prev-over' });
  private box: HTMLElement;
  private scroller: HTMLElement;
  private info = h('div', { class: 'ws-prev-info hint' });
  zoom = 1;
  highlight = new Set<number>();
  onClick: ((px: number, py: number, e: MouseEvent) => void) | null = null;
  hint = '';
  private app: App;

  constructor(app: App) {
    this.app = app;
    this.box = h('div', { class: 'ws-prev-box' }, this.img, this.over);
    this.scroller = h('div', { class: 'ws-prev-scroll' }, this.box);
    const zoomBtn = (z: number) => h('button', { class: this.zoom === z ? 'active' : '', onclick: (e: MouseEvent) => {
      this.zoom = z;
      for (const b of (e.currentTarget as HTMLElement).parentElement!.children) b.classList.toggle('active', b === e.currentTarget);
      this.layout();
    } }, `${z}×`);
    const anim = h('input', { type: 'checkbox', checked: app.show.anim });
    anim.addEventListener('change', () => { app.show.anim = anim.checked; app.refresh(); app.emit('show-anim'); });
    app.on('show-anim', () => (anim.checked = app.show.anim));
    this.root = h('div', { class: 'ws-prev' },
      h('div', { class: 'panel-title' }, 'Level-Vorschau',
        h('label', { class: 'toggle', title: 'Animationen abspielen (wie im Spiel, auch eigene)' }, anim, 'Animation'),
        h('span', { class: 'btn-group' }, zoomBtn(1), zoomBtn(2))),
      this.scroller, this.info);
    this.scroller.addEventListener('mousemove', (e) => {
      const p = this.pos(e);
      if (!p) { this.info.textContent = this.hint; return; }
      const t = this.tileAt(p.px, p.py);
      this.info.textContent = `X ${hex(p.px >> 4, 2)} Y ${hex(p.py >> 4, 2)}${t >= 0 ? ` · Map16 ${hex(t, 3)}` : ''}${this.hint ? ` — ${this.hint}` : ''}`;
    });
    this.scroller.addEventListener('mouseleave', () => (this.info.textContent = this.hint));
    this.scroller.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      const p = this.pos(e);
      if (p) { e.preventDefault(); this.onClick?.(p.px, p.py, e); }
    });
    app.on('render', () => this.update());
    app.on('anim-frame', () => this.update());
  }

  private pos(e: MouseEvent): { px: number; py: number } | null {
    const im = this.app.images;
    if (!im) return null;
    const rc = this.img.getBoundingClientRect();
    const px = Math.floor((e.clientX - rc.left) / this.zoom), py = Math.floor((e.clientY - rc.top) / this.zoom);
    return px >= 0 && py >= 0 && px < im.width && py < im.height ? { px, py } : null;
  }

  tileAt(px: number, py: number): number {
    const im = this.app.images, g = im.geom1;
    const tx = px >> 4, ty = py >> 4;
    if (tx >= g.width || ty >= g.height) return -1;
    return im.tiles1[ty * g.width + tx];
  }

  setHint(s: string): void {
    this.hint = s;
    this.info.textContent = s;
  }

  update(): void {
    const im = this.app.images;
    if (!im || !this.root.isConnected) return;
    if (this.img.width !== im.width || this.img.height !== im.height) {
      this.img.width = this.over.width = im.width;
      this.img.height = this.over.height = im.height;
      this.layout();
    }
    const ci = this.app.compositeImg;
    const id = new ImageData(new Uint8ClampedArray(ci.buffer as ArrayBuffer, ci.byteOffset, im.width * im.height * 4), im.width, im.height);
    this.img.getContext('2d')!.putImageData(id, 0, 0);
    this.drawHighlight();
  }

  private layout(): void {
    const w = this.img.width * this.zoom, hh = this.img.height * this.zoom;
    for (const c of [this.img, this.over]) { c.style.width = `${w}px`; c.style.height = `${hh}px`; }
    this.box.style.width = `${w}px`;
    this.box.style.height = `${hh}px`;
  }

  drawHighlight(): void {
    const ctx = this.over.getContext('2d')!;
    ctx.clearRect(0, 0, this.over.width, this.over.height);
    const im = this.app.images;
    if (!im || !this.highlight.size) return;
    const g = im.geom1;
    ctx.strokeStyle = '#ffb000';
    ctx.lineWidth = 1;
    ctx.fillStyle = 'rgba(255,176,0,0.4)';
    for (let y = 0; y < g.height; y++) for (let x = 0; x < g.width; x++) {
      if (!this.highlight.has(im.tiles1[y * g.width + x])) continue;
      ctx.fillRect(x * 16, y * 16, 16, 16);
      ctx.strokeRect(x * 16 + 0.5, y * 16 + 0.5, 15, 15);
    }
  }

  // number of places of the tile in layer 1
  count(tile: number): number {
    const im = this.app.images;
    if (!im) return 0;
    let n = 0;
    for (const t of im.tiles1) if (t === tile) n++;
    return n;
  }

  scrollTo(tx: number, ty: number): void {
    requestAnimationFrame(() => {
      this.scroller.scrollLeft = tx * 16 * this.zoom - this.scroller.clientWidth / 2;
      this.scroller.scrollTop = ty * 16 * this.zoom - this.scroller.clientHeight / 2;
    });
  }
}

export class GfxWorkspace {
  root: HTMLElement;
  side: HTMLElement;
  preview: LevelPreview;
  tab: WsTab = 'map16';
  pal: PaletteTab;
  map16: Map16Tab;
  gfx: GfxTab;
  anim: AnimTab;
  private body = h('div', { class: 'ws-body' });
  private tabBar: HTMLElement;
  active = false;
  private app: App;

  constructor(app: App) {
    this.app = app;
    this.preview = new LevelPreview(app);
    this.pal = new PaletteTab(app, this);
    this.map16 = new Map16Tab(app, this);
    this.gfx = new GfxTab(app, this);
    this.anim = new AnimTab(app, this);
    const tabBtn = (t: WsTab, label: string, key: string) => h('button', { 'data-tab': t, title: `${label} (${key})`, onclick: () => this.open(t) }, label);
    this.tabBar = h('div', { class: 'ws-tabs' },
      tabBtn('pal', 'Paletten', 'P'), tabBtn('map16', 'Map16-Tiles', 'M'), tabBtn('gfx', 'Grafiken', 'G'), tabBtn('anim', 'Animationen', 'A'),
      h('span', { class: 'spacer' }),
      h('span', { class: 'hint' }, 'Änderungen wirken sofort · Strg+Z / Strg+Y'));
    this.root = h('div', { class: 'ws' }, this.tabBar, this.body);
    this.side = h('div', { class: 'right ws-side' }, this.preview.root);
    this.preview.onClick = (px, py, e) => this.panel().previewClick?.(px, py, e);
  }

  panel(t = this.tab): WsPanel {
    return t === 'pal' ? this.pal : t === 'map16' ? this.map16 : t === 'gfx' ? this.gfx : this.anim;
  }

  open(t: WsTab): void {
    if (this.active && this.tab !== t) this.panel().hide?.();
    this.tab = t;
    for (const b of this.tabBar.querySelectorAll('button')) b.classList.toggle('active', (b as HTMLElement).dataset.tab === t);
    this.body.replaceChildren(this.panel().root);
    this.preview.highlight.clear();
    this.preview.setHint(this.panel().previewHint?.() ?? '');
    this.panel().show();
    this.preview.update();
  }

  // entering the workspace (level image position to center the preview on)
  enter(t: WsTab, at?: { tx: number; ty: number }): void {
    this.active = true;
    this.app.flushRomChange();
    this.open(t);
    if (at) this.preview.scrollTo(at.tx, at.ty);
  }

  leave(): void {
    this.panel().hide?.();
    this.active = false;
  }

  showPalette(row: number, col = 1): void {
    this.open('pal');
    this.pal.select(row * 16 + col);
  }

  showMap16(tile: number, bg = false): void {
    this.open('map16');
    this.map16.select(tile, bg);
  }

  showGfx(file: number, tile?: number, palRow?: number): void {
    this.open('gfx');
    this.gfx.select(file, tile, palRow);
  }

  key(e: KeyboardEvent): boolean {
    const ctrl = e.ctrlKey || e.metaKey;
    if (this.panel().key?.(e)) return true;
    if (!ctrl && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === 'p') { this.open('pal'); return true; }
      if (k === 'm') { this.open('map16'); return true; }
      if (k === 'g') { this.open('gfx'); return true; }
      if (k === 'a') { this.open('anim'); return true; }
    }
    return false;
  }
}
