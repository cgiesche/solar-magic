// Graphics tab: the level's GFX slots as cards (swap a file from a gallery with previews and usage),
// the list of GFX/ExGFX files and a pixel editor (pen, fill, pipette, selection with move, copy/paste,
// flip/rotate) drawing with the colors of a palette row. Each stroke is one undoable ROM edit:
// the file is encoded again and written in place when it fits, otherwise moved to free space.

import type { App } from '../app.ts';
import type { GfxWorkspace, WsPanel } from '../gfxworkspace.ts';
import { menuButton, type MenuItem } from '../menu.ts';
import { h, clear, toast, modal, choose, attachPanZoom, zoomControl, zoomStep, showColorLoupe, hideColorLoupe } from '../dom.ts';
import { downloadBytes, pickFile, pickFiles } from '../platform.ts';

const ZOOM_MIN = 1, ZOOM_MAX = 32; // of the shared zoom levels (dom.ts)
const NEW_FILE = -2, IMPORT_FILE = -3; // gallery picks besides a file number (-1: default)
const ORDER: BinPlanItem['status'][] = ['new', 'replace', 'skip', 'unchanged']; // rows of a bulk import's preview
import { lz2Decompress, lz2Compress } from '../../core/lz2.ts';
import { decodeTile, encodeTile, cgramToRGBA } from '../../core/gfx.ts';
import { snesToPc, type Rom } from '../../core/rom.ts';
import { hex } from '../../core/names.ts';
import {
  gfxEntry, setGfxEntry, freeGfx, gfxRange, gfxRangeFor, gfxDataSize, gfxNumberProblem, gfxHex, VANILLA_GFX, AS_IS_FIRST, GFX_FILES, MAX_GFX, GFX_NONE, levelGfx, setLevelGfx,
  levelExtGfx, setLevelExtGfx, type GfxFileKind,
} from '../../core/patches.ts';
import { exgfxName } from '../../core/map16file.ts';
import { defaultBpp, gfxBinData, gfxBinName, storeGfxBin, parseGfxBinName, binFiles, planGfxBins, applyGfxBins, exportAllGfx, type BinFile, type BinPlanItem } from '../../core/gfxbin.ts';
import { gfxLabels, gfxUserName, setGfxName, GFX_NAME_MAX } from '../../core/gfxnames.ts';
import { gfxNumber } from '../../core/levelgfx.ts';
import { gfxNumberField } from '../gfxnum.ts';
import { levelLayer3, setLevelLayer3, fitsLayer3Slot, lt3SizeFor, LT3_DESTS, LT3_SIZES } from '../../core/layer3gfx.ts';
import { recordPackageChange, type Package } from '../../core/pkgreg.ts';
import { map16Source } from '../../core/render.ts';
import { EXT_FIRST, EXT_TILES } from '../../core/map16ext.ts';
import { gfxName, lmAnimName, ANIM_FILE, levelSlots as map16Slots } from './map16tab.ts';
import { readAltFile, writeAltFile, altFileAddr, ALT_FILE_MAX } from '../../core/exanim.ts';
import { openHeaderDialog } from '../headerdialog.ts';
import { animsAt, animLinks } from './animtab.ts';
import { gfxSlots, gfxUsage, unusedExGfx, savedHeader, slotMove, type GfxSlot as Slot, type GfxUser } from '../../core/levelusage.ts';
import { usedInList } from '../usedin.ts';
import { slotRemapLine } from '../../core/remap.ts';


interface GfxFile { num: number; addr: number; raw: boolean; bpp: number; auto: number; packed: number; pix: Uint8Array; tiles: number; empty: boolean } // auto: the detected bpp

