// Map16 tab: the tile sheet (pages, labelled ranges, multi-selection, copy/paste), a builder for the
// selected 16x16 tile (click a quarter, palette dots, flip/priority toggles) and the level's 8x8 graphics
// grouped by GFX slot. The graphics view uses the palette of the selected quarter; clicking an 8x8 tile
// puts it into that quarter, dragging a 2x2 block fills all four, dragging one onto the builder fills
// the quarter it is dropped on.

import type { App } from '../app.ts';
import type { GfxWorkspace, WsPanel } from '../gfxworkspace.ts';
import { h, clear, toast, pickFile, modal, downloadBytes } from '../dom.ts';
import { TileCache, map16Source } from '../../core/render.ts';
import { hex } from '../../core/names.ts';
import { EXT_FIRST, EXT_TILES, map16Ext, actsLike, setActsLike, setExtTileWords } from '../../core/map16ext.ts';
import { blockFileOf, openBlockDialog } from '../blockdialog.ts';
import { parseMap16File, map16Targets, writeMap16File } from '../../core/map16file.ts';
import { renderMap16Sheet } from '../panels.ts';
import { probeText } from '../../core/blockprobe.ts';
import { levelGfx, defaultGfx, levelExtGfx, VANILLA_GFX } from '../../core/patches.ts';
import { cgramToRGBA } from '../../core/gfx.ts';

const Z = 2; // sheet zoom
const GZ = 2; // 8x8 graphics zoom
const BZ = 12; // builder zoom
const FLIP_X = 0x4000, FLIP_Y = 0x8000, PRIO = 0x2000;
// quarter index (word order TL, BL, TR, BR) from its position
const quarterAt = (qx: number, qy: number) => qx * 2 + qy;

interface Clip { w: number; h: number; words: number[][]; acts: number[] | null }

// files 100-103: the ExAnimation alternative files (Lunar Magic's ExGFX 60-63)
export const ANIM_FILE = 0x100;
export function gfxName(n: number): string {
  if (n >= ANIM_FILE) return `Anim-ExGFX${hex(n - ANIM_FILE + 0x60, 2)}`;
  return `${n < VANILLA_GFX ? 'GFX' : 'ExGFX'}${hex(n, 2)}`;
}

// GFX files in the level's layer slots, in VRAM order (128 tiles each from tile 000)
export function levelSlots(app: App): { name: string; file: number; first: number; custom: boolean }[] {
  const lv = app.level;
  const set = levelGfx(app.rom, lv.number);
  const def = defaultGfx(app.rom, lv.header.tileset, lv.header.spriteGfx);
  const out = [['FG1', 7], ['FG2', 6], ['BG1', 5], ['FG3', 4]].map(([name, k], i) => ({
    name: name as string, file: set[k as number] !== 0xff ? set[k as number] : def[k as number], first: i * 0x80, custom: set[k as number] !== 0xff,
  }));
  const ext = levelExtGfx(app.rom, lv.number);
  ext.forEach((f, i) => { if (f !== 0xff) out.push({ name: i ? 'BG3' : 'BG2', file: f, first: 0x200 + i * 0x80, custom: true }); });
  return out;
}

export class Map16Tab implements WsPanel {
  root: HTMLElement;
  private app: App;
  private ws: GfxWorkspace;
  private bg = false;
  private base = 0; // first tile of the shown sheet
  private sel = 0x130;
  private selW = 1;
  private selH = 1;
  private quad = 0;
  private clip: Clip | null = null;
  private sameActs = false; // mark tiles that act like the selected one
  private visible = false;
  private bar = h('div', { class: 'ws-bar' });
  private sheet = h('canvas', { class: 'mt-sheet', width: 256 * Z + 34, height: 512 * Z });
  private builder = h('div', { class: 'mt-builder' });
  private gfxBox = h('div', { class: 'mt-gfx' });
  private gfxCanvas = h('canvas', { class: 'mt-gfx-canvas' });

  constructor(app: App, ws: GfxWorkspace) {
    this.app = app;
    this.ws = ws;
    this.root = h('div', { class: 'mt' }, this.bar,
      h('div', { class: 'mt-main' },
        h('div', { class: 'mt-col mt-sheet-col' }, h('div', { class: 'mt-scroll' }, this.sheet)),
        h('div', { class: 'mt-col mt-builder-col' }, this.builder),
        h('div', { class: 'mt-col mt-gfx-col' }, this.gfxBox)));
    this.attachSheet();
    this.attachGfx();
    const redraw = () => { if (this.visible) this.redraw(); };
    app.on('rom-change', redraw);
    app.on('render', redraw);
    app.on('blockinfo', () => { if (this.visible) this.buildBuilder(); });
    app.on('animated', redraw);
  }

