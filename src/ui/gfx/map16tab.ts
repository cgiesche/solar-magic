// Map16 tab: the tile sheet (pages, labelled ranges, multi-selection, copy/paste), a builder showing the
// whole selection (quarters marked as a set; palette dots, flips mirroring them as one picture, the priority
// toggle and acts-like for the marked ones; Ctrl+wheel zoom, middle button pan) and the level's 8x8 graphics grouped by GFX slot. The
// graphics view uses the palette of the quarter under the mouse, else of the first marked one. Clicking or
// dragging there chooses 8x8 tiles; a right click in the builder puts them with their top-left corner on
// the quarter under the mouse (right drag paints), as does dropping them there; Enter puts a single one
// into every marked quarter, a block from the first marked one. Move takes the selected tiles to other
// numbers with every use (tilemove.ts); dragging the selection in the sheet chooses where.

import type { App } from '../app.ts';
import type { GfxWorkspace, WsPanel } from '../gfxworkspace.ts';
import { menuButton } from '../menu.ts';
import { h, clear, toast, modal, choose, attachPanZoom } from '../dom.ts';
import { pickFile, downloadBytes } from '../platform.ts';
import { TileCache } from '../../core/render.ts';
import { hex } from '../../core/names.ts';
import { EXT_FIRST, EXT_TILES, actsLike, setActsLike } from '../../core/map16ext.ts';
import { BG_EXT_FIRST, bgTileAddr, bgTileWords, setBgExtTileWords } from '../../core/bgmap16.ts';
import { blockFileOf, blockFilesByTile } from '../blockdialog.ts';
import { openResources } from '../resources.ts';
import { parseMap16File, map16Targets, writeMap16File, type Map16File } from '../../core/map16file.ts';
import { renderMap16Sheet } from '../panels.ts';
import { probeText } from '../../core/blockprobe.ts';
import { VANILLA_GFX } from '../../core/patches.ts';
import { ANIM_FILE } from '../../core/gfxfiles.ts';
import { levelSlots, layerSlots, slotOfTile, type GfxSlot } from '../../core/gfxslots.ts';
import { cgramToRGBA } from '../../core/gfx.ts';
import { tileMatches, drawTileMatches } from '../tilesearch.ts';
import { animsAt, animLinks } from './animtab.ts';
import { fgTileUsers, bgTileUsers, tileLinks, unusedFgTiles, isTilesetTile, TILE_SOURCES } from '../../core/levelusage.ts';
import { usedInList } from '../usedin.ts';
import { map16Source, fgTileAddr, setFgWords } from '../../core/render.ts';
import { remapTile, remapLine, slotRemapLine, parseRemap } from '../../core/remap.ts';
import { remapEditor, type RemapEditor } from '../remaplist.ts';
import { planMove, applyMove, planRemap, rectMap, type MovePlan, type MoveSource } from '../../core/tilemove.ts';
import { levelSource, planList, openRemapUses } from '../tileuses.ts';
import { loadAsar } from '../../core/asar.ts';
import { QuarterGrid, markRect, editMarked, setPalette, setBit, setTileNum, stamp, mirror, summary, wholeTiles, FLIP_X, FLIP_Y, PRIO, type QuarterEdit, type MarkMode, type BitState } from '../../core/quarters.ts';

const Z = 2; // sheet zoom
const M = 34; // sheet margin for the ranges and row numbers
const BZ = 12; // largest fitted builder zoom
const GFX_W = 'mt-gfx-width'; // the graphics column's width (localStorage)
const LABELS_W = 92; // the slot names left of the 8x8 graphics
const QUARTER_NAMES = ['top left', 'bottom left', 'top right', 'bottom right'];

interface Clip { w: number; h: number; words: number[][]; acts: number[] | null }
// the remap panel: the list editor, which tiles it changes ('sel': the selected ones, 'uses': the
// extended tiles 200-FFF that use one of the list's source 8x8 tiles)
export type RemapScope = 'sel' | 'uses';
interface Remapping { ed: RemapEditor; scope: RemapScope; box: HTMLElement; scopes: HTMLElement; status: HTMLElement; preview: HTMLElement }
// what an offer fills in when it opens the remap
export interface RemapFill { line?: string; scope?: RemapScope; bg?: boolean }
// the move panel: where the selection's top left tile goes (-1: not a valid number), the plan for it
// (pending: levels the usage index has not looked through yet for tiles placed by objects' code)
interface Moving { to: number; box: HTMLElement; input: HTMLInputElement; status: HTMLElement; plan: { plan: MovePlan; src: MoveSource; pending: number } | null }
// a tile the remap changes: its words and acts-like before and after
interface RemapRow { tile: number; words: number[]; acts: number | null; newWords: number[]; newActs: number | null; out: number[]; changed: boolean }
type Cell = { x: number; y: number };
// "tileset 1", "tilesets 0, 7, C"
const tilesetNames = (ts: number[]) => `tileset${ts.length > 1 ? 's' : ''} ${ts.map((x) => hex(x, 1)).join(', ')}`;

// a file's name; the Anim graphics are numbered past the ExGFX (gfxfiles.ts)
export function gfxName(n: number): string {
  if (n >= ANIM_FILE) return `Anim graphic ${'ABCD'[n - ANIM_FILE]}`;
  return `${n < VANILLA_GFX ? 'GFX' : 'ExGFX'}${hex(n, 2)}`;
}
// Lunar Magic's name of an animation file (ExGFX60-63)
export function lmAnimName(n: number): string {
  return `ExGFX${hex(n - ANIM_FILE + 0x60, 2)}`;
}

export class Map16Tab implements WsPanel {
  root: HTMLElement;
  private app: App;
  private ws: GfxWorkspace;
  private bg = false;
  private sel = 0x130;
  private selW = 1;
  private selH = 1;
  // the marked quarters (keys of the selection's QuarterGrid), for the selection marksOf names
  private marks = new Set<number>();
  private marksOf = '';
  private hoverQ: number | null = null; // quarter under the mouse in the builder
  private bzoom: number | null = null; // builder zoom, null: fitted into the column
  private gfxW = 470;
  private gzoom: number | null = null; // 8x8 graphics zoom, null: fitted into the column
  private gzPx = 3; // the graphics canvas' pixels per SNES pixel (the zoom rounded up)
  private clip: Clip | null = null;
  private sameActs = false; // mark tiles that act like the selected one
  private markUnused = false; // mark tiles 200-FFF defined but used nowhere
  private unused: Set<number> | null = null; // (known once every level's tiles are)
  private usesBox = h('div', { class: 'mt-uses' });
  private visible = false;
  private bar = h('div', { class: 'ws-bar' });
  // all pages of 256 tiles in one list, each drawn once it scrolls into view
  private scroll = h('div', { class: 'mt-scroll' });
  private pages: HTMLCanvasElement[] = [];
  private heads: HTMLElement[] = [];
  private near = new Set<number>(); // pages in or near the view
  private dirty = new Set<number>(); // pages to draw once they come near the view
  private topPage = 0; // page at the top of the list
  private pageBar = h('span', { class: 'btn-group m16-pages' });
  private search = h('input', { type: 'text', class: 'mt-search', placeholder: 'Tile no. (hex) or block file …', spellcheck: false, autocomplete: 'off',
    title: 'Dims the tiles that do not match; Enter selects the tile once only one is left' });
  private match: number[] | null = null;
  private scrollPending = false; // selected while hidden: scroll there when shown
  private builder = h('div', { class: 'mt-builder' });
  private builderCol = h('div', { class: 'mt-col mt-builder-col' }, this.builder);
  private bHead = h('div', { class: 'mt-builder mt-builder-ctl' });
  private bCtl = h('div', { class: 'mt-builder mt-builder-ctl' });
  private qInfo = h('div', { class: 'hint' });
  private bigCanvas = h('canvas', { class: 'mt-big' });
  private bigScroll = h('div', { class: 'mt-big-scroll' }, this.bigCanvas);
  private gfxTitle = h('div', { class: 'panel-title' });
  private gfxLabels = h('div', { class: 'mt-gfx-labels' });
  private gfxCanvas = h('canvas', { class: 'mt-gfx-canvas' });
  private gfxScroll = h('div', { class: 'mt-gfx-scroll' }, h('div', { class: 'mt-gfx-wrap' }, this.gfxLabels, this.gfxCanvas));
  private gfxCol = h('div', { class: 'mt-col mt-gfx-col' }, this.gfxTitle, this.gfxScroll);
  private remapping: Remapping | null = null;
  private moving: Moving | null = null;
  // the visual mode: the marked source 8x8 tiles (cells of the graphics view), where they are dragged to
  private visualFrom: { x: number; y: number; w: number; h: number } | null = null;
  private visualTo: Cell | null = null;

  // the open level's graphics slots
  private gfxSlots(): GfxSlot[] {
    const lv = this.app.level;
    return levelSlots(this.app.rom, lv.number, lv.header);
  }

  constructor(app: App, ws: GfxWorkspace) {
    this.app = app;
    this.ws = ws;
    this.root = h('div', { class: 'mt' }, this.bar,
      h('div', { class: 'mt-main' },
        h('div', { class: 'mt-col mt-sheet-col' }, this.scroll),
        this.builderCol,
        this.splitter(),
        this.gfxCol));
    this.buildPages();
    this.attachSheet();
    this.attachSearch();
    this.attachGfx();
    this.attachBig();
    const redraw = () => { this.unused = null; if (this.visible) this.redraw(); };
    app.on('rom-change', redraw);
    app.on('render', redraw);
    app.on('probes', () => { if (this.visible) this.buildBuilder(); });
    app.on('animated', redraw);
    app.on('level-uses', () => { this.unused = null; if (this.visible) { this.buildUses(); if (this.markUnused) this.drawSheet(); } });
  }

  previewHint(): string {
    return 'Click: edit the tile under the mouse · marked: where the selected tile occurs in the level';
  }

  show(): void {
    this.visible = true;
    this.buildBar();
    this.redraw();
    if (this.scrollPending) requestAnimationFrame(() => this.scrollToSel());
  }
  hide(): void { this.visible = false; }

  get selected(): { tile: number; bg: boolean } { return { tile: this.sel, bg: this.bg }; }

  select(tile: number, bg = false): void {
    this.bg = bg;
    this.sel = tile & (EXT_TILES - 1);
    this.selW = this.selH = 1;
    this.marksOf = '';
    if (this.visible) { this.buildBar(); this.redraw(); this.scrollToSel(); } else this.scrollPending = true;
  }

  // ---------- data ----------
  private tileAddr(t: number): number {
    return this.bg ? bgTileAddr(this.app.rom, t) ?? -1 : fgTileAddr(this.app.rom, this.app.render, t);
  }
  words(t: number): number[] {
    const a = this.tileAddr(t);
    if (a < 0) return bgTileWords(this.app.rom, t);
    return [0, 1, 2, 3].map((q) => this.app.rom.r16(a + q * 2));
  }
  private setWords(t: number, ws: number[]): void {
    if (!this.bg) setFgWords(this.app.rom, this.app.render, t, ws);
    else if (t >= BG_EXT_FIRST) setBgExtTileWords(this.app.rom, t, ws);
    else { const a = this.tileAddr(t); ws.forEach((v, q) => this.app.rom.w16(a + q * 2, v)); }
  }
  private tc(): TileCache {
    const r = this.app.render;
    return new TileCache(r.vram, r.cgram, (this.bg ? r.ppuRegs[0x0b] >> 4 : r.ppuRegs[0x0b] & 0x0f) << 13);
  }
  private tileName(t: number): string {
    return `${this.bg ? 'BG' : 'FG'} tile ${hex(t, 3)}`;
  }

