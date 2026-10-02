// Graphics tab: the level's GFX slots as cards (swap a file from a gallery with previews and usage),
// the list of GFX/ExGFX files and a pixel editor (pen, fill, pipette, selection with move, copy/paste,
// flip/rotate) drawing with the colors of a palette row. Each stroke is one undoable ROM edit:
// the file is encoded again and written in place when it fits, otherwise moved to free space.

import type { App } from '../app.ts';
import type { GfxWorkspace, WsPanel } from '../gfxworkspace.ts';
import { menuButton } from '../menu.ts';
import { h, clear, toast, downloadBytes, pickFile, modal, choose, attachPanZoom } from '../dom.ts';

const ZOOM_STEPS = [1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24, 32];
import { lz2Decompress, lz2Compress } from '../../core/lz2.ts';
import { decodeTile, encodeTile, cgramToRGBA } from '../../core/gfx.ts';
import { snesToPc, type Rom } from '../../core/rom.ts';
import { hex } from '../../core/names.ts';
import {
  gfxEntry, setGfxEntry, hasEditorPatch, installEditorPatch, VANILLA_GFX, levelGfx, setLevelGfx, defaultGfx,
  levelExtGfx, setLevelExtGfx, extGfxAvailable,
} from '../../core/patches.ts';
import { importGfxFile, exgfxName } from '../../core/map16file.ts';
import { parsePrimaryHeader, L1_PTRS } from '../../core/level.ts';
import { map16Source } from '../../core/render.ts';
import { EXT_FIRST, EXT_TILES, map16Ext } from '../../core/map16ext.ts';
import { gfxName, ANIM_FILE, levelSlots as map16Slots } from './map16tab.ts';
import { readAltFile, writeAltFile, altFileAddr, exanimInstalled } from '../../core/exanim.ts';
import { openHeaderDialog } from '../headerdialog.ts';

// before the first ExAnimation data: the engine (Lunar Magic compatible) is installed with it
export async function confirmExAnim(app: App): Promise<boolean> {
  if (exanimInstalled(app.rom)) return true;
  const c = await choose('ExAnimation einrichten?', 'Eigene Animationen brauchen die ExAnimation-Engine im Lunar-Magic-Format (ein ASM-Patch, dazu der Editor-Patch). Lunar Magic erkennt sie und kann die Animationen weiter bearbeiten.', [{ label: 'Abbrechen' }, { label: 'Einrichten', primary: true }]);
  if (c !== 1) return false;
  await loadAsar();
  return true;
}
import { loadAsar } from '../../core/asar.ts';
import { installVramPatch } from '../../core/vrampatch.ts';

export function defaultBpp(i: number, size: number): number {
  if ((i >= 0x28 && i <= 0x2b) || i === 0x2f) return 2;
  if (size % 24 === 0 && size % 32 !== 0) return 3;
  if (size === 0xc00 || size === 0x600) return 3;
  return 4;
}

interface GfxFile { num: number; addr: number; raw: boolean; bpp: number; packed: number; pix: Uint8Array; tiles: number; empty: boolean }

// decodes a file into pixel indices (64 per 8x8 tile)
export function loadGfx(rom: Rom, num: number, bppOverride: number | null = null): GfxFile {
  if (num >= ANIM_FILE) {
    const d = readAltFile(rom, num - ANIM_FILE);
    if (!d) return { num, addr: 0, raw: true, bpp: 4, packed: 0, pix: new Uint8Array(128 * 64), tiles: 128, empty: true };
    const tiles = Math.max(1, d.length >> 5);
    const pix = new Uint8Array(tiles * 64);
    for (let t = 0; t < tiles; t++) decodeTile(d, t * 32, 4, pix, t * 64);
    return { num, addr: altFileAddr(rom, num - ANIM_FILE), raw: true, bpp: 4, packed: d.length, pix, tiles, empty: false };
  }
  const e = gfxEntry(rom, num);
  if (!e) return { num, addr: 0, raw: true, bpp: 4, packed: 0, pix: new Uint8Array(128 * 64), tiles: 128, empty: true };
  let data: Uint8Array, packed: number;
  if (e.raw) { data = rom.bytes(e.addr, 0x1000); packed = 0x1000; }
  else ({ data, size: packed } = lz2Decompress(rom.data, snesToPc(e.addr)));
  const bpp = e.raw ? 4 : bppOverride ?? defaultBpp(num, data.length);
  const tiles = Math.max(1, Math.floor(data.length / (bpp * 8)));
  const pix = new Uint8Array(tiles * 64);
  for (let t = 0; t < tiles; t++) decodeTile(data, t * bpp * 8, bpp, pix, t * 64);
  return { num, addr: e.addr, raw: e.raw, bpp, packed, pix, tiles, empty: false };
}

function encodeGfx(f: GfxFile): Uint8Array {
  const out = new Uint8Array(f.tiles * f.bpp * 8);
  for (let t = 0; t < f.tiles; t++) encodeTile(f.pix, t * 64, f.bpp, out, t * f.bpp * 8);
  return out;
}

// writes the pixels back: raw files in place, LZ2 in place when the new data fits, else to free space
function storeGfx(rom: Rom, f: GfxFile): void {
  const data = encodeGfx(f);
  if (f.num >= ANIM_FILE) { writeAltFile(rom, f.num - ANIM_FILE, data); f.addr = altFileAddr(rom, f.num - ANIM_FILE); return; }
  if (f.raw) { rom.writeBytes(f.addr, data); return; }
  const packed = lz2Compress(data);
  if (packed.length <= f.packed) { rom.writeBytes(f.addr, packed); f.packed = packed.length; return; }
  rom.freeAt(f.addr);
  f.addr = rom.allocWrite(packed);
  f.packed = packed.length;
  setGfxEntry(rom, f.num, f.addr, false);
}

// slots of a level: name, storage index (levelGfx order) or BG2/BG3 index, file, default file
interface Slot { name: string; k: number; ext: boolean; file: number; def: number; custom: boolean; first: number; sprite: boolean }
function slotsOf(app: App, level: number, tileset: number, spriteSet: number): Slot[] {
  const set = levelGfx(app.rom, level);
  const def = defaultGfx(app.rom, tileset, spriteSet);
  const order: [string, number, number][] = [['FG1', 7, 0], ['FG2', 6, 0x80], ['BG1', 5, 0x100], ['FG3', 4, 0x180], ['SP1', 3, -1], ['SP2', 2, -1], ['SP3', 1, -1], ['SP4', 0, -1]];
  const out: Slot[] = order.map(([name, k, first]) => ({ name, k, ext: false, file: set[k] !== 0xff ? set[k] : def[k], def: def[k], custom: set[k] !== 0xff, first, sprite: first < 0 }));
  if (extGfxAvailable(app.rom)) {
    const ex = levelExtGfx(app.rom, level);
    ['BG2', 'BG3'].forEach((name, k) => out.push({ name, k, ext: true, file: ex[k], def: 0xff, custom: ex[k] !== 0xff, first: 0x200 + k * 0x80, sprite: false }));
  }
  return out;
}