  previewHint(): string {
    return 'Klick: Tile unter der Maus bearbeiten · markiert: wo das gewählte Tile im Level vorkommt';
  }

  show(): void {
    this.visible = true;
    this.buildBar();
    this.redraw();
  }
  hide(): void { this.visible = false; }

  select(tile: number, bg = false): void {
    this.bg = bg;
    this.sel = tile & (bg ? 0x1ff : EXT_TILES - 1);
    this.base = this.sel & ~0x1ff;
    this.selW = this.selH = 1;
    this.quad = 0;
    if (this.visible) { this.buildBar(); this.redraw(); this.scrollToSel(); }
  }

  // ---------- data ----------
  private blank(): number[] {
    return map16Source(this.app.rom, this.app.render).fg(0x025);
  }
  private tileAddr(t: number): number {
    if (this.bg) return 0x0d9100 + t * 8;
    if (t >= EXT_FIRST) { const p = map16Ext(this.app.rom); return p ? p.gfx + (t - EXT_FIRST) * 8 : -1; }
    const w = this.app.render.wram;
    return 0x0d0000 | (w[0x0fbe + t * 2] | (w[0x0fbf + t * 2] << 8));
  }
  words(t: number): number[] {
    const a = this.tileAddr(t);
    return a < 0 ? this.blank() : [0, 1, 2, 3].map((q) => this.app.rom.r16(a + q * 2));
  }
  private setWords(t: number, ws: number[]): void {
    if (!this.bg && t >= EXT_FIRST) setExtTileWords(this.app.rom, t, ws, this.blank());
    else { const a = this.tileAddr(t); ws.forEach((v, q) => this.app.rom.w16(a + q * 2, v)); }
  }
  private tc(): TileCache {
    const r = this.app.render;
    return new TileCache(r.vram, r.cgram, (this.bg ? r.ppuRegs[0x0b] >> 4 : r.ppuRegs[0x0b] & 0x0f) << 13);
  }
  private tileName(t: number): string {
    return `${this.bg ? 'BG' : 'FG'}-Tile ${hex(t, 3)}`;
  }

  private edit(label: string, fn: () => void, key: string | null = null): void {
    try { this.app.romEdit(label, fn, key); } catch (e) { toast(String(e instanceof Error ? e.message : e), 'error'); }
  }

  private writeWord(q: number, v: number, label: string): void {
    const t = this.sel;
    const ws = this.words(t);
    if (ws[q] === v) return;
    ws[q] = v;
    this.edit(`${this.tileName(t)}: ${label}`, () => this.setWords(t, ws));
  }