// decodes a file into pixel indices (64 per 8x8 tile)
export function loadGfx(rom: Rom, num: number, bppOverride: number | null = null): GfxFile {
  if (num >= ANIM_FILE) {
    const d = readAltFile(rom, num - ANIM_FILE);
    if (!d) return { num, addr: 0, raw: true, bpp: 4, auto: 4, packed: 0, pix: new Uint8Array(128 * 64), tiles: 128, empty: true };
    const tiles = Math.max(1, d.length >> 5);
    const pix = new Uint8Array(tiles * 64);
    for (let t = 0; t < tiles; t++) decodeTile(d, t * 32, 4, pix, t * 64);
    return { num, addr: altFileAddr(rom, num - ANIM_FILE), raw: true, bpp: 4, auto: 4, packed: d.length, pix, tiles, empty: false };
  }
  const e = gfxEntry(rom, num);
  if (!e) return { num, addr: 0, raw: true, bpp: 4, auto: 4, packed: 0, pix: new Uint8Array(128 * 64), tiles: 128, empty: true };
  let data: Uint8Array, packed: number;
  if (e.raw) { data = rom.bytes(e.addr, e.size); packed = e.size; }
  else ({ data, size: packed } = lz2Decompress(rom.data, snesToPc(e.addr)));
  const auto = e.raw ? (e.size === 0x800 ? 2 : 4) : defaultBpp(num, data.length);
  const bpp = e.raw ? auto : bppOverride ?? auto;
  const tiles = Math.max(1, Math.floor(data.length / (bpp * 8)));
  const pix = new Uint8Array(tiles * 64);
  for (let t = 0; t < tiles; t++) decodeTile(data, t * bpp * 8, bpp, pix, t * 64);
  return { num, addr: e.addr, raw: e.raw, bpp, auto, packed, pix, tiles, empty: false };
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

const spriteRange = (first: number) => first < 0x100 ? `${hex(first, 2)}–${hex(first + 0x7f, 2)}` : `${hex(first, 3)}–${hex(first + 0x7f, 3)}`;
// sprite tile number of tile t of a sprite slot, as patches write it
const spriteTile = (first: number, t: number) => first + t < 0x100 ? hex(first + t, 2) : `${hex(first + t, 3)} (page 2: ${hex((first + t) & 0xff, 2)} with T bit)`;

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
  private bppOk = -1; // file confirmed to be edited in a format other than the detected one
  private palRow = -1; // -1: automatic for the file
  private color = 1;
  private tool: Tool = 'pen';
  private zoom = 4;
  private zoomCtl = zoomControl(() => this.zoom, (z) => this.setZoom(z), ZOOM_MIN, ZOOM_MAX);
  private fitted = false; // zoomed to fit once on first show
  private zoomFixed = false; // opened at a tile: no fitting
  private grid: 0 | 8 | 16 = 8;
  private sel: Sel | null = null;
  private float: Float | null = null;
  private clip: { w: number; h: number; pix: Uint8Array } | null = null;
  private focusTile = -1; // tile shown under "Usage"
  private filter = '';
  private onlyLevel = false;
  private visible = false;
  private stroke = false;
  private ownEdit = false;
  private cards = h('div', { class: 'gt-cards' });
  private list = h('div', { class: 'gt-list' });
  private canvas = h('canvas', { class: 'gt-canvas', 'data-tool': 'pen' });
  private view = h('div', { class: 'gt-view' }, this.canvas);
  private side = h('div', { class: 'gt-side' });
  private tools = h('div', { class: 'ws-bar' });

  constructor(app: App, ws: GfxWorkspace) {
    this.app = app;
    this.ws = ws;
    const search = h('input', { placeholder: 'Search (e.g. 14, ExGFX80)', class: 'filter' });
    search.addEventListener('input', () => { this.filter = search.value.trim().toLowerCase(); this.buildList(); });
    const only = h('input', { type: 'checkbox' });
    only.addEventListener('change', () => { this.onlyLevel = only.checked; this.buildList(); });
    this.root = h('div', { class: 'gt' },
      this.tools,
      this.cards,
      h('div', { class: 'gt-main' },
        h('div', { class: 'gt-files' }, search, h('label', { class: 'toggle' }, only, 'only used by the level'), this.list,
          h('button', { onclick: () => void this.newExGfx(), title: 'Create an empty 4bpp file; the next free ExGFX number is suggested' }, '+ New ExGFX')),
        this.view,
        this.side));
    this.attachCanvas();
    attachPanZoom(this.view, () => this.zoom, (z, ax, ay) => {
      const rc = this.view.getBoundingClientRect();
      this.setZoom(z, rc.left + ax, rc.top + ay);
    }, ZOOM_MIN, ZOOM_MAX);
    // own strokes already are in this.file: no reload (it would stall the end of every stroke)
    app.on('rom-change', () => { if (this.visible && !this.stroke && !this.ownEdit) this.reload(); });
    app.on('render', () => { this.autoRows = null; if (this.visible) { this.buildCards(); this.draw(); this.buildSide(); } });
    app.on('level', () => (this.palRow = -1));
    app.on('animated', () => { if (this.visible) this.present(); });
  }

  previewHint(): string {
    return 'Click: show the 8x8 graphics of the tile under the mouse (top left quarter)';
  }

  previewClick(px: number, py: number): void {
    const m = this.ws.preview.tileAt(px, py);
    if (m < 0) return;
    const w = map16Source(this.app.rom, this.app.render).fg(m)[0];
    const num = w & 0x3ff;
    const slot = map16Slots(this.app).find((x) => num >= x.first && num < x.first + 0x80);
    if (!slot) { toast(`8x8 tile ${hex(num, 3)} is in none of this level's graphics slots`); return; }
    this.ws.showGfx(slot.file, num - slot.first, (w >> 10) & 7);
  }

  show(): void {
    this.visible = true;
    this.reload();
    if (!this.fitted) { this.fitted = true; requestAnimationFrame(() => { if (!this.zoomFixed) this.fit(); }); }
  }
  hide(): void {
    this.dropFloat();
    hideColorLoupe();
    this.visible = false;
  }

  get selected(): number { return this.cur; }

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
    return gfxSlots(this.app.rom, lv.number, lv.header.tileset, lv.header.spriteGfx);
  }

  // palette row: the one the level's Map16 tiles use most with the file, sprites: row 9
  private autoRows: Map<number, number> | null = null; // file -> row
  private autoRow(file: number): number {
    if (!this.autoRows) {
      const slots = this.levelSlots().filter((x) => x.map16 && x.file !== 0xff);
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
    box.append(h('div', { class: 'gt-cards-title' }, h('b', null, `Graphics slots of level ${hex(app.level.number, 3)}`),
      h('span', { class: 'hint' }, 'apply to this level only · a click opens the file, “Swap” chooses another')));
    for (const s of slots) {
      const has = s.file !== 0xff;
      const thumb = h('canvas', { class: 'gt-card-img', width: 64, height: 16 });
      if (has && s.kind !== 'lt3') this.thumb(thumb, s.file, this.rowForSlot(s), 64, 16);
      // where a default comes from: the header's tileset (layers) or sprite set
      const from = s.sprite ? `sprite graphics ${hex(hd.spriteGfx, 2)}` : `tileset ${hex(hd.tileset, 1)}`;
      const status = s.custom ? h('span', { class: 'hint', title: 'Only in this level; “Swap” → “Default” takes the graphics from the header again' }, 'custom')
        : has && s.kind === 'lg' ? h('span', { class: 'hint', title: 'The game\'s layer 3 graphics (status bar, messages, tides …)' }, 'Default')
        : has && s.kind === 'gfx' ? h('a', { href: '#', class: 'hint', title: `Comes from the level header (${from}); changing it there changes all default slots of this level`, onclick: (e: Event) => { e.preventDefault(); openHeaderDialog(app); } }, 'Default')
        : h('span', { class: 'hint' }, 'empty');
      box.append(h('div', { class: `gt-card${has && s.file === this.cur ? ' active' : ''}${has ? '' : ' empty'}` },
        h('div', { class: 'gt-card-head' }, h('b', null, s.name), status),
        h('div', { class: 'gt-card-body', title: has ? `Open ${gfxName(s.file)}` : '', onclick: () => { if (has) this.select(s.file); } }, thumb, h('span', { class: 'mono' }, has ? gfxName(s.file) : '–')),
        h('div', { class: 'hint gt-card-range', title: this.rangeTitle(s) }, this.range(s)),
        s.kind === 'lt3' && has ? this.lt3Settings() : '',
        h('button', { class: 'gt-card-btn', onclick: () => void this.swap(s) }, 'Swap …')));
    }
  }

  private rowForSlot(s: Slot): number {
    return s.sprite ? 9 : s.map16 ? this.autoRow(s.file) : 0;
  }

  // the tile numbers a slot's file is loaded as
  private range(s: Slot): string {
    if (s.sprite) return `Sprite tiles ${spriteRange(s.first)}`;
    if (s.kind === 'lg') return `Layer 3 tiles ${hex(s.first, 3)}–${hex(s.first + 0x7f, 3)}`;
    if (s.kind === 'lt3') return 'Layer 3 tilemap';
    return `Tiles ${hex(s.first, 3)}–${hex(s.first + 0x7f, 3)}`;
  }
  private rangeTitle(s: Slot): string {
    if (s.sprite) return 'Sprite tile numbers (as in patches and sprites); from 100 = second page (T bit), given there without the 1';
    if (s.kind === 'lg') return 'Layer 3 graphics (2bpp, 0x800 bytes): the 8x8 tile numbers of the layer 3 tilemap';
    if (s.kind === 'lt3') return 'A file with layer 3 tilemap data, shown instead of the image of the layer 3 setting (its behaviour, e.g. a tide, stays)';
    return 'The Map16 tiles use these 8x8 tile numbers';
  }

  // where the LT3 file goes in the layer 3 tilemap, and how much of it
  private lt3Settings(): HTMLElement {
    const app = this.app, n = app.level.number, g = levelLayer3(app.rom, n), bytes = gfxEntry(app.rom, g.lt3)?.size ?? 0;
    const set = (what: string, v: Partial<typeof g>) => {
      try { app.romEdit(`LT3 of level ${hex(n, 3)}: ${what}`, () => setLevelLayer3(app.rom, n, { ...levelLayer3(app.rom, n), ...v })); }
      catch (e) { toast(String(e instanceof Error ? e.message : e), 'error'); }
    };
    const sel = (opts: string[], cur: number, title: string, on: (v: number) => void, off: (i: number) => boolean = () => false) => h('select', { title, onchange: (e: Event) => on(Number((e.target as HTMLSelectElement).value)) },
      opts.map((o, i) => h('option', { value: String(i), selected: i === cur, disabled: off(i) }, o)));
    return h('div', { class: 'gt-card-l3' },
      sel(LT3_DESTS, g.dest, 'Where the file goes: “Under the status bar” keeps the status bar\'s tilemap, the others overwrite (part of) it', (v) => set(LT3_DESTS[v].toLowerCase(), { dest: v })),
      sel(LT3_SIZES.map((b) => (b === 0x2000 ? '512×512' : b === 0x1000 ? '512×256' : '256×256')), g.size, 'How much of the file is copied: 512×512 pixels = 0x2000 bytes, 512×256 = 0x1000, 256×256 = 0x800', (v) => set(`0x${hex(LT3_SIZES[v], 4)} bytes`, { size: v }), (i) => LT3_SIZES[i] > bytes));
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

  // which levels use which file, in which slots (defaults included; the open level as edited)
  private usage(): Map<number, GfxUser[]> {
    const app = this.app;
    return gfxUsage(app.rom, app.usedLevels(), (n) => (n === app.level.number ? app.level.header : savedHeader(app.rom, n)));
  }

  private async swap(s: Slot): Promise<void> {
    const app = this.app;
    const usage = this.usage();
    const row = this.rowForSlot(s);
    const grid = h('div', { class: 'gt-gallery' });
    let done: (v: number | null) => void = () => {};
    const result = new Promise<number | null>((r) => (done = r));
    const item = (num: number, label: string, sub: string, img?: HTMLCanvasElement) => h('div', {
      class: `gt-gal-item${num === (s.custom ? s.file : -1) ? ' active' : ''}`,
      onclick: () => { done(num); dlg.close(); },
    }, img ?? h('div', { class: 'gt-gal-none' }, '—'), h('b', { class: 'mono' }, label), h('span', { class: 'hint' }, sub));
    const empty = s.kind === 'ext' || s.kind === 'lt3';
    grid.append(item(-1, empty ? 'none' : `Default (${gfxName(s.def)})`, s.kind === 'lt3' ? 'the layer 3 setting\'s image' : empty ? 'Leave slot empty' : s.kind === 'lg' ? 'the game\'s layer 3 graphics' : s.sprite ? 'from the sprite graphics in the header' : 'from the tileset in the header'));
    const extra = (code: number, label: string, sub: string) => h('div', { class: 'gt-gal-item gt-gal-new', onclick: () => { done(code); dlg.close(); } },
      h('div', { class: 'gt-gal-none' }, '+'), h('b', null, label), h('span', { class: 'hint' }, sub));
    // the slot's range (layer 3's files are kept "as is", E00-FFF, as Lunar Magic does)
    const size = s.kind === 'lg' ? 0x800 : s.kind === 'lt3' ? 0x2000 : 0x1000;
    const free = freeGfx(app.rom, new Set(), gfxRangeFor({ slot: s.name, size }));
    if (free >= 0) grid.append(
      extra(NEW_FILE, 'New ExGFX …', `create empty (next free: ${gfxHex(free)}) and use here`),
      extra(IMPORT_FILE, 'Import …', `.bin or .png into a new ExGFX number (next free: ${gfxHex(free)}), use here`));
    for (let i = 0; i < GFX_FILES; i++) {
      if (!gfxEntry(app.rom, i)) continue;
      // layer 3: only 2bpp graphics files for LG, only uncompressed tilemap files for LT3
      if ((s.kind === 'lg' || s.kind === 'lt3') && !fitsLayer3Slot(app.rom, s.name, i)) continue;
      const c = h('canvas', { width: 128, height: 32, class: 'gt-gal-img' });
      this.thumb(c, i, row, 128, 32);
      const users = usage.get(i) ?? [];
      grid.append(item(i, gfxName(i), users.length ? `${users.length} Level${users.length > 1 ? 's' : ''}: ${users.slice(0, 4).map((u) => hex(u.level, 3)).join(' ')}${users.length > 4 ? ' …' : ''}` : 'unused'));
      (grid.lastChild as HTMLElement).prepend(c);
      (grid.lastChild as HTMLElement).querySelector('.gt-gal-none')?.remove();
    }
    const dlg = modal(`${s.name} of level ${hex(app.level.number, 3)}: choose graphics`, h('div', { class: 'gt-gallery-wrap' }, grid), [{ label: 'Cancel' }], () => done(null));
    const pick = await result;
    if (pick === null) return;
    if (pick === NEW_FILE || pick === IMPORT_FILE) {
      const n = pick === NEW_FILE ? await this.newExGfx(false, size, s.name) : await this.importNew(undefined, undefined, s.name);
      if (n !== null) await this.assignSlot(s, n);
      return;
    }
    await this.assignSlot(s, pick < 0 ? 0xff : pick);
  }

  // puts a file into a slot of the current level (0xff: the default / empty)
  private async assignSlot(s: Slot, v: number): Promise<void> {
    const app = this.app;
    if (v === (s.custom ? s.file : 0xff)) return;
    const before = this.levelSlots();
    try {
      app.romEdit(`${s.name} of level ${hex(app.level.number, 3)} → ${v === 0xff ? 'default' : gfxName(v)}`, () => {
        if (s.kind === 'ext') { const ex = levelExtGfx(app.rom, app.level.number); ex[s.k] = v; setLevelExtGfx(app.rom, app.level.number, ex); }
        else if (s.kind === 'lg' || s.kind === 'lt3') {
          const g = levelLayer3(app.rom, app.level.number);
          // an LT3 file copies at most its own length
          if (s.kind === 'lt3') { g.lt3 = v; const e = v !== 0xff ? gfxEntry(app.rom, v) : null; if (e) g.size = Math.max(g.size, lt3SizeFor(e.size)); } else g.lg[s.k] = v;
          setLevelLayer3(app.rom, app.level.number, g);
        } else { const set = levelGfx(app.rom, app.level.number); set[s.k] = v; setLevelGfx(app.rom, app.level.number, set); }
      });
    } catch (e) { toast(String(e instanceof Error ? e.message : e), 'error'); return; }
    if (s.map16) await this.offerRemap(s, before);
  }

  // Map16 tiles made for another slot than their file is in now (core: slotMove): offers to remap the
  // tiles 200-FFF that draw from the old slot
  private async offerRemap(s: Slot, before: Slot[]): Promise<void> {
    const m = slotMove(before, this.levelSlots(), s.name, this.usage(), this.app.level.number);
    if (!m) return;
    const { file, from, to } = m;
    const span = (x: Slot) => `${x.name} (${hex(x.first, 3)}–${hex(x.first + 0x7f, 3)})`;
    const line = slotRemapLine(from.first, to.first);
    const pick = await choose('Remap Map16 tiles?', h('div', { style: 'max-width:480px' },
      h('p', null, !m.levels ? `${gfxName(file)} moved from ${span(from)} to ${span(to)}.` : `${gfxName(file)} is in ${span(from)} in ${m.levels} other level${m.levels > 1 ? 's' : ''}, here in ${span(to)}.`,
        ` Map16 tiles made for it still point at ${from.name}.`),
      h('p', { class: 'hint' }, `The Map16 tab's remap opens with ${line} for the tiles 200–FFF that use these 8x8 tiles; the preview shows them before anything changes. Map16 tiles are shared by all levels: one that keeps ${gfxName(file)} in ${from.name} then shows them wrong.`)),
      [{ label: 'Remap …', primary: true }, { label: 'Not now' }]);
    if (pick === 0) this.ws.showRemap({ line, scope: 'uses', bg: false });
  }

  // ---------- file list ----------
  private buildList(): void {
    const app = this.app;
    clear(this.list);
    const used = new Map(this.levelSlots().filter((s) => s.file !== 0xff).map((s) => [s.file, s.name] as [number, string]));
    const unused = new Set(unusedExGfx(app.rom, app.usedLevels(), this.usage()));
    const label = gfxLabels(app.rom);
    // by range: the game's files, ExGFX, files kept "as is" (Lunar Magic's E00-FFF)
    const groups: [number, number, string, string][] = [
      [0, VANILLA_GFX, 'GFX', 'The game\'s graphics files'],
      [VANILLA_GFX, AS_IS_FIRST, `ExGFX ${gfxHex(0x80)}–${gfxHex(AS_IS_FIRST - 1)}`, 'Own graphics files (also 32–7F); Lunar Magic converts these between 3bpp and 4bpp'],
      [AS_IS_FIRST, GFX_FILES, `“As is” ${gfxHex(AS_IS_FIRST)}–${gfxHex(MAX_GFX)}`, 'Files Lunar Magic keeps as they are: 2bpp layer 3 graphics (LG1–LG4), layer 3 tilemaps (LT3)'],
    ];
    for (const [from, to, head, title] of groups) {
      const items: HTMLElement[] = [];
      for (let i = from; i < to; i++) {
        const e = gfxEntry(app.rom, i);
        const name = gfxName(i), own = e ? label(i) : null;
        // empty ExGFX numbers: via "+ New ExGFX", or found by their exact number
        const exact = /^(exgfx)?[0-9a-f]{1,3}$/.test(this.filter) && parseInt(this.filter.replace('exgfx', ''), 16) === i;
        if (!e && i >= VANILLA_GFX && i !== this.cur && !exact) continue;
        if (i === GFX_NONE) continue;
        if (this.filter && !exact && !`${name} ${own ?? ''}`.toLowerCase().includes(this.filter) && !hex(i, 2).toLowerCase().includes(this.filter)) continue;
        if (this.onlyLevel && !used.has(i)) continue;
        items.push(this.listItem(i, e !== null, used.get(i), unused.has(i), own));
      }
      if (items.length) this.list.append(h('div', { class: 'gt-list-head', title }, head), ...items);
    }
    this.buildAnimList();
    this.list.querySelector('.current')?.scrollIntoView({ block: 'nearest' });
  }

  private listItem(i: number, exists: boolean, slot: string | undefined, unused: boolean, name: string | null): HTMLElement {
    return h('div', {
      class: `level-item${i === this.cur ? ' current' : ''}${exists ? '' : ' unused'}`,
      onclick: () => this.select(i),
    }, gfxName(i), name ? h('span', { class: 'lname gt-name', title: name }, name) : '', slot ? h('span', { class: 'gt-used' }, slot) : '',
      unused ? h('span', { class: 'gt-unused', title: 'Inserted, but in no level\'s graphics slots' }, 'unused') : '');
  }

  // ExAnimation sources (Lunar Magic's ExGFX 60-63)
  private buildAnimList(): void {
    const app = this.app;
    if (!this.onlyLevel || this.cur >= ANIM_FILE) {
      this.list.append(h('div', { class: 'gt-list-head', title: 'Frames for own tile animations (“Animations” tab); in Lunar Magic ExGFX60–63, uncompressed' }, 'Animation graphics'));
      for (let k = 0; k < 4; k++) {
        const i = ANIM_FILE + k;
        const name = gfxName(i);
        if (this.filter && !`${name} ${lmAnimName(i)}`.toLowerCase().includes(this.filter)) continue;
        this.list.append(h('div', {
          class: `level-item${i === this.cur ? ' current' : ''}${altFileAddr(app.rom, k) ? '' : ' unused'}`,
          title: `Lunar Magic: ${lmAnimName(i)}`,
          onclick: () => this.select(i),
        }, name));
      }
    }
  }

  // creates an empty animation source file (4 KB, 128 tiles)
  private async newAnimFile(n: number): Promise<void> {
    try {
      this.app.romEdit(`${gfxName(n)} created`, () => writeAltFile(this.app.rom, n - ANIM_FILE, new Uint8Array(0x1000)));
      this.reload();
    } catch (e) { toast(String(e instanceof Error ? e.message : e), 'error'); }
  }

  // asks the number for a new file (`f`; `want`: the number it has in its name), the author's when it
  // fits and is free, else the next free one of the file's range suggested; null: cancelled / none left
  private askNumber(title: string, f: GfxFileKind, want: number | null = null): Promise<number | null> {
    let n: number;
    try { n = gfxNumber(this.app.rom, want, new Set(), f); } catch (e) { toast(String(e instanceof Error ? e.message : e), 'error'); return Promise.resolve(null); }
    let done: (v: number | null) => void = () => {};
    const result = new Promise<number | null>((r) => (done = r));
    const range = gfxRangeFor(f) === 'asIs'
      ? `${gfxHex(AS_IS_FIRST)}–${gfxHex(MAX_GFX)} keep files as they are (layer 3 graphics and tilemaps)`
      : `ExGFX go in 80–${gfxHex(AS_IS_FIRST - 1)} (also 32–7F)`;
    const field = gfxNumberField(this.app.rom, n, { file: () => f, taken: () => new Set(), onChange: (v) => (n = v), author: want, by: 'file name' });
    modal(title, h('div', null, h('div', { class: 'prop' }, h('label', null, 'ExGFX number'), field), h('p', { class: 'hint' }, range)),
      [{ label: 'Cancel' }, { label: 'OK', primary: true, onClick: () => { done(n); } }], () => done(null));
    return result;
  }

  // creates an empty file under a number the user chooses; null: cancelled / failed
  // size: 0x1000 (4bpp), 0x800 (2bpp, layer 3) or 0x2000 (a layer 3 tilemap); slot: the one it is for
  private async newExGfx(hint = true, size = 0x1000, slot?: string): Promise<number | null> {
    const app = this.app;
    const n = await this.askNumber('New ExGFX', { slot, size });
    if (n === null) return null;
    if (gfxEntry(app.rom, n) && (await choose(`Overwrite ${gfxName(n)}?`, `An empty file replaces the contents of ${gfxName(n)} (undo with Ctrl+Z).`, [{ label: 'Cancel' }, { label: 'Overwrite', primary: true }])) !== 1) return null;
    try {
      app.romEdit(`${gfxName(n)} created`, () => {
        const old = gfxEntry(app.rom, n);
        if (old) app.rom.freeAt(old.addr);
        setGfxEntry(app.rom, n, app.rom.allocWrite(new Uint8Array(size)), true, size);
      });
      this.select(n);
      if (hint) toast(`${gfxName(n)} created (empty, ${size === 0x800 ? '2' : '4'}bpp). “Use in slot” on the right puts it into this level.`);
      return n;
    } catch (e) { toast(String(e instanceof Error ? e.message : e), 'error'); return null; }
  }

  // import into a number the user chooses (from the slot gallery: `slot`, or a file of a package: `into`,
  // which the number goes to in the same undo step); suggested: the number in the file name when it fits,
  // else the next free one of the file's range; the number it went to, null: cancelled
  async importNew(given?: File, into?: Package, slot?: string): Promise<number | null> {
    const file = given ?? await pickFile('.bin,.png,image/png');
    if (!file) return null;
    const png = /\.png$/i.test(file.name);
    const f: GfxFileKind = { slot, size: png ? undefined : gfxDataSize(new Uint8Array(await file.arrayBuffer())) };
    const n = await this.askNumber(`Import ${file.name}`, f, png ? null : exgfxName(file.name).num);
    if (n === null) return null;
    this.select(n);
    return png ? this.importPng(file, into) : this.importBin(file, into, n);
  }

  // ---------- tools bar ----------
  private buildTools(): void {
    const b = this.tools;
    clear(b);
    const tool = (t: Tool, label: string, key: string, title: string) => h('button', { class: this.tool === t ? 'active' : '', title: `${title} (${key})`, onclick: () => this.setTool(t) }, label);
    const gridBtn = (g: 0 | 8 | 16, label: string) => h('button', { class: this.grid === g ? 'active' : '', onclick: () => { this.grid = g; this.buildTools(); this.draw(); } }, label);
    b.append(
      h('span', { class: 'btn-group' },
        tool('pen', '✎ Pen', 'B', 'Draw; right click draws transparent'),
        tool('fill', '▧ Fill', 'F', 'Fill an area of the same color'),
        tool('pick', '⌖ Eyedropper', 'I', 'Take a color from the image (also Alt+click)'),
        tool('select', '⬚ Select', 'S', 'Select an area; dragging inside moves it, Enter/Esc drops it')),
      h('span', { class: 'btn-group' },
        h('button', { onclick: () => this.transform('h'), title: 'Flip the selection (or the tile under the last selection) horizontally' }, '↔'),
        h('button', { onclick: () => this.transform('v'), title: 'Flip vertically' }, '↕'),
        h('button', { onclick: () => this.transform('r'), title: 'Rotate by 90° (square selection only)' }, '⟳')),
      h('span', { class: 'sep' }),
      h('button', { onclick: () => this.copySel(), title: 'Copy selection (Ctrl+C)' }, 'Copy'),
      h('button', { onclick: () => this.pasteSel(), title: 'Paste at the selection, movable afterwards (Ctrl+V)' }, 'Paste'),
      h('span', { class: 'sep' }),
      h('span', { class: 'gt-viewctl' },
        h('span', { class: 'hint' }, 'Grid'), h('span', { class: 'btn-group' }, gridBtn(0, 'off'), gridBtn(8, '8'), gridBtn(16, '16')),
        this.zoomCtl.root,
        h('button', { title: 'Fit the whole file', onclick: () => this.fit() }, 'Fit')),
      h('span', { class: 'spacer' }),
      menuButton({ label: 'Import/Export', items: [
        { label: 'Import (.png) …', title: 'PNG (128 pixels wide) into this file; colors are mapped to the selected palette', onClick: () => void this.importPng() },
        { label: 'Import (.bin) …', title: 'Lunar Magic GFX/ExGFX (.bin) into this file', onClick: () => void this.importBin() },
        { label: 'Import several (.bin, .zip) …', title: 'GFX##.bin and ExGFX###.bin files (or a .zip of them), each to the number in its name; shows what changes first', onClick: () => void this.importMany() },
        { label: 'Export (.png)', title: 'File as PNG in the selected palette', onClick: () => this.exportPng() },
        { label: 'Export (.bin)', title: 'File as Lunar Magic extracts it: unpacked, 3bpp as 4bpp, named GFX##.bin / ExGFX###_Name.bin', onClick: () => void this.exportBin() },
        { label: 'Export all (.zip)', title: 'All GFX and ExGFX as .bin in Lunar Magic\'s folders (Graphics/, ExGraphics/)', onClick: () => void this.exportAll() },
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
      class: `gt-color${k === this.color ? ' sel' : ''}${k === 0 ? ' transp' : ''}`, title: k === 0 ? 'Color 0: transparent' : `Color ${k}`,
      style: k ? { background: css(v) } : {},
      onclick: () => { this.color = k; this.buildSide(); },
    }, String(k))));
    const used = this.levelSlots().filter((x) => x.file === f.num).map((x) => x.name);
    s.append(
      h('div', { class: 'prop-title' }, gfxName(f.num), f.empty ? h('span', { class: 'hint' }, ' (empty)') : ''),
      h('div', { class: 'hint' }, f.empty ? 'This number is not in use.' : `${f.bpp}bpp · ${f.tiles} tiles · ${f.raw ? 'uncompressed' : `LZ2 (${f.packed} bytes)`} · $${hex(f.addr, 6)}`),
      f.num >= ANIM_FILE ? h('div', { class: 'hint' }, `Frames for own tile animations (“Animations” tab). Lunar Magic: ${lmAnimName(f.num)}.`) : '',
      f.num >= ANIM_FILE && f.empty ? h('button', { onclick: () => void this.newAnimFile(f.num) }, 'Create (128 empty tiles)') : '',
      used.length ? h('div', { class: 'hint' }, `In the level as ${used.join(', ')}`) : h('div', { class: 'hint' }, 'Not used by the current level'),
      f.num < ANIM_FILE && !f.empty ? this.nameField(f.num) : '',
      f.num < ANIM_FILE && !f.empty ? this.assignMenu(f.num, used.length > 0) : '',
      f.num < ANIM_FILE && !f.empty ? usedInList(this.app, 'Used in levels', (this.usage().get(f.num) ?? []).map((u) => ({ level: u.level, text: u.slots.join(', ') })), 0,
        f.num >= VANILLA_GFX ? 'In no level\'s graphics slots: inserted, but unused.' : 'In no level\'s graphics slots.') : '',
      f.raw || f.empty ? '' : h('div', { class: 'prop' }, h('label', { title: 'How the file is read; drawing saves it in this format' }, 'Read as'),
        h('span', { class: 'btn-group' }, [2, 3, 4].map((b) => h('button', { class: f.bpp === b ? 'active' : '', title: b === f.auto ? 'Detected format' : 'Only choose if the graphics look wrong', onclick: () => { this.bppOverride = b === f.auto ? null : b; this.reload(); } }, `${b}bpp`)))),
      !f.raw && !f.empty && f.bpp !== f.auto ? h('div', { class: 'warn-box' }, `Detected: ${f.auto}bpp. Drawing here saves the file as ${f.bpp}bpp – the game then reads it that way.`) : '',
      h('div', { class: 'panel-title' }, 'Color', h('span', { class: 'hint' }, 'right click paints transparent')),
      sw,
      h('div', { class: 'panel-title' }, 'Palette', h('span', { class: 'hint' }, this.palRow < 0 ? 'automatic' : h('a', { href: '#', onclick: (e: Event) => { e.preventDefault(); this.palRow = -1; this.draw(); this.buildSide(); } }, 'automatic'))),
      rowSel,
      this.usageUi(),
    );
  }

  // the user's name of the file (exported as ExGFX###_Name.bin); without one, the package's
  private nameField(num: number): HTMLElement {
    const app = this.app, own = gfxUserName(app.rom, num) ?? '';
    const inp = h('input', { value: own, maxlength: GFX_NAME_MAX, placeholder: gfxLabels(app.rom)(num) ?? 'none', title: 'Part of the file name when exported (ExGFX###_Name.bin); without one, the name of the package that brought the file' });
    inp.addEventListener('change', () => {
      const v = inp.value.trim();
      if (v === own) return;
      try { app.romEdit(v ? `${gfxName(num)} named “${v}”` : `${gfxName(num)}: name removed`, () => setGfxName(app.rom, num, v)); }
      catch (e) { toast(String(e instanceof Error ? e.message : e), 'error'); }
    });
    return h('div', { class: 'prop' }, h('label', null, 'Name'), inp);
  }

  // "Use in slot": puts the open file into one of the level's slots (same as the card's "Swap")
  private assignMenu(num: number, used: boolean): HTMLElement {
    const items: MenuItem[] = [{ heading: `Level ${hex(this.app.level.number, 3)}` }];
    for (const s of this.levelSlots()) {
      items.push({
        label: `${s.name} – now ${s.file === 0xff ? 'empty' : gfxName(s.file)} (${s.sprite ? 'Sprites' : this.range(s).replace(/^Tiles/, 'tiles')})`,
        disabled: () => s.file === num || ((s.kind === 'lg' || s.kind === 'lt3') && !fitsLayer3Slot(this.app.rom, s.name, num)),
        onClick: () => void this.assignSlot(s, num),
      });
    }
    return h('div', { class: 'row' }, menuButton({ label: used ? 'Into another slot' : 'Use in slot', title: 'Put this file into a graphics slot of the current level', items }));
  }

  // Map16 tiles that use the focused 8x8 tile (when the file is in one of the level's layer slots)
  private usageUi(): HTMLElement | string {
    const t = this.focusTile;
    if (t < 0 || !this.file || t >= this.file.tiles) return h('p', { class: 'hint' }, 'A click with the eyedropper (or Alt+click) also shows which Map16 tiles use the 8x8 tile.');
    const slot = this.levelSlots().find((s) => s.file === this.cur && s.map16);
    const box = h('div', { class: 'gt-usage' }, h('div', { class: 'panel-title' }, `8x8 tile ${hex(t, 2)} of the file`));
    if (!slot) { box.append(h('div', { class: 'hint' }, "The file is in none of this level's layer slots.")); return box; }
    const num = slot.first + t;
    const src = map16Source(this.app.rom, this.app.render);
    const users: number[] = [];
    const max = EXT_TILES;
    for (let m = 0; m < max && users.length < 64; m++) if (src.fg(m).some((w) => (w & 0x3ff) === num)) users.push(m);
    // animated tiles: the game overwrites them, so drawing there does not show in the level
    const own = animsAt(this.app, num);
    const anim = own.length ? h('div', { class: 'warn-box' }, 'Animated by ', animLinks(this.ws, own), ' – the level shows its frames instead of this tile.')
      : this.animatedTiles().has(t) ? h('div', { class: 'warn-box' }, 'Animated by the game (original animation, e.g. ?-block, coin): the level shows its frames instead of this tile. To turn it off: Animations tab → “Play in level …”.') : '';
    box.append(h('div', { class: 'hint' }, `= VRAM tile ${hex(num, 3)} (${slot.name})`), anim,
      users.length ? h('div', { class: 'gt-users' }, users.map((m) => h('a', { href: '#', class: 'mono', title: 'Open in the Map16 tab', onclick: (e: Event) => { e.preventDefault(); this.ws.showMap16(m); } }, hex(m, 3))))
        : h('div', { class: 'hint' }, 'No Map16 tile uses it.'));
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
    const cw = Math.round(W * z), ch = Math.round(H * z);
    if (c.width !== cw || c.height !== ch) { c.width = cw; c.height = ch; }
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
    z = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
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
    // the largest zoom level at which the whole file fits
    const fits = Math.min((v.clientWidth - 4) / this.W(), (v.clientHeight - 4) / this.H());
    this.setZoom(zoomStep(fits + 1e-5, -1, ZOOM_MIN, ZOOM_MAX) ?? ZOOM_MIN);
  }
  private syncZoomUi(): void {
    this.zoomCtl.update();
  }

  // tiles of this file the game overwrites with animation frames (when it is in a layer slot)
  private animatedTiles(): Set<number> {
    const out = new Set<number>();
    const anim = this.app.animated();
    if (!anim) return out;
    for (const s of this.levelSlots()) {
      if (s.file !== this.cur || !s.map16) continue;
      for (let k = 0; k < 128; k++) if (anim.tiles.has(s.first + k)) out.add(k);
    }
    return out;
  }
  // Ctrl+click: the own animation that overwrites the tile, in the Animations tab
  private gotoAnim(t: number): void {
    const slot = this.levelSlots().find((s) => s.file === this.cur && s.map16);
    const own = slot ? animsAt(this.app, slot.first + t) : [];
    if (own.length) { this.ws.showAnim(own[0].global, own[0].slot); return; }
    toast(this.animatedTiles().has(t) ? `Tile ${hex(t, 2)} is animated by the game itself, not by an own animation.` : `Tile ${hex(t, 2)} is not animated.`);
  }
  private warned = new Set<string>(); // file:tile already warned about

  private warnAnimated(x: number, y: number): void {
    const t = (y >> 3) * 16 + (x >> 3);
    const key = `${this.cur}:${t}`;
    if (this.warned.has(key) || !this.animatedTiles().has(t)) return;
    this.warned.add(key);
    toast(`Tile ${hex(t, 2)} is animated in the game: the game keeps overwriting it with animation frames, so the change does not show there.`, 'error');
  }

  private commit(label: string): void {
    const f = this.file;
    if (!f || f.empty) { toast(f ? `${gfxName(f.num)} is empty – nothing to export` : 'Choose a file on the left first'); return; }
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
      if (e.button === 0 && (e.ctrlKey || e.metaKey)) { this.gotoAnim((p.y >> 3) * 16 + (p.x >> 3)); return; }
      const tool: Tool = e.altKey ? 'pick' : this.tool;
      if (tool === 'pick') {
        this.color = this.get(p.x, p.y);
        this.focusTile = (p.y >> 3) * 16 + (p.x >> 3);
        this.draw(); this.buildSide();
        return;
      }
      if (f.empty) { toast(f.num >= ANIM_FILE ? 'The file does not exist yet – “Create” on the right' : 'This number is empty – “+ New ExGFX” creates a file'); return; }
      if (f.bpp !== f.auto && this.bppOk !== f.num) {
        void choose(`Save ${gfxName(f.num)} as ${f.bpp}bpp?`, `The file was detected as ${f.auto}bpp and is currently read as ${f.bpp}bpp. Drawing saves it in this format. That is only right if the detection was wrong.`,
          [{ label: 'Cancel' }, { label: `Back to ${f.auto}bpp` }, { label: `Edit as ${f.bpp}bpp`, primary: true }]).then((c) => {
          if (c === 1) { this.bppOverride = null; this.reload(); }
          if (c === 2) this.bppOk = f.num;
        });
        return;
      }
      const v = e.button === 2 ? 0 : this.color;
      if (tool === 'pen' || tool === 'fill') this.warnAnimated(p.x, p.y);
      if (tool === 'fill') { this.fill(p.x, p.y, v); this.draw(); this.app.renderPause(); this.commit('Fill'); return; }
      let last = p;
      let move: (ev: MouseEvent) => void;
      let label = 'Draw';
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
          label = 'Move';
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
          if (label === 'Draw') this.commit(label);
        }
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
    let lastHover = -1;
    c.addEventListener('mousemove', (e) => {
      if (this.stroke) return;
      const p = pos(e);
      // eyedropper (tool or Alt held): pipette cursor and the color under it
      const picking = this.tool === 'pick' || e.altKey;
      c.classList.toggle('pipette', picking);
      if (picking && this.file && p.x >= 0 && p.y >= 0 && p.x < this.W() && p.y < this.H()) {
        const v = this.get(p.x, p.y);
        showColorLoupe(e, v ? this.colors()[v] : null, `Color ${v}`);
      } else hideColorLoupe();
      const t = (p.y >> 3) * 16 + (p.x >> 3);
      if (p.y * 128 + p.x === lastHover) return;
      lastHover = p.y * 128 + p.x;
      const spr = t < 0x80 ? this.levelSlots().filter((s) => s.sprite && s.file === this.cur).map((s) => ` · sprite tile ${spriteTile(s.first, t)}`).join('') : '';
      c.title = `Tile ${hex(t, 2)}${spr}${this.animatedTiles().has(t) ? ' (animated – Ctrl+click: open its animation)' : ''} · pixel ${p.x & 7},${p.y & 7} · color ${this.file ? this.get(Math.max(0, p.x), Math.max(0, p.y)) : ''}`;
    });
    c.addEventListener('mouseleave', () => { c.classList.remove('pipette'); hideColorLoupe(); });
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
    this.commit('Selection moved');
    this.draw();
  }

  private copySel(): void {
    const r = this.float ?? this.sel;
    if (!r) { toast('First select an area with the selection tool (S)'); return; }
    const pix = new Uint8Array(r.w * r.h);
    for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) pix[y * r.w + x] = this.get(r.x + x, r.y + y);
    this.clip = { w: r.w, h: r.h, pix };
    toast(`${r.w}×${r.h} pixels copied`);
  }
  private pasteSel(): void {
    const c = this.clip;
    if (!c) { toast('Copy something first'); return; }
    this.dropFloat();
    const at = this.sel ?? { x: 0, y: 0 };
    this.float = { x: at.x, y: at.y, w: c.w, h: c.h, pix: c.pix.slice() };
    this.tool = 'select';
    this.buildTools();
    this.draw();
  }

  private transform(kind: 'h' | 'v' | 'r'): void {
    if (!this.float) { if (!this.sel) { toast('First select an area with the selection tool (S)'); return; } this.lift(); }
    const fl = this.float!;
    if (kind === 'r' && fl.w !== fl.h) { toast('Rotating only works with a square selection'); return; }
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
    if (!f || f.empty) { toast(f ? `${gfxName(f.num)} is empty – nothing to export` : 'Choose a file on the left first'); return; }
    const W = 128, H = this.H();
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d')!;
    const img = ctx.createImageData(W, H);
    const px = new Uint32Array(img.data.buffer);
    const cols = this.colors();
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const v = this.get(x, y); px[y * W + x] = v ? cols[v] : 0; }
    ctx.putImageData(img, 0, 0);
    c.toBlob(async (b) => { if (b) { const name = `${f.num >= ANIM_FILE ? lmAnimName(f.num) : gfxName(f.num)}.png`; if (await downloadBytes(name, new Uint8Array(await b.arrayBuffer()), 'image/png')) toast(`${name} exported`); } }, 'image/png');
  }

  // the file as Lunar Magic extracts it (animation graphics: as its ExGFX60-63)
  private async exportBin(): Promise<void> {
    const f = this.file;
    if (!f || f.empty) { toast(f ? `${gfxName(f.num)} is empty – nothing to export` : 'Choose a file on the left first'); return; }
    const rom = this.app.rom, anim = f.num >= ANIM_FILE;
    const data = anim ? readAltFile(rom, f.num - ANIM_FILE) : gfxBinData(rom, f.num);
    if (!data) return;
    const name = anim ? `${lmAnimName(f.num)}.bin` : gfxBinName(rom, f.num);
    if (await downloadBytes(name, data)) toast(`${name} exported`);
  }

  private async exportAll(): Promise<void> {
    if (await downloadBytes('graphics.zip', exportAllGfx(this.app.rom), 'application/zip')) toast('graphics.zip exported (Graphics/, ExGraphics/)');
  }

  // several .bin files (or .zip files of them), each to the number in its name: what changes is shown
  // first, then all of it is one ROM edit
  private async importMany(): Promise<void> {
    const app = this.app;
    const picked = await pickFiles('.bin,.zip');
    if (!picked.length) return;
    const files: BinFile[] = [];
    try { for (const f of picked) files.push(...binFiles(f.name, new Uint8Array(await f.arrayBuffer()))); }
    catch (e) { toast(`Could not read the files: ${e instanceof Error ? e.message : e}`, 'error'); return; }
    if (!files.length) { toast('No .bin files found'); return; }
    const plan = planGfxBins(app.rom, files);
    const todo = plan.filter((x) => x.status === 'new' || x.status === 'replace');
    const count = (s: BinPlanItem['status']) => plan.filter((x) => x.status === s).length;
    const result = (x: BinPlanItem) => x.status === 'new' ? 'new' : x.status === 'replace' ? 'replaces the file' : x.status === 'unchanged' ? 'unchanged' : `skipped: ${x.why}`;
    const body = h('div', null,
      h('p', null, `${count('new')} new, ${count('replace')} replaced, ${count('unchanged')} unchanged, ${count('skip')} skipped. A descriptive name in the file name (ExGFX80_Name.bin) becomes the file's name.`),
      h('div', { style: 'max-height:60vh;overflow:auto' }, h('table', { class: 'uber-table' },
        h('tr', null, h('th', null, 'File'), h('th', null, 'Into'), h('th', null, 'Result')),
        // what changes first, what is unchanged last
        [...plan].sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status)).map((x) => h('tr', null,
          h('td', { class: 'mono' }, x.path),
          h('td', { class: 'mono' }, x.num === null ? '–' : gfxName(x.num)),
          h('td', { class: x.status === 'skip' ? 'err' : x.status === 'unchanged' ? 'hint' : '' }, result(x)))))));
    const go = () => {
      try {
        app.romEdit(`${todo.length} graphics file${todo.length > 1 ? 's' : ''} imported`, () => applyGfxBins(app.rom, plan));
        toast(`${todo.length} graphics file${todo.length > 1 ? 's' : ''} imported`);
      } catch (e) { toast(String(e instanceof Error ? e.message : e), 'error'); }
    };
    modal(`Import ${files.length} graphics file${files.length > 1 ? 's' : ''}`, body,
      todo.length ? [{ label: 'Cancel' }, { label: `Import ${todo.length}`, primary: true, onClick: go }] : [{ label: 'Close' }]);
  }

  // writes an imported file as one undoable ROM edit; into: the package that gets the new number
  private importEdit<T>(label: string, into: Package | undefined, write: () => T): T {
    return this.app.romEdit(label, () => {
      if (!into) return write();
      let value!: T;
      recordPackageChange(this.app.rom, into, () => { value = write(); return { ok: true }; });
      return value;
    });
  }

  // the number the image went to; null: cancelled or failed
  private async importPng(given?: File, into?: Package): Promise<number | null> {
    const f = this.file;
    if (!f) return null;
    const file = given ?? await pickFile('.png,image/png');
    if (!file) return null;
    const bmp = await createImageBitmap(file);
    if (bmp.width !== 128) { toast('The image must be 128 pixels wide (16 tiles)', 'error'); return null; }
    let raw = f.raw, newBpp = 4;
    if (f.empty && f.num >= ANIM_FILE) raw = true;
    else if (f.empty && gfxRange(f.num) === 'asIs') {
      // kept as it is: uncompressed, no 3bpp
      const c = await choose(`Create ${gfxName(f.num)}`, 'Save in which format? (E00–FFF hold files as they are)', [{ label: 'Cancel' }, { label: '2bpp uncompressed (layer 3 graphics, 4 colors)' }, { label: '4bpp uncompressed (16 colors)', primary: true }]);
      if (!c) return null;
      raw = true;
      newBpp = c === 1 ? 2 : 4;
    } else if (f.empty) {
      const c = await choose(`Create ${gfxName(f.num)}`, 'Save in which format?', [{ label: 'Cancel' }, { label: 'LZ2 (like the original, 3bpp/8 colors)' }, { label: '4bpp uncompressed (16 colors)', primary: true }]);
      if (!c) return null;
      raw = c === 2;
    } else if ((await choose(`Overwrite ${gfxName(f.num)}?`, `The image replaces the contents of ${gfxName(f.num)}. Colors are mapped to palette ${hex(this.row(), 1)}. (Undo with Ctrl+Z.)`, [{ label: 'Cancel' }, { label: 'Overwrite', primary: true }])) !== 1) return null;
    // an uncompressed file keeps its format (2bpp layer 3 graphics, 4bpp), a new one is 4bpp
    const bpp = raw ? (f.raw && !f.empty ? f.bpp : newBpp) : f.empty ? 3 : f.bpp;
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
    const tiles = f.num >= ANIM_FILE ? Math.min(0x400, Math.floor(bmp.height / 8) * 16) : raw ? (f.raw && !f.empty ? f.tiles : 128) : Math.floor(bmp.height / 8) * 16;
    const pix = new Uint8Array(tiles * 64);
    for (let t = 0; t < tiles; t++) {
      const bx = (t & 15) * 8, by = (t >> 4) * 8;
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) pix[t * 64 + y * 8 + x] = by + y < bmp.height ? nearest(px[(by + y) * 128 + bx + x]) : 0;
    }
    const nf: GfxFile = { ...f, raw, bpp, tiles, pix, empty: false };
    try {
      this.importEdit(`${file.name} → ${gfxName(f.num)}`, into, () => {
        const enc = encodeGfx(nf);
        if (f.num >= ANIM_FILE) { writeAltFile(this.app.rom, f.num - ANIM_FILE, enc); return; }
        const payload = raw ? enc : lz2Compress(enc);
        if (!f.empty) this.app.rom.freeAt(f.addr);
        setGfxEntry(this.app.rom, f.num, this.app.rom.allocWrite(payload), raw, payload.length);
      });
      this.bppOverride = f.empty || raw ? null : bpp;
      this.reload();
      toast(`${file.name} imported`);
      return f.num;
    } catch (e) { toast(String(e instanceof Error ? e.message : e), 'error'); return null; }
  }

  // the number the file went to (`to`: the one chosen for it); null: cancelled or failed
  private async importBin(given?: File, into?: Package, to?: number): Promise<number | null> {
    const file = given ?? await pickFile('.bin');
    if (!file) return null;
    let target = to ?? this.cur;
    const n = exgfxName(file.name).num;
    // the file name names a number (unless one was chosen): Lunar Magic's ExGFX 60-63 can also mean the
    // animation files
    const targets: number[] = [];
    if (to === undefined && n !== null && !gfxNumberProblem(n) && n !== this.cur) targets.push(n);
    if (n !== null && n >= 0x60 && n <= 0x63 && ANIM_FILE + n - 0x60 !== this.cur) targets.push(ANIM_FILE + n - 0x60);
    const what = (t: number) => (t >= ANIM_FILE ? 'animation graphic' : 'layer/sprite graphics');
    if (targets.length) {
      const c = await choose('Choose target', `The file name says ExGFX${hex(n!, 2)}. Where should the graphics go?${targets.length > 1 ? ` Lunar Magic uses ExGFX60–63 as frames for animations (here ${gfxName(ANIM_FILE)}–D).` : ''}`,
        [{ label: 'Cancel' }, { label: `Into ${gfxName(this.cur)} (current file)` }, ...targets.map((t, i) => ({ label: `Into ${gfxName(t)} (${what(t)})`, primary: i === targets.length - 1 }))]);
      if (!c) return null;
      if (c >= 2) target = targets[c - 2];
    }
    if ((target === this.cur || !targets.length) && (target >= ANIM_FILE ? altFileAddr(this.app.rom, target - ANIM_FILE) : gfxEntry(this.app.rom, target))
      && (await choose(`Overwrite ${gfxName(target)}?`, `${file.name} replaces the contents of ${gfxName(target)} (undo with Ctrl+Z).`, [{ label: 'Cancel' }, { label: 'Overwrite', primary: true }])) !== 1) return null;
    try {
      const data = new Uint8Array(await file.arrayBuffer());
      if (target >= ANIM_FILE) {
        if (data.length % 32 || data.length > ALT_FILE_MAX) throw new Error('Animation graphic: an uncompressed 4bpp file of up to 1023 tiles is expected');
        this.importEdit(`${file.name} → ${gfxName(target)}`, into, () => writeAltFile(this.app.rom, target - ANIM_FILE, data));
        this.select(target);
        toast(`${file.name} → ${gfxName(target)}`);
        return target;
      }
      const named = parseGfxBinName(file.name);
      const kind = this.importEdit(`${file.name} → ${gfxName(target)}`, into, () => {
        const what = storeGfxBin(this.app.rom, target, data);
        if (named?.name && named.num === target) setGfxName(this.app.rom, target, named.name);
        return what;
      });
      this.select(target);
      toast(`${file.name} → ${gfxName(target)} (${kind})`);
      return target;
    } catch (e) { toast(String(e instanceof Error ? e.message : e), 'error'); return null; }
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