type Tool = 'pen' | 'fill' | 'pick' | 'select';
interface Sel { x: number; y: number; w: number; h: number }
interface Float { x: number; y: number; w: number; h: number; pix: Uint8Array } // pixels lifted out of the sheet

export class GfxTab implements WsPanel {
  root: HTMLElement;
  private app: App;
  private ws: GfxWorkspace;
  private cur = 0x14;
  private file: GfxFile | null = null;
  private bppOverride: number | null = null;
  private palRow = -1; // -1: automatic for the file
  private color = 1;
  private tool: Tool = 'pen';
  private zoom = 4;
  private fitted = false; // zoomed to fit once on first show
  private zoomFixed = false; // opened at a tile: no fitting
  private grid: 0 | 8 | 16 = 8;
  private sel: Sel | null = null;
  private float: Float | null = null;
  private clip: { w: number; h: number; pix: Uint8Array } | null = null;
  private focusTile = -1; // tile shown under "Verwendung"
  private filter = '';
  private onlyLevel = false;
  private visible = false;
  private stroke = false;
  private ownEdit = false;
  private cards = h('div', { class: 'gt-cards' });
  private list = h('div', { class: 'gt-list' });
  private canvas = h('canvas', { class: 'gt-canvas' });
  private view = h('div', { class: 'gt-view' }, this.canvas);
  private side = h('div', { class: 'gt-side' });
  private tools = h('div', { class: 'ws-bar' });

  constructor(app: App, ws: GfxWorkspace) {
    this.app = app;
    this.ws = ws;
    const search = h('input', { placeholder: 'Suchen (z. B. 14, ExGFX80)', class: 'filter' });
    search.addEventListener('input', () => { this.filter = search.value.trim().toLowerCase(); this.buildList(); });
    const only = h('input', { type: 'checkbox' });
    only.addEventListener('change', () => { this.onlyLevel = only.checked; this.buildList(); });
    this.root = h('div', { class: 'gt' },
      this.tools,
      this.cards,
      h('div', { class: 'gt-main' },
        h('div', { class: 'gt-files' }, search, h('label', { class: 'toggle' }, only, 'nur vom Level benutzt'), this.list,
          h('button', { onclick: () => this.newExGfx(), title: 'Leere 4bpp-Datei in der ersten freien ExGFX-Nummer anlegen' }, '+ Neue ExGFX')),
        this.view,
        this.side));
    this.attachCanvas();
    attachPanZoom(this.view, () => this.zoom, (z, ax, ay) => {
      const rc = this.view.getBoundingClientRect();
      this.setZoom(z, rc.left + ax, rc.top + ay);
    }, 1, 32, ZOOM_STEPS);
    // own strokes already are in this.file: no reload (it would stall the end of every stroke)
    app.on('rom-change', () => { if (this.visible && !this.stroke && !this.ownEdit) this.reload(); });
    app.on('render', () => { this.autoRows = null; if (this.visible) { this.buildCards(); this.draw(); this.buildSide(); } });
    app.on('level', () => (this.palRow = -1));
    app.on('animated', () => { if (this.visible) this.present(); });
  }

  previewHint(): string {
    return 'Klick: 8x8-Grafik des Tiles unter der Maus (Viertel oben links) zeigen';
  }

  previewClick(px: number, py: number): void {
    const m = this.ws.preview.tileAt(px, py);
    if (m < 0) return;
    const w = map16Source(this.app.rom, this.app.render).fg(m)[0];
    const num = w & 0x3ff;
    const slot = map16Slots(this.app).find((x) => num >= x.first && num < x.first + 0x80);
    if (!slot) { toast(`8x8-Tile ${hex(num, 3)} liegt in keinem Grafik-Slot dieses Levels`); return; }
    this.ws.showGfx(slot.file, num - slot.first, (w >> 10) & 7);
  }

  show(): void {
    this.visible = true;
    this.reload();
    if (!this.fitted) { this.fitted = true; requestAnimationFrame(() => { if (!this.zoomFixed) this.fit(); }); }
  }
  hide(): void {
    this.dropFloat();
    this.visible = false;
  }

  select(file: number, tile?: number, palRow?: number): void {
    if (file !== this.cur) { this.dropFloat(); this.cur = file; this.bppOverride = null; this.palRow = -1; this.sel = null; }
    if (palRow !== undefined) this.palRow = palRow;
    if (tile !== undefined) {
      this.focusTile = tile;
      // zoom in on the tile (at least 12x), select it for flip/rotate
      this.sel = { x: (tile & 15) * 8, y: (tile >> 4) * 8, w: 8, h: 8 };
      this.fitted = this.zoomFixed = true;
      if (this.zoom < 12) this.zoom = 12;
    }
    if (this.visible) this.reload();
    if (tile !== undefined) this.scrollToTile(tile);
  }

  private scrollToTile(t: number): void {
    requestAnimationFrame(() => {
      const v = this.view, z = this.zoom;
      v.scrollLeft = ((t & 15) * 8 + 4) * z - v.clientWidth / 2;
      v.scrollTop = ((t >> 4) * 8 + 4) * z - v.clientHeight / 2;
      this.syncZoomUi();
    });
  }

  private reload(): void {
    this.autoRows = null;
    this.file = loadGfx(this.app.rom, this.cur, this.bppOverride);
    this.buildCards();
    this.buildTools();
    this.buildList();
    this.draw();
    this.buildSide();
  }

  // ---------- palette ----------
  private levelSlots(): Slot[] {
    const lv = this.app.level;
    return slotsOf(this.app, lv.number, lv.header.tileset, lv.header.spriteGfx);
  }

  // palette row: the one the level's Map16 tiles use most with the file, sprites: row 9
  private autoRows: Map<number, number> | null = null; // file -> row
  private autoRow(file: number): number {
    if (!this.autoRows) {
      const slots = this.levelSlots().filter((x) => !x.sprite && x.file !== 0xff);
      const count = slots.map(() => new Array(8).fill(0));
      const src = map16Source(this.app.rom, this.app.render);
      // tiles the level uses (else the standard pages)
      const inLevel = new Set(this.app.images?.tiles1 ?? []);
      const tiles = inLevel.size > 1 ? [...inLevel] : Array.from({ length: EXT_FIRST }, (_, i) => i);
      for (const t of tiles) for (const w of src.fg(t)) {
        const si = slots.findIndex((x) => (w & 0x3ff) >= x.first && (w & 0x3ff) < x.first + 0x80);
        if (si >= 0) count[si][(w >> 10) & 7]++;
      }
      this.autoRows = new Map();
      slots.forEach((x, i) => {
        const best = count[i].indexOf(Math.max(...count[i]));
        if (!this.autoRows!.has(x.file)) this.autoRows!.set(x.file, count[i][best] ? best : 2);
      });
      for (const x of this.levelSlots()) if (x.sprite && x.file !== 0xff && !this.autoRows.has(x.file)) this.autoRows.set(x.file, 9);
    }
    return this.autoRows.get(file) ?? 2;
  }
  private row(): number {
    return this.palRow >= 0 ? this.palRow : this.autoRow(this.cur);
  }
  private colors(): Uint32Array {
    const all = cgramToRGBA(this.app.render.cgram);
    const n = 1 << (this.file?.bpp ?? 4);
    const r = this.row();
    return Uint32Array.from({ length: n }, (_, k) => all[(r * 16 + k) & 0xff]);
  }