  // ---------- UI ----------
  private buildBar(): void {
    clear(this.bar);
    const page = (b: number, bg: boolean, label: string, title: string) => h('button', {
      class: this.bg === bg && (bg || this.base === b) ? 'active' : '', title,
      onclick: () => { this.bg = bg; this.base = b; this.sel = b + (this.sel & 0x1ff); this.selW = this.selH = 1; this.buildBar(); this.redraw(); },
    }, label);
    const ext = !!map16Ext(this.app.rom);
    this.bar.append(
      h('span', { class: 'btn-group' },
        page(0, false, 'Seite 0–1', 'Vordergrund: Standard-Tiles und Tileset-Tiles'),
        ...Array.from({ length: EXT_TILES / 512 - 1 }, (_, i) => {
          const b = (i + 1) * 512;
          return page(b, false, `${hex(b >> 8, 1)}–${hex((b >> 8) + 1, 1)}`, `Erweiterte Tiles ${hex(b, 3)}–${hex(b + 511, 3)} (im Level per Direct-Map16-Objekt)${ext ? '' : ' – werden beim ersten Ändern angelegt'}`);
        }),
        page(0, true, 'Hintergrund', 'BG-Tiles (Layer-2-Hintergründe)')),
      h('span', { class: 'sep' }),
      h('button', { onclick: () => this.copy(), title: 'Gewählte Tiles kopieren, mit Verhalten (Strg+C)' }, 'Kopieren'),
      h('button', { onclick: () => this.paste(), title: 'Ab dem gewählten Tile einfügen (Strg+V)' }, 'Einfügen'),
      h('label', { class: 'toggle', title: 'Alle Tiles markieren, die sich wie das gewählte verhalten' },
        (() => { const cb = h('input', { type: 'checkbox', checked: this.sameActs }); cb.addEventListener('change', () => { this.sameActs = cb.checked; this.drawSheet(); }); return cb; })(),
        'Gleiches Verhalten markieren'),
      h('span', { class: 'spacer' }),
      h('button', { onclick: () => void this.importMap16(), title: 'Lunar-Magic-.map16 ab dem gewählten Tile einfügen' }, '.map16 importieren'),
      h('button', { onclick: () => this.exportMap16(), title: 'Gewählte Tiles (mit Verhalten) als .map16 speichern' }, '.map16 exportieren'),
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

  // sheet: 16x32 tiles with a margin showing what the ranges are
  private drawSheet(): void {
    const c = this.sheet, ctx = c.getContext('2d')!;
    const M = 34; // left margin
    ctx.fillStyle = '#1b1d22';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(renderMap16Sheet(this.app, this.bg, this.base), M, 0, 256 * Z, 512 * Z);
    // ranges
    const band = (from: number, to: number, color: string, label: string) => {
      const a = Math.max(from, this.base), b = Math.min(to, this.base + 0x1ff);
      if (a > b) return;
      const y0 = ((a - this.base) >> 4) * 16 * Z, y1 = (((b - this.base) >> 4) + 1) * 16 * Z;
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
    if (this.bg) band(0, 0x1ff, '#7d8bff', 'Hintergrund-Tiles');
    else {
      band(0x000, 0x072, '#8b93a3', 'Standard');
      band(0x073, 0x0ff, '#ffb000', `Tileset ${hex(this.app.level.header.tileset, 1)}`);
      band(0x100, 0x1ff, '#8b93a3', 'Standard');
      band(0x200, EXT_TILES - 1, '#4cc2ff', 'Erweitert');
    }
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'right';
    for (let row = 0; row < 32; row += 2) ctx.fillText(hex(this.base + row * 16, 3), M - 2, row * 16 * Z + 11);
    ctx.textAlign = 'left';
    if (this.sameActs && !this.bg) {
      const a = actsLike(this.app.rom, this.sel);
      ctx.fillStyle = 'rgba(255,176,0,0.35)';
      for (let t = 0; t < 512; t++) if (actsLike(this.app.rom, this.base + t) === a) ctx.fillRect(M + (t & 15) * 16 * Z, (t >> 4) * 16 * Z, 16 * Z, 16 * Z);
    }
    if ((this.sel & ~0x1ff) === this.base) {
      const s = this.sel - this.base;
      ctx.strokeStyle = '#4cc2ff';
      ctx.lineWidth = 2;
      ctx.strokeRect(M + (s & 15) * 16 * Z + 1, (s >> 4) * 16 * Z + 1, this.selW * 16 * Z - 2, this.selH * 16 * Z - 2);
    }
  }

  private attachSheet(): void {
    const c = this.sheet;
    const M = 34;
    const cell = (e: MouseEvent) => {
      const rc = c.getBoundingClientRect();
      const sx = c.width / rc.width;
      return {
        x: Math.max(0, Math.min(15, Math.floor(((e.clientX - rc.left) * sx - M) / (16 * Z)))),
        y: Math.max(0, Math.min(31, Math.floor(((e.clientY - rc.top) * sx) / (16 * Z)))),
      };
    };
    c.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const a = cell(e);
      const pick = (b: { x: number; y: number }) => {
        this.sel = this.base + Math.min(a.y, b.y) * 16 + Math.min(a.x, b.x);
        this.selW = Math.abs(a.x - b.x) + 1;
        this.selH = Math.abs(a.y - b.y) + 1;
        this.drawSheet();
      };
      pick(a);
      const move = (ev: MouseEvent) => pick(cell(ev));
      const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); this.quad = 0; this.redraw(); };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
    c.addEventListener('mousemove', (e) => {
      const p = cell(e);
      const t = this.base + p.y * 16 + p.x;
      const info = this.bg ? undefined : this.app.blockInfo(actsLike(this.app.rom, t));
      c.title = `${this.tileName(t)}${this.bg ? '' : ` – ${info ? probeText(info) : 'Verhalten wird ermittelt …'}`}`;
    });
  }

  private scrollToSel(): void {
    const sc = this.sheet.parentElement!;
    const y = ((this.sel - this.base) >> 4) * 16 * Z;
    if (y < sc.scrollTop || y > sc.scrollTop + sc.clientHeight - 40) sc.scrollTop = y - sc.clientHeight / 2;
  }

  // ---------- builder ----------
  private buildBuilder(): void {
    const app = this.app;
    const b = this.builder;
    clear(b);
    const t = this.sel;
    const ws = this.words(t);
    const cache = this.tc();
    const cv = h('canvas', { width: 16 * BZ, height: 16 * BZ, class: 'mt-big' });
    const ctx = cv.getContext('2d')!;
    const img = ctx.createImageData(16, 16);
    const px = new Uint32Array(img.data.buffer);
    for (let q = 0; q < 4; q++) {
      const tile = cache.get(ws[q]);
      const ox = (q >> 1) * 8, oy = (q & 1) * 8;
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) px[(oy + y) * 16 + ox + x] = tile[y * 8 + x] || ((x + y) & 4 ? 0xff2a2a2a : 0xff222222);
    }
    const off = document.createElement('canvas');
    off.width = off.height = 16;
    off.getContext('2d')!.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(off, 0, 0, 16 * BZ, 16 * BZ);
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(8 * BZ + 0.5, 0); ctx.lineTo(8 * BZ + 0.5, 16 * BZ); ctx.moveTo(0, 8 * BZ + 0.5); ctx.lineTo(16 * BZ, 8 * BZ + 0.5); ctx.stroke();
    const anim = this.bg ? null : app.animated();
    for (let q = 0; q < 4; q++) {
      if (!anim?.tiles.has(ws[q] & 0x3ff)) continue;
      const x = (q >> 1) * 8 * BZ, y = (q & 1) * 8 * BZ;
      ctx.fillStyle = '#ff4fd8';
      ctx.beginPath(); ctx.moveTo(x + 8 * BZ, y); ctx.lineTo(x + 8 * BZ, y + 16); ctx.lineTo(x + 8 * BZ - 16, y); ctx.fill();
    }
    ctx.strokeStyle = '#ffb000';
    ctx.lineWidth = 3;
    ctx.strokeRect((this.quad >> 1) * 8 * BZ + 1.5, (this.quad & 1) * 8 * BZ + 1.5, 8 * BZ - 3, 8 * BZ - 3);
    cv.title = 'Klick: Viertel wählen · Doppelklick: 8x8-Tile im Grafik-Tab bearbeiten';
    cv.addEventListener('mousedown', (e) => {
      const rc = cv.getBoundingClientRect();
      const q = quarterAt(e.clientX - rc.left >= rc.width / 2 ? 1 : 0, e.clientY - rc.top >= rc.height / 2 ? 1 : 0);
      // the canvas is rebuilt on every click, so a double click is two clicks on the same quarter
      const now = performance.now();
      const dbl = q === this.lastClick.q && now - this.lastClick.t < 400;
      this.lastClick = { q, t: dbl ? 0 : now };
      this.quad = q;
      if (dbl) { this.editGfx(q); return; }
      this.buildBuilder();
      this.drawGfx();
    });
    cv.dataset.drop = '1';

    const v = ws[this.quad];
    const pal = (v >> 10) & 7;
    const toggle = (label: string, bit: number, title: string) => h('button', {
      class: v & bit ? 'active' : '', title,
      onclick: () => this.writeWord(this.quad, v ^ bit, label),
    }, label);
    const allPal = cgramToRGBA(app.render.cgram);
    const palDot = (p: number) => {
      const c = h('canvas', { width: 7, height: 1, class: 'mt-paldot' });
      const cx = c.getContext('2d')!;
      const im = cx.createImageData(7, 1);
      const pp = new Uint32Array(im.data.buffer);
      for (let k = 0; k < 7; k++) pp[k] = allPal[p * 16 + 1 + k * 2] | 0xff000000;
      cx.putImageData(im, 0, 0);
      return h('button', {
        class: `mt-pal${p === pal ? ' active' : ''}`, title: `Palette ${p} (Taste ${p + 1}) · Strg+Klick: im Paletten-Tab öffnen`,
        onclick: (e: MouseEvent) => {
          if (e.ctrlKey || e.metaKey) { this.ws.showPalette(p, 1); return; }
          this.writeWord(this.quad, (v & ~0x1c00) | (p << 10), `Palette ${p}`);
        },
      }, c, h('span', null, String(p)));
    };
    const quarterNames = ['oben links', 'unten links', 'oben rechts', 'unten rechts'];
    const num8 = v & 0x3ff;
    const slot = levelSlots(app).find((s) => num8 >= s.first && num8 < s.first + 0x80);
    const used = this.bg ? 0 : this.ws.preview.count(t);
    b.append(
      h('div', { class: 'prop-title' }, this.tileName(t), this.selW * this.selH > 1 ? h('span', { class: 'hint' }, `  (${this.selW}×${this.selH} gewählt)`) : ''),
      h('div', { class: 'hint' }, this.rangeText(t), !this.bg ? ` · im Level ${used}×` : ''),
      cv,
      h('div', { class: 'hint' }, `Viertel ${quarterNames[this.quad]}: 8x8-Tile ${hex(num8, 3)}${slot ? ` aus ${slot.name} (${gfxName(slot.file)})` : ''}`),
      !this.bg && ws.some((w) => app.animated()?.tiles.has(w & 0x3ff)) ? h('div', { class: 'warn-box' },
        `Animiert: das Spiel überschreibt ${ws.filter((w) => app.animated()?.tiles.has(w & 0x3ff)).length === 4 ? 'alle Viertel' : 'markierte Viertel'} laufend mit Animationsbildern (z. B. ?-Block, Münze, Wasser). Gezeichnete Änderungen an diesen 8x8-Tiles sieht man im Spiel nicht.`) : '',
      h('div', { class: 'mt-pals' }, Array.from({ length: 8 }, (_, p) => palDot(p))),
      h('div', { class: 'row' },
        toggle('↔ Spiegeln', FLIP_X, 'Horizontal spiegeln (X)'),
        toggle('↕ Spiegeln', FLIP_Y, 'Vertikal spiegeln (Y)'),
        toggle('Vordergrund', PRIO, 'Priorität: vor Sprites/Mario gezeichnet')),
      this.bg ? '' : this.actsUi(t),
      h('details', { class: 'mt-adv' }, h('summary', null, 'Rohwerte'),
        h('div', { class: 'mono hint' }, ws.map((w, q) => `${['TL', 'BL', 'TR', 'BR'][q]} $${hex(w, 4)}`).join('  ')),
        h('div', { class: 'hint' }, this.tileAddr(t) < 0 ? 'Erweitertes Tile – wird beim ersten Ändern angelegt.' : `ROM $${hex(this.tileAddr(t), 6)}`)),
      h('p', { class: 'hint' }, 'Viertel anklicken, dann rechts ein 8x8-Tile wählen. 2×2 Tiles ziehen füllt alle vier Viertel; ein Tile auf ein Viertel ziehen setzt genau dieses. Tasten: X/Y spiegeln, 1–8 Palette, Q nächstes Viertel, Pfeile anderes Tile.'),
    );
  }

