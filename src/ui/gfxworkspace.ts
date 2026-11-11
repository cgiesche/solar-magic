// Graphics workspace: palettes, Map16 and GFX files as linked tabs next to a live preview of the level.
// Not a modal: the level list stays usable, edits show up in the preview right away and undo works.
// Its target is the open level or a submap of the overworld (submapgfx.ts: its own palettes, …), chosen in its bar;
// the preview then shows the submap's map as the game loads it (emulated, App.overworldMap).

import type { App } from './app.ts';
import { h, toast, attachPanZoom, zoomControl, showColorLoupe, hideColorLoupe } from './dom.ts';
import { viewMenu } from './viewmenu.ts';
import { hex } from '../core/names.ts';
import { PaletteTab } from './gfx/palettetab.ts';
import { Map16Tab, type RemapFill } from './gfx/map16tab.ts';
import { gfxTarget, type GfxTarget, type Map16Target } from './gfx/target.ts';
import { GfxTab } from './gfx/gfxtab.ts';
import { AnimTab } from './gfx/animtab.ts';
import { MAP_NAMES, gameL2, owTileAt, drawOwMap, owShownAt, owMapAt, type OwRender } from '../core/overworld.ts';
import { cgramToRGBA } from '../core/gfx.ts';
import { sameProgress, type EventProgress } from '../core/eventset.ts';
import { MARK, rgba } from './marks.ts';

export type WsTab = 'pal' | 'map16' | 'gfx' | 'anim';

export interface WsPanel {
  root: HTMLElement;
  show(): void; // became visible (redraw from the current state)
  hide?(): void;
  key?(e: KeyboardEvent): boolean; // true: handled
  // click into the level preview (pixel position in the level image)
  previewClick?(px: number, py: number, e: MouseEvent): void;
  previewHint?(): string;
  // eyedropper in the preview: the color under the mouse (pipette cursor and swatch)
  previewColor?(px: number, py: number): { rgba: number; label: string };
  // the workspace's target changed (WsTarget); a panel without it shows nothing of a submap
  targetChanged?(): void;
  // the panel edits a submap's graphics (else it shows a note while a submap is the target)
  submaps?: boolean;
}

// what the workspace edits: the open level's graphics (submap null) or those of a submap (0–6); progress: the
// overworld's event progress its preview is shown at (eventset.ts); special: a submap shown (and its colors edited)
// after the special world
export interface WsTarget { submap: number | null; progress: EventProgress; special?: boolean }

// the current level image, scaled; marks every place of the highlighted Map16 tiles
export class LevelPreview {
  root: HTMLElement;
  private img = h('canvas', { class: 'ws-prev-img' });
  private over = h('canvas', { class: 'ws-prev-over' });
  private box: HTMLElement;
  private scroller: HTMLElement;
  private info = h('div', { class: 'ws-prev-info hint' });
  zoom = 1;
  private zoomCtl = zoomControl(() => this.zoom, (z) => this.setZoom(z));
  highlight = new Set<number>(); // Map16 tiles of layer 1
  highlight2 = new Set<number>(); // of layer 2 objects
  highlightBg = new Set<number>(); // BG Map16 tiles of the BG tilemap
  onClick: ((px: number, py: number, e: MouseEvent) => void) | null = null;
  colorAt: ((px: number, py: number) => { rgba: number; label: string }) | null = null;
  hint = '';
  private app: App;
  // a submap shown instead of the level: its map at the event progress (its load, the image drawn from it; null while
  // it is emulated); switched: the console with the event triggers switched (null: none switched, or still emulated)
  private ow: { submap: number; progress: EventProgress; special: boolean; r: OwRender | null; switched: OwRender | null; img: Uint32Array | null; fresh: boolean } | null = null;
  // the event triggers 01–08 of the submap's animations switched for the preview (holds or not; the others as the
  // event progress has them): the Animations tab's, never saved; kept while the submap stays
  private switches = new Map<number, boolean>();
  // called when the submap's load came (it shows the ROM as it is now)
  private mapListeners: (() => void)[] = [];
  onMap(fn: () => void): void { this.mapListeners.push(fn); }
  private title = h('span', null, 'Level preview');