  private edit(label: string, fn: () => void, key: string | null = null): void {
    try { this.app.romEdit(label, fn, { key }); } catch (e) { toast(String(e instanceof Error ? e.message : e), 'error'); }
  }

  // ---------- marked quarters ----------
  private grid(): QuarterGrid { return new QuarterGrid(this.selW, this.selH); }
  // the marks; a new selection starts with every quarter marked and the builder fitted
  private marked(): Set<number> {
    const of = `${this.bg}:${this.sel}:${this.selW}x${this.selH}`;
    if (of !== this.marksOf) { this.marksOf = of; this.marks = this.grid().all(); this.bzoom = null; this.hoverQ = null; }
    return this.marks;
  }
  private setMarks(m: Set<number>): void {
    this.marked();
    this.marks = m;
    this.buildBuilder();
    this.drawGfx();
  }
  private selWords(): number[][] { return this.selection().map((t) => this.words(t)); }
  // the quarter the graphics view follows: under the mouse, else the first marked (else the first)
  private focusQ(): number {
    const m = this.marked();
    return this.hoverQ ?? (m.size ? Math.min(...m) : 0);
  }
  private wordAt(key: number): number {
    const { tile, q } = this.grid().locate(key);
    return this.words(this.selection()[tile])[q];
  }
  private editLabel(n: number, what: string): string {
    return n === 1 && this.selW * this.selH === 1 ? `${this.tileName(this.sel)}: ${what}` : `${n} ${this.bg ? 'BG' : 'FG'} tile${n > 1 ? 's' : ''}: ${what}`;
  }
  // the changed tiles in one ROM edit (one undo step)
  private writeTiles(e: QuarterEdit, what: string, key: string | null = null): void {
    if (!e.changed.length) return;
    const tiles = this.selection();
    this.edit(this.editLabel(e.changed.length, what), () => { for (const i of e.changed) this.setWords(tiles[i], e.words[i]); }, key);
  }
  private editQuarters(fn: (w: number) => number, what: string): void {
    const m = this.marked();
    if (!m.size) { toast('Mark quarters first (click, drag or Ctrl+A in the builder)'); return; }
    this.writeTiles(editMarked(this.grid(), this.selWords(), m, fn), what);
  }
  // priority toggles: on for every marked quarter, off once all have it
  private togglePrio(): void {
    const state = summary(this.grid(), this.selWords(), this.marked()).prio;
    this.editQuarters(setBit(PRIO, state !== 'on'), `Priority ${state === 'on' ? 'off' : 'on'}`);
  }
  // the marked quarters mirrored as one picture (acts-like stays with its tile)
  private flip(bit: number, what: string): void {
    const m = this.marked();
    if (!m.size) { toast('Mark quarters first (click, drag or Ctrl+A in the builder)'); return; }
    const e = mirror(this.grid(), this.selWords(), m, bit);
    if (!e) { toast(`Mark a rectangle (or a shape symmetric to the ${bit === FLIP_X ? 'vertical' : 'horizontal'} axis) to flip it`); return; }
    this.writeTiles(e, what);
  }
  // key: a stroke's edits merge into one undo step (and say nothing about cut off tiles)
  private stampAt(at: { x: number; y: number }, block: number[][], key: string | null = null): void {
    const r = stamp(this.grid(), this.selWords(), at, block);
    const n = block.length * (block[0]?.length ?? 0);
    this.writeTiles(r, n === 1 ? `8x8 tile ${hex(block[0][0], 3)}` : `${block[0].length}×${block.length} graphics`, key);
    if (r.cut && !key) toast(`${r.cut} of ${n} 8x8 tiles were outside the selection and cut off`);
  }

  // ---------- UI ----------
  private buildBar(): void {
    clear(this.bar);
    const layer = (bg: boolean, label: string, title: string) => h('button', {
      class: this.bg === bg ? 'active' : '', title,
      onclick: () => { if (this.bg === bg) return; this.bg = bg; this.sel = this.sel & 0x1ff; this.selW = this.selH = 1; this.buildBar(); this.redraw(); this.scrollToSel(); },
    }, label);
    clear(this.pageBar);
    for (let p = 0; p < this.pages.length; p++) {
      this.pageBar.appendChild(h('button', {
        class: p === this.topPage ? 'active' : '',
        title: p < 2 ? `Page ${p}: ${this.bg ? 'BG tiles of the original backgrounds' : p ? 'standard tiles' : 'standard and tileset tiles'}`
          : `Page ${hex(p, 1)}: extended ${this.bg ? 'BG ' : ''}tiles${this.bg ? '' : ' (in the level via Direct Map16 object)'}`,
        onclick: () => this.scrollToPage(p),
      }, hex(p, 1)));
      this.heads[p].replaceChildren(`Page ${hex(p, 1)}`);
    }
    this.bar.append(
      h('span', { class: 'btn-group' },
        layer(false, 'Foreground', 'FG tiles (layer 1 and layer 2 objects)'),
        layer(true, 'Background', 'BG tiles (layer 2 backgrounds)')),
      this.pageBar,
      this.search,
      h('span', { class: 'sep' }),
      h('button', { onclick: () => this.copy(), title: 'Copy the selected tiles, with acts-like (Ctrl+C)' }, 'Copy'),
      h('button', { onclick: () => this.paste(), title: 'Paste starting at the selected tile (Ctrl+V)' }, 'Paste'),
      h('button', { class: this.remapping ? 'active' : '', onclick: () => (this.remapping ? this.closeRemap() : this.openRemap()),
        title: 'Change the 8x8 tile numbers, palettes or acts-like of tiles in bulk (Lunar Magic\'s Remap)' }, 'Remap …'),
      h('button', { class: this.moving ? 'active' : '', onclick: () => (this.moving ? this.closeMove() : this.openMove()),
        title: 'Move the selected tiles to other numbers, with every level, prefab and block using them' }, 'Move …'),
      this.bg ? '' : h('label', { class: 'toggle', title: 'Mark all tiles that act like the selected one' },
        (() => { const cb = h('input', { type: 'checkbox', checked: this.sameActs }); cb.addEventListener('change', () => { this.sameActs = cb.checked; this.drawSheet(); }); return cb; })(),
        'Mark same acts-like'),
      this.bg ? '' : h('label', { class: 'toggle', title: 'Mark the tiles 200–FFF that have graphics, an acts-like setting or a block but are in no level and no prefab' },
        (() => { const cb = h('input', { type: 'checkbox', checked: this.markUnused }); cb.addEventListener('change', () => { this.markUnused = cb.checked; this.drawSheet(); }); return cb; })(),
        'Mark unused'),
      h('span', { class: 'spacer' }),
      menuButton({ label: 'Import/Export', items: [
        { label: 'Import (.map16) …', title: 'Insert a Lunar Magic .map16 starting at the selected tile', onClick: () => void this.importMap16() },
        { label: 'Export (.map16)', title: 'Save the selected tiles (with acts-like) as .map16', onClick: () => this.exportMap16() },
      ] }),
    );
  }

  private redraw(): void {
    this.drawSheet();
    this.buildBuilder();
    this.drawGfx();
    this.ws.preview.highlight = new Set(this.bg ? [] : this.selection());
    this.ws.preview.drawHighlight();
  }

  private selection(): number[] {
    const out: number[] = [];
    for (let y = 0; y < this.selH; y++) for (let x = 0; x < this.selW; x++) out.push(this.sel + y * 16 + x);
    return out;
  }