  private lastClick = { q: -1, t: 0 };

  // opens the quarter's 8x8 tile in the graphics tab, in the quarter's palette
  private editGfx(q: number): void {
    const w = this.words(this.sel)[q];
    const num = w & 0x3ff;
    const slot = levelSlots(this.app).find((s) => num >= s.first && num < s.first + 0x80);
    if (!slot) { toast(`8x8-Tile ${hex(num, 3)} liegt in keinem Grafik-Slot dieses Levels`); return; }
    this.ws.showGfx(slot.file, num - slot.first, (w >> 10) & 7);
  }

  private rangeText(t: number): string {
    if (this.bg) return 'Hintergrund-Tile';
    if (t >= EXT_FIRST) return 'erweitertes Tile (im Level per Direct-Map16-Objekt)';
    if (t >= 0x073 && t <= 0x0ff) return `Tileset-Tile (gilt nur für Tileset ${hex(this.app.level.header.tileset, 1)})`;
    return 'Standard-Tile (alle Tilesets)';
  }

  private actsUi(t: number): HTMLElement {
    const app = this.app;
    const a = actsLike(app.rom, t);
    const info = app.blockInfo(a);
    const thumb = h('canvas', { width: 16, height: 16, class: 'mt-acts-thumb' });
    thumb.getContext('2d')!.drawImage(renderMap16Sheet(app, false, a & ~0x1ff), (a & 15) * 16, ((a >> 4) & 31) * 16, 16, 16, 0, 0, 16, 16);
    const file = blockFileOf(app.rom, t);
    return h('div', { class: 'mt-acts' },
      h('div', { class: 'panel-title' }, 'Verhalten'),
      h('div', { class: 'row' }, thumb,
        h('div', { class: 'grow' }, a === t ? 'wie es selbst' : `wie Tile ${hex(a, 3)}`, h('div', { class: 'hint' }, info ? probeText(info) : 'wird ermittelt …')),
        h('button', { onclick: () => this.pickActs(), title: 'Verhalten von einem anderen Tile übernehmen' }, 'Ändern …')),
      h('div', { class: 'row' }, h('span', { class: 'hint grow' }, file ? `Custom Block: ${file}` : 'Kein Custom Block'),
        h('button', { onclick: () => void openBlockDialog(app, t, () => this.redraw()) }, 'Custom Blocks …')),
    );
  }

