// The overworld's border in the Game workspace (#330): the screen's layer 3 of a map (the main map or a submap), 32x28
// 8x8 tiles fixed on the screen, in front of the screen as the game shows it after the load (the map, the sprites,
// Mario; dimmed by default). Painted with layer 3's 8x8 tiles (l3picker.ts) as the title screen is: each stroke one ROM
// edit into the map's LT3 file (core/owlayer3.ts), a new one where it has none. The cells the game writes the lives
// and the level name over are hatched and not painted. The bar says where the border is saved and who shares the file;
// a map can get a file of its own, take another map's border or go back to the game's.

import type { App, Brush } from './app.ts';
import { h, toast } from './dom.ts';
import { TileCache, blit8 } from '../core/render.ts';
import { hex } from '../core/names.ts';
import { MAP_NAMES, type OwRender } from '../core/overworld.ts';
import { layer3Word, layer3WordText, layer3CharBase, blankTile, lt3Covers } from '../core/layer3map.ts';
import { levelLayer3 } from '../core/layer3gfx.ts';
import { submapGfxEntry } from '../core/patches.ts';
import {
  owLayer3Grid, submapLt3Target, submapLayer3, saveSubmapLayer3, lt3UserText, owL3GameWrites, borderStamp, submapBorderFile,
  ownBorderFile, takeBorder, resetBorder, OW_L3_COLS, OW_L3_ROWS,
} from '../core/owlayer3.ts';
import { layer3Picker } from './l3picker.ts';
import { fillPixels, hidePickerPreview } from './pickerview.ts';

const W = OW_L3_COLS * 8, H = OW_L3_ROWS * 8;
const GAME_CELL = 'The game writes the lives and the level name here when the overworld loads: not painted';
const OUTSIDE_FILE = 'Not in the part of the screen the map\'s layer 3 tilemap file holds: not painted';

export class BorderView {
  canvas = h('canvas', { class: 'game-canvas', width: W, height: H });
  side = h('div', { class: 'panel game-pick' });
  bar: HTMLElement;
  map = 0;
  special = false;
  private app: App;
  private dim = true;
  private r: OwRender | null = null; // the map's load (VRAM, colors, the grid)
  private rKey = '';
  private frame: Uint32Array | null = null; // the screen behind the border
  private stroke = new Map<number, number>(); // tilemap entry → word: painted, not yet shown by a load
  private brush: Brush = { w: 1, h: 1, tiles: [0] };
  private brushSet = false; // chosen by the user (else the blank tile, once a load comes)
  private hover: { x: number; y: number } | null = null;
  private drag: { kind: 'paint' | 'pick'; x0: number; y0: number; x1: number; y1: number } | null = null;
  private pickPixels = 0;
  private fileLine = h('span', { class: 'hint' });
  private actions = h('span');
  private specialBox = h('input', { type: 'checkbox' });
  private dimBox = h('input', { type: 'checkbox', checked: true });
  setStatus: (s: string) => void = () => {};

  constructor(app: App) {
    this.app = app;
    this.specialBox.addEventListener('change', () => { this.special = this.specialBox.checked; this.reload(); });
    this.dimBox.addEventListener('change', () => { this.dim = this.dimBox.checked; this.paint(); });
    this.bar = h('span', { class: 'game-border-bar' },
      h('label', { class: 'toggle', title: 'The map as the game shows it once the special world is passed: its second set of colors, the border\'s too' }, this.specialBox, 'After the special world'),
      h('label', { class: 'toggle', title: 'The screen behind the border dimmed, so that the border stands out' }, this.dimBox, 'Dim the map'),
      h('span', { class: 'sep' }), this.fileLine, this.actions);
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    this.canvas.addEventListener('mousedown', (e) => this.onDown(e));
    this.canvas.addEventListener('mousemove', (e) => this.onMove(e));
    this.canvas.addEventListener('mouseleave', () => { this.hover = null; this.canvas.title = ''; this.paint(); this.setStatus(''); });
    window.addEventListener('mouseup', () => this.onUp());
    new ResizeObserver(() => requestAnimationFrame(() => { if (this.pickPixels && fillPixels(this.side.clientWidth, 128) !== this.pickPixels) this.buildPicker(); })).observe(this.side);
  }