  // ---------- slot cards ----------
  private buildCards(): void {
    const app = this.app;
    const box = this.cards;
    clear(box);
    const slots = this.levelSlots();
    const hd = app.level.header;
    box.append(h('div', { class: 'gt-cards-title' }, h('b', null, `Grafik-Slots von Level ${hex(app.level.number, 3)}`),
      h('span', { class: 'hint' }, 'gelten nur für dieses Level · Klick öffnet die Datei, „Tauschen“ wählt eine andere')));
    for (const s of slots) {
      const has = s.file !== 0xff;
      const thumb = h('canvas', { class: 'gt-card-img', width: 64, height: 16 });
      if (has) this.thumb(thumb, s.file, s.sprite ? 9 : this.rowForSlot(s), 64, 16);
      // where a default comes from: the header's tileset (layers) or sprite set
      const from = s.sprite ? `Sprite-Grafik ${hex(hd.spriteGfx, 2)}` : `Tileset ${hex(hd.tileset, 1)}`;
      const status = s.custom ? h('span', { class: 'hint', title: 'Nur in diesem Level; „Tauschen“ → „Standard“ nimmt wieder die Grafik aus dem Header' }, 'eigene')
        : has && !s.ext ? h('a', { href: '#', class: 'hint', title: `Kommt aus dem Level-Header (${from}); dort ändern ändert alle Standard-Slots dieses Levels`, onclick: (e: Event) => { e.preventDefault(); openHeaderDialog(app); } }, 'Standard')
        : h('span', { class: 'hint' }, 'leer');
      box.append(h('div', { class: `gt-card${has && s.file === this.cur ? ' active' : ''}${has ? '' : ' empty'}` },
        h('div', { class: 'gt-card-head' }, h('b', null, s.name), status),
        h('div', { class: 'gt-card-body', title: has ? `${gfxName(s.file)} öffnen` : '', onclick: () => { if (has) this.select(s.file); } }, thumb, h('span', { class: 'mono' }, has ? gfxName(s.file) : '–')),
        h('div', { class: 'hint gt-card-range', title: s.sprite ? 'Grafik für Sprites (nicht für Map16-Tiles)' : 'Diese 8x8-Tile-Nummern benutzen die Map16-Tiles' }, s.sprite ? 'Sprites' : `Tiles ${hex(s.first, 3)}–${hex(s.first + 0x7f, 3)}`),
        h('button', { class: 'gt-card-btn', onclick: () => void this.swap(s) }, 'Tauschen …')));
    }
    if (!extGfxAvailable(app.rom)) box.append(h('div', { class: 'gt-card empty' }, h('div', { class: 'gt-card-head' }, h('b', null, 'BG2/BG3')),
      h('div', { class: 'hint' }, 'Zusätzliche Grafik für Tiles 200–2FF'),
      h('button', { class: 'gt-card-btn', title: 'Verlegt die Layer-1-Tilemap wie Lunar Magic, damit VRAM für BG2/BG3 frei wird', onclick: () => void this.enableExt() }, 'Aktivieren …')));
  }

  private rowForSlot(s: Slot): number {
    return s.sprite ? 9 : this.autoRow(s.file);
  }