  // picks the acts-like value from a sheet of the vanilla tiles
  private pickActs(): void {
    const app = this.app;
    const tiles = this.selection();
    const c = h('canvas', { width: 256 * 2, height: 512 * 2, class: 'mt-acts-pick' });
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(renderMap16Sheet(app, false, 0), 0, 0, 512, 1024);
    const cur = actsLike(app.rom, this.sel);
    ctx.strokeStyle = '#ffb000'; ctx.lineWidth = 2;
    ctx.strokeRect((cur & 15) * 32 + 1, (cur >> 4) * 32 + 1, 30, 30);
    const info = h('div', { class: 'hint', style: 'min-height:2.6em' }, 'Tile anklicken: das gewählte Tile verhält sich dann wie dieses.');
    const at = (e: MouseEvent) => {
      const rc = c.getBoundingClientRect();
      return Math.floor((e.clientY - rc.top) / (rc.height / 32)) * 16 + Math.floor((e.clientX - rc.left) / (rc.width / 16));
    };
    c.addEventListener('mousemove', (e) => {
      const t = at(e);
      const p = app.blockInfo(t);
      info.textContent = `Tile ${hex(t, 3)}: ${p ? probeText(p) : 'wird ermittelt …'}`;
    });
    const dlg = modal(`Verhalten für ${tiles.length > 1 ? `${tiles.length} Tiles` : this.tileName(this.sel)}`,
      h('div', { class: 'mt-acts-dlg' }, info, h('div', { class: 'mt-acts-scroll' }, c)), [{ label: 'Abbrechen' }]);
    c.addEventListener('mousedown', (e) => {
      const v = at(e);
      this.edit(`Verhalten wie ${hex(v, 3)}`, () => { for (const t of tiles) setActsLike(app.rom, t, v, this.blank()); });
      dlg.close();
    });
  }