  private get connected(): boolean { return this.canvas.isConnected; }

  setZoom(z: number): void {
    this.canvas.style.width = `${W * z}px`;
    this.canvas.style.height = `${H * z}px`;
  }

  // shows map `map`'s border (special: after the special world)
  show(map: number, special = this.special): void {
    if (map !== this.map) { this.stroke.clear(); this.drag = null; }
    this.map = map;
    this.special = special;
    this.specialBox.checked = special;
    this.reload();
  }

  // the load and the screen asked for again (a ROM edit, another map); shown when they come
  reload(): void {
    const map = this.map, special = this.special, key = `${map}:${special}`;
    if (key !== this.rKey) { this.r = null; this.frame = null; this.rKey = key; }
    const loaded = (r: OwRender) => {
      if (this.rKey !== key || !this.connected) return;
      // (the strokes are shown by the load after their ROM edit; one being painted stays)
      if (!this.drag) this.stroke.clear();
      this.r = r;
      if (!this.brushSet) this.brush = { w: 1, h: 1, tiles: [blankTile(r.vram, layer3CharBase(r.ppuRegs))] };
      this.buildPicker();
      this.paint();
    };
    const r = this.app.overworldMap(map, 0, loaded, undefined, special);
    if (r) loaded(r);
    const f = this.app.overworldScreen(map, special, (x) => { if (this.rKey === key && this.connected) { this.frame = x; this.paint(); } });
    if (f) this.frame = f;
    this.buildBar();
    this.paint();
    if (!r) this.buildPicker();
  }