  private thumb(c: HTMLCanvasElement, num: number, row: number, w: number, hh: number): void {
    try {
      const f = loadGfx(this.app.rom, num);
      if (f.empty) return;
      const all = cgramToRGBA(this.app.render.cgram);
      const W = 128, rows = Math.min(Math.ceil(f.tiles / 16), (hh * 128) / (w * 8));
      const off = document.createElement('canvas');
      off.width = W; off.height = rows * 8;
      const ctx = off.getContext('2d')!;
      const img = ctx.createImageData(W, rows * 8);
      const px = new Uint32Array(img.data.buffer);
      for (let t = 0; t < Math.min(f.tiles, rows * 16); t++) for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
        const v = f.pix[t * 64 + y * 8 + x];
        px[((t >> 4) * 8 + y) * W + (t & 15) * 8 + x] = v ? all[(row * 16 + v) & 0xff] : 0xff1b1d22;
      }
      ctx.putImageData(img, 0, 0);
      const cx = c.getContext('2d')!;
      cx.imageSmoothingEnabled = false;
      cx.drawImage(off, 0, 0, w, (w / W) * rows * 8);
    } catch { /* broken file */ }
  }

  // which levels use which file (slots incl. defaults)
  private usage(): Map<number, number[]> {
    const m = new Map<number, number[]>();
    for (const n of this.app.usedLevels()) {
      let hd;
      try { hd = n === this.app.level.number ? this.app.level.header : parsePrimaryHeader(this.app.rom.bytes(this.app.rom.r24(L1_PTRS + n * 3), 5)); } catch { continue; }
      for (const s of slotsOf(this.app, n, hd.tileset, hd.spriteGfx)) {
        if (s.file === 0xff) continue;
        const l = m.get(s.file) ?? [];
        if (!l.includes(n)) l.push(n);
        m.set(s.file, l);
      }
    }
    return m;
  }

  private async swap(s: Slot): Promise<void> {
    const app = this.app;
    const usage = this.usage();
    const n = hasEditorPatch(app.rom) ? 0x100 : VANILLA_GFX;
    const row = this.rowForSlot(s);
    const grid = h('div', { class: 'gt-gallery' });
    let done: (v: number | null) => void = () => {};
    const result = new Promise<number | null>((r) => (done = r));
    const item = (num: number, label: string, sub: string, img?: HTMLCanvasElement) => h('div', {
      class: `gt-gal-item${num === (s.custom ? s.file : -1) ? ' active' : ''}`,
      onclick: () => { done(num); dlg.close(); },
    }, img ?? h('div', { class: 'gt-gal-none' }, '—'), h('b', { class: 'mono' }, label), h('span', { class: 'hint' }, sub));
    grid.append(item(-1, s.ext ? 'keine' : `Standard (${gfxName(s.def)})`, s.ext ? 'Slot frei lassen' : 'aus Tileset/Sprite-Set'));
    for (let i = 0; i < n; i++) {
      if (!gfxEntry(app.rom, i)) continue;
      const c = h('canvas', { width: 128, height: 32, class: 'gt-gal-img' });
      this.thumb(c, i, row, 128, 32);
      const users = usage.get(i) ?? [];
      grid.append(item(i, gfxName(i), users.length ? `${users.length} Level${users.length > 1 ? 's' : ''}: ${users.slice(0, 4).map((l) => hex(l, 3)).join(' ')}${users.length > 4 ? ' …' : ''}` : 'unbenutzt'));
      (grid.lastChild as HTMLElement).prepend(c);
      (grid.lastChild as HTMLElement).querySelector('.gt-gal-none')?.remove();
    }
    const dlg = modal(`${s.name} von Level ${hex(app.level.number, 3)}: Grafik wählen`, h('div', { class: 'gt-gallery-wrap' }, grid), [{ label: 'Abbrechen' }], () => done(null));
    const pick = await result;
    if (pick === null) return;
    const v = pick < 0 ? 0xff : pick;
    if (v === (s.custom ? s.file : 0xff)) return;
    if (!s.ext && !hasEditorPatch(app.rom)) {
      const ok = await choose('Editor-Patch installieren?', 'Eigene Grafik pro Level braucht den Editor-Patch (wird einmalig installiert, wie bei Direct-Map16).', [{ label: 'Abbrechen' }, { label: 'Installieren', primary: true }]);
      if (ok !== 1) return;
    }
    try {
      app.romEdit(`${s.name} von Level ${hex(app.level.number, 3)} → ${v === 0xff ? 'Standard' : gfxName(v)}`, () => {
        if (s.ext) { const ex = levelExtGfx(app.rom, app.level.number); ex[s.k] = v; setLevelExtGfx(app.rom, app.level.number, ex); }
        else { const set = levelGfx(app.rom, app.level.number); set[s.k] = v; setLevelGfx(app.rom, app.level.number, set); }
      });
      app.flushRomChange();
    } catch (e) { toast(String(e instanceof Error ? e.message : e), 'error'); }
  }

  private async enableExt(): Promise<void> {
    const app = this.app;
    const ok = await choose('BG2/BG3 aktivieren?', 'Verlegt die Layer-1-Tilemap im VRAM (wie Lunar Magic), damit die Tiles 200–2FF eigene Grafik bekommen können. Dazu wird ein ASM-Patch angewendet.', [{ label: 'Abbrechen' }, { label: 'Aktivieren', primary: true }]);
    if (ok !== 1) return;
    try {
      await loadAsar();
      let err: string[] = [];
      app.romEdit('BG2/BG3 aktiviert (VRAM-Patch)', () => { const r = installVramPatch(app.rom); if (!r.ok) err = r.errors; });
      if (err.length) { toast(err.join(' '), 'error'); return; }
      app.flushRomChange();
      toast('VRAM-Patch installiert: BG2/BG3 sind jetzt verfügbar.');
    } catch (e) { toast(String(e instanceof Error ? e.message : e), 'error'); }
  }

  // ---------- file list ----------
  private buildList(): void {
    const app = this.app;
    clear(this.list);
    const n = hasEditorPatch(app.rom) ? 0x100 : VANILLA_GFX;
    const used = new Map(this.levelSlots().filter((s) => s.file !== 0xff).map((s) => [s.file, s.name] as [number, string]));
    for (let i = 0; i < n; i++) {
      const e = gfxEntry(app.rom, i);
      const name = gfxName(i);
      if (this.filter && !name.toLowerCase().includes(this.filter) && !hex(i, 2).toLowerCase().includes(this.filter)) continue;
      if (this.onlyLevel && !used.has(i)) continue;
      if (!e && i >= VANILLA_GFX && !this.filter && !this.onlyLevel && i !== this.cur) continue; // empty ExGFX numbers: via "+ Neue ExGFX"
      this.list.append(h('div', {
        class: `level-item${i === this.cur ? ' current' : ''}${e ? '' : ' unused'}`,
        onclick: () => this.select(i),
      }, name, used.has(i) ? h('span', { class: 'gt-used' }, used.get(i)) : ''));
    }
    // ExAnimation sources (Lunar Magic's ExGFX 60-63)
    if (!this.onlyLevel || this.cur >= ANIM_FILE) {
      this.list.append(h('div', { class: 'gt-list-head', title: 'Quellgrafik für eigene Animationen (Lunar Magics ExGFX 60–63, unkomprimiert)' }, 'Animationen'));
      for (let k = 0; k < 4; k++) {
        const i = ANIM_FILE + k;
        const name = gfxName(i);
        if (this.filter && !name.toLowerCase().includes(this.filter)) continue;
        this.list.append(h('div', {
          class: `level-item${i === this.cur ? ' current' : ''}${altFileAddr(app.rom, k) ? '' : ' unused'}`,
          onclick: () => this.select(i),
        }, name));
      }
    }
    this.list.querySelector('.current')?.scrollIntoView({ block: 'nearest' });
  }

  // creates an empty animation source file (4 KB, 128 tiles)
  private async newAnimFile(n: number): Promise<void> {
    if (!(await confirmExAnim(this.app))) return;
    try {
      this.app.romEdit(`${gfxName(n)} angelegt`, () => writeAltFile(this.app.rom, n - ANIM_FILE, new Uint8Array(0x1000)));
      this.reload();
    } catch (e) { toast(String(e instanceof Error ? e.message : e), 'error'); }
  }

  private newExGfx(): void {
    const app = this.app;
    let n = -1;
    for (let i = 0x80; i < 0x100 && n < 0; i++) if (!hasEditorPatch(app.rom) || !gfxEntry(app.rom, i)) n = i;
    for (let i = VANILLA_GFX; i < 0x80 && n < 0; i++) if (!gfxEntry(app.rom, i)) n = i;
    if (n < 0) { toast('Keine freie ExGFX-Nummer mehr', 'error'); return; }
    try {
      app.romEdit(`${gfxName(n)} angelegt`, () => { installEditorPatch(app.rom); setGfxEntry(app.rom, n, app.rom.allocWrite(new Uint8Array(0x1000)), true); });
      this.select(n);
      toast(`${gfxName(n)} angelegt (leer, 4bpp). Zuweisen: Slot-Karte oben → Tauschen.`);
    } catch (e) { toast(String(e instanceof Error ? e.message : e), 'error'); }
  }

  // ---------- tools bar ----------
  private buildTools(): void {
    const b = this.tools;
    clear(b);
    const tool = (t: Tool, label: string, key: string, title: string) => h('button', { class: this.tool === t ? 'active' : '', title: `${title} (${key})`, onclick: () => this.setTool(t) }, label);
    const slider = h('input', { type: 'range', min: 1, max: 32, value: String(this.zoom), class: 'gt-zoom', title: 'Zoom (Strg+Mausrad, mittlere Maustaste verschiebt)' });
    slider.addEventListener('input', () => this.setZoom(Number(slider.value)));
    this.zoomSlider = slider;
    this.zoomLabel = h('span', { class: 'mono gt-zoom-label' }, `${this.zoom}×`);
    const gridBtn = (g: 0 | 8 | 16, label: string) => h('button', { class: this.grid === g ? 'active' : '', onclick: () => { this.grid = g; this.buildTools(); this.draw(); } }, label);
    b.append(
      h('span', { class: 'btn-group' },
        tool('pen', '✎ Stift', 'B', 'Zeichnen; Rechtsklick zeichnet transparent'),
        tool('fill', '▧ Füllen', 'F', 'Fläche gleicher Farbe füllen'),
        tool('pick', '⌖ Pipette', 'I', 'Farbe aus dem Bild nehmen (auch Alt+Klick)'),
        tool('select', '⬚ Auswahl', 'S', 'Bereich wählen; Ziehen innerhalb verschiebt ihn, Enter/Esc setzt ab')),
      h('span', { class: 'btn-group' },
        h('button', { onclick: () => this.transform('h'), title: 'Auswahl (oder Tile unter der letzten Auswahl) horizontal spiegeln' }, '↔'),
        h('button', { onclick: () => this.transform('v'), title: 'Vertikal spiegeln' }, '↕'),
        h('button', { onclick: () => this.transform('r'), title: 'Um 90° drehen (nur quadratische Auswahl)' }, '⟳')),
      h('span', { class: 'sep' }),
      h('button', { onclick: () => this.copySel(), title: 'Auswahl kopieren (Strg+C)' }, 'Kopieren'),
      h('button', { onclick: () => this.pasteSel(), title: 'An der Auswahl einfügen, danach verschiebbar (Strg+V)' }, 'Einfügen'),
      h('span', { class: 'sep' }),
      h('span', { class: 'gt-viewctl' },
        h('span', { class: 'hint' }, 'Raster'), h('span', { class: 'btn-group' }, gridBtn(0, 'aus'), gridBtn(8, '8'), gridBtn(16, '16')),
        h('span', { class: 'hint' }, 'Zoom'), slider, this.zoomLabel,
        h('button', { title: 'Ganze Datei einpassen', onclick: () => this.fit() }, 'Einpassen')),
      h('span', { class: 'spacer' }),
      menuButton({ label: 'Import/Export', items: [
        { label: 'Importieren (.png) …', title: 'PNG (128 Pixel breit) in diese Datei; Farben werden auf die gewählte Palette abgebildet', onClick: () => void this.importPng() },
        { label: 'Importieren (.bin) …', title: 'Lunar-Magic-ExGFX (.bin)', onClick: () => void this.importBin() },
        { label: 'Exportieren (.png)', title: 'Datei als PNG in der gewählten Palette', onClick: () => this.exportPng() },
      ] }),
    );
  }

  private setTool(t: Tool): void {
    if (t !== 'select') this.dropFloat();
    this.tool = t;
    this.buildTools();
    this.canvas.dataset.tool = t;
  }

  // ---------- side panel ----------
  private buildSide(): void {
    const f = this.file;
    const s = this.side;
    clear(s);
    if (!f) return;
    const cols = this.colors();
    const row = this.row();
    const all = cgramToRGBA(this.app.render.cgram);
    const css = (v: number) => `rgb(${v & 255},${(v >> 8) & 255},${(v >> 16) & 255})`;
    const rowSel = h('div', { class: 'gt-rows' }, Array.from({ length: 16 }, (_, r) => h('button', {
      class: `gt-row${r === row ? ' active' : ''}`, title: `Palette ${hex(r, 1)}`,
      onclick: () => { this.palRow = r; this.draw(); this.buildSide(); },
    }, h('span', { class: 'mono' }, hex(r, 1)), h('span', { class: 'gt-row-strip' }, Array.from({ length: 15 }, (_, k) => h('i', { style: { background: css(all[r * 16 + 1 + k]) } }))))));
    const sw = h('div', { class: 'gt-colors' }, Array.from(cols, (v, k) => h('div', {
      class: `gt-color${k === this.color ? ' sel' : ''}${k === 0 ? ' transp' : ''}`, title: k === 0 ? 'Farbe 0: transparent' : `Farbe ${k}`,
      style: k ? { background: css(v) } : {},
      onclick: () => { this.color = k; this.buildSide(); },
    }, String(k))));
    const used = this.levelSlots().filter((x) => x.file === f.num).map((x) => x.name);
    s.append(
      h('div', { class: 'prop-title' }, gfxName(f.num), f.empty ? h('span', { class: 'hint' }, ' (leer)') : ''),
      h('div', { class: 'hint' }, f.empty ? 'Diese Nummer ist nicht belegt.' : `${f.bpp}bpp · ${f.tiles} Tiles · ${f.raw ? 'unkomprimiert' : `LZ2 (${f.packed} Bytes)`} · $${hex(f.addr, 6)}`),
      f.num >= ANIM_FILE ? h('div', { class: 'hint' }, 'Quellgrafik für eigene Animationen (Tab „Animationen“). Lunar Magic nennt sie ExGFX ' + hex(f.num - ANIM_FILE + 0x60, 2) + '.') : '',
      f.num >= ANIM_FILE && f.empty ? h('button', { onclick: () => void this.newAnimFile(f.num) }, 'Anlegen (128 leere Tiles)') : '',
      used.length ? h('div', { class: 'hint' }, `Im Level als ${used.join(', ')}`) : h('div', { class: 'hint' }, 'Vom aktuellen Level nicht benutzt'),
      f.raw || f.empty ? '' : h('div', { class: 'prop' }, h('label', null, 'Format'),
        h('span', { class: 'btn-group' }, [2, 3, 4].map((b) => h('button', { class: f.bpp === b ? 'active' : '', title: 'Nur ändern, wenn die Grafik falsch aussieht', onclick: () => { this.bppOverride = b; this.reload(); } }, `${b}bpp`)))),
      h('div', { class: 'panel-title' }, 'Farbe', h('span', { class: 'hint' }, 'Rechtsklick malt transparent')),
      sw,
      h('div', { class: 'panel-title' }, 'Palette', h('span', { class: 'hint' }, this.palRow < 0 ? 'automatisch' : h('a', { href: '#', onclick: (e: Event) => { e.preventDefault(); this.palRow = -1; this.draw(); this.buildSide(); } }, 'automatisch'))),
      rowSel,
      this.usageUi(),
    );
  }

  // Map16 tiles that use the focused 8x8 tile (when the file is in one of the level's layer slots)
  private usageUi(): HTMLElement | string {
    const t = this.focusTile;
    if (t < 0 || !this.file || t >= this.file.tiles) return h('p', { class: 'hint' }, 'Klick mit der Pipette (oder Alt+Klick) zeigt auch, welche Map16-Tiles das 8x8-Tile benutzen.');
    const slot = this.levelSlots().find((s) => s.file === this.cur && !s.sprite);
    const box = h('div', { class: 'gt-usage' }, h('div', { class: 'panel-title' }, `8x8-Tile ${hex(t, 2)} der Datei`));
    if (!slot) { box.append(h('div', { class: 'hint' }, 'Die Datei liegt in keinem Layer-Slot dieses Levels.')); return box; }
    const num = slot.first + t;
    const src = map16Source(this.app.rom, this.app.render);
    const users: number[] = [];
    const max = map16Ext(this.app.rom) ? EXT_TILES : EXT_FIRST;
    for (let m = 0; m < max && users.length < 64; m++) if (src.fg(m).some((w) => (w & 0x3ff) === num)) users.push(m);
    box.append(h('div', { class: 'hint' }, `= VRAM-Tile ${hex(num, 3)} (${slot.name})`),
      users.length ? h('div', { class: 'gt-users' }, users.map((m) => h('a', { href: '#', class: 'mono', title: 'Im Map16-Tab öffnen', onclick: (e: Event) => { e.preventDefault(); this.ws.showMap16(m); } }, hex(m, 3))))
        : h('div', { class: 'hint' }, 'Kein Map16-Tile benutzt es.'));
    return box;
  }

  // ---------- drawing ----------
  private W(): number { return 128; }
  private H(): number { return Math.ceil((this.file?.tiles ?? 128) / 16) * 8; }
  private idx(x: number, y: number): number { return ((y >> 3) * 16 + (x >> 3)) * 64 + (y & 7) * 8 + (x & 7); }
  private get(x: number, y: number): number {
    const f = this.file!;
    if (this.float && x >= this.float.x && y >= this.float.y && x < this.float.x + this.float.w && y < this.float.y + this.float.h) {
      const v = this.float.pix[(y - this.float.y) * this.float.w + x - this.float.x];
      if (v !== 255) return v;
    }
    const i = this.idx(x, y);
    return i < f.pix.length ? f.pix[i] : 0;
  }
  private set(x: number, y: number, v: number): void {
    if (x < 0 || y < 0 || x >= this.W() || y >= this.H()) return;
    const i = this.idx(x, y);
    if (i >= this.file!.pix.length) return;
    this.file!.pix[i] = v;
    if (this.px && !this.float) this.px[y * this.W() + x] = this.rgba(x, y, v);
  }

  // persistent 1:1 image of the sheet; drawing updates single pixels and presents once per frame
  private off = document.createElement('canvas');
  private img: ImageData | null = null;
  private px: Uint32Array | null = null;
  private cols: Uint32Array = new Uint32Array(16);
  private frame = 0;
  private rgba(x: number, y: number, v: number): number {
    return v ? this.cols[v] ?? 0xffff00ff : ((x >> 2) + (y >> 2)) & 1 ? 0xff2b2e35 : 0xff23262c;
  }

  // full redraw (file, palette or floating selection changed)
  draw(): void {
    const f = this.file;
    if (!f) return;
    const W = this.W(), H = this.H();
    if (!this.img || this.img.width !== W || this.img.height !== H) {
      this.off.width = W; this.off.height = H;
      this.img = new ImageData(W, H);
      this.px = new Uint32Array(this.img.data.buffer);
    }
    this.cols = this.colors();
    const px = this.px!;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) px[y * W + x] = this.rgba(x, y, this.get(x, y));
    this.present();
  }

  private requestPresent(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => { this.frame = 0; this.present(); });
  }

  private present(): void {
    const f = this.file;
    if (!f || !this.img) return;
    const W = this.W(), H = this.H(), z = this.zoom;
    const c = this.canvas;
    if (c.width !== W * z || c.height !== H * z) { c.width = W * z; c.height = H * z; }
    const ctx = c.getContext('2d')!;
    this.off.getContext('2d')!.putImageData(this.img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.off, 0, 0, W * z, H * z);
    // grids: a dark and a light line next to each other stay visible on any color
    const lines = (step: number, dark: string, light: string) => {
      ctx.lineWidth = 1;
      for (const [col, d] of [[dark, 0.5], [light, 1.5]] as [string, number][]) {
        ctx.strokeStyle = col;
        ctx.beginPath();
        for (let x = step; x < W; x += step) { ctx.moveTo(x * z - 1 + d, 0); ctx.lineTo(x * z - 1 + d, H * z); }
        for (let y = step; y < H; y += step) { ctx.moveTo(0, y * z - 1 + d); ctx.lineTo(W * z, y * z - 1 + d); }
        ctx.stroke();
      }
    };
    if (this.grid && z >= 8) {
      ctx.strokeStyle = 'rgba(128,128,128,0.35)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 1; x < W; x++) { ctx.moveTo(x * z + 0.5, 0); ctx.lineTo(x * z + 0.5, H * z); }
      for (let y = 1; y < H; y++) { ctx.moveTo(0, y * z + 0.5); ctx.lineTo(W * z, y * z + 0.5); }
      ctx.stroke();
    }
    if (this.grid === 8) lines(8, 'rgba(0,0,0,0.7)', 'rgba(255,255,255,0.55)');
    if (this.grid) lines(16, 'rgba(0,0,0,0.85)', 'rgba(76,194,255,0.9)');
    // tiles the game animates in this level: magenta corner
    const anim = this.animatedTiles();
    if (anim.size) {
      ctx.fillStyle = '#ff4fd8';
      const m = Math.max(5, z * 2);
      for (const t of anim) {
        const x = ((t & 15) + 1) * 8 * z, y = (t >> 4) * 8 * z;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y + m); ctx.lineTo(x - m, y); ctx.fill();
      }
    }
    if (this.focusTile >= 0 && this.focusTile < f.tiles) {
      ctx.strokeStyle = '#ffb000';
      ctx.lineWidth = 3;
      ctx.strokeRect((this.focusTile & 15) * 8 * z - 1.5, (this.focusTile >> 4) * 8 * z - 1.5, 8 * z + 3, 8 * z + 3);
    }
    const r = this.float ?? this.sel;
    if (r) {
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = '#4cc2ff';
      ctx.lineWidth = 2;
      ctx.strokeRect(r.x * z + 1, r.y * z + 1, r.w * z - 2, r.h * z - 2);
      ctx.setLineDash([]);
    }
  }

  // zoom around a point of the view (client coordinates; default: its center)
  setZoom(z: number, ax?: number, ay?: number): void {
    z = Math.max(1, Math.min(32, Math.round(z)));
    const old = this.zoom;
    if (z === old) return;
    const v = this.view;
    const rc = v.getBoundingClientRect();
    const cx = ax === undefined ? v.clientWidth / 2 : ax - rc.left, cy = ay === undefined ? v.clientHeight / 2 : ay - rc.top;
    const lx = (v.scrollLeft + cx) / old, ly = (v.scrollTop + cy) / old;
    this.zoom = z;
    this.present();
    v.scrollLeft = lx * z - cx;
    v.scrollTop = ly * z - cy;
    this.syncZoomUi();
  }
  private fit(): void {
    const v = this.view;
    this.setZoom(Math.max(1, Math.floor(Math.min((v.clientWidth - 4) / this.W(), (v.clientHeight - 4) / this.H()))));
  }
  private zoomSlider: HTMLInputElement | null = null;
  private zoomLabel: HTMLElement | null = null;
  private syncZoomUi(): void {
    if (this.zoomSlider) this.zoomSlider.value = String(this.zoom);
    if (this.zoomLabel) this.zoomLabel.textContent = `${this.zoom}×`;
  }

  // tiles of this file the game overwrites with animation frames (when it is in a layer slot)
  private animatedTiles(): Set<number> {
    const out = new Set<number>();
    const anim = this.app.animated();
    if (!anim) return out;
    for (const s of this.levelSlots()) {
      if (s.file !== this.cur || s.sprite) continue;
      for (let k = 0; k < 128; k++) if (anim.tiles.has(s.first + k)) out.add(k);
    }
    return out;
  }
  private warned = new Set<string>(); // file:tile already warned about

  private warnAnimated(x: number, y: number): void {
    const t = (y >> 3) * 16 + (x >> 3);
    const key = `${this.cur}:${t}`;
    if (this.warned.has(key) || !this.animatedTiles().has(t)) return;
    this.warned.add(key);
    toast(`Tile ${hex(t, 2)} wird im Spiel animiert: das Spiel überschreibt es laufend mit Animationsbildern, die Änderung sieht man dort nicht.`, 'error');
  }

  private commit(label: string): void {
    const f = this.file;
    if (!f || f.empty) { toast(f ? `${gfxName(f.num)} ist leer – nichts zu exportieren` : 'Erst links eine Datei wählen'); return; }
    this.ownEdit = true;
    try {
      this.app.romEdit(`${gfxName(f.num)}: ${label}`, () => storeGfx(this.app.rom, f));
    } catch (e) { toast(String(e instanceof Error ? e.message : e), 'error'); this.ownEdit = false; this.reload(); }
    this.ownEdit = false;
  }

  private fill(x: number, y: number, v: number): void {
    const from = this.get(x, y);
    if (from === v) return;
    const W = this.W(), H = this.H();
    const st = [[x, y]];
    while (st.length) {
      const [cx, cy] = st.pop()!;
      if (cx < 0 || cy < 0 || cx >= W || cy >= H || this.get(cx, cy) !== from) continue;
      this.set(cx, cy, v);
      st.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
    }
  }

  private line(x0: number, y0: number, x1: number, y1: number, v: number): void {
    const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0), n = Math.max(dx, dy, 1);
    for (let i = 0; i <= n; i++) this.set(Math.round(x0 + ((x1 - x0) * i) / n), Math.round(y0 + ((y1 - y0) * i) / n), v);
  }

  private attachCanvas(): void {
    const c = this.canvas;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    const pos = (e: MouseEvent) => {
      const rc = c.getBoundingClientRect();
      return { x: Math.floor(((e.clientX - rc.left) / rc.width) * this.W()), y: Math.floor(((e.clientY - rc.top) / rc.height) * this.H()) };
    };
    c.addEventListener('mousedown', (e) => {
      const f = this.file;
      if (!f || (e.button !== 0 && e.button !== 2)) return;
      e.preventDefault();
      const p = pos(e);
      const tool: Tool = e.altKey ? 'pick' : this.tool;
      if (tool === 'pick') {
        this.color = this.get(p.x, p.y);
        this.focusTile = (p.y >> 3) * 16 + (p.x >> 3);
        this.draw(); this.buildSide();
        return;
      }
      if (f.empty) { toast(f.num >= ANIM_FILE ? 'Die Datei gibt es noch nicht – rechts „Anlegen“' : 'Diese Nummer ist leer – „+ Neue ExGFX“ legt eine Datei an'); return; }
      const v = e.button === 2 ? 0 : this.color;
      if (tool === 'pen' || tool === 'fill') this.warnAnimated(p.x, p.y);
      if (tool === 'fill') { this.fill(p.x, p.y, v); this.draw(); this.app.renderPause(); this.commit('Füllen'); return; }
      let last = p;
      let move: (ev: MouseEvent) => void;
      let label = 'Zeichnen';
      if (tool === 'pen') {
        this.stroke = true;
        this.set(p.x, p.y, v);
        this.app.holdRender = true;
        move = (ev) => { const n = pos(ev); if (n.x === last.x && n.y === last.y) return; this.line(last.x, last.y, n.x, n.y, v); last = n; this.requestPresent(); };
      } else {
        // selection: drag inside moves (lifting the pixels), outside starts a new rectangle
        const r = this.float ?? this.sel;
        if (r && p.x >= r.x && p.y >= r.y && p.x < r.x + r.w && p.y < r.y + r.h) {
          if (!this.float) this.lift();
          this.stroke = true;
          label = 'Verschieben';
          move = (ev) => {
            const n = pos(ev);
            this.float!.x += n.x - last.x; this.float!.y += n.y - last.y;
            last = n; this.draw();
          };
        } else {
          this.dropFloat();
          this.sel = { x: p.x, y: p.y, w: 1, h: 1 };
          move = (ev) => {
            const n = pos(ev);
            const x0 = Math.max(0, Math.min(p.x, n.x)), y0 = Math.max(0, Math.min(p.y, n.y));
            const x1 = Math.min(this.W() - 1, Math.max(p.x, n.x)), y1 = Math.min(this.H() - 1, Math.max(p.y, n.y));
            this.sel = { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
            this.requestPresent();
          };
          label = '';
        }
      }
      if (tool === 'pen') this.requestPresent(); else this.draw();
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        this.app.holdRender = false;
        this.app.renderPause();
        if (this.stroke) {
          this.stroke = false;
          if (label === 'Zeichnen') this.commit(label);
        }
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
    let lastHover = -1;
    c.addEventListener('mousemove', (e) => {
      if (this.stroke) return;
      const p = pos(e);
      const t = (p.y >> 3) * 16 + (p.x >> 3);
      if (p.y * 128 + p.x === lastHover) return;
      lastHover = p.y * 128 + p.x;
      c.title = `Tile ${hex(t, 2)}${this.animatedTiles().has(t) ? ' (animiert)' : ''} · Pixel ${p.x & 7},${p.y & 7} · Farbe ${this.file ? this.get(Math.max(0, p.x), Math.max(0, p.y)) : ''}`;
    });
  }

  // lifts the selected pixels into a floating block (the place becomes transparent)
  private lift(): void {
    const s = this.sel;
    if (!s) return;
    const pix = new Uint8Array(s.w * s.h);
    for (let y = 0; y < s.h; y++) for (let x = 0; x < s.w; x++) { pix[y * s.w + x] = this.get(s.x + x, s.y + y); this.set(s.x + x, s.y + y, 0); }
    this.float = { ...s, pix };
  }

  // puts a floating block down and stores the file
  private dropFloat(): void {
    const fl = this.float;
    if (!fl) return;
    this.float = null;
    for (let y = 0; y < fl.h; y++) for (let x = 0; x < fl.w; x++) {
      const v = fl.pix[y * fl.w + x];
      if (v !== 255) this.set(fl.x + x, fl.y + y, v);
    }
    this.sel = { x: Math.max(0, fl.x), y: Math.max(0, fl.y), w: fl.w, h: fl.h };
    this.commit('Auswahl verschoben');
    this.draw();
  }

  private copySel(): void {
    const r = this.float ?? this.sel;
    if (!r) { toast('Erst mit dem Auswahl-Werkzeug (S) einen Bereich wählen'); return; }
    const pix = new Uint8Array(r.w * r.h);
    for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) pix[y * r.w + x] = this.get(r.x + x, r.y + y);
    this.clip = { w: r.w, h: r.h, pix };
    toast(`${r.w}×${r.h} Pixel kopiert`);
  }
  private pasteSel(): void {
    const c = this.clip;
    if (!c) { toast('Erst etwas kopieren'); return; }
    this.dropFloat();
    const at = this.sel ?? { x: 0, y: 0 };
    this.float = { x: at.x, y: at.y, w: c.w, h: c.h, pix: c.pix.slice() };
    this.tool = 'select';
    this.buildTools();
    this.draw();
  }

  private transform(kind: 'h' | 'v' | 'r'): void {
    if (!this.float) { if (!this.sel) { toast('Erst mit dem Auswahl-Werkzeug (S) einen Bereich wählen'); return; } this.lift(); }
    const fl = this.float!;
    if (kind === 'r' && fl.w !== fl.h) { toast('Drehen geht nur bei quadratischer Auswahl'); return; }
    const out = new Uint8Array(fl.pix.length);
    for (let y = 0; y < fl.h; y++) for (let x = 0; x < fl.w; x++) {
      const v = fl.pix[y * fl.w + x];
      if (kind === 'h') out[y * fl.w + (fl.w - 1 - x)] = v;
      else if (kind === 'v') out[(fl.h - 1 - y) * fl.w + x] = v;
      else out[x * fl.w + (fl.w - 1 - y)] = v;
    }
    fl.pix = out;
    this.dropFloat();
  }

  // ---------- files ----------
  private exportPng(): void {
    const f = this.file;
    if (!f || f.empty) { toast(f ? `${gfxName(f.num)} ist leer – nichts zu exportieren` : 'Erst links eine Datei wählen'); return; }
    const W = 128, H = this.H();
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d')!;
    const img = ctx.createImageData(W, H);
    const px = new Uint32Array(img.data.buffer);
    const cols = this.colors();
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const v = this.get(x, y); px[y * W + x] = v ? cols[v] : 0; }
    ctx.putImageData(img, 0, 0);
    c.toBlob(async (b) => { if (b) { downloadBytes(`${gfxName(f.num)}.png`, new Uint8Array(await b.arrayBuffer()), 'image/png'); toast(`${gfxName(f.num)}.png exportiert`); } }, 'image/png');
  }

  private async importPng(): Promise<void> {
    const f = this.file;
    if (!f) return;
    const file = await pickFile('.png,image/png');
    if (!file) return;
    const bmp = await createImageBitmap(file);
    if (bmp.width !== 128) { toast('Das Bild muss 128 Pixel breit sein (16 Tiles)', 'error'); return; }
    let raw = f.raw;
    if (f.num >= ANIM_FILE && !(await confirmExAnim(this.app))) return;
    if (f.empty && f.num >= ANIM_FILE) raw = true;
    else if (f.empty) {
      const c = await choose(`${gfxName(f.num)} anlegen`, 'In welchem Format speichern?', [{ label: 'Abbrechen' }, { label: 'LZ2 (wie Original, 3bpp/8 Farben)' }, { label: '4bpp unkomprimiert (16 Farben)', primary: true }]);
      if (!c) return;
      raw = c === 2;
    } else if ((await choose(`${gfxName(f.num)} überschreiben?`, `Das Bild ersetzt den Inhalt von ${gfxName(f.num)}. Farben werden auf Palette ${hex(this.row(), 1)} abgebildet. (Rückgängig mit Strg+Z.)`, [{ label: 'Abbrechen' }, { label: 'Überschreiben', primary: true }])) !== 1) return;
    const bpp = raw ? 4 : f.empty ? 3 : f.bpp;
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(bmp, 0, 0);
    const px = new Uint32Array(ctx.getImageData(0, 0, c.width, c.height).data.buffer);
    const all = cgramToRGBA(this.app.render.cgram);
    const row = this.row();
    const pal = Array.from({ length: 1 << bpp }, (_, k) => all[(row * 16 + k) & 0xff]);
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
    const tiles = f.num >= ANIM_FILE ? Math.min(0x400, Math.floor(bmp.height / 8) * 16) : raw ? 128 : Math.floor(bmp.height / 8) * 16;
    const pix = new Uint8Array(tiles * 64);
    for (let t = 0; t < tiles; t++) {
      const bx = (t & 15) * 8, by = (t >> 4) * 8;
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) pix[t * 64 + y * 8 + x] = by + y < bmp.height ? nearest(px[(by + y) * 128 + bx + x]) : 0;
    }
    const nf: GfxFile = { ...f, raw, bpp, tiles, pix, empty: false };
    try {
      this.app.romEdit(`${file.name} → ${gfxName(f.num)}`, () => {
        const enc = encodeGfx(nf);
        if (f.num >= ANIM_FILE) { writeAltFile(this.app.rom, f.num - ANIM_FILE, enc); return; }
        const payload = raw ? enc : lz2Compress(enc);
        if (!f.empty) this.app.rom.freeAt(f.addr);
        setGfxEntry(this.app.rom, f.num, this.app.rom.allocWrite(payload), raw);
      });
      this.bppOverride = f.empty || raw ? null : bpp;
      this.reload();
      toast(`${file.name} importiert`);
    } catch (e) { toast(String(e instanceof Error ? e.message : e), 'error'); }
  }

  private async importBin(): Promise<void> {
    const file = await pickFile('.bin');
    if (!file) return;
    let target = this.cur;
    const n0 = exgfxName(file.name).num;
    // Lunar Magic's ExGFX 60-63 are the animation files
    const n = n0 !== null && n0 >= 0x60 && n0 <= 0x63 ? ANIM_FILE + n0 - 0x60 : n0;
    if (n !== null && n !== this.cur && (n <= 0xff || n >= ANIM_FILE)) {
      const c = await choose('Ziel wählen', `Der Dateiname nennt ${gfxName(n)}. Wohin soll die Grafik?`, [{ label: 'Abbrechen' }, { label: `In ${gfxName(this.cur)} (aktuelle Datei)` }, { label: `In ${gfxName(n)}`, primary: true }]);
      if (!c) return;
      if (c === 2) target = n;
    } else if ((target >= ANIM_FILE ? altFileAddr(this.app.rom, target - ANIM_FILE) : gfxEntry(this.app.rom, target)) && (await choose(`${gfxName(target)} überschreiben?`, `${file.name} ersetzt den Inhalt von ${gfxName(target)} (Rückgängig mit Strg+Z).`, [{ label: 'Abbrechen' }, { label: 'Überschreiben', primary: true }])) !== 1) return;
    try {
      const data = new Uint8Array(await file.arrayBuffer());
      if (target >= ANIM_FILE) {
        if (!(await confirmExAnim(this.app))) return;
        if (data.length % 32 || data.length > 0x8000) throw new Error('Animationsgrafik: unkomprimierte 4bpp-Datei bis 32 KB erwartet');
        this.app.romEdit(`${file.name} → ${gfxName(target)}`, () => writeAltFile(this.app.rom, target - ANIM_FILE, data));
        this.select(target);
        toast(`${file.name} → ${gfxName(target)}`);
        return;
      }
      const what = this.app.romEdit(`${file.name} → ${gfxName(target)}`, () => importGfxFile(this.app.rom, target, data));
      this.select(target);
      toast(`${file.name} → ${gfxName(target)} (${what})`);
    } catch (e) { toast(String(e instanceof Error ? e.message : e), 'error'); }
  }

  key(e: KeyboardEvent): boolean {
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (ctrl && k === 'c') { this.copySel(); return true; }
    if (ctrl && k === 'v') { this.pasteSel(); return true; }
    if (ctrl || e.altKey) return false;
    if (k === 'b') { this.setTool('pen'); return true; }
    if (k === 'f') { this.setTool('fill'); return true; }
    if (k === 'i') { this.setTool('pick'); return true; }
    if (k === 's') { this.setTool('select'); return true; }
    if (e.key === 'Escape' && (this.float || this.sel)) { this.dropFloat(); this.sel = null; this.draw(); return true; }
    if (e.key === 'Enter' && this.float) { this.dropFloat(); return true; }
    if (/^[0-9]$/.test(k) && this.file && Number(k) < (1 << this.file.bpp)) { this.color = Number(k); this.buildSide(); return true; }
    return false;
  }
}