  // the sheet: one canvas per page of 256 tiles (16x16) under its heading, with a margin showing what the
  // ranges are
  private buildPages(): void {
    const observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const p = this.pages.indexOf(e.target as HTMLCanvasElement);
        if (!e.isIntersecting) { this.near.delete(p); continue; }
        this.near.add(p);
        if (this.dirty.has(p)) this.drawPage(p);
      }
    }, { root: this.scroll, rootMargin: '300px 0px' });
    for (let p = 0; p < EXT_TILES / 256; p++) {
      const c = h('canvas', { class: 'mt-sheet', width: 256 * Z + M, height: 256 * Z });
      const head = h('div', { class: 'pal-head' });
      this.pages.push(c);
      this.heads.push(head);
      this.dirty.add(p);
      observer.observe(c);
      this.scroll.append(head, c);
    }
    this.scroll.addEventListener('scroll', () => this.pageScrolled());
  }

  // pages near the view are drawn now, the others once they come near it
  private drawSheet(): void {
    for (let p = 0; p < this.pages.length; p++) {
      if (this.near.has(p)) this.drawPage(p); else this.dirty.add(p);
    }
  }

  private drawPage(p: number): void {
    this.dirty.delete(p);
    const c = this.pages[p], ctx = c.getContext('2d')!;
    const base = p * 256;
    ctx.fillStyle = '#1b1d22';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(renderMap16Sheet(this.app, this.bg, base, 256), M, 0, 256 * Z, 256 * Z);
    // ranges
    const band = (from: number, to: number, color: string, label: string) => {
      const a = Math.max(from, base), b = Math.min(to, base + 0xff);
      if (a > b) return;
      const y0 = ((a - base) >> 4) * 16 * Z, y1 = (((b - base) >> 4) + 1) * 16 * Z;
      ctx.fillStyle = color;
      ctx.fillRect(0, y0, 4, y1 - y0);
      ctx.save();
      ctx.translate(14, (y0 + y1) / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.fillStyle = color;
      ctx.font = '11px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText(label, 0, 0);
      ctx.restore();
    };
    if (this.bg) {
      band(0, 0x1ff, '#7d8bff', 'Background tiles');
      band(BG_EXT_FIRST, EXT_TILES - 1, '#4cc2ff', 'Extended');
    }
    else {
      band(0x000, 0x072, '#8b93a3', 'Standard');
      // (the tilesets sharing all of them)
      let ts = this.app.tilesetsOf(0x073);
      for (let t = 0x074; t <= 0x0ff; t++) { const of = this.app.tilesetsOf(t); ts = ts.filter((x) => of.includes(x)); }
      band(0x073, 0x0ff, '#ffb000', `Tileset${ts.length > 1 ? 's' : ''} ${ts.map((x) => hex(x, 1)).join('/')}`);
      band(0x100, 0x1ff, '#8b93a3', 'Standard');
      band(0x200, EXT_TILES - 1, '#4cc2ff', 'Extended');
    }
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'right';
    for (let row = 0; row < 16; row += 2) ctx.fillText(hex(base + row * 16, 3), M - 2, row * 16 * Z + 11);
    ctx.textAlign = 'left';
    if (this.sameActs && !this.bg) {
      const a = actsLike(this.app.rom, this.sel);
      ctx.fillStyle = 'rgba(255,176,0,0.35)';
      for (let t = 0; t < 256; t++) if (actsLike(this.app.rom, base + t) === a) ctx.fillRect(M + (t & 15) * 16 * Z, (t >> 4) * 16 * Z, 16 * Z, 16 * Z);
    }
    const unused = this.markUnused && !this.bg ? this.unusedTiles() : null;
    if (unused) {
      ctx.strokeStyle = 'rgba(255,90,90,0.9)';
      ctx.lineWidth = 2;
      for (let t = 0; t < 256; t++) if (unused.has(base + t)) {
        const x = M + (t & 15) * 16 * Z, y = (t >> 4) * 16 * Z;
        ctx.beginPath(); ctx.moveTo(x + 4, y + 4); ctx.lineTo(x + 16 * Z - 4, y + 16 * Z - 4); ctx.moveTo(x + 16 * Z - 4, y + 4); ctx.lineTo(x + 4, y + 16 * Z - 4); ctx.stroke();
      }
    }
    drawTileMatches(ctx, this.match, base, 256, 16 * Z, M);
    // the selection may reach over several pages; each draws its part
    const row = (this.sel >> 4) - p * 16;
    if (row < 16 && row + this.selH > 0) {
      ctx.strokeStyle = '#4cc2ff';
      ctx.lineWidth = 2;
      ctx.strokeRect(M + (this.sel & 15) * 16 * Z + 1, row * 16 * Z + 1, this.selW * 16 * Z - 2, this.selH * 16 * Z - 2);
    }
    const to = this.moving?.to ?? -1, toRow = (to >> 4) - p * 16;
    if (to >= 0 && toRow < 16 && toRow + this.selH > 0) {
      ctx.strokeStyle = '#ffb000';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(M + (to & 15) * 16 * Z + 1, toRow * 16 * Z + 1, this.selW * 16 * Z - 2, this.selH * 16 * Z - 2);
      ctx.setLineDash([]);
    }
  }

  // tile column and row (over all pages) under the mouse; between pages: the page above
  private cellAt(e: MouseEvent): { x: number; y: number } {
    let p = 0;
    for (let i = 1; i < this.pages.length; i++) if (this.pages[i].getBoundingClientRect().top <= e.clientY) p = i;
    const c = this.pages[p], rc = c.getBoundingClientRect();
    const sx = c.width / rc.width;
    return {
      x: Math.max(0, Math.min(15, Math.floor(((e.clientX - rc.left) * sx - M) / (16 * Z)))),
      y: p * 16 + Math.max(0, Math.min(15, Math.floor(((e.clientY - rc.top) * sx) / (16 * Z)))),
    };
  }

  private attachSheet(): void {
    this.scroll.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || !(e.target instanceof HTMLCanvasElement)) return;
      e.preventDefault();
      const a = this.cellAt(e);
      if (this.moving && this.inSelection(a)) { this.dragMove(a); return; }
      const pick = (b: { x: number; y: number }) => {
        this.sel = Math.min(a.y, b.y) * 16 + Math.min(a.x, b.x);
        this.selW = Math.abs(a.x - b.x) + 1;
        this.selH = Math.abs(a.y - b.y) + 1;
        this.drawSheet();
      };
      pick(a);
      const move = (ev: MouseEvent) => pick(this.cellAt(ev));
      const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); this.marksOf = ''; this.redraw(); };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
    this.scroll.addEventListener('mousemove', (e) => {
      if (!(e.target instanceof HTMLCanvasElement)) return;
      const p = this.cellAt(e);
      const t = p.y * 16 + p.x;
      const info = this.bg ? undefined : this.app.probes.block(actsLike(this.app.rom, t));
      e.target.title = `${this.tileName(t)}${this.bg ? '' : ` – ${info ? probeText(info) : 'determining behavior …'}`}`;
    });
  }

  // search by tile number or block file: the other tiles are dimmed, the list goes to the first match, Enter
  // selects a single match
  private attachSearch(): void {
    const s = this.search;
    s.addEventListener('input', () => {
      this.match = tileMatches(s.value, EXT_TILES, blockFilesByTile(this.app.rom));
      this.drawSheet();
      if (this.match?.length) this.scrollToTile(this.match[0]);
    });
    s.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && s.value) { e.preventDefault(); this.clearSearch(); return; }
      if (e.key !== 'Enter' || this.match?.length !== 1) return;
      e.preventDefault();
      this.sel = this.match[0];
      this.selW = this.selH = 1;
      this.marksOf = '';
      this.clearSearch();
      s.blur();
      this.redraw();
      this.scrollToSel();
    });
  }
  private clearSearch(): void {
    this.search.value = '';
    this.match = null;
    this.drawSheet();
  }

  // y of a tile's row in the list
  private tileY(t: number): number {
    const c = this.pages[t >> 8];
    return c.getBoundingClientRect().top - this.scroll.getBoundingClientRect().top + this.scroll.scrollTop
      + ((t & 0xff) >> 4) * 16 * Z * (c.clientHeight / c.height);
  }
  private scrollToTile(t: number): void {
    const sc = this.scroll, y = this.tileY(t);
    if (y < sc.scrollTop || y > sc.scrollTop + sc.clientHeight - 40) sc.scrollTop = y - sc.clientHeight / 2;
  }
  private scrollToSel(): void {
    this.scrollPending = false;
    this.scrollToTile(this.sel);
  }
  private scrollToPage(p: number): void {
    this.scroll.scrollTop = this.heads[p].offsetTop - this.scroll.offsetTop;
    this.pageScrolled();
  }
  // marks the page at the top of the list in the bar
  private pageScrolled(): void {
    let page = 0;
    this.heads.forEach((head, p) => { if (head.offsetTop - this.scroll.offsetTop <= this.scroll.scrollTop + 4) page = p; });
    this.topPage = page;
    this.pageBar.querySelectorAll('button').forEach((b, i) => b.classList.toggle('active', i === page));
  }

  // ---------- builder ----------
  private buildBuilder(): void {
    const app = this.app;
    const b = this.builder;
    const col = this.builderCol;
    col.classList.toggle('mt-remap-col', !!this.remapping || !!this.moving);
    if (this.remapping) { if (b.firstChild !== this.remapping.box) b.replaceChildren(this.remapping.box); this.drawRemap(); return; }
    if (this.moving) { if (b.firstChild !== this.moving.box) b.replaceChildren(this.moving.box); this.drawMove(); return; }
    // the canvas stays in place, so its scroll position and zoom do
    if (b.firstChild !== this.bHead) b.replaceChildren(this.bHead, this.bigScroll, this.bCtl);
    this.buildUses();
    const t = this.sel, one = this.selW * this.selH === 1;
    const tiles = this.selection(), words = tiles.map((x) => this.words(x));
    const g = this.grid(), marks = this.marked();
    this.drawBig();
    const s = summary(g, words, marks);
    const ws = this.words(t);
    const prio = (st: BitState) => h('button', {
      class: st === 'on' ? 'active' : st === 'mixed' ? 'mt-is-mixed' : '', title: 'Drawn in front of sprites/Mario', disabled: !marks.size,
      onclick: () => this.togglePrio(),
    }, 'Priority', st === 'mixed' ? h('span', { class: 'mt-mixed' }, 'mixed') : '');
    const flip = (label: string, bit: number, title: string) => h('button', { title, disabled: !marks.size, onclick: () => this.flip(bit, label) }, label);
    const allPal = cgramToRGBA(app.render.cgram);
    const palDot = (p: number) => {
      const c = h('canvas', { width: 7, height: 1, class: 'mt-paldot' });
      const cx = c.getContext('2d')!;
      const im = cx.createImageData(7, 1);
      const pp = new Uint32Array(im.data.buffer);
      for (let k = 0; k < 7; k++) pp[k] = allPal[p * 16 + 1 + k * 2] | 0xff000000;
      cx.putImageData(im, 0, 0);
      return h('button', {
        class: `mt-pal${s.pals.has(p) ? ' active' : ''}`, title: `Palette ${p} (key ${p + 1}) · Ctrl+click: open in the Palettes tab`,
        onclick: (e: MouseEvent) => {
          if (e.ctrlKey || e.metaKey) { this.ws.showPalette(p, 1); return; }
          this.editQuarters(setPalette(p), `Palette ${p}`);
        },
      }, c, h('span', null, String(p)));
    };
    // own animations on the quarters, each once
    const all = words.flat();
    const own = this.bg ? [] : all.flatMap((w) => animsAt(app, w & 0x3ff)).filter((a, i, l) => l.findIndex((x) => x.global === a.global && x.slot === a.slot) === i);
    const animated = this.bg ? 0 : all.filter((w) => app.animated()?.tiles.has(w & 0x3ff)).length;
    const used = this.bg || !one ? 0 : this.ws.preview.count(t);
    const last = tiles[tiles.length - 1];
    this.bHead.replaceChildren(
      h('div', { class: 'prop-title' }, one ? this.tileName(t) : `${this.bg ? 'BG' : 'FG'} tiles ${hex(t, 3)}–${hex(last, 3)}`, one ? '' : h('span', { class: 'hint' }, `  (${this.selW}×${this.selH})`)),
      h('div', { class: 'hint' }, this.rangeText(t), one && !this.bg ? ` · in the level ${used}×` : ''),
      h('div', { class: 'mt-section' }, 'Quarters', h('span', { class: 'hint' }, `${marks.size} of ${g.cols * g.rows} marked`)),
    );
    this.updateQInfo();
    let acts: HTMLElement | string = '';
    if (!this.bg) {
      const whole = wholeTiles(g, marks);
      acts = whole ? this.actsUi(whole.map((i) => tiles[i])) : h('div', { class: 'mt-acts mt-off' },
        h('div', { class: 'panel-title' }, 'Acts like'),
        h('div', { class: 'row' }, h('span', { class: 'hint grow' }, marks.size ? 'Acts-like applies per 16x16 tile: mark whole tiles (Shift+click) to change it.' : 'Mark tiles to change their acts-like.'),
          h('button', { disabled: true }, 'Change …')));
    }
    this.bCtl.replaceChildren(
      this.qInfo,
      animated ? h('div', { class: 'warn-box' },
        `Animated: the game keeps overwriting ${animated === all.length ? 'all quarters' : 'the quarters flagged with a pink corner'} with animation frames (e.g. ?-block, coin, water). Changes drawn on these 8x8 tiles are not visible in the game.`,
        own.length ? h('div', null, 'By ', animLinks(this.ws, own), '.') : '') : '',
      h('div', { class: 'hint' }, 'Palette (keys 1–8)'),
      h('div', { class: 'mt-pals' }, Array.from({ length: 8 }, (_, p) => palDot(p))),
      h('div', { class: 'row' },
        flip('↔ Flip', FLIP_X, 'Mirror the marked quarters horizontally as one picture (X)'),
        flip('↕ Flip', FLIP_Y, 'Mirror the marked quarters vertically as one picture (Y)'),
        prio(s.prio)),
      h('div', { class: 'mt-section' }, one ? 'Tile' : 'Tiles'),
      acts,
      this.usesBox,
      h('details', { class: 'mt-adv' }, h('summary', null, one ? 'Raw values' : `Raw values of ${hex(t, 3)}`),
        h('div', { class: 'mono hint' }, ws.map((w, q) => `${QUARTER_NAMES[q]} $${hex(w, 4)}`).join('  ')),
        h('div', { class: 'hint' }, this.tileAddr(t) < 0 ? 'Extended tile – created on the first change.' : `ROM $${hex(this.tileAddr(t), 6)}`)),
      h('p', { class: 'hint' }, 'Choose 8x8 tiles on the right (click or drag), then right-click a quarter to put them there (right drag: paint), or press Enter to put a single one into every marked quarter. Mark quarters for palette, flips (mirroring them as one picture) and priority (click, drag, Ctrl: add/remove, Shift: whole tile, Ctrl+A: all, Esc: none).'),
    );
  }

  // the line about the quarter the graphics view follows
  private updateQInfo(): void {
    const k = this.focusQ(), { tile, q } = this.grid().locate(k);
    const w = this.wordAt(k), num8 = w & 0x3ff;
    const slot = slotOfTile(this.gfxSlots(), num8);
    const where = this.selW * this.selH > 1 ? `${hex(this.selection()[tile], 3)} ` : '';
    this.qInfo.textContent = `${this.hoverQ !== null ? 'Under the mouse' : 'Quarter'}: ${where}${QUARTER_NAMES[q]}, 8x8 tile ${hex(num8, 3)}${slot ? ` from ${slot.name} (${gfxName(slot.file)})` : ''}, palette ${(w >> 10) & 7}`;
  }

  // zoom of the builder: as set by Ctrl+wheel, else the selection fitted into the column (at most BZ)
  private bigZoom(): number {
    if (this.bzoom !== null) return this.bzoom;
    const aw = Math.max(32, this.bigScroll.clientWidth - 4), ah = Math.max(96, window.innerHeight * 0.55 - 4);
    return Math.min(BZ, aw / (16 * this.selW), ah / (16 * this.selH));
  }
  private setBigZoom(z: number, ax: number, ay: number): void {
    const old = this.bigZoom(), sc = this.bigScroll;
    const lx = (sc.scrollLeft + ax) / old, ly = (sc.scrollTop + ay) / old;
    this.bzoom = z;
    this.drawBig();
    sc.scrollLeft = lx * z - ax;
    sc.scrollTop = ly * z - ay;
  }

  // the selection's tiles, the quarters' grid, the marked quarters (orange), the one under the mouse and
  // where the chosen or dragged 8x8 tiles would land (dashed)
  private drawBig(): void {
    const g = this.grid(), marks = this.marked(), z = this.bigZoom();
    const words = this.selWords(), cache = this.tc();
    const W = g.cols * 8, H = g.rows * 8;
    const img = new ImageData(W, H);
    const px = new Uint32Array(img.data.buffer);
    words.forEach((ws, i) => ws.forEach((w, q) => {
      const tile = cache.get(w);
      const ox = (i % this.selW) * 16 + (q >> 1) * 8, oy = Math.floor(i / this.selW) * 16 + (q & 1) * 8;
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) px[(oy + y) * W + ox + x] = tile[y * 8 + x] || ((x + y) & 4 ? 0xff2a2a2a : 0xff222222);
    }));
    const off = document.createElement('canvas');
    off.width = W; off.height = H;
    off.getContext('2d')!.putImageData(img, 0, 0);
    const c = this.bigCanvas;
    c.width = Math.max(1, Math.round(W * z)); c.height = Math.max(1, Math.round(H * z));
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(off, 0, 0, c.width, c.height);
    const sx = c.width / g.cols, sy = c.height / g.rows; // a quarter's size
    // quarter lines faint, tile lines stronger
    ctx.lineWidth = 1;
    if (sx >= 6) {
      ctx.strokeStyle = 'rgba(255,255,255,0.15)';
      ctx.beginPath();
      for (let x = 1; x < g.cols; x += 2) { ctx.moveTo(Math.round(x * sx) + 0.5, 0); ctx.lineTo(Math.round(x * sx) + 0.5, c.height); }
      for (let y = 1; y < g.rows; y += 2) { ctx.moveTo(0, Math.round(y * sy) + 0.5); ctx.lineTo(c.width, Math.round(y * sy) + 0.5); }
      ctx.stroke();
    }
    if (sx >= 3) {
      ctx.strokeStyle = 'rgba(255,255,255,0.4)';
      ctx.beginPath();
      for (let x = 2; x < g.cols; x += 2) { ctx.moveTo(Math.round(x * sx) + 0.5, 0); ctx.lineTo(Math.round(x * sx) + 0.5, c.height); }
      for (let y = 2; y < g.rows; y += 2) { ctx.moveTo(0, Math.round(y * sy) + 0.5); ctx.lineTo(c.width, Math.round(y * sy) + 0.5); }
      ctx.stroke();
    }
    const anim = this.bg ? null : this.app.animated();
    if (anim?.tiles.size) {
      const a = Math.max(3, Math.min(16, sx / 3));
      ctx.fillStyle = '#ff4fd8';
      for (let k = 0; k < g.cols * g.rows; k++) {
        const { x, y } = g.pos(k), { tile, q } = g.locate(k);
        if (!anim.tiles.has(words[tile][q] & 0x3ff)) continue;
        const rx = (x + 1) * sx, ry = y * sy;
        ctx.beginPath(); ctx.moveTo(rx, ry); ctx.lineTo(rx, ry + a); ctx.lineTo(rx - a, ry); ctx.fill();
      }
    }
    // marks: tinted, the outline of the marked area
    ctx.fillStyle = 'rgba(255,176,0,0.22)';
    for (const k of marks) { const { x, y } = g.pos(k); ctx.fillRect(x * sx, y * sy, sx, sy); }
    ctx.strokeStyle = '#ffb000';
    ctx.lineWidth = 2;
    ctx.beginPath();
    const on = (x: number, y: number) => x >= 0 && y >= 0 && x < g.cols && y < g.rows && marks.has(g.key(x, y));
    for (const k of marks) {
      const { x, y } = g.pos(k), x0 = x * sx + 1, y0 = y * sy + 1, x1 = (x + 1) * sx - 1, y1 = (y + 1) * sy - 1;
      if (!on(x - 1, y)) { ctx.moveTo(x0, y0); ctx.lineTo(x0, y1 + 1); }
      if (!on(x + 1, y)) { ctx.moveTo(x1, y0 - 1); ctx.lineTo(x1, y1 + 1); }
      if (!on(x, y - 1)) { ctx.moveTo(x0 - 1, y0); ctx.lineTo(x1 + 1, y0); }
      if (!on(x, y + 1)) { ctx.moveTo(x0 - 1, y1); ctx.lineTo(x1 + 1, y1); }
    }
    ctx.stroke();
    if (this.hoverQ !== null && this.hoverQ < g.cols * g.rows) {
      const { x, y } = g.pos(this.hoverQ);
      // where a drop or a right click would put the 8x8 tiles
      const d = this.drag, p = this.pick;
      const bw = d ? Math.abs(d.a.x - d.b.x) + 1 : p?.w ?? 1, bh = d ? Math.abs(d.a.y - d.b.y) + 1 : p?.h ?? 1;
      ctx.strokeStyle = d || p ? '#4cc2ff' : 'rgba(255,255,255,0.8)';
      ctx.lineWidth = 2;
      ctx.setLineDash(d || p ? [4, 3] : []);
      ctx.strokeRect(x * sx + 1, y * sy + 1, bw * sx - 2, bh * sy - 2);
      ctx.setLineDash([]);
    }
  }

  // the builder's mouse: marking quarters, putting 8x8 tiles, double click, hover, zoom and pan
  private attachBig(): void {
    const c = this.bigCanvas;
    c.dataset.drop = '1';
        c.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const g = this.grid(), a = this.quarterUnder(e), base = this.marked();
      const ctrl = e.ctrlKey || e.metaKey, whole = e.shiftKey;
      const mode: MarkMode = ctrl ? (base.has(g.key(a.x, a.y)) ? 'remove' : 'add') : 'set';
      // Shift: whole 16x16 tiles
      const mark = (b: { x: number; y: number }) => {
        let x0 = Math.min(a.x, b.x), y0 = Math.min(a.y, b.y), x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
        if (whole) { x0 &= ~1; y0 &= ~1; x1 |= 1; y1 |= 1; }
        this.marks = markRect(g, base, { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }, mode);
        this.drawBig();
      };
      mark(a);
      let last = a;
      const move = (ev: MouseEvent) => { const n = this.quarterUnder(ev); if (n.x !== last.x || n.y !== last.y) { last = n; mark(n); } };
      const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); this.setMarks(this.marks); };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
    c.addEventListener('dblclick', (e) => { const g = this.grid(), a = this.quarterUnder(e); this.editGfx(this.wordAt(g.key(a.x, a.y))); });
    // right button: puts the chosen 8x8 tiles; dragging paints them, one undo step
    c.addEventListener('mousedown', (e) => {
      if (e.button !== 2) return;
      e.preventDefault();
      let last = this.quarterUnder(e);
      const key = `m16-paint:${++this.paints}`;
      if (!this.putPick(last, key)) return;
      const move = (ev: MouseEvent) => {
        if (ev.target !== c) return;
        const n = this.quarterUnder(ev);
        if (n.x === last.x && n.y === last.y) return;
        last = n;
        this.putPick(n, key);
      };
      const up = (ev: MouseEvent) => { if (ev.button !== 2) return; window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    const hover = (k: number | null) => {
      if (k === this.hoverQ) return;
      const pal = (this.wordAt(this.focusQ()) >> 10) & 7;
      this.hoverQ = k;
      this.drawBig();
      this.updateQInfo();
      if (((this.wordAt(this.focusQ()) >> 10) & 7) !== pal || this.drag) this.drawGfx();
    };
    c.addEventListener('mousemove', (e) => {
      const g = this.grid(), a = this.quarterUnder(e);
      hover(g.key(a.x, a.y));
      c.title = 'Click/drag: mark quarters · Ctrl: add/remove · Shift: whole tile · Right click/drag: put the chosen 8x8 tiles · Double click: edit the 8x8 tile in the Graphics tab';
    });
    c.addEventListener('mouseleave', () => hover(null));
    attachPanZoom(this.bigScroll, () => this.bigZoom(), (z, ax, ay) => this.setBigZoom(z, ax, ay), 0.5, 32);
    // the column follows the window while fitted
    let lastW = 0;
    new ResizeObserver(() => {
      const w = this.bigScroll.clientWidth;
      if (w === lastW) return;
      lastW = w;
      if (this.visible && this.bzoom === null && !this.remapping) this.drawBig();
    }).observe(this.bigScroll);
  }
  // the quarter under the mouse in the builder
  private quarterUnder(e: MouseEvent): { x: number; y: number } {
    const g = this.grid(), rc = this.bigCanvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(g.cols - 1, Math.floor(((e.clientX - rc.left) / rc.width) * g.cols))),
      y: Math.max(0, Math.min(g.rows - 1, Math.floor(((e.clientY - rc.top) / rc.height) * g.rows))),
    };
  }

  // the handle between the builder and the graphics: drag to change the graphics column's width (the
  // builder takes the rest)
  private splitter(): HTMLElement {
    try { const v = Number(localStorage.getItem(GFX_W)); if (v >= 200 && v <= 1600) this.gfxW = v; } catch { /* no storage */ }
    this.gfxCol.style.width = `${this.gfxW}px`;
    const el = h('div', { class: 'mt-split', title: 'Drag: width of the builder and the 8x8 graphics' });
    el.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const x0 = e.clientX, w0 = this.gfxCol.getBoundingClientRect().width;
      const move = (ev: MouseEvent) => {
        this.gfxW = Math.round(Math.max(200, Math.min(1600, w0 - (ev.clientX - x0))));
        this.gfxCol.style.width = `${this.gfxW}px`;
      };
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        try { localStorage.setItem(GFX_W, String(this.gfxW)); } catch { /* no storage */ }
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
    return el;
  }

  // the defined tiles 200-FFF used nowhere (null while not every level's tiles are known)
  private unusedTiles(): Set<number> | null {
    if (this.unused) return this.unused;
    const app = this.app, { levels, pending } = app.levelTiles();
    if (!pending) this.unused = new Set(unusedFgTiles(app.rom, levels, map16Source(app.rom, app.render).fg(0x025)));
    return this.unused;
  }

  // "Used in levels": where the selected tile is placed (the open level as edited), what else refers to it
  private buildUses(): void {
    const app = this.app, t = this.sel, box = this.usesBox;
    const { levels, pending } = app.levelTiles();
    const link = (x: number) => h('a', { href: '#', class: 'mono', title: 'Show the tile', onclick: (e: Event) => { e.preventDefault(); this.select(x, this.bg); } }, hex(x, 3));
    if (this.bg) {
      const users = bgTileUsers(levels, t);
      box.replaceChildren(usedInList(app, 'Used in levels', users.map((u) => ({ level: u.level, text: `${u.count}× in the BG` })), pending, 'In no level\'s background.'));
      return;
    }
    const tilesets = app.tilesetsOf(t), tilesetTile = isTilesetTile(t);
    const users = fgTileUsers(levels, t, tilesets);
    const items = users.map((u) => ({
      level: u.level, at: { x: u.uses[0].x, y: u.uses[0].y },
      text: u.uses.map((q) => `${q.count}× ${TILE_SOURCES[q.source]}${q.layer === 2 ? ' (layer 2)' : ''}`).join(', '),
    }));
    const l = tileLinks(app.rom, t);
    box.replaceChildren(
      usedInList(app, tilesetTile ? `Used in levels of ${tilesetNames(tilesets)}` : 'Used in levels', items, pending, this.unusedTiles()?.has(t) ? 'Defined, but placed in no level and no prefab: unused.' : 'Placed in no level.'),
      l.actsLike.length ? h('div', { class: 'hint' }, 'Acting like it: ', ...l.actsLike.slice(0, 24).flatMap((x, i) => [i ? ' ' : '', link(x)]), l.actsLike.length > 24 ? ` … (${l.actsLike.length})` : '') : '',
      l.prefabs.length ? h('div', { class: 'hint' }, `In prefab${l.prefabs.length > 1 ? 's' : ''} ${l.prefabs.map((n) => hex(n, 2)).join(', ')}`) : '',
      l.blocks.length ? h('div', { class: 'hint' }, `Custom block on it: ${l.blocks.join(', ')}`) : '',
    );
  }

  // opens a quarter's 8x8 tile in the graphics tab, in the quarter's palette
  private editGfx(w: number): void {
    const num = w & 0x3ff;
    const slot = slotOfTile(this.gfxSlots(), num);
    if (!slot) { toast(`8x8 tile ${hex(num, 3)} is in none of this level's graphics slots`); return; }
    this.ws.showGfx(slot.file, num - slot.first, (w >> 10) & 7);
  }

  private rangeText(t: number): string {
    if (this.bg) return t >= BG_EXT_FIRST ? 'extended background tile' : 'background tile';
    if (t >= EXT_FIRST) return 'extended tile (in the level via Direct Map16 object)';
    if (isTilesetTile(t)) { const ts = this.app.tilesetsOf(t); return `tileset tile (applies to ${tilesetNames(ts)}${ts.length > 1 ? '' : ' only'})`; }
    return 'standard tile (all tilesets)';
  }

  // acts-like of the wholly marked tiles
  private actsUi(tiles: number[]): HTMLElement {
    const app = this.app, t = tiles[0];
    const values = [...new Set(tiles.map((x) => actsLike(app.rom, x)))];
    const a = values[0];
    const info = app.probes.block(a);
    const thumb = h('canvas', { width: 16, height: 16, class: 'mt-acts-thumb' });
    if (values.length === 1) thumb.getContext('2d')!.drawImage(renderMap16Sheet(app, false, a & ~0x1ff), (a & 15) * 16, ((a >> 4) & 31) * 16, 16, 16, 0, 0, 16, 16);
    const of = tiles.length > 1 ? h('div', { class: 'hint' }, `of the ${tiles.length} marked tiles`) : '';
    const file = tiles.length === 1 ? blockFileOf(app.rom, t) : null;
    return h('div', { class: 'mt-acts' },
      h('div', { class: 'panel-title' }, 'Acts like'),
      h('div', { class: 'row' }, thumb,
        values.length > 1 ? h('div', { class: 'grow' }, `${values.length} different`, of)
          : h('div', { class: 'grow' }, tiles.length === 1 && a === t ? 'like itself' : `like tile ${hex(a, 3)}`, of, h('div', { class: 'hint' }, info ? probeText(info) : 'determining …')),
        h('button', { onclick: () => this.pickActs(tiles), title: `Act like another tile${tiles.length > 1 ? ' (all marked tiles)' : ''}` }, 'Change …')),
      tiles.length === 1 ? h('div', { class: 'row' }, h('span', { class: 'hint grow' }, file ? `Custom Block: ${file}` : 'No custom block'),
        h('button', { onclick: () => void openResources(app, 'block', { tile: t, onChange: () => this.redraw() }) }, 'Custom Blocks …')) : '',
    );
  }

  // picks the acts-like value from a sheet of the vanilla tiles, by click or by typing its number:
  // typing dims the tiles that do not match, Enter takes the tile once only one is left
  private pickActs(tiles: number[]): void {
    const app = this.app;
    const c = h('canvas', { width: 256 * 2, height: 512 * 2, class: 'mt-acts-pick' });
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    const sheet = renderMap16Sheet(app, false, 0);
    const cur = actsLike(app.rom, tiles[0]);
    const scroll = h('div', { class: 'mt-acts-scroll' }, c);
    const tip = `Click a tile or type its number: the ${tiles.length > 1 ? 'marked tiles then act' : 'tile then acts'} like this one.`;
    const info = h('div', { class: 'hint mt-acts-info' }, tip);
    const say = (text: string) => { info.textContent = text; info.title = text; };
    const describe = (t: number) => { const p = app.probes.block(t); say(`Tile ${hex(t, 3)}: ${p ? probeText(p) : 'determining …'}`); };
    const input = h('input', { type: 'text', class: 'mt-acts-input', placeholder: 'Tile number (hex), e.g. 130', spellcheck: false, autocomplete: 'off' });
    let matches: number[] | null = null;
    const draw = () => {
      ctx.drawImage(sheet, 0, 0, 512, 1024);
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#ffb000';
      ctx.strokeRect((cur & 15) * 32 + 1, (cur >> 4) * 32 + 1, 30, 30);
      drawTileMatches(ctx, matches, 0, 0x200, 32);
    };
    const update = () => {
      matches = tileMatches(input.value, 0x200);
      draw();
      if (matches?.length === 1) describe(matches[0]);
      else say(!matches ? tip : matches.length ? `${matches.length} tiles match.` : 'No tile 000–1FF matches.');
      if (matches?.length) {
        const y = (matches[0] >> 4) * 32 * (c.getBoundingClientRect().height / 1024 || 1);
        if (y < scroll.scrollTop || y > scroll.scrollTop + scroll.clientHeight - 32) scroll.scrollTop = y - 8;
      }
    };
    const at = (e: MouseEvent) => {
      const rc = c.getBoundingClientRect();
      return Math.floor((e.clientY - rc.top) / (rc.height / 32)) * 16 + Math.floor((e.clientX - rc.left) / (rc.width / 16));
    };
    c.addEventListener('mousemove', (e) => describe(at(e)));
    c.addEventListener('mouseleave', update);
    const dlg = modal(`Acts-like for ${tiles.length > 1 ? `${tiles.length} Tiles` : this.tileName(tiles[0])}`,
      h('div', { class: 'mt-acts-dlg' }, input, info, scroll), [{ label: 'Cancel' }]);
    const take = (v: number) => {
      this.edit(`Acts like ${hex(v, 3)}`, () => { for (const t of tiles) setActsLike(app.rom, t, v); });
      dlg.close();
    };
    c.addEventListener('mousedown', (e) => take(at(e)));
    input.addEventListener('input', update);
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      if (matches?.length === 1) take(matches[0]);
    });
    update();
    input.focus();
  }

  // ---------- move ----------
  private inSelection(c: Cell): boolean {
    return c.x >= (this.sel & 15) && c.x < (this.sel & 15) + this.selW && c.y >= this.sel >> 4 && c.y < (this.sel >> 4) + this.selH;
  }
  // the move panel: the selection goes to the typed number or where it is dragged in the sheet
  openMove(): void {
    if (this.remapping) this.closeRemap();
    if (!this.moving) {
      const input = h('input', { type: 'text', class: 'hex', size: 4, maxLength: 3, spellcheck: false, autocomplete: 'off', title: 'The new number of the top left tile (hex)' });
      input.addEventListener('input', () => { const v = /^[0-9a-f]{1,3}$/i.test(input.value.trim()) ? parseInt(input.value, 16) : -1; this.setMoveTo(v, false); });
      input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') void this.applyMove(); if (e.key === 'Escape') this.closeMove(); });
      const status = h('div', { class: 'mt-remap' });
      const box = h('div', { class: 'mt-remap' },
        h('div', { class: 'prop-title' }, 'Move tiles', h('span', { class: 'hint' }, '  with every use')),
        h('div', { class: 'row' }, h('label', { class: 'hint', title: 'Or drag the selection in the sheet' }, 'Top left tile to'), input),
        h('div', { class: 'hint' }, 'Or drag the selection in the sheet. Levels, prefabs and blocks using the tiles are rewritten, so every level looks as before.'),
        status);
      this.moving = { to: -1, box, input, status, plan: null };
    }
    if (this.visible) { this.buildBar(); this.redraw(); }
    this.moving.input.focus();
  }
  private closeMove(): void {
    this.moving = null;
    this.buildBar();
    this.redraw();
  }
  private setMoveTo(to: number, typed = true): void {
    const m = this.moving!;
    m.to = to;
    if (typed) m.input.value = to < 0 ? '' : hex(to, 3);
    this.drawSheet();
    this.drawMove();
  }
  // dragging the selection in the sheet chooses its destination
  private dragMove(a: Cell): void {
    const move = (ev: MouseEvent) => {
      const b = this.cellAt(ev), x = (this.sel & 15) + b.x - a.x, y = (this.sel >> 4) + b.y - a.y;
      const to = x >= 0 && x + this.selW <= 16 && y >= 0 ? y * 16 + x : -1;
      if (to !== this.moving?.to) this.setMoveTo(to);
    };
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  // the plan for the selection's move, with what it rewrites and why it can't be done
  private drawMove(): void {
    const m = this.moving;
    if (!m) return;
    m.plan = null;
    const app = this.app, n = this.selW * this.selH, last = m.to + (this.selH - 1) * 16 + this.selW - 1;
    const what = `${n} ${this.bg ? 'BG' : 'FG'} tile${n > 1 ? 's' : ''} from ${hex(this.sel, 3)}`;
    if (m.to < 0 || (m.to & 15) + this.selW > 16 || last >= EXT_TILES || m.to === this.sel) {
      m.status.replaceChildren(h('div', { class: 'hint' }, m.to < 0 || m.to === this.sel ? `Where do the ${what} go?` : 'The tiles do not fit on the page there.'));
      return;
    }
    const map = rectMap(this.sel, this.selW, this.selH, m.to);
    const { levels: index, pending } = app.levelTiles();
    const src: MoveSource = { ...levelSource(app, map), blank: map16Source(app.rom, app.render).fg(0x025), index };
    const plan = planMove(app.rom, this.bg ? 'bg' : 'fg', map, src);
    m.plan = { plan, src, pending: this.bg ? 0 : pending };
    const ok = !plan.problems.length;
    m.status.replaceChildren(
      ...plan.problems.map((q) => h('div', { class: 'warn-box' }, q)),
      ok && plan.overwrite.length ? h('div', { class: 'warn-box' }, `Tile${plan.overwrite.length > 1 ? 's' : ''} ${plan.overwrite.slice(0, 8).map((t) => hex(t, 3)).join(', ')}${plan.overwrite.length > 8 ? ' …' : ''} ${plan.overwrite.length > 1 ? 'have' : 'has'} graphics, acts-like or a block of ${plan.overwrite.length > 1 ? 'their' : 'its'} own, used nowhere: overwritten (asked first).`) : '',
      ok ? planList(app, plan, 'No level places these tiles.') : '',
      ok && m.plan.pending ? h('div', { class: 'warn-box' }, `${pending} level${pending > 1 ? 's are' : ' is'} still being looked through for tiles placed by objects' code, which can't be rewritten.`) : '',
      h('div', { class: 'row' },
        h('button', { class: 'primary', disabled: !ok, onclick: () => void this.applyMove() }, `Move to ${hex(m.to, 3)}`),
        h('button', { onclick: () => this.closeMove() }, 'Close')),
    );
  }

  // one undo step; a block among the tiles assembles the blocks again
  private async applyMove(): Promise<void> {
    const m = this.moving, p = m?.plan;
    if (!m || !p || p.plan.problems.length) return;
    const { plan, src } = p, to = m.to, from = this.sel, layer = this.bg ? 'bg' : 'fg';
    if (p.pending && await choose('Move now?', `${p.pending} level${p.pending > 1 ? 's have' : ' has'} not been looked through yet for these tiles placed by objects' code (custom objects), which a move can't rewrite. Wait for the look-through, or move now?`,
      [{ label: 'Wait' }, { label: 'Move now' }]) !== 1) return;
    if (plan.overwrite.length && await choose('Overwrite tiles?', `Tile${plan.overwrite.length > 1 ? 's' : ''} ${plan.overwrite.map((t) => hex(t, 3)).join(', ')} ${plan.overwrite.length > 1 ? 'have' : 'has'} contents of ${plan.overwrite.length > 1 ? 'their' : 'its'} own (used nowhere). Overwrite with the moved tiles?`,
      [{ label: 'Cancel' }, { label: 'Overwrite', danger: true }]) !== 1) return;
    try {
      if (plan.blocks.length) await loadAsar();
      const n = plan.map.size;
      this.app.romEdit(`${n} ${layer.toUpperCase()} tile${n > 1 ? 's' : ''} moved from ${hex(from, 3)} to ${hex(to, 3)}`, () => applyMove(this.app.rom, layer, plan, src));
      const l = plan.levels.length;
      toast(`${n} tile${n > 1 ? 's' : ''} moved${l ? `, ${l} level${l > 1 ? 's' : ''} rewritten` : ''} – Ctrl+Z undoes it`);
    } catch (e) { toast(String(e instanceof Error ? e.message : e), 'error'); return; }
    this.moving = null;
    this.sel = to;
    this.buildBar();
    this.redraw();
    this.scrollToSel();
  }

  // ---------- remap ----------
  // opens the remap panel; an offer fills in the list and may choose the tiles it changes
  openRemap(fill: RemapFill = {}): void {
    if (this.moving) this.closeMove();
    if (fill.bg !== undefined && fill.bg !== this.bg) { this.bg = fill.bg; this.sel &= 0x1ff; this.selW = this.selH = 1; }
    if (!this.remapping) {
      const preview = h('div', { class: 'mt-remap-preview' }), scopes = h('div', { class: 'mt-remap-scopes' }), status = h('div', { class: 'mt-remap' });
      const ed = remapEditor('map16', () => this.drawRemap());
      const box = h('div', { class: 'mt-remap' },
        h('div', { class: 'prop-title' }, 'Remap tiles', h('span', { class: 'hint' }, '  8x8 tile numbers, palettes, acts-like')),
        scopes, ed.root,
        h('div', { class: 'hint' }, 'Visual: mark source 8x8 tiles on the right, then drag them to where they are now – the list gets the line.'),
        status);
      this.remapping = { ed, scope: 'sel', box, scopes, status, preview };
    }
    const r = this.remapping;
    if (fill.scope) r.scope = fill.scope;
    if (fill.line !== undefined) r.ed.setText(fill.line);
    this.visualFrom = this.visualTo = null;
    if (this.visible) { this.buildBar(); this.redraw(); }
  }
  private closeRemap(): void {
    this.remapping = null;
    this.visualFrom = this.visualTo = null;
    this.buildBar();
    this.redraw();
  }

  // the tiles the remap changes: the selection, or the extended tiles using a source 8x8 tile of the list
  private remapTargets(): number[] {
    const r = this.remapping!;
    if (r.scope === 'sel') return this.selection();
    const { remap } = r.ed.parsed();
    const src = new Set([...remap.tiles.keys(), ...remap.tilePals.keys()]);
    const out: number[] = [];
    if (!src.size) return out;
    for (let t = EXT_FIRST; t < EXT_TILES; t++) if (this.words(t).some((w) => src.has(w & 0x3ff))) out.push(t);
    return out;
  }

  // each target before and after the remap
  private remapResult(): RemapRow[] {
    const { remap } = this.remapping!.ed.parsed();
    return this.remapTargets().map((t) => {
      const words = this.words(t), acts = this.bg ? null : actsLike(this.app.rom, t);
      const r = remapTile(words, acts, t, remap);
      return { tile: t, words, acts, newWords: r.words, newActs: r.acts, out: r.out, changed: r.words.some((w, q) => w !== words[q]) || r.acts !== acts };
    });
  }

  private drawRemap(): void {
    const r = this.remapping;
    if (!r) return;
    const { remap } = r.ed.parsed();
    const res = this.remapResult();
    const changed = res.filter((x) => x.changed);
    const out = [...new Set(res.flatMap((x) => x.out))].sort((a, b) => a - b);
    const scope = (v: RemapScope, label: string, title: string) => h('label', { class: 'toggle', title },
      h('input', { type: 'radio', name: 'mt-remap-scope', checked: r.scope === v, onchange: () => { r.scope = v; this.drawRemap(); } }), label);
    const bad = !r.ed.valid();
    r.scopes.replaceChildren(
      scope('sel', `Selected ${this.bg ? 'BG' : 'FG'} tiles (${this.selW * this.selH} from ${hex(this.sel, 3)})`, 'Select tiles in the sheet on the left'),
      scope('uses', `${this.bg ? 'BG' : 'FG'} tiles 200–FFF that use the list's source 8x8 tiles`, 'Every extended tile with a quarter the list changes'));
    r.status.replaceChildren(
      this.bg && (remap.acts.size || remap.tileActs.size) ? h('div', { class: 'hint' }, 'BG tiles have no acts-like setting: G and S pairs do nothing here.') : '',
      r.preview,
      out.length ? h('div', { class: 'warn-box' }, `The offset takes 8x8 tile${out.length > 1 ? 's' : ''} ${out.slice(0, 8).map((t) => hex(t, 3)).join(', ')}${out.length > 8 ? ' …' : ''} out of 000–3FF: they stay.`) : '',
      h('div', { class: 'hint' }, bad ? 'Fix the marked lines first.' : `${changed.length} of ${res.length} tile${res.length === 1 ? '' : 's'} change.`),
      h('div', { class: 'row' },
        h('button', { class: 'primary', disabled: bad || !changed.length, onclick: () => this.applyRemap() }, 'Apply'),
        h('button', { onclick: () => this.closeRemap() }, 'Close')),
    );
    this.drawRemapPreview(res);
    this.drawGfx();
  }

  // the targets before and after, side by side (the selection in its shape, other tiles 8 a row)
  private drawRemapPreview(res: RemapRow[]): void {
    const r = this.remapping!;
    const MAX = 256, shown = res.slice(0, MAX);
    const cols = r.scope === 'sel' ? this.selW : Math.min(8, Math.max(1, shown.length));
    const rows = Math.ceil(shown.length / cols);
    const z = cols <= 8 ? 2 : 1;
    const cache = this.tc();
    const grid = (pick: (x: RemapRow) => number[], mark: boolean) => {
      const c = h('canvas', { width: cols * 16 * z, height: Math.max(1, rows) * 16 * z, class: 'mt-remap-grid' });
      const ctx = c.getContext('2d')!;
      const img = ctx.createImageData(cols * 16, Math.max(1, rows) * 16);
      const px = new Uint32Array(img.data.buffer);
      shown.forEach((x, i) => {
        const ox = (i % cols) * 16, oy = Math.floor(i / cols) * 16;
        pick(x).forEach((w, q) => {
          const tile = cache.get(w);
          const qx = ox + (q >> 1) * 8, qy = oy + (q & 1) * 8;
          for (let y = 0; y < 8; y++) for (let xx = 0; xx < 8; xx++) px[(qy + y) * cols * 16 + qx + xx] = tile[y * 8 + xx] || ((xx + y) & 4 ? 0xff2a2a2a : 0xff222222);
        });
      });
      const off = document.createElement('canvas');
      off.width = cols * 16; off.height = Math.max(1, rows) * 16;
      off.getContext('2d')!.putImageData(img, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(off, 0, 0, c.width, c.height);
      if (mark) {
        ctx.strokeStyle = '#ffb000'; ctx.lineWidth = 1;
        shown.forEach((x, i) => { if (x.changed) ctx.strokeRect((i % cols) * 16 * z + 0.5, Math.floor(i / cols) * 16 * z + 0.5, 16 * z - 1, 16 * z - 1); });
      }
      c.title = 'Marked: tiles that change';
      return c;
    };
    r.preview.replaceChildren(!shown.length ? h('div', { class: 'hint' }, r.scope === 'uses' ? 'No tile 200–FFF uses the list\'s source 8x8 tiles.' : 'No tiles selected.') :
      h('div', { class: 'mt-remap-sides' },
        h('div', null, h('div', { class: 'hint' }, 'Before'), grid((x) => x.words, false)),
        h('div', null, h('div', { class: 'hint' }, 'After'), grid((x) => x.newWords, true))),
      res.length > MAX ? h('div', { class: 'hint' }, `The first ${MAX} of ${res.length} tiles shown.`) : '');
  }

  // one undo step for all tiles
  private applyRemap(): void {
    const res = this.remapResult().filter((x) => x.changed);
    if (!res.length) return;
    this.edit(`${res.length} ${this.bg ? 'BG' : 'FG'} tile${res.length > 1 ? 's' : ''} remapped`, () => {
      for (const x of res) {
        if (x.newWords.some((w, q) => w !== x.words[q])) this.setWords(x.tile, x.newWords);
        if (x.newActs !== null && x.newActs !== x.acts) setActsLike(this.app.rom, x.tile, x.newActs);
      }
    });
    toast(`${res.length} tile${res.length > 1 ? 's' : ''} remapped – Ctrl+Z undoes it`);
    this.closeRemap();
  }

  // visual mode: a drag marks source 8x8 tiles; dragging the marked tiles drops them where they are now
  // and writes the list line (a rectangle of the view must be one of consecutive tile rows)
  private remapMouse(e: MouseEvent, cell: (e: MouseEvent) => Cell, tileOf: (p: Cell) => number): void {
    const a = cell(e), v = this.visualFrom;
    const block = (x: number, y: number, w: number, hh: number) => {
      const t0 = tileOf({ x, y });
      for (let dy = 0; dy < hh; dy++) for (let dx = 0; dx < w; dx++) if (t0 < 0 || tileOf({ x: x + dx, y: y + dy }) !== t0 + dy * 16 + dx) return -1;
      return t0;
    };
    let move: (ev: MouseEvent) => void, up: (ev: MouseEvent) => void;
    if (v && a.x >= v.x && a.x < v.x + v.w && a.y >= v.y && a.y < v.y + v.h) {
      // dragging the marked tiles
      const gx = a.x - v.x, gy = a.y - v.y;
      move = (ev) => { const n = cell(ev); this.visualTo = { x: n.x - gx, y: n.y - gy }; this.drawGfx(); };
      up = () => {
        const d = this.visualTo;
        this.visualTo = null;
        if (!d || (d.x === v.x && d.y === v.y)) { this.drawGfx(); return; }
        const from = block(v.x, v.y, v.w, v.h), to = d.x < 0 || d.x + v.w > 16 ? -1 : block(d.x, d.y, v.w, v.h);
        if (from < 0 || to < 0) { toast('Source and destination must each be tiles in consecutive rows (not across a gap between slots)'); this.drawGfx(); return; }
        this.visualFrom = null;
        this.remapping?.ed.append(remapLine(from, v.w, v.h, to));
      };
    } else {
      this.visualFrom = { x: a.x, y: a.y, w: 1, h: 1 };
      move = (ev) => {
        const n = cell(ev);
        this.visualFrom = { x: Math.min(a.x, n.x), y: Math.min(a.y, n.y), w: Math.abs(a.x - n.x) + 1, h: Math.abs(a.y - n.y) + 1 };
        this.drawGfx();
      };
      up = () => this.drawGfx();
      this.drawGfx();
    }
    const done = (ev: MouseEvent) => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', done); up(ev); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', done);
  }

  // ---------- 8x8 graphics ----------
  private drawGfx(): void {
    const app = this.app;
    const z = this.gfxZoom();
    this.gzPx = Math.ceil(z);
    const fq = this.focusQ(), fw = this.wordAt(fq);
    const pal = (fw >> 10) & 7;
    const slots = layerSlots(this.gfxSlots());
    const rows = slots.length * 8;
    const W = 128, Hh = rows * 8;
    const c = this.gfxCanvas;
    c.width = W * this.gzPx; c.height = Hh * this.gzPx;
    const ctx = c.getContext('2d')!;
    const img = ctx.createImageData(W, Hh);
    const px = new Uint32Array(img.data.buffer);
    px.fill(0xff202020);
    const cache = this.tc();
    slots.forEach((s, si) => {
      for (let k = 0; k < 128; k++) {
        const tile = cache.get((s.first + k) | (pal << 10));
        const bx = (k & 15) * 8, by = si * 64 + (k >> 4) * 8;
        for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) { const v = tile[y * 8 + x]; if (v) px[(by + y) * W + bx + x] = v; }
      }
    });
    const off = document.createElement('canvas');
    off.width = W; off.height = Hh;
    off.getContext('2d')!.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(off, 0, 0, W * this.gzPx, Hh * this.gzPx);
    // the marked quarters' 8x8 tiles, the followed quarter's stronger
    const mark = (n: number, strong: boolean) => {
      const si = slots.findIndex((s) => n >= s.first && n < s.first + 0x80);
      if (si < 0) return;
      const k = n - slots[si].first;
      ctx.strokeStyle = strong ? '#ffb000' : 'rgba(255,176,0,0.55)'; ctx.lineWidth = strong ? 2 : 1;
      ctx.strokeRect((k & 15) * 8 * this.gzPx + 1, (si * 64 + (k >> 4) * 8) * this.gzPx + 1, 8 * this.gzPx - 2, 8 * this.gzPx - 2);
    };
    const words = this.selWords(), g = this.grid();
    for (const n of new Set([...this.marked()].map((k) => { const { tile, q } = g.locate(k); return words[tile][q] & 0x3ff; }))) mark(n, false);
    mark(fw & 0x3ff, true);
    // tiles the game animates: hatched corner
    const anim = app.animated();
    if (anim?.tiles.size) {
      ctx.fillStyle = '#ff4fd8';
      slots.forEach((s, si) => {
        for (let k = 0; k < 128; k++) {
          if (!anim.tiles.has(s.first + k)) continue;
          const x = (k & 15) * 8 * this.gzPx, y = (si * 64 + (k >> 4) * 8) * this.gzPx;
          ctx.beginPath(); ctx.moveTo(x + 8 * this.gzPx, y); ctx.lineTo(x + 8 * this.gzPx, y + 6); ctx.lineTo(x + 8 * this.gzPx - 6, y); ctx.fill();
        }
      });
    }
    if (this.remapping) this.drawRemapMarks(ctx, slots);
    // the chosen 8x8 tiles, or those being chosen
    const d = this.drag, r = d ? { x: Math.min(d.a.x, d.b.x), y: Math.min(d.a.y, d.b.y), w: Math.abs(d.a.x - d.b.x) + 1, h: Math.abs(d.a.y - d.b.y) + 1 } : this.remapping ? null : this.pick;
    if (r) {
      ctx.strokeStyle = '#4cc2ff'; ctx.lineWidth = 2;
      ctx.strokeRect(r.x * 8 * this.gzPx + 1, r.y * 8 * this.gzPx + 1, r.w * 8 * this.gzPx - 2, r.h * 8 * this.gzPx - 2);
    }
    c.style.width = `${W * z}px`; c.style.height = `${Hh * z}px`;
    this.gfxLabels.replaceChildren(...slots.map((s) => h('div', { class: 'mt-slot', style: { height: `${64 * z}px` } },
      h('span', { class: 'mt-slot-name' }, s.name),
      h('a', { href: '#', class: 'mt-slot-file', title: 'Open in the Graphics tab (sheet and pixel editor)', onclick: (e: Event) => { e.preventDefault(); this.ws.showGfx(s.file); } }, gfxName(s.file)),
      s.custom ? h('span', { class: 'hint' }, 'custom') : '',
      h('span', { class: 'hint mono' }, `${hex(s.first, 3)}–${hex(s.first + 0x7f, 3)}`))));
    this.gfxTitle.replaceChildren(`8x8 graphics in palette ${pal}`);
    this.gfxTitle.title = 'The palette follows the quarter under the mouse, else the first marked · Ctrl+wheel: zoom · middle button: pan';
  }

  // zoom of the 8x8 graphics: as set by Ctrl+wheel, else 16 tiles fitted into the column
  private gfxZoom(): number {
    if (this.gzoom !== null) return this.gzoom;
    return Math.max(1, Math.min(8, (this.gfxScroll.clientWidth - LABELS_W - 2) / 128));
  }
  private setGfxZoom(z: number, ax: number, ay: number): void {
    const old = this.gfxZoom(), sc = this.gfxScroll;
    const lx = (sc.scrollLeft + ax - LABELS_W) / old, ly = (sc.scrollTop + ay) / old;
    this.gzoom = z;
    this.drawGfx();
    sc.scrollLeft = lx * z + LABELS_W - ax;
    sc.scrollTop = ly * z - ay;
  }

  // remap: the list's sources (orange) and destinations (green), the visual mode's marked tiles (blue)
  // and where they are being dragged (dashed)
  private drawRemapMarks(ctx: CanvasRenderingContext2D, slots: { first: number }[]): void {
    const { remap } = this.remapping!.ed.parsed();
    const at = (t: number) => { const si = slots.findIndex((s) => t >= s.first && t < s.first + 0x80); return si < 0 ? null : { x: ((t - slots[si].first) & 15) * 8 * this.gzPx, y: (si * 8 + ((t - slots[si].first) >> 4)) * 8 * this.gzPx }; };
    const fill = (tiles: Iterable<number>, color: string) => { ctx.fillStyle = color; for (const t of tiles) { const p = at(t); if (p) ctx.fillRect(p.x, p.y, 8 * this.gzPx, 8 * this.gzPx); } };
    fill(new Set([...remap.tiles.keys(), ...remap.tilePals.keys()]), 'rgba(255,176,0,0.35)');
    fill(new Set(remap.tiles.values()), 'rgba(80,220,120,0.35)');
    const box = (x: number, y: number, w: number, hh: number, dash: boolean) => {
      ctx.strokeStyle = '#4cc2ff'; ctx.lineWidth = 2; ctx.setLineDash(dash ? [4, 3] : []);
      ctx.strokeRect(x * 8 * this.gzPx + 1, y * 8 * this.gzPx + 1, w * 8 * this.gzPx - 2, hh * 8 * this.gzPx - 2);
      ctx.setLineDash([]);
    };
    if (this.visualFrom) box(this.visualFrom.x, this.visualFrom.y, this.visualFrom.w, this.visualFrom.h, false);
    if (this.visualFrom && this.visualTo) box(this.visualTo.x, this.visualTo.y, this.visualFrom.w, this.visualFrom.h, true);
  }

  // 8x8 tile number at a cell of the grouped view (-1: none)
  private gfxTileAt(p: Cell): number {
    const s = layerSlots(this.gfxSlots())[p.y >> 3];
    return s ? s.first + (p.y & 7) * 16 + p.x : -1;
  }
  // the chosen 8x8 tiles as rows of tile numbers
  private pickBlock(): number[][] | null {
    const p = this.pick;
    return p && Array.from({ length: p.h }, (_, y) => Array.from({ length: p.w }, (_, x) => this.gfxTileAt({ x: p.x + x, y: p.y + y })));
  }
  // puts the chosen 8x8 tiles with their top-left corner on a quarter; a single one keeps the quarter's
  // flips. key: edits of one stroke merge into one undo step; false when nothing is chosen
  private putPick(at: Cell, key: string | null = null): boolean {
    const block = this.pickBlock();
    if (!block) { toast('Choose 8x8 tiles on the right first'); return false; }
    const n = block[0][0];
    if (block.length === 1 && block[0].length === 1) {
      if (n < 0) return true;
      const g = this.grid();
      this.writeTiles(editMarked(g, this.selWords(), new Set([g.key(at.x, at.y)]), setTileNum(n)), `8x8 tile ${hex(n, 3)}`, key);
    } else this.stampAt(at, block, key);
    return true;
  }
  // Enter: a single chosen 8x8 tile into every marked quarter, a block from the first marked one
  private fillMarked(): void {
    const block = this.pickBlock(), m = this.marked();
    if (!block) { toast('Choose 8x8 tiles on the right first'); return; }
    if (block.length === 1 && block[0].length === 1) { if (block[0][0] >= 0) this.editQuarters(setTileNum(block[0][0]), `8x8 tile ${hex(block[0][0], 3)}`); }
    else if (!m.size) toast('Mark a quarter first');
    else this.stampAt(this.grid().pos(Math.min(...m)), block);
  }

  private drag: { a: Cell; b: Cell } | null = null;
  private pick: { x: number; y: number; w: number; h: number } | null = null; // the chosen 8x8 tiles (cells)
  private paints = 0; // right-button strokes in the builder, for their undo keys
  private attachGfx(): void {
    const c = this.gfxCanvas;
    attachPanZoom(this.gfxScroll, () => this.gfxZoom(), (z, ax, ay) => this.setGfxZoom(z, ax, ay), 1, 8);
    let lastW = 0;
    new ResizeObserver(() => {
      const w = this.gfxScroll.clientWidth;
      if (w === lastW) return;
      lastW = w;
      if (this.visible && this.gzoom === null) this.drawGfx();
    }).observe(this.gfxScroll);
    const cell = (e: MouseEvent) => {
      const rc = c.getBoundingClientRect();
      return {
        x: Math.max(0, Math.min(15, Math.floor((e.clientX - rc.left) / (rc.width / 16)))),
        y: Math.max(0, Math.min(c.height / (8 * this.gzPx) - 1, Math.floor((e.clientY - rc.top) / (rc.height / (c.height / (8 * this.gzPx)))))),
      };
    };
    const tileOf = (p: Cell) => this.gfxTileAt(p);
    c.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      if (this.remapping) { this.remapMouse(e, cell, tileOf); return; }
      this.drag = { a: cell(e), b: cell(e) };
      this.drawGfx();
      const move = (ev: MouseEvent) => {
        if (!this.drag) return;
        const n = cell(ev);
        const over = (ev.target as HTMLElement).dataset?.drop;
        if (!over && (n.x !== this.drag.b.x || n.y !== this.drag.b.y)) { this.drag.b = n; this.drawGfx(); }
        document.body.classList.toggle('mt-dragging', !!over);
      };
      const up = (ev: MouseEvent) => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        document.body.classList.remove('mt-dragging');
        const d = this.drag!;
        this.drag = null;
        this.pick = { x: Math.min(d.a.x, d.b.x), y: Math.min(d.a.y, d.b.y), w: Math.abs(d.a.x - d.b.x) + 1, h: Math.abs(d.a.y - d.b.y) + 1 };
        // dropped onto the builder: put where it lies
        if (ev.target === this.bigCanvas) this.putPick(this.quarterUnder(ev));
        this.redraw();
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
    c.addEventListener('mousemove', (e) => {
      if (this.drag) return;
      const n = tileOf(cell(e));
      c.title = n >= 0 ? `8x8 tile ${hex(n, 3)}${this.app.animated()?.tiles.has(n) ? ' – animated (the game keeps overwriting it)' : ''}` : '';
    });
  }

  // ---------- copy / paste / files ----------
  private copy(): void {
    const tiles = this.selection();
    this.clip = { w: this.selW, h: this.selH, words: tiles.map((t) => this.words(t)), acts: this.bg ? null : tiles.map((t) => actsLike(this.app.rom, t)) };
    toast(`${tiles.length} tile${tiles.length > 1 ? 's' : ''} copied`);
  }
  private paste(): void {
    const c = this.clip;
    if (!c) { toast('Copy tiles first (Ctrl+C)'); return; }
    const max = EXT_TILES;
    const targets: number[] = [];
    for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) targets.push(this.sel + y * 16 + x);
    if (targets.some((t) => t >= max) || (this.sel & 15) + c.w > 16) { toast('The tiles do not fit on the page from here', 'error'); return; }
    this.edit(`${targets.length} tile${targets.length > 1 ? 's' : ''} pasted at ${hex(this.sel, 3)}`, () => {
      targets.forEach((t, i) => {
        this.setWords(t, c.words[i]);
        if (c.acts && !this.bg) setActsLike(this.app.rom, t, c.acts[i]);
      });
    });
    this.selW = c.w; this.selH = c.h;
    this.redraw();
  }

  private async importMap16(): Promise<void> {
    const f = await pickFile('.map16');
    if (!f) return;
    let m: Map16File;
    try {
      m = parseMap16File(new Uint8Array(await f.arrayBuffer()));
      const targets = map16Targets(m, this.sel);
      if (targets.some((t) => t >= EXT_TILES)) throw new Error('The tiles no longer fit on the Map16 pages from here');
      this.edit(`${f.name} imported`, () => targets.forEach((t, i) => {
        this.setWords(t, m.tiles[i]);
        if (m.acts && !this.bg) setActsLike(this.app.rom, t, m.acts![i]);
      }));
      this.selW = Math.min(16, m.width); this.selH = m.height;
      toast(`${m.tiles.length} tile(s) from ${f.name} imported at ${hex(this.sel, 3)}`);
    } catch (e) { toast(String(e instanceof Error ? e.message : e), 'error'); this.buildBar(); this.redraw(); return; }
    this.buildBar();
    this.redraw();
    await this.offerImportRemap();
    await this.offerUsesRemap(m);
  }

  // A .map16 imported elsewhere than it was exported from: the levels using the tiles at their old numbers
  // may be rewritten to the new ones (Remap Direct Map16 / Background Tiles with the list filled in)
  private async offerUsesRemap(m: Map16File): Promise<void> {
    const o = m.origin, layer = this.bg ? 'bg' : 'fg';
    if (!o || o.bg !== this.bg || o.tile === this.sel) return;
    const w = Math.min(16, m.width), line = remapLine(o.tile, w, m.height, this.sel);
    const { remap } = parseRemap(line, { what: 'numbers' });
    const users = planRemap(this.app.rom, layer, remap.tiles, levelSource(this.app, remap.tiles)).levels;
    if (!users.length) return;
    const span = `${hex(o.tile, 3)}–${hex(o.tile + (m.height - 1) * 16 + w - 1, 3)}`;
    const pick = await choose('Rewrite the levels using these tiles?', h('div', { style: 'max-width:480px' },
      h('p', null, `The file's tiles were exported from ${span}. ${users.length} level${users.length > 1 ? 's' : ''} here ${users.length > 1 ? 'use' : 'uses'} tiles at those numbers (e.g. ${hex(users[0].level, 3)}).`),
      h('p', { class: 'hint' }, `${layer === 'fg' ? 'Remap Direct Map16' : 'Remap Background Tiles'} opens with the list filled in; it shows every level it rewrites before anything changes.`)),
      [{ label: 'Rewrite …', primary: true }, { label: 'Not now' }]);
    if (pick === 0) openRemapUses(this.app, layer, { line, all: true });
  }

  // imported tiles that draw from a slot holding no ExGFX in this level, while ExGFX the tiles don't use
  // are in other slots: their graphics are likely there. Offers the remap with that slot's offset.
  private async offerImportRemap(): Promise<void> {
    const slots = layerSlots(this.gfxSlots());
    const count = new Map<number, number>(); // 128-tile region → quarters drawing from it
    for (const t of this.selection()) for (const w of this.words(t)) count.set((w & 0x3ff) >> 7, (count.get((w & 0x3ff) >> 7) ?? 0) + 1);
    const main = [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (main === undefined) return;
    const own = slots.find((x) => x.first === main * 0x80);
    if (own && own.custom && own.file >= VANILLA_GFX) return;
    const cands = slots.filter((x) => x.custom && x.file >= VANILLA_GFX && x.file < ANIM_FILE && !count.has(x.first >> 7)).slice(0, 3);
    if (!cands.length) return;
    const span = `${hex(main * 0x80, 3)}–${hex(main * 0x80 + 0x7f, 3)}`;
    const pick = await choose('Remap the imported tiles?', h('div', { style: 'max-width:480px' },
      h('p', null, `The imported tiles draw mostly from ${own ? `${own.name} (${span})` : span}, where this level has ${own ? gfxName(own.file) : 'no graphics'}. ` +
        `Their graphics may be in ${cands.map((x) => `${x.name} (${gfxName(x.file)})`).join(' or ')}.`),
      h('p', { class: 'hint' }, 'The remap opens with the offset filled in; the preview shows the tiles before anything changes.')),
      [...cands.map((x, i) => ({ label: `Remap to ${x.name} …`, primary: i === 0 })), { label: 'Not now' }]);
    if (pick === null || pick >= cands.length) return;
    this.openRemap({ line: slotRemapLine(main * 0x80, cands[pick].first), scope: 'sel' });
  }

  private async exportMap16(): Promise<void> {
    const tiles = this.selection();
    const data = writeMap16File({ width: this.selW, height: this.selH, tiles: tiles.map((t) => this.words(t)), acts: this.bg ? null : tiles.map((t) => actsLike(this.app.rom, t)) });
    const name = `${this.bg ? 'bg' : 'fg'}_${hex(this.sel, 3)}.map16`;
    if (await downloadBytes(name, data)) toast(`${name} exported`);
  }

  key(e: KeyboardEvent): boolean {
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key;
    if (ctrl && k.toLowerCase() === 'c') { this.copy(); return true; }
    if (ctrl && k.toLowerCase() === 'v') { this.paste(); return true; }
    if (ctrl && k.toLowerCase() === 'a' && !this.remapping) { this.setMarks(this.grid().all()); return true; }
    if (ctrl || e.altKey) return false;
    if (k === 'Escape' && this.moving) { this.closeMove(); return true; }
    if (k === 'Escape' && this.remapping) { if (this.visualFrom) { this.visualFrom = null; this.drawGfx(); } else this.closeRemap(); return true; }
    if (k === 'Escape') { if (!this.marked().size) return false; this.setMarks(new Set()); return true; }
    if (k === 'Enter' && !this.remapping) { this.fillMarked(); return true; }
    if (k === 'x' || k === 'X') { this.flip(FLIP_X, '↔ Flip'); return true; }
    if (k === 'y' || k === 'Y') { this.flip(FLIP_Y, '↕ Flip'); return true; }
    if (k >= '1' && k <= '8') { const p = Number(k) - 1; this.editQuarters(setPalette(p), `Palette ${p}`); return true; }
    if (k === 'q' || k === 'Q') {
      // only the next quarter of the followed quarter's tile (in reading order)
      const g = this.grid(), { x, y } = g.pos(this.focusQ()), nq = [2, 3, 1, 0][g.at(x, y).q];
      this.hoverQ = null;
      this.setMarks(new Set([g.key((x & ~1) + (nq >> 1), (y & ~1) + (nq & 1))]));
      return true;
    }
    if (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'ArrowUp' || k === 'ArrowDown') {
      const d = k === 'ArrowLeft' ? -1 : k === 'ArrowRight' ? 1 : k === 'ArrowUp' ? -16 : 16;
      const max = EXT_TILES;
      const n = this.sel + d;
      if (n < 0 || n >= max) return true;
      this.sel = n;
      this.selW = this.selH = 1;
      this.redraw();
      this.scrollToSel();
      return true;
    }
    return false;
  }

  previewClick(px: number, py: number): void {
    const t = this.ws.preview.tileAt(px, py);
    if (t >= 0) this.select(t, false);
  }
}