  // ---------- 8x8 graphics ----------
  private drawGfx(): void {
    const app = this.app;
    const box = this.gfxBox;
    const pal = (this.words(this.sel)[this.quad] >> 10) & 7;
    const slots = levelSlots(app);
    const rows = slots.length * 8;
    const W = 128, Hh = rows * 8;
    const c = this.gfxCanvas;
    c.width = W * GZ; c.height = Hh * GZ;
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
    ctx.drawImage(off, 0, 0, W * GZ, Hh * GZ);
    // current quarter's tile
    const cur = this.words(this.sel)[this.quad] & 0x3ff;
    const si = slots.findIndex((s) => cur >= s.first && cur < s.first + 0x80);
    if (si >= 0) {
      const k = cur - slots[si].first;
      ctx.strokeStyle = '#ffb000'; ctx.lineWidth = 2;
      ctx.strokeRect((k & 15) * 8 * GZ + 1, (si * 64 + (k >> 4) * 8) * GZ + 1, 8 * GZ - 2, 8 * GZ - 2);
    }
    // tiles the game animates: hatched corner
    const anim = app.animated();
    if (anim?.tiles.size) {
      ctx.fillStyle = '#ff4fd8';
      slots.forEach((s, si) => {
        for (let k = 0; k < 128; k++) {
          if (!anim.tiles.has(s.first + k)) continue;
          const x = (k & 15) * 8 * GZ, y = (si * 64 + (k >> 4) * 8) * GZ;
          ctx.beginPath(); ctx.moveTo(x + 8 * GZ, y); ctx.lineTo(x + 8 * GZ, y + 6); ctx.lineTo(x + 8 * GZ - 6, y); ctx.fill();
        }
      });
    }
    if (this.drag) {
      const d = this.drag;
      ctx.strokeStyle = '#4cc2ff'; ctx.lineWidth = 2;
      ctx.strokeRect(Math.min(d.a.x, d.b.x) * 8 * GZ + 1, Math.min(d.a.y, d.b.y) * 8 * GZ + 1, (Math.abs(d.a.x - d.b.x) + 1) * 8 * GZ - 2, (Math.abs(d.a.y - d.b.y) + 1) * 8 * GZ - 2);
    }
    clear(box);
    const labels = h('div', { class: 'mt-gfx-labels' }, slots.map((s) => h('div', { class: 'mt-slot', style: { height: `${64 * GZ}px` } },
      h('span', { class: 'mt-slot-name' }, s.name),
      h('a', { href: '#', class: 'mt-slot-file', title: 'Im Grafik-Tab öffnen (zum Bearbeiten/Zeichnen)', onclick: (e: Event) => { e.preventDefault(); this.ws.showGfx(s.file); } }, gfxName(s.file)),
      s.custom ? h('span', { class: 'hint' }, 'eigene') : '',
      h('span', { class: 'hint mono' }, `${hex(s.first, 3)}–${hex(s.first + 0x7f, 3)}`))));
    box.append(
      h('div', { class: 'panel-title' }, `8x8-Grafik in Palette ${pal}`, h('span', { class: 'hint' }, 'folgt dem gewählten Viertel')),
      h('div', { class: 'mt-gfx-scroll' }, h('div', { class: 'mt-gfx-wrap' }, labels, c)),
    );
  }