  constructor(app: App) {
    this.app = app;
    this.box = h('div', { class: 'ws-prev-box' }, this.img, this.over);
    this.scroller = h('div', { class: 'ws-prev-scroll' }, this.box);
    this.root = h('div', { class: 'ws-prev' },
      h('div', { class: 'panel-title' }, this.title, this.zoomCtl.root),
      this.scroller, this.info);
    attachPanZoom(this.scroller, () => this.zoom, (z, ax, ay) => this.setZoom(z, ax, ay));
    this.scroller.addEventListener('mousemove', (e) => {
      const p = this.pos(e);
      this.box.classList.toggle('pipette', !!(p && this.colorAt));
      if (p && this.colorAt && !(e.buttons & 4)) { const c = this.colorAt(p.px, p.py); showColorLoupe(e, c.rgba, c.label); } else hideColorLoupe();
      if (!p) { this.info.textContent = this.hint; return; }
      const t = this.ow ? -1 : this.tileAt(p.px, p.py), q = this.owTileAt(p.px, p.py);
      this.info.textContent = `X ${hex(p.px >> 4, 2)} Y ${hex(p.py >> 4, 2)}${t >= 0 ? ` · Map16 ${hex(t, 3)}` : ''}${q ? ` · 8x8 tile ${hex(q.word & 0x3ff, 3)} (layer ${q.layer})` : ''}${this.hint ? ` — ${this.hint}` : ''}`;
    });
    this.scroller.addEventListener('mouseleave', () => { this.info.textContent = this.hint; hideColorLoupe(); });
    this.scroller.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      const p = this.pos(e);
      if (p) { e.preventDefault(); this.onClick?.(p.px, p.py, e); }
    });
    app.on('render', () => { if (!this.ow) this.update(); });
    app.on('anim-frame', () => { if (!this.ow) this.update(); });
    app.on('reveal', () => { if (!this.ow) this.scrollTo(app.reveal.x >> 4, app.reveal.y >> 4); });
    // (a ROM edit may change what the submap's load shows: asked for again)
    app.on('rom-change', () => { if (this.ow) this.loadMap(); });
  }

  // shows submap `map` at event progress `progress` (null: the level)
  showSubmap(t: WsTarget): void {
    const was = this.ow?.submap;
    if (t.submap !== was) this.switches.clear();
    this.ow = t.submap === null ? null : { submap: t.submap, progress: t.progress, special: !!t.special, r: null, switched: null, img: null, fresh: false };
    this.title.textContent = this.ow ? `${MAP_NAMES[this.ow.submap]} (overworld${this.ow.special ? ', after the special world' : ''})` : 'Level preview';
    if (this.ow) this.loadMap();
    else this.update();
    if (this.ow && was !== this.ow.submap && this.root.isConnected) this.scrollToSubmap();
  }
  private loadMap(): void {
    const o = this.ow!;
    const r = this.app.overworldMap(o.submap, o.progress, (x) => {
      if (this.ow !== o) return;
      const first = !o.img;
      o.r = x;
      this.loadSwitched(o);
      o.fresh = true;
      for (const fn of this.mapListeners) fn();
      this.update();
      this.info.textContent = this.hint;
      // (the image had no size to scroll in before)
      if (first) this.scrollToSubmap();
    }, undefined, o.special);
    o.fresh = !!r;
    if (r) { o.r = r; this.loadSwitched(o); }
    this.update();
  }
  // the map with the switched triggers (as loaded while it is emulated, or none is switched)
  private loadSwitched(o: NonNullable<LevelPreview['ow']>): void {
    o.switched = null;
    const switches = [...this.switches].sort((a, b) => a[0] - b[0]), key = JSON.stringify(switches);
    if (switches.length) {
      const t = this.app.overworldTriggers(o.submap, o.progress, o.special, switches, (x) => {
        // (not when the switches changed since: the map they were switched for is no longer asked for)
        if (this.ow !== o || JSON.stringify([...this.switches].sort((a, b) => a[0] - b[0])) !== key) return;
        o.switched = x;
        this.drawMap(o, x);
        for (const fn of this.mapListeners) fn();
        this.update();
      });
      if (t) o.switched = t;
    }
    this.drawMap(o, o.switched ?? o.r!);
  }
  // event trigger t (01–08) switched for the preview: holds or not, null: as the event progress has it
  switchTrigger(t: number, holds: boolean | null): void {
    if (holds === null) this.switches.delete(t); else this.switches.set(t, holds);
    this.switchesChanged();
  }
  // every event trigger as the event progress has it
  resetTriggers(): void {
    this.switches.clear();
    this.switchesChanged();
  }
  private switchesChanged(): void {
    if (this.ow?.r) { this.loadSwitched(this.ow); this.update(); }
    for (const fn of this.mapListeners) fn();
  }
  // the triggers switched (trigger: holds)
  get switched(): ReadonlyMap<number, boolean> { return this.switches; }
  private drawMap(o: NonNullable<LevelPreview['ow']>, r: OwRender): void {
    // (layer 2 of the loaded region as the game shows it, in readL2's order)
    const region = o.submap > 0 ? 1 : 0, l2 = new Uint16Array(0x2000);
    l2.set(gameL2(r), region * 0x1000);
    // (shown as the overworld editor shows it: the submaps' region moved, wrapping; owShownAt)
    const img = drawOwMap(this.app.rom, r, region, null, l2), shown = new Uint32Array(img.length);
    for (let y = 0; y < 512; y++) for (let x = 0; x < 512; x++) { const p = owShownAt(region, x, y); shown[p.y * 512 + p.x] = img[y * 512 + x]; }
    o.img = shown;
  }
  // the submap's view in the middle (its region's 512x512 image)
  scrollToSubmap(): void {
    const o = this.ow!;
    const v = this.app.submapViews((vs) => { if (this.ow === o) this.scrollToRect(vs[o.submap]); });
    if (v) this.scrollToRect(v[o.submap]);
  }
  private scrollToRect(r: { x: number; y: number; w: number; h: number } | undefined): void {
    if (!r || !this.ow) return;
    const p = owShownAt(this.ow.submap > 0 ? 1 : 0, (r.x + r.w / 2) * 8, (r.y + r.h / 2) * 8);
    this.scrollTo(p.x / 16, p.y / 16);
  }
  // the image shown (the level's, or the submap's map; null while none is known)
  private image(): { w: number; h: number; px: Uint32Array; backdrop: number } | null {
    if (this.ow) return this.ow.img ? { w: 512, h: 512, px: this.ow.img, backdrop: 0 } : null;
    const im = this.app.images;
    return im ? { w: im.width, h: im.height, px: this.app.compositeImg, backdrop: im.backdrop } : null;
  }
  // the colors of the submap shown as loaded, null: none shown or still emulated
  submapCgram(): Uint8Array | null {
    return this.ow?.fresh ? this.ow.r?.cgram ?? null : null;
  }
  // the console after the load of the submap shown (VRAM, CGRAM, WRAM, PPU registers), null: none shown or still
  // emulated
  submapRender(): OwRender | null {
    return this.ow?.fresh ? this.ow.r : null;
  }
  // the console the submap's image is drawn from: after its load, or run on from there with the triggers switched
  // (switchTrigger; as loaded while that is emulated); null as submapRender
  submapShown(): OwRender | null {
    return this.ow?.fresh ? this.ow.switched ?? this.ow.r : null;
  }
  // whether the image shows the triggers switched (false while that is emulated, or none is switched)
  get switchesShown(): boolean { return !!this.ow?.switched; }
  // the colors of what is shown (CGRAM as loaded, with the triggers switched)
  get cgram(): Uint8Array {
    return this.ow ? (this.ow.switched ?? this.ow.r)?.cgram ?? new Uint8Array(0x200) : this.app.render.cgram;
  }
  // the pixel at (px, py) of what is shown (RGBA) and the backdrop color there (a submap's: of its map, pos)
  pixel(px: number, py: number): { rgba: number; backdrop: boolean } {
    const im = this.image();
    if (!im) return { rgba: 0, backdrop: true };
    if (this.ow) ({ x: px, y: py } = owShownAt(this.ow.submap > 0 ? 1 : 0, px, py));
    const v = im.px[py * im.w + px];
    return { rgba: v, backdrop: !v || (v >>> 0) === (im.backdrop >>> 0) };
  }
  // the CGRAM entry with the pixel's color (FG/BG rows first, then the others), -1 if none has it
  entryAt(px: number, py: number): number {
    const p = this.pixel(px, py), pal = cgramToRGBA(this.cgram);
    const order = [2, 3, 4, 5, 6, 7, 0, 1, 8, 9, 10, 11, 12, 13, 14, 15];
    for (const row of order) for (let c = 1; c < 16; c++) if (pal[row * 16 + c] === p.rgba) return row * 16 + c;
    return pal[0] === p.rgba || p.backdrop ? 0 : -1;
  }

  // z: zoom factor; anchor: point in the scroller that stays put (default: the middle)
  setZoom(z: number, ax = this.scroller.clientWidth / 2, ay = this.scroller.clientHeight / 2): void {
    const old = this.zoom;
    if (z === old) return;
    const lx = (this.scroller.scrollLeft + ax) / old, ly = (this.scroller.scrollTop + ay) / old;
    this.zoom = z;
    this.layout();
    this.scroller.scrollLeft = lx * z - ax;
    this.scroller.scrollTop = ly * z - ay;
    this.zoomCtl.update();
  }

  // the pixel under the mouse: the level's, or the pixel of the submap's map shown there (owMapAt)
  private pos(e: MouseEvent): { px: number; py: number } | null {
    const im = this.image();
    if (!im) return null;
    const rc = this.img.getBoundingClientRect();
    const px = Math.floor((e.clientX - rc.left) / this.zoom), py = Math.floor((e.clientY - rc.top) / this.zoom);
    if (px < 0 || py < 0 || px >= im.w || py >= im.h) return null;
    if (!this.ow) return { px, py };
    const p = owMapAt(this.ow.submap > 0 ? 1 : 0, px, py);
    return { px: p.x, py: p.y };
  }

  tileAt(px: number, py: number): number {
    const im = this.app.images, g = im.geom1;
    const tx = px >> 4, ty = py >> 4;
    if (tx >= g.width || ty >= g.height) return -1;
    return im.tiles1[ty * g.width + tx];
  }

  // the 8x8 tile of the submap shown at (px, py) (overworld.ts owTileAt; the load the image is drawn from), null: none
  // there, a level shown or no map yet
  owTileAt(px: number, py: number): { word: number; layer: 1 | 2 } | null {
    const r = this.ow?.switched ?? this.ow?.r;
    return r ? owTileAt(r, px, py) : null;
  }

  setHint(s: string): void {
    this.hint = s;
    this.info.textContent = s;
  }

  update(): void {
    const im = this.image();
    if (!this.root.isConnected) return;
    // (the submap's map while it is emulated: nothing of the level stays)
    if (!im) { if (this.ow) { this.img.getContext('2d')!.clearRect(0, 0, this.img.width, this.img.height); this.info.textContent = 'The map is being loaded …'; } return; }
    if (this.img.width !== im.w || this.img.height !== im.h) {
      this.img.width = this.over.width = im.w;
      this.img.height = this.over.height = im.h;
      this.layout();
    }
    const px = this.ow ? im.px.map((v) => v || 0xff000000) : im.px;
    const id = new ImageData(new Uint8ClampedArray(px.buffer as ArrayBuffer, px.byteOffset, im.w * im.h * 4), im.w, im.h);
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
    if (!im || this.ow || !this.highlight.size && !this.highlight2.size && !this.highlightBg.size) return;
    ctx.strokeStyle = MARK.warn;
    ctx.lineWidth = 1;
    ctx.fillStyle = rgba(MARK.warn, 0.4);
    const mark = (x: number, y: number) => { ctx.fillRect(x * 16, y * 16, 16, 16); ctx.strokeRect(x * 16 + 0.5, y * 16 + 0.5, 15, 15); };
    const g = im.geom1;
    for (let y = 0; y < g.height; y++) for (let x = 0; x < g.width; x++) if (this.highlight.has(im.tiles1[y * g.width + x])) mark(x, y);
    const g2 = im.geom2;
    if (g2 && im.tiles2 && this.highlight2.size) for (let y = 0; y < g2.height; y++) for (let x = 0; x < g2.width; x++) if (this.highlight2.has(im.tiles2[y * g2.width + x])) mark(x, y);
    // the BG tilemap (32 x 27) repeats over the level
    if (im.bgTiles && this.highlightBg.size) for (let y = 0; y < im.height / 16; y++) for (let x = 0; x < im.width / 16; x++) if (this.highlightBg.has(im.bgTiles[(y % 27) * 32 + (x % 32)])) mark(x, y);
  }
  clearHighlight(): void {
    this.highlight.clear();
    this.highlight2.clear();
    this.highlightBg.clear();
  }

  // number of places of the tile in layer 1
  count(tile: number): number {
    const im = this.app.images;
    if (!im || this.ow) return 0;
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
  bar: HTMLElement;
  active = false;
  target: WsTarget = { submap: null, progress: 0 };
  private targetSel: HTMLSelectElement;
  // a submap's preview and colors after the special world
  private specialBox = h('input', { type: 'checkbox' });
  private specialLabel = h('label', { class: 'toggle', title: 'The submap as the game shows it once the special world is passed (its last level\'s passed flag): its second set of colors, which the Palettes tab then edits' }, this.specialBox, 'After the special world');
  private note = h('div', { class: 'ws-note' });
  // set by the host: a tab was opened (jump: a jump to something in it, Ctrl+click or a link)
  onNav: (jump: boolean) => void = () => {};
  private app: App;

  constructor(app: App) {
    this.app = app;
    this.preview = new LevelPreview(app);
    this.pal = new PaletteTab(app, this);
    this.map16 = new Map16Tab(app, this);
    this.gfx = new GfxTab(app, this);
    this.anim = new AnimTab(app, this);
    const tabBtn = (t: WsTab, label: string, key: string) => h('button', { 'data-tab': t, title: `${label} (${key})`, onclick: () => this.open(t) }, label);
    this.targetSel = h('select', { class: 'ws-target', title: 'Whose graphics are edited: the open level\'s or those of a submap of the overworld' });
    this.targetSel.addEventListener('change', () => this.setTarget({ ...this.target, submap: this.targetSel.value === 'level' ? null : Number(this.targetSel.value) }));
    app.on('level', () => this.fillTargets());
    this.fillTargets();
    this.specialBox.addEventListener('change', () => this.setTarget({ ...this.target, special: this.specialBox.checked }));
    this.specialLabel.hidden = true;
    this.bar = h('div', { class: 'ctxbar ws-tabs' },
      this.targetSel,
      this.specialLabel,
      h('div', { class: 'btn-group' }, tabBtn('pal', 'Palettes', 'P'), tabBtn('map16', 'Map16 tiles', 'M'), tabBtn('gfx', 'Graphics', 'G'), tabBtn('anim', 'Animations', 'A')),
      h('span', { class: 'spacer' }),
      h('span', { class: 'hint', title: 'Exception: the palette choice in the header (Palettes tab, below) belongs to the level and is written with “Save level”.' }, 'Changes go straight into the ROM · Ctrl+Z / Ctrl+Y'),
      viewMenu(app, () => this.preview.update(), false));
    this.root = h('div', { class: 'ws' }, this.body);
    this.side = h('div', { class: 'right ws-side' }, this.preview.root);
    this.preview.onClick = (px, py, e) => this.panel().previewClick?.(px, py, e);
  }

  // what the target is, for the palette, graphics and animation tabs (the level's FG tiles, or the submap's)
  get desc(): GfxTarget { return gfxTarget(this.app, this.target); }

  panel(t = this.tab): WsPanel {
    return t === 'pal' ? this.pal : t === 'map16' ? this.map16 : t === 'gfx' ? this.gfx : this.anim;
  }

  private fillTargets(): void {
    const lv = this.app.level ? `Level ${hex(this.app.level.number, 3)}` : 'Level';
    this.targetSel.replaceChildren(h('option', { value: 'level' }, lv), ...MAP_NAMES.map((n, k) => h('option', { value: String(k) }, `Submap ${k}: ${n}`)));
    this.targetSel.value = this.target.submap === null ? 'level' : String(this.target.submap);
  }

  // edits the level's graphics (submap null) or a submap's; the open tab shows them
  setTarget(t: WsTarget): void {
    const locked = gfxTarget(this.app, t).locked();
    if (locked) { toast(`The overworld is replaced by ${locked}: its graphics can't be edited here`); t = { ...t, submap: null }; }
    t = { ...t, special: t.submap !== null && !!t.special };
    const same = t.submap === this.target.submap && sameProgress(t.progress, this.target.progress) && t.special === !!this.target.special;
    this.target = t;
    this.targetSel.value = t.submap === null ? 'level' : String(t.submap);
    this.specialBox.checked = t.special!;
    this.specialLabel.hidden = t.submap === null;
    if (same) return;
    this.preview.showSubmap(this.target);
    this.pal.targetChanged();
    this.map16.targetChanged();
    this.anim.targetChanged();
    if (this.active) { this.open(this.tab); this.onNav(false); }
  }

  open(t: WsTab): void {
    if (this.active && this.tab !== t) { this.panel().hide?.(); this.onNav(false); }
    this.tab = t;
    for (const b of this.bar.querySelectorAll('button')) b.classList.toggle('active', (b as HTMLElement).dataset.tab === t);
    if (this.target.submap !== null && !this.panel().submaps) {
      this.panel().hide?.();
      this.note.replaceChildren(h('p', null, `${({ pal: 'Palettes', map16: 'Map16 tiles', gfx: 'Graphics', anim: 'Animations' })[t]} of a submap are not edited here yet.`),
        h('button', { onclick: () => this.setTarget({ ...this.target, submap: null }) }, 'Edit the level\'s'));
      this.body.replaceChildren(this.note);
      this.preview.setHint('');
      this.preview.colorAt = null;
      this.preview.update();
      return;
    }
    this.body.replaceChildren(this.panel().root);
    this.preview.clearHighlight();
    this.preview.setHint(this.panel().previewHint?.() ?? '');
    const p = this.panel();
    this.preview.colorAt = p.previewColor ? (px, py) => p.previewColor!(px, py) : null;
    hideColorLoupe();
    this.panel().show();
    this.preview.update();
  }

  // entering the workspace (level image position to center the preview on)
  enter(t: WsTab, at?: { tx: number; ty: number }): void {
    this.active = true;
    this.app.flushRomChange();
    this.open(t);
    if (this.target.submap !== null) this.preview.scrollToSubmap();
    else if (at) this.preview.scrollTo(at.tx, at.ty);
  }

  leave(): void {
    this.panel().hide?.();
    this.active = false;
  }

  showPalette(row: number, col = 1): void {
    this.open('pal');
    this.pal.select(row * 16 + col);
    this.onNav(true);
  }

  // a Map16 tile of a target; the overworld's tiles drawn as on the submap of `at` (else the one shown last)
  showMap16(tile: number, target: Map16Target = 'fg', at?: WsTarget): void {
    this.open('map16');
    const progress = at?.progress ?? this.target.progress;
    this.setTarget({ ...this.target, submap: target === 'ow' ? at?.submap ?? this.target.submap ?? this.map16.lastSubmap : null, progress });
    this.map16.select(tile, target);
    this.onNav(true);
  }

  // the Map16 tab's remap panel, filled in by an offer
  showRemap(fill: RemapFill): void {
    this.open('map16');
    this.map16.openRemap(fill);
    this.onNav(true);
  }

  showGfx(file: number, tile?: number, palRow?: number): void {
    this.open('gfx');
    this.gfx.select(file, tile, palRow);
    this.onNav(true);
  }

  showAnim(global: boolean, slot: number): void {
    this.anim.select(global, slot);
    this.open('anim');
    this.onNav(true);
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