  private paint(): void {
    const ctx = this.canvas.getContext('2d')!, img = ctx.createImageData(W, H), px = new Uint32Array(img.data.buffer);
    px.fill(0xff22201b);
    if (this.frame) {
      if (!this.dim) px.set(this.frame);
      // (dimmed: a third of each color)
      else for (let i = 0; i < px.length; i++) { const c = this.frame[i]; px[i] = 0xff000000 | (((c >> 16) & 0xff) / 3) << 16 | (((c >> 8) & 0xff) / 3) << 8 | ((c & 0xff) / 3); }
    }
    const r = this.r;
    if (r) {
      const g = owLayer3Grid(r), tc = new TileCache(r.vram, r.cgram, layer3CharBase(r.ppuRegs));
      for (let y = 0; y < OW_L3_ROWS; y++) for (let x = 0; x < OW_L3_COLS; x++) {
        const i = g.entry(x, y);
        if (i < 0) continue;
        blit8(px, W, H, tc.get(this.stroke.get(i) ?? layer3Word(r.vram, i), 2), x * 8, y * 8);
      }
    }
    ctx.putImageData(img, 0, 0);
    // the game's cells hatched
    ctx.strokeStyle = 'rgba(255,90,90,0.8)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let y = 0; y < OW_L3_ROWS; y++) for (let x = 0; x < OW_L3_COLS; x++) {
      if (!owL3GameWrites(x, y)) continue;
      for (const d of [0, 4]) { ctx.moveTo(x * 8 + d, y * 8 + 8); ctx.lineTo(x * 8 + 8, y * 8 + d); }
      ctx.moveTo(x * 8, y * 8 + 4); ctx.lineTo(x * 8 + 4, y * 8);
    }
    ctx.stroke();
    if (!r) {
      ctx.fillStyle = '#fff';
      ctx.font = '10px sans-serif';
      ctx.fillText(`Loading ${MAP_NAMES[this.map]}…`, 12, 20);
    }
    const c = this.drag?.kind === 'pick' ? this.rect(this.drag) : this.hover ? { x: this.hover.x, y: this.hover.y, w: this.brush.w, h: this.brush.h } : null;
    if (c) {
      ctx.strokeStyle = this.drag?.kind === 'pick' ? '#4cc2ff' : 'rgba(255,255,0,0.9)';
      ctx.strokeRect(c.x * 8 + 0.5, c.y * 8 + 0.5, c.w * 8 - 1, c.h * 8 - 1);
    }
  }

  private cellAt(e: MouseEvent): { x: number; y: number } | null {
    const rc = this.canvas.getBoundingClientRect();
    const x = Math.floor((e.clientX - rc.left) / rc.width * OW_L3_COLS), y = Math.floor((e.clientY - rc.top) / rc.height * OW_L3_ROWS);
    return x >= 0 && y >= 0 && x < OW_L3_COLS && y < OW_L3_ROWS ? { x, y } : null;
  }
  private rect(d: { x0: number; y0: number; x1: number; y1: number }) {
    return { x: Math.min(d.x0, d.x1), y: Math.min(d.y0, d.y1), w: Math.abs(d.x1 - d.x0) + 1, h: Math.abs(d.y1 - d.y0) + 1 };
  }
  // the word shown at cell (x, y): painted, else the load's (-1: none)
  private word(x: number, y: number): number {
    const r = this.r, i = r ? owLayer3Grid(r).entry(x, y) : -1;
    return r && i >= 0 ? this.stroke.get(i) ?? layer3Word(r.vram, i) : -1;
  }

  // the brush put at cell (cx, cy): the cells the file holds and the game doesn't write over (borderStamp)
  private stamp(cx: number, cy: number): boolean {
    const r = this.r;
    if (!r) return false;
    const cells = borderStamp(owLayer3Grid(r), submapLt3Target(this.app.rom, this.map).place, this.brush, cx, cy, (i) => this.stroke.get(i) ?? layer3Word(r.vram, i));
    for (const [i, w] of cells) this.stroke.set(i, w);
    return cells.size > 0;
  }
  // why cell (x, y) is not painted ('' where it is)
  private refusal(x: number, y: number): string {
    if (owL3GameWrites(x, y)) return GAME_CELL;
    const r = this.r, i = r ? owLayer3Grid(r).entry(x, y) : -1;
    return r && (i < 0 || !lt3Covers(submapLt3Target(this.app.rom, this.map).place, i)) ? OUTSIDE_FILE : '';
  }

  // left: paint the brush (a stroke), right drag: take the border's tiles as the brush (as on the title screen)
  private onDown(e: MouseEvent): void {
    const c = this.cellAt(e);
    if (!c || !this.r) return;
    e.preventDefault();
    if (e.button === 2) { this.drag = { kind: 'pick', x0: c.x, y0: c.y, x1: c.x, y1: c.y }; this.paint(); return; }
    if (e.button !== 0) return;
    const no = this.refusal(c.x, c.y);
    if (no) { toast(no); return; }
    this.drag = { kind: 'paint', x0: c.x, y0: c.y, x1: c.x, y1: c.y };
    if (this.stamp(c.x, c.y)) this.paint();
  }
  private onMove(e: MouseEvent): void {
    const c = this.cellAt(e);
    this.hover = c;
    if (c && this.drag && (c.x !== this.drag.x1 || c.y !== this.drag.y1)) {
      this.drag.x1 = c.x; this.drag.y1 = c.y;
      if (this.drag.kind === 'paint') this.stamp(c.x, c.y);
    }
    this.canvas.title = c ? this.refusal(c.x, c.y) : '';
    this.paint();
    this.updateStatus();
  }
  private onUp(): void {
    const d = this.drag, r = this.r;
    if (!d || !r) return;
    this.drag = null;
    if (d.kind === 'pick') {
      const q = this.rect(d);
      this.brush = { w: q.w, h: q.h, tiles: Array.from({ length: q.w * q.h }, (_, k) => Math.max(0, this.word(q.x + (k % q.w), q.y + Math.floor(k / q.w)))) };
      this.brushSet = true;
      this.buildPicker();
      this.paint();
      return;
    }
    if (!this.stroke.size) return;
    const rom = this.app.rom, map = this.map, tilemap = submapLayer3(rom, map, r.vram);
    for (const [i, v] of this.stroke) tilemap[i] = v;
    this.edit(`Paint the border of ${MAP_NAMES[map]}`, () => saveSubmapLayer3(rom, map, tilemap));
  }

  // one ROM edit; refused: shown as in the ROM
  private edit(label: string, f: () => unknown): void {
    try {
      this.app.romEdit(label, () => { f(); });
    } catch (e) {
      toast(String(e instanceof Error ? e.message : e), 'error');
      this.stroke.clear();
      this.paint();
    }
  }

  private updateStatus(): void {
    const c = this.hover;
    if (!c) { this.setStatus(''); return; }
    const w = this.word(c.x, c.y), no = this.refusal(c.x, c.y);
    this.setStatus(`Column ${c.x}, row ${c.y}${w >= 0 ? `: tile ${layer3WordText(w)}` : ''} – ${no || 'click: paint, right drag: take tiles as the brush'}`);
  }

  // where the border is saved, and what can be done with its file
  buildBar(): void {
    const rom = this.app.rom, map = this.map, f = submapBorderFile(rom, map), assigned = levelLayer3(rom, submapGfxEntry(map)).lt3;
    this.fileLine.textContent = f.file !== null ? `Saved in ExGFX ${hex(f.file, 3)}${f.others.length ? ` · also used by ${lt3UserText(f.others)}` : ''}`
      : assigned !== 0xff ? `Its layer 3 tilemap file ExGFX ${hex(assigned, 3)} can't be painted (not an uncompressed file of its size) – the first stroke makes a file of its own`
        : 'Still the game\'s border – the first stroke makes a file of its own';
    this.fileLine.classList.toggle('warn-text', f.others.length > 0);
    const name = MAP_NAMES[map];
    const take = h('select', { title: `${name} shows the border of another map: saved as a stroke over the whole border` },
      h('option', { value: '' }, 'Take border from …'),
      ...MAP_NAMES.flatMap((n, m) => (m === map ? [] : [h('option', { value: String(m) }, n)])));
    take.addEventListener('change', () => {
      const v = take.value;
      take.value = '';
      if (!v) return;
      const from = Number(v);
      const go = (fr: OwRender) => this.edit(`${name} takes the border of ${MAP_NAMES[from]}`, () => takeBorder(this.app.rom, map, from, fr.vram));
      // (in a lane of its own: the map shown keeps its load)
      const fr = this.app.overworldMap(from, 0, (x) => { if (this.map === map && this.connected) go(x); },
        { lane: 'owbt', failed: () => toast(`${MAP_NAMES[from]} could not be loaded: its border was not taken.`, 'error') });
      if (fr) go(fr);
      else toast(`Loading ${MAP_NAMES[from]}… its border is taken once it is loaded.`);
    });
    this.actions.replaceChildren(
      ...(f.others.length ? [h('button', { title: `${name} gets a copy of the file under a free number; ${lt3UserText(f.others)} keep the file`, onclick: () => this.edit(`Own border file for ${name}`, () => ownBorderFile(this.app.rom, map)) }, 'Own copy for this map')] : []),
      take,
      ...(assigned !== 0xff ? [h('button', { title: `${name} uses no layer 3 tilemap file any more and shows the game's border (the file stays in the ROM${f.others.length ? `, ${lt3UserText(f.others)} keep it` : ''})`, onclick: () => this.edit(`Game's border for ${name}`, () => resetBorder(this.app.rom, map)) }, 'Reset to the game\'s border')] : []));
  }

  // layer 3's 8x8 tiles as the brush (l3picker.ts)
  private buildPicker(): void {
    hidePickerPreview(this.side);
    this.side.replaceChildren(h('div', { class: 'panel-title' }, 'Layer 3 tiles'));
    this.pickPixels = 0;
    const r = this.r;
    if (!r) { this.side.append(h('div', { class: 'hint' }, 'Loading the overworld…')); return; }
    const w = this.side.clientWidth;
    layer3Picker(this.side, { vram: r.vram, cgram: r.cgram, charBase: layer3CharBase(r.ppuRegs) }, this.brush, (nb) => { this.brush = nb; this.buildPicker(); }, {
      pixels: this.pickPixels = fillPixels(w, 128), shown: w / 128, from: 'the border',
      hint: 'click or drag on the border to paint, right drag there takes its tiles. Each stroke is saved into the map\'s layer 3 tilemap file (see the bar). Hatched: the lives and the level name, which the game writes there.',
    });
  }
}