  private drag: { a: { x: number; y: number }; b: { x: number; y: number } } | null = null;
  private attachGfx(): void {
    const c = this.gfxCanvas;
    const cell = (e: MouseEvent) => {
      const rc = c.getBoundingClientRect();
      return {
        x: Math.max(0, Math.min(15, Math.floor((e.clientX - rc.left) / (rc.width / 16)))),
        y: Math.max(0, Math.min(c.height / (8 * GZ) - 1, Math.floor((e.clientY - rc.top) / (rc.height / (c.height / (8 * GZ)))))),
      };
    };
    // 8x8 tile number at a cell of the grouped view
    const tileOf = (p: { x: number; y: number }) => {
      const s = levelSlots(this.app)[p.y >> 3];
      return s ? s.first + (p.y & 7) * 16 + p.x : -1;
    };
    c.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
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
        const target = ev.target as HTMLElement;
        const x0 = Math.min(d.a.x, d.b.x), y0 = Math.min(d.a.y, d.b.y), w = Math.abs(d.a.x - d.b.x) + 1, hh = Math.abs(d.a.y - d.b.y) + 1;
        const ws = this.words(this.sel);
        const keep = (q: number, num: number) => (ws[q] & 0xfc00) | num;
        if (target.dataset?.drop) {
          // dropped onto the builder: the quarter under the mouse
          const rc = target.getBoundingClientRect();
          const q = quarterAt(ev.clientX - rc.left >= rc.width / 2 ? 1 : 0, ev.clientY - rc.top >= rc.height / 2 ? 1 : 0);
          const n = tileOf(d.a);
          if (n >= 0) { this.quad = q; this.writeWord(q, keep(q, n), `8x8-Tile ${hex(n, 3)}`); }
        } else if (w === 2 && hh === 2) {
          const nums = [tileOf({ x: x0, y: y0 }), tileOf({ x: x0, y: y0 + 1 }), tileOf({ x: x0 + 1, y: y0 }), tileOf({ x: x0 + 1, y: y0 + 1 })];
          if (nums.every((n) => n >= 0) && (y0 >> 3) === ((y0 + 1) >> 3)) {
            const t = this.sel;
            const pal = ws[this.quad] & 0x1c00;
            const nw = nums.map((n, q) => (ws[q] & 0xe000) | pal | n);
            this.edit(`${this.tileName(t)}: 2×2 Grafik`, () => this.setWords(t, nw));
          }
        } else if (w === 1 && hh === 1) {
          const n = tileOf(d.a);
          const q = this.quad;
          if (n >= 0) this.writeWord(q, keep(q, n), `8x8-Tile ${hex(n, 3)}`);
        } else toast('Ein einzelnes 8x8-Tile oder einen 2×2-Block ziehen');
        this.redraw();
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
    c.addEventListener('mousemove', (e) => {
      if (this.drag) return;
      const n = tileOf(cell(e));
      c.title = n >= 0 ? `8x8-Tile ${hex(n, 3)}${this.app.animated()?.tiles.has(n) ? ' – animiert (das Spiel überschreibt es laufend)' : ''}` : '';
    });
  }

