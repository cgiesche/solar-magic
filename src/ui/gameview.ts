// The Game workspace: the game's screens that belong to no level – the title screen's layer 3 tilemap
// (titlescreen.ts: its picture as the game draws it) and the overworld's borders (owborder.ts: each map's layer 3
// fixed on the screen) – painted with layer 3's 8x8 tiles as every brush editor paints (brushsurface.ts, ADR 0011); a
// stroke is one ROM edit when the mouse is released.

import type { App } from './app.ts';
import { h, toast, attachPanZoom } from './dom.ts';
import { LevelEmulator } from '../core/levelemu.ts';
import { TileCache } from '../core/render.ts';
import { TITLE_COLS, TITLE_ROWS, TITLE_SHOWN_ROWS, titleTilemap, titlePicture, writeTitleScreen, type TitlePicture } from '../core/titlescreen.ts';
import { layer3WordText } from '../core/layer3map.ts';
import { layer3Picker } from './l3picker.ts';
import { fillPixels, hidePickerPreview } from './pickerview.ts';
import type { Brush } from './app.ts';
import { BorderView } from './owborder.ts';
import { MAP_NAMES } from '../core/overworld.ts';
import { BrushSurface, PAINT_HINT, PAINT_TITLE } from './brushsurface.ts';
import { uiToken } from './marks.ts';

// the title screen, or the border of an overworld map (0 the main map, 1–6 the submaps)
export type GameTab = 'title' | 'border';
const GAP = 4; // pixels between the screen and the row below it
const SCROLLER_PAD = 16; // .game-scroller's padding (style.css)
const W = 256, H = TITLE_SHOWN_ROWS * 8 + GAP + 8;

export class GameView {
  root: HTMLDivElement;
  side: HTMLDivElement;
  bar: HTMLDivElement;
  left: HTMLDivElement;
  tab: GameTab = 'title';
  private app: App;
  private border: BorderView;
  private title = h('span', { class: 'level-title' }, 'Title screen');
  private list = h('div', { class: 'level-list' });
  private scroller: HTMLDivElement;
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
  private surface: BrushSurface;

  constructor(app: App) {
    this.app = app;
    this.border = new BorderView(app);
    this.border.setStatus = (t) => { this.status.textContent = t; };
    this.bar = h('div', { class: 'ctxbar' }, this.title,
      h('span', { class: 'sep' }),
      h('button', { title: 'Zoom out', onclick: () => this.setZoom(this.zoom - 1) }, '−'),
      h('button', { title: 'Zoom in', onclick: () => this.setZoom(this.zoom + 1) }, '+'),
      h('span', { class: 'sep' }));
    this.left = h('div', { class: 'left' }, h('div', { class: 'panel levels' }, h('div', { class: 'panel-title' }, 'Game'), this.list));
    this.surface = new BrushSurface(this.canvas, {
      cells: { w: TITLE_COLS, h: TITLE_ROWS },
      cellAt: (px, py) => (this.map ? this.cellAt(px, py) : null),
      box: (r) => {
        const y0 = this.cellY(r.y), y1 = this.cellY(Math.min(TITLE_ROWS - 1, r.y + r.h - 1));
        return y0 < 0 || y1 < 0 ? null : { x: r.x * 8, y: y0, w: Math.min(r.w, TITLE_COLS - r.x) * 8, h: y1 + 8 - y0 };
      },
      brush: () => this.brush,
      stamp: (x, y) => this.stamp(x, y),
      end: () => this.save(),
      cancel: () => { if (this.saved) { this.map = this.saved.slice(); this.redraw(); } },
      pick: (r) => {
        const map = this.map!, w = Math.min(r.w, TITLE_COLS - r.x), hh = Math.min(r.h, TITLE_ROWS - r.y);
        this.brush = { w, h: hh, tiles: Array.from({ length: w * hh }, (_, k) => map[(r.y + Math.floor(k / w)) * TITLE_COLS + r.x + (k % w)]) };
        this.buildPicker();
      },
      changed: () => this.redraw(),
      moved: (c) => this.updateStatus(c),
    });
    this.scroller = h('div', { class: 'level-scroller game-scroller' }, this.surface.root);
    attachPanZoom(this.scroller, () => this.zoom, (z, ax, ay) => this.setZoom(z, ax, ay), 1, 6, () => [1, 2, 3, 4, 5, 6]);
    this.root = h('div', { class: 'center' }, h('div', { class: 'level-view' }, this.scroller), h('div', { class: 'statusbar' }, this.status));
    this.side = h('div', { class: 'ow-side' }, this.pickPanel);
    this.buildList();
    // a ROM edit, undo or redo: shown as in the ROM (a stroke being painted is dropped)
    app.on('rom-change', () => {
      if (!this.root.isConnected) return;
      if (this.tab === 'border') { this.border.reload(); return; }
      this.surface.drop();
      this.sync();
    });
    // the sheet follows the panel's width, drawn anew when it needs other screen pixels per pixel
    new ResizeObserver(() => requestAnimationFrame(() => { if (this.pickPixels && fillPixels(this.pickPanel.clientWidth, 128) !== this.pickPixels) this.buildPicker(); })).observe(this.pickPanel);
    this.setZoom(this.zoom);
  }

  // the border's map shown (while the border is the tab; else the last one shown)
  get borderMap(): number { return this.border.map; }