  // ---------- copy / paste / files ----------
  private copy(): void {
    const tiles = this.selection();
    this.clip = { w: this.selW, h: this.selH, words: tiles.map((t) => this.words(t)), acts: this.bg ? null : tiles.map((t) => actsLike(this.app.rom, t)) };
    toast(`${tiles.length} Tile${tiles.length > 1 ? 's' : ''} kopiert`);
  }
  private paste(): void {
    const c = this.clip;
    if (!c) { toast('Erst Tiles kopieren (Strg+C)'); return; }
    const max = this.bg ? 0x200 : EXT_TILES;
    const targets: number[] = [];
    for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) targets.push(this.sel + y * 16 + x);
    if (targets.some((t) => t >= max) || (this.sel & 15) + c.w > 16) { toast('Die Tiles passen ab hier nicht auf die Seite', 'error'); return; }
    this.edit(`${targets.length} Tile${targets.length > 1 ? 's' : ''} eingefügt ab ${hex(this.sel, 3)}`, () => {
      targets.forEach((t, i) => {
        this.setWords(t, c.words[i]);
        if (c.acts && !this.bg) setActsLike(this.app.rom, t, c.acts[i], this.blank());
      });
    });
    this.selW = c.w; this.selH = c.h;
    this.redraw();
  }

  private async importMap16(): Promise<void> {
    const f = await pickFile('.map16');
    if (!f) return;
    try {
      const m = parseMap16File(new Uint8Array(await f.arrayBuffer()));
      const targets = map16Targets(m, this.sel);
      if (targets.some((t) => t >= EXT_TILES)) throw new Error('Die Tiles passen ab hier nicht mehr auf die Map16-Seiten');
      this.bg = false;
      this.edit(`${f.name} importiert`, () => targets.forEach((t, i) => {
        this.setWords(t, m.tiles[i]);
        if (m.acts) setActsLike(this.app.rom, t, m.acts[i], this.blank());
      }));
      this.selW = Math.min(16, m.width); this.selH = m.height;
      toast(`${m.tiles.length} Tile(s) aus ${f.name} ab ${hex(this.sel, 3)} importiert`);
    } catch (e) { toast(String(e instanceof Error ? e.message : e), 'error'); }
    this.buildBar();
    this.redraw();
  }

  private exportMap16(): void {
    const tiles = this.selection();
    const data = writeMap16File({ width: this.selW, height: this.selH, tiles: tiles.map((t) => this.words(t)), acts: this.bg ? null : tiles.map((t) => actsLike(this.app.rom, t)) });
    downloadBytes(`${this.bg ? 'bg' : 'fg'}_${hex(this.sel, 3)}.map16`, data);
  }

  key(e: KeyboardEvent): boolean {
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key;
    if (ctrl && k.toLowerCase() === 'c') { this.copy(); return true; }
    if (ctrl && k.toLowerCase() === 'v') { this.paste(); return true; }
    if (ctrl || e.altKey) return false;
    const v = this.words(this.sel)[this.quad];
    if (k === 'x' || k === 'X') { this.writeWord(this.quad, v ^ FLIP_X, '↔ Spiegeln'); return true; }
    if (k === 'y' || k === 'Y') { this.writeWord(this.quad, v ^ FLIP_Y, '↕ Spiegeln'); return true; }
    if (k >= '1' && k <= '8') { const p = Number(k) - 1; this.writeWord(this.quad, (v & ~0x1c00) | (p << 10), `Palette ${p}`); return true; }
    if (k === 'q' || k === 'Q') { this.quad = [2, 3, 1, 0][this.quad]; this.buildBuilder(); this.drawGfx(); return true; }
    if (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'ArrowUp' || k === 'ArrowDown') {
      const d = k === 'ArrowLeft' ? -1 : k === 'ArrowRight' ? 1 : k === 'ArrowUp' ? -16 : 16;
      const max = this.bg ? 0x200 : EXT_TILES;
      const n = this.sel + d;
      if (n < 0 || n >= max) return true;
      this.sel = n;
      this.base = n & ~0x1ff;
      this.selW = this.selH = 1;
      this.buildBar();
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