  // shown: the title screen as in the ROM, or the border of the map shown last
  show(): void {
    if (this.tab === 'border') this.border.show(this.border.map);
    else this.sync();
  }
  // the title screen, or the border of map `map`
  select(tab: GameTab, map = this.border.map): void {
    this.tab = tab;
    const border = tab === 'border';
    this.title.textContent = border ? `${MAP_NAMES[map]} – overworld border` : 'Title screen';
    this.scroller.replaceChildren(border ? this.border.root : this.surface.root);
    this.side.replaceChildren(border ? this.border.side : this.pickPanel);
    if (border) this.bar.append(this.border.bar); else this.border.bar.remove();
    this.status.textContent = PAINT_HINT;
    if (border) this.border.show(map); else this.sync();
    this.buildList();
  }
  private buildList(): void {
    const item = (label: string, title: string, on: boolean, go: () => void) => h('div', { class: `level-item${on ? ' current' : ''}`, title, onclick: go }, label);
    this.list.replaceChildren(
      item('Title screen', 'The title screen\'s layer 3: the logo, the frame and the copyright line', this.tab === 'title', () => { this.select('title'); this.onNav(); }),
      h('div', { class: 'panel-title' }, 'Overworld border'),
      ...MAP_NAMES.map((n, m) => item(n, `${n}'s border: layer 3, fixed on the screen while the map is shown`, this.tab === 'border' && this.border.map === m, () => { this.select('border', m); this.onNav(); })));
  }
  onNav: () => void = () => {};
  // Esc: a stroke or pick in progress cancelled (else the workspace is left); whether it was taken
  key(e: KeyboardEvent): boolean {
    return this.tab === 'border' ? this.border.key(e) : this.surface.key(e);
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
    this.updateStatus(null);
    this.buildPicker();
  }

  // z: zoom factor; anchor: the point in the scroller that stays put (default: its top left)
  private setZoom(z: number, ax = 0, ay = 0): void {
    const old = this.zoom, sc = this.scroller;
    this.zoom = Math.max(1, Math.min(6, Math.round(z)));
    this.canvas.style.width = `${W * this.zoom}px`;
    this.canvas.style.height = `${H * this.zoom}px`;
    this.border.setZoom(this.zoom);
    this.surface.frames();
    // (the picture starts after the scroller's padding)
    const pad = SCROLLER_PAD, at = (s: number, a: number) => (s + a - pad) / old * this.zoom + pad - a;
    if (sc && old !== this.zoom) { sc.scrollLeft = at(sc.scrollLeft, ax); sc.scrollTop = at(sc.scrollTop, ay); }
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
    ctx.fillStyle = uiToken('--canvas-bg', '#15171b');
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
    this.surface.frames();
  }

  // the canvas's pixel y of a tilemap row (-1: none)
  private cellY(row: number): number {
    return row < TITLE_SHOWN_ROWS ? row * 8 : row === TITLE_ROWS - 1 ? TITLE_SHOWN_ROWS * 8 + GAP : -1;
  }

  // the cell at canvas pixel (px, py): the screen's rows, the row below it under the gap
  private cellAt(px: number, py: number): { x: number; y: number } | null {
    const x = Math.floor(px / 8);
    if (x < 0 || x >= TITLE_COLS || py < 0) return null;
    if (py < TITLE_SHOWN_ROWS * 8) return { x, y: Math.floor(py / 8) };
    const below = TITLE_SHOWN_ROWS * 8 + GAP;
    return py >= below && py < below + 8 ? { x, y: TITLE_ROWS - 1 } : null;
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

  // the stroke saved: one ROM edit
  private save(): void {
    const map = this.map;
    if (!map || !this.saved || map.every((w, i) => w === this.saved![i])) return;
    try {
      this.app.romEdit('Title screen painted', () => writeTitleScreen(this.app.rom, map.slice()));
    } catch (e) {
      toast(String(e instanceof Error ? e.message : e), 'error');
      this.sync();
    }
  }

  private updateStatus(c: { x: number; y: number } | null): void {
    if (!this.map) { this.status.textContent = this.error; return; }
    if (!c) { this.status.textContent = PAINT_HINT; return; }
    const w = this.map[c.y * TITLE_COLS + c.x];
    this.status.textContent = `Column ${c.x}, row ${c.y}${c.y === TITLE_ROWS - 1 ? ' (below the screen)' : ''}: tile ${layer3WordText(w)} – ${PAINT_HINT}`;
  }

  // layer 3's 8x8 tiles as the brush (l3picker.ts), as on the title screen
  private buildPicker(): void {
    const p = this.pic;
    hidePickerPreview(this.pickPanel);
    this.pickPanel.replaceChildren(h('div', { class: 'panel-title' }, 'Paint', h('span', { class: 'hint' }, PAINT_TITLE)));
    this.pickPixels = 0;
    if (!p) return;
    const w = this.pickPanel.clientWidth;
    layer3Picker(this.pickPanel, p, this.brush, (nb) => { this.brush = nb; this.buildPicker(); }, {
      pixels: this.pickPixels = fillPixels(w, 128), shown: w / 128, from: 'the screen',
      hint: 'click tiles here or on the title screen (drag: block). The graphics are layer 3\'s as the title screen\'s level has them; the row under the screen is written too (as Lunar Magic does), the game\'s scroll does not show it.',
    });
  }
}
