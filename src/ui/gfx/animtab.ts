// Animations tab: ExAnimation in Lunar Magic's format (core/exanim.ts). A list for the level and a global
// one; each slot animates 8x8 tiles in VRAM (frames from an animation file, Anim-ExGFX60-63, or from
// RAM) or a color, with a trigger. Every frame of a slot shows for 8 game frames; longer frames are
// repeated frames. The level preview plays the real result (the engine runs in the emulator).

import type { App } from '../app.ts';
import type { GfxWorkspace, WsPanel } from '../gfxworkspace.ts';
import { h, clear, toast, pickerOpen, modal } from '../dom.ts';
import { menuButton, type MenuItem } from '../menu.ts';
import { hex } from '../../core/names.ts';
import { cgramToRGBA, decodeTile, snesColorToRGBA } from '../../core/gfx.ts';
import { map16Source, levelColorUsers } from '../../core/render.ts';
import { EXT_TILES } from '../../core/map16ext.ts';
import {
  type ExList, type ExSlot, emptyList, readLevelList, readGlobalList, writeLevelList, writeGlobalList, levelSettings, setLevelSettings,
  readAltFile, writeAltFile, kindOf, tilesOf, secondSet, secondSetName, triggerName, TYPE_NAMES, SLOTS,
  NO_GAME_COLORS, NO_GAME_TILES, NO_LEVEL_LIST, NO_GLOBAL_LIST, altFileUsers, localizeFrames, shapeOf, exanimTiles, exanimColors, ALT_FILE_MAX,
  rotationRange, setRotationRange, rotationStep, rotated, stepsPerSecond, heldColors, reversesOnTrigger, ROTATION_MAX,
} from '../../core/exanim.ts';
import { levelSlots, gfxName, lmAnimName, ANIM_FILE } from './map16tab.ts';
import { cssOf, htmlOf } from './palettetab.ts';
import { remapSlot } from '../../core/remap.ts';
import { remapEditor } from '../remaplist.ts';
import type { LevelRender } from '../../core/levelemu.ts';

const TILE_TYPES = [0x01, 0x02, 0x04, 0x08, 0x10, 0x11, 0x12, 0x03, 0x05, 0x06, 0x07, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e];
const COLOR_TYPES = [0x14, 0x13, 0x15, 0x16, 0x17];
const ROTATION_TYPES = [0x18, 0x1a, 0x19, 0x1b];
const TRIGGERS = [0x00, 0x03, 0x01, 0x02, 0x04, 0x05, 0x07, 0x06, 0x08];
const ROTATION_TRIGGERS = [0x00, 0x03, 0x01, 0x02, 0x04, 0x05, 0x07]; // the one-time ones are for frames
const ALT = 0x8000;

// own tile animations of the current level (its list and the global one) that overwrite a VRAM tile
export function animsAt(app: App, tile: number): { global: boolean; slot: number }[] {
  return exanimTiles(app.rom, app.level.number, (app.render.ppuRegs[0x0b] & 0x0f) << 12).get(tile) ?? [];
}
// own color animations (and rotations) of the current level that rewrite a color
export function colorAnimsAt(app: App, color: number): { global: boolean; slot: number }[] {
  return exanimColors(app.rom, app.level.number).get(color) ?? [];
}
// links to own animations, for the warnings of the other tabs
export function animLinks(ws: GfxWorkspace, own: { global: boolean; slot: number }[]): HTMLElement[] {
  return own.map((a, i) => h('span', null, i ? ', ' : '', h('a', { href: '#', title: 'Open in the Animations tab (Ctrl+click on the tile or color does the same)', onclick: (e: Event) => { e.preventDefault(); ws.showAnim(a.global, a.slot); } }, `Animation ${hex(a.slot, 2)} (${a.global ? 'global' : 'level'})`)));
}

const fmt = (v: number) => String(+v.toFixed(3));
const speedName = (delay: number) => `${fmt(stepsPerSecond(delay))} steps per second`;
// a rotation's colors as row·column, first–last
const rangeName = (s: ExSlot) => {
  const { first, count } = rotationRange(s), last = Math.min(255, first + count - 1);
  return `${hex(first >> 4, 1)}·${hex(first & 15, 1)}–${hex(last >> 4, 1)}·${hex(last & 15, 1)} (${count})`;
};

export class AnimTab implements WsPanel {
  root: HTMLElement;
  private app: App;
  private ws: GfxWorkspace;
  private global = false;
  private sel = 0; // slot
  private frame = 0; // selected column
  private set = 0; // selected frame set (1: the trigger's second set)
  private palRow = -1; // palette for tile previews (-1: from the target's Map16 use)
  private visible = false;
  private tick = 0;
  private timer = 0;
  private picking: 'target' | null = null;
  private triggerOn = false; // a rotation's preview as while its trigger holds
  // the colors of the selected rotation the game keeps setting itself, from the emulated level (null: not known yet)
  private held: { key: string; render: LevelRender | null; colors: number[] | null; timer: number } = { key: '', render: null, colors: null, timer: 0 };
  private bar = h('div', { class: 'ws-bar' });
  private slotsBox = h('div', { class: 'at-slots' });
  private detail = h('div', { class: 'at-detail' });
  private side = h('div', { class: 'at-side' });
  private previews: { c: HTMLCanvasElement; slot: number }[] = [];
  // what the ROM holds, read once per build (drawing reads it many times)
  private view: ExList = emptyList();
  private altBytes: Uint8Array | null = null;

  constructor(app: App, ws: GfxWorkspace) {
    this.app = app;
    this.ws = ws;
    this.root = h('div', { class: 'at' }, this.bar, h('div', { class: 'at-main' }, this.slotsBox, this.detail, this.side));
    const rebuild = () => { if (this.visible) this.build(); };
    app.on('rom-change', rebuild);
    app.on('level', rebuild);
    app.on('render', () => { if (this.visible) this.buildSide(); });
  }

  previewHint(): string {
    return 'Click: take the Map16 tile under the mouse as target (top left quarter)';
  }

  get selected(): { global: boolean; slot: number } { return { global: this.global, slot: this.sel }; }

  // opens a slot of the level's or the global list
  select(global: boolean, slot: number): void {
    this.global = global;
    this.sel = slot;
    this.frame = 0;
    this.set = 0;
    this.picking = null;
    this.triggerOn = false;
    if (this.visible) this.build();
  }

  show(): void {
    this.visible = true;
    this.build();
    clearInterval(this.timer);
    this.timer = window.setInterval(() => { this.tick++; this.animate(); }, 1000 / 7.5);
  }
  hide(): void {
    this.visible = false;
    clearInterval(this.timer);
  }

  // ---------- data ----------
  private list(): ExList {
    const rom = this.app.rom;
    return (this.global ? readGlobalList(rom) : readLevelList(rom, this.app.level.number)) ?? emptyList();
  }
  private slot(): ExSlot | null {
    return this.view.slots.get(this.sel) ?? null;
  }

  private async save(list: ExList, label: string, key: string | null = null): Promise<void> {
    const app = this.app;
    try {
      app.romEdit(`${this.global ? 'Global animation' : `Animation level ${hex(app.level.number, 3)}`}: ${label}`, () => {
        if (this.global) writeGlobalList(app.rom, list); else writeLevelList(app.rom, app.level.number, list);
      }, { key });
    } catch (e) { toast(String(e instanceof Error ? e.message : e), 'error'); }
  }
  private async editSlot(fn: (s: ExSlot) => void, label: string, key: string | null = null): Promise<void> {
    const l = this.list();
    const s = l.slots.get(this.sel);
    if (!s) return;
    fn(s);
    await this.save(l, label, key);
  }

  // frames as columns: [set 0 frame, set 1 frame]
  private columns(s: ExSlot): number[][] {
    const n = s.framesLess1 + 1;
    return Array.from({ length: n }, (_, i) => (secondSet(s.trigger) ? [s.frames[i], s.frames[n + i]] : [s.frames[i]]));
  }
  private setColumns(s: ExSlot, cols: number[][]): void {
    s.framesLess1 = Math.max(0, cols.length - 1);
    s.frames = secondSet(s.trigger) ? [...cols.map((c) => c[0]), ...cols.map((c) => c[1] ?? c[0])] : cols.map((c) => c[0]);
  }

  private charWord(): number {
    return (this.app.render.ppuRegs[0x0b] & 0x0f) << 12; // VRAM word address of layer 1/2 tile 000
  }
  private targetTile(s: ExSlot): number {
    return ((s.dest & 0x7fff) - this.charWord()) >> 4;
  }

  // palette the target tile is mostly drawn with in this level's Map16 tiles
  private rowFor(s: ExSlot): number {
    if (this.palRow >= 0) return this.palRow;
    const t = this.targetTile(s);
    const count = new Array(8).fill(0);
    const src = map16Source(this.app.rom, this.app.render);
    for (const m of new Set(this.app.images?.tiles1 ?? [])) for (const w of src.fg(m)) if ((w & 0x3ff) === t) count[(w >> 10) & 7]++;
    const best = count.indexOf(Math.max(...count));
    return count[best] ? best : 2;
  }

  // pixels of one 8x8 tile of a frame source (32 bytes): alternative file or RAM ($7E)
  private sourceBytes(s: ExSlot, word: number, tile: number): Uint8Array | null {
    const off = word + tile * 32;
    if (s.dest & ALT) {
      const f = this.altBytes;
      return f && off + 32 <= f.length ? f.subarray(off, off + 32) : null;
    }
    const w = this.app.render.wram;
    return off + 32 <= 0x10000 ? w.subarray(off, off + 32) : null;
  }

  // draws a frame of a tile slot (its shape) into a canvas
  private drawFrame(c: HTMLCanvasElement, s: ExSlot, word: number): void {
    const { w, h: hh } = shapeOf(s.type);
    const W = Math.min(w, 16) * 8, H = (hh * Math.ceil(w / 16)) * 8;
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    const ctx = c.getContext('2d')!;
    const img = ctx.createImageData(W, H);
    const px = new Uint32Array(img.data.buffer);
    const pal = cgramToRGBA(this.app.render.cgram);
    const row = this.rowFor(s);
    const idx = new Uint8Array(64);
    for (let t = 0; t < w * hh; t++) {
      const b = this.sourceBytes(s, word, t);
      const r = Math.floor(t / w), col = t % w;
      const x0 = (col % 16) * 8, y0 = (r + Math.floor(col / 16)) * 8;
      if (b) decodeTile(b, 0, 4, idx, 0); else idx.fill(0);
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
        const v = idx[y * 8 + x];
        px[(y0 + y) * W + x0 + x] = v ? pal[row * 16 + v] : ((x + y) & 4 ? 0xff2b2e35 : 0xff23262c);
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  // ---------- UI ----------
  private build(): void {
    this.view = this.list();
    this.altBytes = readAltFile(this.app.rom, this.view.altFile);
    this.buildBar();
    this.buildSlots();
    this.buildDetail();
    this.buildSide();
  }

  private buildBar(): void {
    const app = this.app, b = this.bar;
    clear(b);
    const scope = (g: boolean, label: string, title: string) => h('button', { class: this.global === g ? 'active' : '', title, onclick: () => { this.global = g; this.sel = 0; this.frame = 0; this.build(); } }, label);
    b.append(h('span', { class: 'hint' }, 'List'), h('span', { class: 'btn-group' },
      scope(false, `Level ${hex(app.level.number, 3)}`, 'Animations that run only in this level'),
      scope(true, 'Global', 'Animations that run in all levels (a level can turn them off via “Play in level …”)')));
    if (this.flagsLevel !== app.level.number) { this.flagsMenu = this.levelFlagsMenu(); this.flagsLevel = app.level.number; }
    b.append(h('span', { class: 'spacer' }), this.flagsMenu!);
  }

  // the animation file all tile animations of the list take their frames from (one per list)
  private sourceSelect(l: ExList): HTMLElement {
    const app = this.app;
    const alt = h('select', { title: 'One animation graphic per list: changing it affects all tile animations of this list' },
      [0, 1, 2, 3].map((k) => h('option', { value: String(k), selected: l.altFile === k }, `${gfxName(ANIM_FILE + k)} (${lmAnimName(ANIM_FILE + k)})${readAltFile(app.rom, k) ? '' : ' – empty'}`)));
    alt.addEventListener('change', () => { const nl = this.list(); nl.altFile = Number(alt.value); void this.save(nl, `Frames from ${gfxName(ANIM_FILE + nl.altFile)}`); });
    const n = [...l.slots.values()].filter((s) => kindOf(s.type) === 'tiles' && s.dest & ALT).length;
    // the graphic is shared: other lists animating from it change along when it is drawn on
    const u = altFileUsers(app.rom, l.altFile);
    const others = [...(this.global ? [] : u.global ? ['the global list'] : []), ...u.levels.filter((x) => this.global || x !== app.level.number).map((x) => `level ${hex(x, 3)}`)];
    return h('div', { class: 'at-source' }, h('div', { class: 'row' }, h('span', { class: 'hint' }, 'Frames from'), alt),
      h('div', { class: 'hint' }, n > 1 ? `applies to all ${n} tile animations of this list` : 'applies to all tile animations of this list'),
      others.length ? h('div', { class: 'hint', title: others.join(', ') }, `Also used by ${others.slice(0, 3).join(', ')}${others.length > 3 ? ` and ${others.length - 3} more` : ''} – drawing on it changes their animations too`) : '');
  }

  // which animations play in the current level (always the level's settings, also in "Global"); kept across
  // rebuilds so the open menu stays open while toggling
  private flagsMenu: HTMLElement | null = null;
  private flagsLevel = -1;
  private levelFlagsMenu(): HTMLElement {
    const app = this.app;
    const flag = (bit: number, label: string, title: string): MenuItem => ({
      label, title,
      checked: () => !(levelSettings(app.rom, app.level.number) & bit),
      onToggle: async (on) => {
        const st = levelSettings(app.rom, app.level.number);
        app.romEdit(`Level ${hex(app.level.number, 3)}: ${label} ${on ? 'on' : 'off'}`, () => setLevelSettings(app.rom, app.level.number, on ? st & ~bit : st | bit));
      },
    });
    return menuButton({ label: `Play in level ${hex(app.level.number, 3)}`, title: 'Which animations run in this level (a setting of the level, also for “Global”)', items: [
      { heading: 'Game' },
      flag(NO_GAME_TILES, 'Original tile animation', 'The game\'s animations (?-block, coin, water …)'),
      flag(NO_GAME_COLORS, 'Original color flashing', 'The flashing of color 6·4 (coins, Yoshi coins)'),
      { heading: 'Own' },
      flag(NO_LEVEL_LIST, 'Level animations', 'This level\'s own animations'),
      flag(NO_GLOBAL_LIST, 'Global animations', 'The global animations'),
    ] });
  }

  private buildSlots(): void {
    const box = this.slotsBox;
    clear(box);
    this.previews = [];
    const l = this.list();
    box.append(h('div', { class: 'panel-title' }, this.global ? 'Global animations' : `Animations of level ${hex(this.app.level.number, 3)}`, h('span', { class: 'hint' }, `${l.slots.size} of ${SLOTS}`)));
    box.append(this.sourceSelect(l));
    const items = h('div', { class: 'at-slot-list' });
    for (const [n, s] of [...l.slots.entries()].sort((a, b) => a[0] - b[0])) {
      const c = h('canvas', { class: 'at-mini' });
      this.previews.push({ c, slot: n });
      const kind = kindOf(s.type);
      items.append(h('div', { class: `at-slot${n === this.sel ? ' sel' : ''}`, onclick: () => { this.sel = n; this.frame = 0; this.set = 0; this.build(); } },
        h('span', { class: 'mono hint' }, hex(n, 2)), c,
        h('div', { class: 'at-slot-text' },
          h('div', null, kind === 'tiles' ? `Tile ${hex(this.targetTile(s), 3)} · ${TYPE_NAMES[s.type] ?? ''}` : kind === 'colors' ? `Color ${hex(s.dest & 0xff, 2)} · ${TYPE_NAMES[s.type]}` : `Colors ${rangeName(s)} · ${TYPE_NAMES[s.type] ?? ''}`),
          h('div', { class: 'hint' }, kind === 'rotation' ? `${triggerName(s.trigger)} · ${speedName(s.framesLess1 + 1)}` : `${triggerName(s.trigger)} · ${s.framesLess1 + 1} frame${s.framesLess1 ? 's' : ''}`))));
    }
    if (!l.slots.size) items.append(h('p', { class: 'hint' }, 'No animations yet. A tile animation keeps replacing 8x8 tiles in VRAM with frames from an animation graphic – all Map16 tiles that use them animate along.'));
    box.append(items,
      h('div', { class: 'row' },
        h('button', { onclick: () => void this.add('tiles') }, '+ Tile animation'),
        h('button', { onclick: () => void this.add('colors') }, '+ Color animation'),
        h('button', { title: 'Colors of the palette that move along by one, again and again', onclick: () => void this.add('rotation') }, '+ Color rotation')),
      h('div', { class: 'row' },
        h('button', { disabled: !this.slot(), onclick: () => void this.duplicate() }, 'Duplicate'),
        h('button', { disabled: !this.slot(), onclick: () => void this.remove() }, 'Delete'),
        h('button', { disabled: ![...l.slots.values()].some((x) => kindOf(x.type) === 'tiles'), title: 'Change the frames and targets of tile animations by an offset or a list (Lunar Magic\'s Remap)',
          onclick: () => this.openRemap() }, 'Remap …')));
    this.animate();
  }

  private freeSlot(l: ExList): number {
    for (let s = 0; s < SLOTS; s++) if (!l.slots.has(s)) return s;
    return -1;
  }

  private async add(kind: 'tiles' | 'colors' | 'rotation'): Promise<void> {
    const l = this.list();
    const n = this.freeSlot(l);
    if (n < 0) { toast('All 32 slots are in use'); return; }
    if (kind === 'tiles') {
      if (!readAltFile(this.app.rom, l.altFile)) {
        this.app.romEdit(`${gfxName(ANIM_FILE + l.altFile)} created`, () => writeAltFile(this.app.rom, l.altFile, new Uint8Array(0x1000)));
      }
      l.slots.set(n, { type: 0x01, trigger: 0, framesLess1: 1, dest: ALT | (this.charWord() + 0x60 * 16), frames: [0x00, 0x20] });
    } else if (kind === 'colors') {
      l.slots.set(n, { type: 0x14, trigger: 0, framesLess1: 1, dest: 0x21, frames: [0x001f, 0x7c00] });
    } else {
      const e: ExSlot = { type: 0x18, trigger: 0, framesLess1: 0, dest: 0, frames: [] };
      setRotationRange(e, 0x21, 4);
      l.slots.set(n, e);
    }
    this.sel = n;
    this.frame = 0;
    this.triggerOn = false;
    await this.save(l, kind === 'tiles' ? 'new tile animation' : kind === 'colors' ? 'new color animation' : 'new color rotation');
  }
  private async duplicate(): Promise<void> {
    const l = this.list();
    const s = l.slots.get(this.sel);
    const n = this.freeSlot(l);
    if (!s || n < 0) return;
    l.slots.set(n, { ...s, frames: s.frames.slice() });
    this.sel = n;
    await this.save(l, `Slot ${hex(n, 2)} duplicated`);
  }
  // Lunar Magic's ExAnimation Remap: the chosen tile slots' frames (tiles of the animation graphic) and
  // targets (VRAM tiles) by the same list as the Map16 remap; one undo step
  private openRemap(): void {
    const l = this.list();
    const tileSlots = [...l.slots.entries()].filter(([, x]) => kindOf(x.type) === 'tiles').sort((a, b) => a[0] - b[0]);
    const chosen = new Set(tileSlots.some(([n]) => n === this.sel) ? [this.sel] : tileSlots.map(([n]) => n));
    const what = { frames: true, target: true };
    const file = readAltFile(this.app.rom, l.altFile);
    const frameMax = (file ? file.length : ALT_FILE_MAX) / 32 - 1;
    const charWord = this.charWord();
    const preview = h('div', { class: 'at-remap-preview' });
    const result = () => {
      const { remap } = ed.parsed();
      return tileSlots.filter(([n]) => chosen.has(n)).map(([n, x]) => ({ n, before: x, ...remapSlot(x, remap, charWord, what, frameMax) }));
    };
    const tile = (x: ExSlot, f: number) => (x.dest & ALT ? hex(f >> 5, 2) : `$${hex(f, 4)}`);
    const draw = () => {
      if (!ed.valid()) { preview.replaceChildren(h('div', { class: 'hint' }, 'Fix the marked lines first.')); return; }
      const res = result();
      preview.replaceChildren(h('table', { class: 'at-remap-table' },
        h('tr', null, h('th', null, 'Slot'), h('th', null, 'Target'), h('th', null, 'Frames')),
        res.map((r) => h('tr', { class: r.slot !== r.before ? 'changed' : '' },
          h('td', { class: 'mono' }, hex(r.n, 2)),
          h('td', { class: 'mono' }, `${hex(this.targetTile(r.before), 3)}${r.slot.dest !== r.before.dest ? ` → ${hex(this.targetTile(r.slot), 3)}` : ''}`),
          h('td', { class: 'mono' }, r.before.frames.map((f, i) => tile(r.before, f) + (r.slot.frames[i] !== f ? `→${tile(r.before, r.slot.frames[i])}` : '')).join(' '),
            r.before.dest & ALT ? '' : h('span', { class: 'hint' }, ' (from RAM: stay)'),
            r.out.length ? h('div', { class: 'rl-problems' }, `Out of range, stays: ${r.out.join(', ')}`) : '')))),
        h('div', { class: 'hint' }, `${res.filter((r) => r.slot !== r.before).length} of ${res.length} slot${res.length === 1 ? '' : 's'} change.`));
    };
    const ed = remapEditor('tiles', draw);
    const check = (label: string, on: boolean, set: (v: boolean) => void) => h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: on, onchange: (e: Event) => { set((e.target as HTMLInputElement).checked); draw(); } }), label);
    const body = h('div', { class: 'at-remap' },
      h('div', { class: 'hint' }, 'Slots'),
      h('div', { class: 'at-remap-slots' }, tileSlots.map(([n, x]) => check(`${hex(n, 2)} · tile ${hex(this.targetTile(x), 3)}`, chosen.has(n), (v) => { if (v) chosen.add(n); else chosen.delete(n); }))),
      h('div', { class: 'row' }, check('Frames (tiles of the animation graphic)', true, (v) => { what.frames = v; }), check('Target (VRAM tiles)', true, (v) => { what.target = v; })),
      ed.root, preview);
    draw();
    modal(`Remap ${this.global ? 'global' : `level ${hex(this.app.level.number, 3)}`} tile animations`, body, [
      { label: 'Apply', primary: true, onClick: () => {
        if (!ed.valid()) { toast('Fix the marked lines first', 'error'); return false; }
        const res = result().filter((r) => r.slot !== r.before);
        if (!res.length) { toast('Nothing changes'); return false; }
        const nl = this.list();
        for (const r of res) nl.slots.set(r.n, r.slot);
        void this.save(nl, `${res.length} slot${res.length > 1 ? 's' : ''} remapped`);
      } },
      { label: 'Cancel' },
    ]);
  }

  private async remove(): Promise<void> {
    const l = this.list();
    if (!l.slots.delete(this.sel)) return;
    l.count = 0;
    await this.save(l, `Slot ${hex(this.sel, 2)} deleted`);
    toast(`Animation ${hex(this.sel, 2)} deleted – Ctrl+Z brings it back`);
  }

  private buildDetail(): void {
    const d = this.detail;
    // an open native color picker closes when its input is replaced: rebuild once it is done (change)
    if (pickerOpen(d)) return;
    clear(d);
    const pv = this.ws.preview;
    if (pv.highlight.size || pv.highlight2.size || pv.highlightBg.size) { pv.clearHighlight(); pv.drawHighlight(); }
    const s = this.slot();
    if (!s) { d.append(h('p', { class: 'hint' }, 'Select or create an animation on the left.')); return; }
    const kind = kindOf(s.type);
    const typeSel = h('select', null, (kind === 'colors' ? COLOR_TYPES : kind === 'tiles' ? TILE_TYPES : ROTATION_TYPES).map((t) => h('option', { value: String(t), selected: t === s.type }, TYPE_NAMES[t] ?? hex(t, 2))));
    typeSel.addEventListener('change', () => void this.editSlot((x) => { x.type = Number(typeSel.value); }, `Type ${TYPE_NAMES[Number(typeSel.value)]}`));
    const trig = h('select', null, [...new Set([...(kind === 'rotation' ? ROTATION_TRIGGERS : TRIGGERS), s.trigger])].map((t) => h('option', { value: String(t), selected: t === s.trigger }, triggerName(t))));
    trig.addEventListener('change', () => void this.editSlot((x) => {
      if (kind === 'rotation') { x.trigger = Number(trig.value); return; } // no frames
      const cols = this.columns(x);
      x.trigger = Number(trig.value);
      this.setColumns(x, cols);
    }, `Trigger ${triggerName(Number(trig.value))}`));
    const trigger = [
      h('div', { class: 'prop' }, h('label', null, 'Trigger'), trig),
      secondSet(s.trigger) && kind !== 'rotation' ? h('p', { class: 'hint' }, `Two frame sequences: top normally, bottom while “${secondSetName(s.trigger)}”.`) : '',
      s.trigger === 6 || s.trigger === 8 ? h('p', { class: 'hint' }, 'Runs once up to the last frame as soon as the condition occurs, and stays there.') : '',
    ];
    d.append(
      h('div', { class: 'prop-title' }, `Slot ${hex(this.sel, 2)}`, h('span', { class: 'hint' }, this.global ? ' · global' : ` · level ${hex(this.app.level.number, 3)}`)),
      h('div', { class: 'prop' }, h('label', null, 'Type'), typeSel),
    );
    if (kind === 'tiles') { this.tileDetail(d, s, trigger); return; }
    d.append(...trigger);
    if (kind === 'colors') this.colorDetail(d, s);
    else this.rotationDetail(d, s);
  }

  // where colors show in the level: the Map16 tiles that draw them (links, marked in the preview), or
  // that they are sprite palettes or drawn by no tile here
  private colorUsers(colors: number[]): HTMLElement {
    const app = this.app, im = app.images, pv = this.ws.preview;
    const layers = colors.filter((c) => c < 0x80), sprites = colors.length - layers.length;
    const u = im && layers.length ? levelColorUsers(app.rom, app.render, im, new Set(layers)) : { layer1: [], layer2: [], bg: [] };
    pv.highlight = new Set(u.layer1);
    pv.highlight2 = new Set(u.layer2);
    pv.highlightBg = new Set(u.bg);
    pv.drawHighlight();
    const links = (label: string, tiles: number[], bg: boolean) => tiles.length
      ? h('div', { class: 'gt-users' }, h('span', { class: 'hint' }, label), tiles.slice(0, 24).map((m) => h('a', { href: '#', class: 'mono', title: 'Open in the Map16 tab', onclick: (e: Event) => { e.preventDefault(); this.ws.showMap16(m, bg); } }, hex(m, 3))), tiles.length > 24 ? h('span', { class: 'hint' }, `… (${tiles.length})`) : '')
      : '';
    const none = layers.length && !u.layer1.length && !u.layer2.length && !u.bg.length;
    return h('div', { class: 'at-users' },
      links('shows on Map16 (layer 1):', u.layer1, false), links('layer 2:', u.layer2, false), links('BG:', u.bg, true),
      none ? h('div', { class: 'hint' }, `No Map16 tile of this level draws ${layers.length === 1 ? 'this color' : 'these colors'} – not visible on its layers.`) : '',
      sprites ? h('div', { class: 'hint' }, `${sprites === colors.length ? (colors.length === 1 ? 'This color is' : 'These colors are') : `${sprites} of the colors are`} in the sprite palettes (rows 8–F): ${sprites === 1 ? 'it shows' : 'they show'} on sprites that use them, not on Map16 tiles.`) : '',
      u.layer1.length || u.layer2.length || u.bg.length ? h('div', { class: 'hint' }, 'Marked in the level preview.') : '');
  }

  // a color rotation: its colors (dragged in the palette on the right), how often it turns, a strip
  // of the colors turning at that speed (as while the trigger holds, when asked)
  private rotationDetail(d: HTMLElement, s: ExSlot): void {
    const { first, count } = rotationRange(s), delay = s.framesLess1 + 1;
    const reversible = reversesOnTrigger(s.type);
    d.append(h('p', { class: 'hint' }, s.trigger === 0
      ? (reversible ? 'Runs always (without a trigger it never turns the other way).' : 'Runs always.')
      : reversible ? `Runs always and turns the other way while “${secondSetName(s.trigger)}”.` : `Runs only while “${secondSetName(s.trigger)}” – otherwise the colors stay.`));
    const num = (value: number, min: number, max: number, title: string, set: (v: number) => void) => {
      const i = h('input', { type: 'number', min: String(min), max: String(max), value: String(value), title, class: 'at-num' });
      i.addEventListener('change', () => {
        const v = Math.round(Number(i.value));
        if (!Number.isFinite(v) || v < min || v > max) { toast(`${min}–${max}`); i.value = String(value); return; }
        set(v);
      });
      return i;
    };
    const countIn = num(count, 2, Math.min(ROTATION_MAX, 256 - first), 'Number of colors (2–128, drag in the palette on the right)', (v) => void this.editSlot((x) => setRotationRange(x, first, v), `${v} colors`));
    const delayIn = num(delay, 1, 256, 'Frames per step: 1 = every animation frame (8 game frames), 2 = every 2nd …', (v) => void this.editSlot((x) => { x.framesLess1 = v - 1; }, `Delay ${v}`));
    const strip = h('div', { class: 'at-rot-strip' });
    strip.dataset.slot = String(this.sel);
    const dir = rotationStep(s.type, s.trigger, this.triggerOn);
    d.append(
      h('div', { class: 'prop' }, h('label', null, 'Colors'), h('span', { class: 'mono' }, rangeName(s)), h('span', { class: 'hint' }, 'drag in the palette on the right')),
      this.colorUsers(Array.from({ length: Math.min(count, 256 - first) }, (_, i) => first + i)),
      h('div', { class: 'prop' }, h('label', null, 'Count'), countIn),
      h('div', { class: 'prop' }, h('label', null, 'Frames'), delayIn, h('span', { class: 'hint' }, speedName(delay))),
      h('p', { class: 'hint' }, `A step every ${delay * 8} game frames; all ${count} colors go round in ${fmt(count * delay * 8 / 60)} s.`),
      h('div', { class: 'at-big-wrap' }, strip, h('div', { class: 'hint' }, dir ? `Preview (${dir})` : 'Preview: waits for its trigger')),
      s.trigger ? h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: this.triggerOn, onchange: (e: Event) => { this.triggerOn = (e.target as HTMLInputElement).checked; this.buildDetail(); } }), `Preview while “${secondSetName(s.trigger)}”`) : '',
    );
    const held = this.heldColors(s);
    if (held?.length) {
      const name = (c: number) => `${hex(c >> 4, 1)}·${hex(c & 15, 1)}`;
      const runs: number[][] = [];
      for (const c of held) { const r = runs.at(-1); if (r && r[1] === c - 1) r[1] = c; else runs.push([c, c]); }
      const names = runs.map(([a, b]) => (a === b ? name(a) : `${name(a)}–${name(b)}`)).join(', ');
      d.append(h('p', { class: 'warn-box' }, `In the game, ${held.length === 1 ? `color ${names} does` : `colors ${names} do`} not rotate: the game sets ${held.length === 1 ? 'it' : 'them'} itself every frame (seen in the emulated level).`));
    }
    this.animate();
  }

  // the colors of a rotation that do not turn in the emulated level (the game sets them itself), found
  // in the background once per level render and slot; null until known or when it waits for its trigger
  private heldColors(s: ExSlot): number[] | null {
    const app = this.app, { first, count } = rotationRange(s), delay = s.framesLess1 + 1;
    const key = `${this.global}:${app.level.number}:${this.sel}:${s.type}:${s.trigger}:${s.dest}:${delay}`;
    const hd = this.held;
    if (hd.key === key && hd.render === app.render) return hd.colors;
    const dir = rotationStep(s.type, s.trigger, false);
    if (!dir || delay > 32) return null; // not a step in the 64 the check takes
    clearTimeout(hd.timer);
    hd.timer = window.setTimeout(() => {
      hd.timer = 0;
      const render = app.render;
      let colors: number[] = [];
      try { colors = heldColors(app.animationCgrams(Math.min(64, count * delay) + 1), first, count, dir, delay); } catch (e) { console.error(e); }
      Object.assign(hd, { key, render, colors });
      if (this.visible && this.slot() && hd.key === key) this.buildDetail();
    }, 50);
    return null;
  }

  // the palette on the right for a rotation: drag over it for its colors; a click moves them there
  private rotationPicker(box: HTMLElement, s: ExSlot): void {
    const { first, count } = rotationRange(s);
    const pal = cgramToRGBA(this.app.render.cgram);
    const grid = h('div', { class: 'at-palgrid rot' });
    const cells: HTMLElement[] = [];
    let from = -1, to = -1;
    const range = (): [number, number] => {
      const a = Math.min(from, to), b = Math.max(from, to);
      return b - a + 1 > ROTATION_MAX ? (to > from ? [from, from + ROTATION_MAX - 1] : [from - ROTATION_MAX + 1, from]) : [a, b];
    };
    const mark = (a: number, b: number) => cells.forEach((c, i) => c.classList.toggle('in', i >= a && i <= b));
    const up = () => {
      window.removeEventListener('mouseup', up);
      if (from < 0) return;
      const [a, b] = range();
      from = -1;
      // a click (no drag) moves the colors there, as many as before
      const [f, n] = a === b ? [Math.min(a, 256 - count), count] : [a, b - a + 1];
      if (f === first && n === count) { mark(first, first + count - 1); return; }
      void this.editSlot((x) => setRotationRange(x, f, n), `Colors ${hex(f, 2)}–${hex(f + n - 1, 2)}`);
    };
    for (let i = 0; i < 256; i++) {
      const v = pal[i];
      const c = h('div', { class: 'at-pal', title: `Color ${hex(i >> 4, 1)}·${hex(i & 15, 1)}`, style: { background: `rgb(${v & 255},${(v >> 8) & 255},${(v >> 16) & 255})` },
        onmousedown: (e: MouseEvent) => { if (e.button) return; e.preventDefault(); from = to = i; mark(i, i); window.addEventListener('mouseup', up); },
        onmouseenter: () => { if (from < 0) return; to = i; mark(...range()); } });
      cells.push(c);
      grid.append(c);
    }
    mark(first, first + count - 1);
    box.append(h('div', { class: 'panel-title' }, 'Colors', h('span', { class: 'hint' }, 'drag over the palette (2–128 colors)')), grid);
  }

  // 8x8 tiles (VRAM numbers) a tile slot overwrites
  private targetTiles(s: ExSlot): number[] {
    const t = this.targetTile(s), shape = shapeOf(s.type);
    const out: number[] = [];
    for (let y = 0; y < shape.h; y++) for (let x = 0; x < shape.w; x++) out.push(t + y * 16 + x);
    return out;
  }

  // Map16 tiles that use one of the slot's target tiles (they animate with it)
  private targetUsers(s: ExSlot): number[] {
    const tiles = new Set(this.targetTiles(s));
    const src = map16Source(this.app.rom, this.app.render);
    const max = EXT_TILES;
    const users: number[] = [];
    for (let m = 0; m < max && users.length < 64; m++) if (src.fg(m).some((w) => tiles.has(w & 0x3ff))) users.push(m);
    return users;
  }

  private tileDetail(d: HTMLElement, s: ExSlot, trigger: (HTMLElement | string)[]): void {
    const t = this.targetTile(s);
    const shape = shapeOf(s.type);
    const slot = levelSlots(this.app).find((x) => t >= x.first && t < x.first + 0x80);
    const users = this.targetUsers(s);
    // places in the level: marked in the preview
    this.ws.preview.highlight = new Set(users);
    this.ws.preview.drawHighlight();
    d.append(
      h('div', { class: 'panel-title at-step' }, '1 · Target', h('span', { class: 'hint' }, 'which 8x8 tiles are replaced')),
      h('div', { class: 'prop' }, h('label', null, 'Target'),
        h('span', { class: 'mono' }, `8x8 tile ${hex(t, 3)}`), slot ? h('span', { class: 'hint' }, ` ${slot.name}`) : '',
        h('button', { class: this.picking === 'target' ? 'active' : '', title: 'Click in the VRAM grid on the right or in the level preview', onclick: () => { this.picking = this.picking ? null : 'target'; this.buildSide(); this.buildDetail(); } }, 'Choose target')),
      h('div', { class: 'hint' }, `${shape.w}×${shape.h} tiles`, slot ? h('span', null, ' · ', h('a', { href: '#', title: `Open ${gfxName(slot.file)} in the Graphics tab`, onclick: (e: Event) => { e.preventDefault(); this.ws.showGfx(slot.file, t - slot.first); } }, `view in ${gfxName(slot.file)}`)) : ''),
      users.length
        ? h('div', { class: 'gt-users' }, h('span', { class: 'hint' }, 'animates Map16:'), users.slice(0, 24).map((m) => h('a', { href: '#', class: 'mono', title: 'Open in the Map16 tab', onclick: (e: Event) => { e.preventDefault(); this.ws.showMap16(m); } }, hex(m, 3))), users.length > 24 ? h('span', { class: 'hint' }, `… (${users.length})`) : '')
        : h('div', { class: 'hint' }, 'No Map16 tile uses this target – the animation is not visible in the level.'),
      h('div', { class: 'panel-title at-step' }, '2 · When'),
      ...trigger,
      h('div', { class: 'panel-title at-step' }, '3 · Frames', h('span', { class: 'hint' }, s.dest & ALT ? `from ${gfxName(ANIM_FILE + this.list().altFile)}` : 'from RAM ($7E, the game\'s graphics)')),
    );
    // frames: big preview + columns
    const big = h('canvas', { class: 'at-big' });
    big.dataset.slot = String(this.sel);
    d.append(h('div', { class: 'at-big-wrap' }, big, h('div', { class: 'hint' }, 'Preview (7.5 frames/s)')));
    const cols = this.columns(s);
    const sets = secondSet(s.trigger) ? 2 : 1;
    const strip = h('div', { class: 'at-frames' });
    for (let set = 0; set < sets; set++) {
      const row = h('div', { class: 'at-frame-row' }, sets > 1 ? h('span', { class: 'hint at-set-label' }, set ? secondSetName(s.trigger) : 'normal') : '');
      cols.forEach((c, i) => {
        const cv = h('canvas', { class: 'at-frame-img' });
        this.drawFrame(cv, s, c[set]);
        row.append(h('div', { class: `at-frame${i === this.frame && set === this.set ? ' sel' : ''}`, title: `Frame ${i + 1}: ${s.dest & ALT ? `tile ${hex(c[set] >> 5, 3)} of the animation graphic` : `RAM $7E${hex(c[set], 4)}`}`,
          onclick: () => { this.frame = i; this.set = set; this.buildDetail(); this.buildSide(); } }, cv, h('span', { class: 'hint mono' }, s.dest & ALT ? hex(c[set] >> 5, 2) : '$' + hex(c[set], 4))));
      });
      strip.append(row);
    }
    const step = shape.w * shape.h * 32;
    d.append(strip,
      h('div', { class: 'row' },
        h('button', { title: 'New frame after the selected one (next tiles of the graphic)', onclick: () => void this.editSlot((x) => {
          const cs = this.columns(x);
          if (cs.length >= (secondSet(x.trigger) ? 0x80 : 0x100)) return;
          cs.splice(this.frame + 1, 0, cs[this.frame].map((v) => v + step));
          this.setColumns(x, cs);
          this.frame++;
        }, 'Frame added') }, '+ Frame'),
        h('button', { title: 'Selected frame once more (shows it twice as long)', onclick: () => void this.editSlot((x) => {
          const cs = this.columns(x);
          cs.splice(this.frame + 1, 0, cs[this.frame].slice());
          this.setColumns(x, cs);
        }, 'Frame lengthened') }, 'Longer'),
        h('button', { disabled: cols.length < 2, onclick: () => void this.editSlot((x) => {
          const cs = this.columns(x);
          cs.splice(this.frame, 1);
          this.setColumns(x, cs);
          this.frame = Math.max(0, this.frame - 1);
        }, 'Frame removed') }, 'Remove'),
        h('button', { disabled: this.frame === 0, title: 'Move earlier', onclick: () => void this.editSlot((x) => {
          const cs = this.columns(x);
          [cs[this.frame - 1], cs[this.frame]] = [cs[this.frame], cs[this.frame - 1]];
          this.setColumns(x, cs);
          this.frame--;
        }, 'Frame moved') }, '◀'),
        h('button', { disabled: this.frame >= cols.length - 1, title: 'Move later', onclick: () => void this.editSlot((x) => {
          const cs = this.columns(x);
          [cs[this.frame + 1], cs[this.frame]] = [cs[this.frame], cs[this.frame + 1]];
          this.setColumns(x, cs);
          this.frame++;
        }, 'Frame moved') }, '▶')),
      h('p', { class: 'hint' }, `Each frame shows for 8 game frames (≈0.13 s); “Longer” repeats it. Select a frame, then click the source tile in the animation graphic on the right (${shape.w * shape.h > 1 ? `${shape.w * shape.h} consecutive tiles` : 'one tile'}).`),
    );
  }

  private colorDetail(d: HTMLElement, s: ExSlot): void {
    const count = ((s.dest >> 8) & 0x7f) + 1;
    const back = s.type === 0x16 || s.type === 0x17;
    if (!back) {
      const c = s.dest & 0xff;
      d.append(h('div', { class: 'prop' }, h('label', null, 'Color'), h('span', { class: 'mono' }, `${hex(c >> 4, 1)}·${hex(c & 15, 1)}`),
        h('button', { class: this.picking === 'target' ? 'active' : '', onclick: () => { this.picking = this.picking ? null : 'target'; this.buildSide(); this.buildDetail(); } }, 'Choose color')));
      d.append(this.colorUsers(Array.from({ length: Math.min(count, 256 - c) }, (_, i) => c + i)));
    } else d.append(h('div', { class: 'hint' }, 'Shows wherever no layer draws (the back area).'));
    if (count > 1) { d.append(h('p', { class: 'hint' }, `This animation sets ${count} colors at once (from data) – not editable here yet.`)); return; }
    const cols = this.columns(s);
    const sets = secondSet(s.trigger) ? 2 : 1;
    const strip = h('div', { class: 'at-frames' });
    for (let set = 0; set < sets; set++) {
      const row = h('div', { class: 'at-frame-row' }, sets > 1 ? h('span', { class: 'hint at-set-label' }, set ? secondSetName(s.trigger) : 'normal') : '');
      cols.forEach((c, i) => {
        const pick = h('input', { type: 'color', value: htmlOf(c[set]), class: 'at-color' });
        pick.addEventListener('input', () => {
          const m = /^#(..)(..)(..)$/.exec(pick.value)!;
          const v = (parseInt(m[1], 16) >> 3) | ((parseInt(m[2], 16) >> 3) << 5) | ((parseInt(m[3], 16) >> 3) << 10);
          void this.editSlot((x) => { const cs = this.columns(x); cs[i][set] = v; this.setColumns(x, cs); }, `Color of frame ${i + 1}`, `anim-color:${this.sel}:${i}:${set}`);
        });
        pick.addEventListener('change', () => { pick.blur(); this.buildDetail(); });
        row.append(h('div', { class: `at-frame${i === this.frame && set === this.set ? ' sel' : ''}`, onclick: (e: MouseEvent) => {
          this.frame = i; this.set = set;
          for (const f of strip.querySelectorAll('.at-frame')) f.classList.toggle('sel', f === e.currentTarget);
        } }, pick, h('span', { class: 'hint mono' }, `$${hex(c[set], 4)}`)));
      });
      strip.append(row);
    }
    const sw = h('div', { class: 'at-color-big' });
    sw.dataset.slot = String(this.sel);
    d.append(h('div', { class: 'at-big-wrap' }, sw, h('div', { class: 'hint' }, 'Preview')), strip,
      h('div', { class: 'row' },
        h('button', { onclick: () => void this.editSlot((x) => { const cs = this.columns(x); cs.splice(this.frame + 1, 0, cs[this.frame].slice()); this.setColumns(x, cs); this.frame++; }, 'Frame added') }, '+ Frame'),
        h('button', { disabled: cols.length < 2, onclick: () => void this.editSlot((x) => { const cs = this.columns(x); cs.splice(this.frame, 1); this.setColumns(x, cs); this.frame = Math.max(0, this.frame - 1); }, 'Frame removed') }, 'Remove')),
      h('p', { class: 'hint' }, 'Each frame shows for 8 game frames (≈0.13 s). The same color twice in a row shows it longer.'));
  }

  // right: the source sheet (frame pick) or the target pick
  private buildSide(): void {
    const box = this.side;
    clear(box);
    const s = this.slot();
    if (!s) return;
    const kind = kindOf(s.type);
    if (kind === 'colors') {
      if (this.picking !== 'target') { box.append(h('p', { class: 'hint' }, 'Use “Choose color” to set the palette color that is animated.')); return; }
      const pal = cgramToRGBA(this.app.render.cgram);
      const grid = h('div', { class: 'at-palgrid' });
      for (let i = 0; i < 256; i++) {
        const v = pal[i];
        grid.append(h('div', { class: `at-pal${(s.dest & 0xff) === i ? ' sel' : ''}`, title: `Color ${hex(i >> 4, 1)}·${hex(i & 15, 1)}`, style: { background: `rgb(${v & 255},${(v >> 8) & 255},${(v >> 16) & 255})` },
          onclick: () => { this.picking = null; void this.editSlot((x) => { x.dest = (x.dest & 0xff00) | i; }, `Color ${hex(i, 2)}`); } }));
      }
      box.append(h('div', { class: 'panel-title' }, 'Choose color'), grid);
      return;
    }
    if (kind === 'rotation') { this.rotationPicker(box, s); return; }
    if (kind !== 'tiles') return;
    const row = this.rowFor(s);
    const rows = h('div', { class: 'at-rows' }, Array.from({ length: 8 }, (_, r) => h('button', { class: r === row ? 'active' : '', onclick: () => { this.palRow = r; this.build(); } }, String(r))));
    box.append(h('div', { class: 'row' }, h('span', { class: 'hint' }, 'Palette'), rows, this.palRow >= 0 ? h('a', { href: '#', onclick: (e: Event) => { e.preventDefault(); this.palRow = -1; this.build(); } }, 'auto') : ''));
    if (this.picking === 'target') { this.targetPicker(box, s, row); return; }
    this.sourcePicker(box, s, row);
  }

  private sheet(tiles: number, get: (t: number) => Uint8Array | null, row: number, Z = 3): HTMLCanvasElement {
    const rowsN = Math.ceil(tiles / 16);
    const c = h('canvas', { width: 128 * Z, height: rowsN * 8 * Z, class: 'at-sheet' });
    const off = document.createElement('canvas');
    off.width = 128; off.height = rowsN * 8;
    const octx = off.getContext('2d')!;
    const img = octx.createImageData(128, rowsN * 8);
    const px = new Uint32Array(img.data.buffer);
    const pal = cgramToRGBA(this.app.render.cgram);
    const idx = new Uint8Array(64);
    for (let t = 0; t < tiles; t++) {
      const b = get(t);
      if (b) decodeTile(b, 0, 4, idx, 0); else idx.fill(0);
      const x0 = (t & 15) * 8, y0 = (t >> 4) * 8;
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) { const v = idx[y * 8 + x]; px[(y0 + y) * 128 + x0 + x] = v ? pal[row * 16 + v] : 0xff202226; }
    }
    octx.putImageData(img, 0, 0);
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(off, 0, 0, c.width, c.height);
    return c;
  }

  private sourcePicker(box: HTMLElement, s: ExSlot, row: number): void {
    const l = this.list();
    const file = readAltFile(this.app.rom, l.altFile);
    if (!(s.dest & ALT)) {
      box.append(h('p', { class: 'hint' }, 'This slot takes its frames from RAM (the game\'s graphics, e.g. from a Lunar Magic ROM). Copied into the animation graphic, they can be picked and drawn here.'),
        h('button', { onclick: () => void this.copyRamFrames() }, `Copy frames into ${gfxName(ANIM_FILE + l.altFile)}`));
      return;
    }
    if (!file) {
      box.append(h('p', { class: 'hint' }, `${gfxName(ANIM_FILE + l.altFile)} (Lunar Magic: ${lmAnimName(ANIM_FILE + l.altFile)}) is still empty.`),
        h('button', { onclick: () => void this.createAltFile(l.altFile) }, `Create ${gfxName(ANIM_FILE + l.altFile)} (128 empty tiles)`));
      return;
    }
    const n = s.framesLess1 + 1;
    const cur = s.frames[this.set * n + this.frame] ?? 0;
    const per = shapeOf(s.type).w * shapeOf(s.type).h;
    const tiles = file.length >> 5;
    const c = this.sheet(tiles, (t) => file.subarray(t * 32, t * 32 + 32), row);
    const ctx = c.getContext('2d')!;
    const first = cur >> 5;
    ctx.strokeStyle = '#ffb000'; ctx.lineWidth = 2;
    for (let k = 0; k < per; k++) { const t = first + k; ctx.strokeRect((t & 15) * 24 + 1, (t >> 4) * 24 + 1, 22, 22); }
    c.addEventListener('mousedown', (e) => {
      const rc = c.getBoundingClientRect();
      const t = Math.floor((e.clientY - rc.top) / (rc.height / Math.ceil(tiles / 16))) * 16 + Math.floor((e.clientX - rc.left) / (rc.width / 16));
      if (t + per > tiles) { toast('The tiles no longer fit into the graphic from here'); return; }
      void this.editSlot((x) => { const cs = this.columns(x); cs[this.frame][this.set] = t * 32; this.setColumns(x, cs); }, `Frame ${this.frame + 1}: tile ${hex(t, 2)}`);
    });
    box.append(h('div', { class: 'panel-title' }, `${gfxName(ANIM_FILE + l.altFile)}`, h('a', { href: '#', onclick: (e: Event) => { e.preventDefault(); this.ws.showGfx(ANIM_FILE + l.altFile, first); } }, 'draw')),
      h('div', { class: 'hint' }, `Click the source for frame ${this.frame + 1}${secondSet(s.trigger) ? ` (${this.set ? secondSetName(s.trigger) : 'normal'})` : ''}`),
      h('div', { class: 'at-sheet-scroll' }, c));
  }

  // the selected RAM slot's frames (as the level's WRAM has them after its load) into the list's graphic
  private async copyRamFrames(): Promise<void> {
    const app = this.app, l = this.list(), s = l.slots.get(this.sel);
    if (!s) return;
    try {
      app.romEdit(`Slot ${hex(this.sel, 2)}: frames copied into ${gfxName(ANIM_FILE + l.altFile)}`, () => {
        const r = localizeFrames(app.rom, [s], { ram: app.render.wram }, l.altFile, true);
        if (!r.slots[0]) throw new Error(r.notes.join(' '));
        l.slots.set(this.sel, r.slots[0]);
        if (this.global) writeGlobalList(app.rom, l); else writeLevelList(app.rom, app.level.number, l);
      });
    } catch (e) { toast(String(e instanceof Error ? e.message : e), 'error'); }
  }

  private async createAltFile(k: number): Promise<void> {
    try { this.app.romEdit(`${gfxName(ANIM_FILE + k)} created`, () => writeAltFile(this.app.rom, k, new Uint8Array(0x1000))); }
    catch (e) { toast(String(e instanceof Error ? e.message : e), 'error'); }
  }

  private targetPicker(box: HTMLElement, s: ExSlot, row: number): void {
    const app = this.app;
    const base = this.charWord() * 2;
    const vram = app.render.vram;
    const slots = levelSlots(app);
    const shape = shapeOf(s.type);
    box.append(h('div', { class: 'panel-title' }, 'Choose target in VRAM'), h('div', { class: 'hint' }, `Click a tile (top left of the ${shape.w}×${shape.h} tiles). A click into the level preview works too.`));
    for (const sl of slots) {
      const c = this.sheet(128, (t) => vram.subarray((base + (sl.first + t) * 32) & 0xffff, ((base + (sl.first + t) * 32) & 0xffff) + 32), row);
      const t0 = this.targetTile(s) - sl.first;
      const ctx = c.getContext('2d')!;
      ctx.strokeStyle = '#ffb000'; ctx.lineWidth = 2;
      for (let y = 0; y < shape.h; y++) for (let x = 0; x < shape.w; x++) {
        const t = t0 + y * 16 + x;
        if (t >= 0 && t < 128) ctx.strokeRect((t & 15) * 24 + 1, (t >> 4) * 24 + 1, 22, 22);
      }
      c.addEventListener('mousedown', (e) => {
        const rc = c.getBoundingClientRect();
        const t = sl.first + Math.floor((e.clientY - rc.top) / (rc.height / 8)) * 16 + Math.floor((e.clientX - rc.left) / (rc.width / 16));
        this.setTarget(t);
      });
      box.append(h('div', { class: 'at-target-head' }, h('b', null, sl.name), h('span', { class: 'hint mono' }, ` ${gfxName(sl.file)} · ${hex(sl.first, 3)}–${hex(sl.first + 0x7f, 3)}`)), c);
    }
  }

  private setTarget(t: number): void {
    this.picking = null;
    void this.editSlot((x) => { x.dest = (x.dest & ALT) | (this.charWord() + t * 16); }, `Target tile ${hex(t, 3)}`);
  }

  previewClick(px: number, py: number): void {
    const s = this.slot();
    if (!s) return;
    if (kindOf(s.type) === 'tiles') {
      const m = this.ws.preview.tileAt(px, py);
      if (m < 0) return;
      const w = map16Source(this.app.rom, this.app.render).fg(m)[0]; // top left quarter
      this.setTarget(w & 0x3ff);
    }
  }

  // advances every preview to the frame of the current tick
  private animate(): void {
    const l = this.view;
    const frameOf = (s: ExSlot, set: number) => {
      const n = s.framesLess1 + 1;
      return s.frames[set * n + (this.tick % n)];
    };
    for (const p of this.previews) {
      const s = l.slots.get(p.slot);
      if (!s) continue;
      if (kindOf(s.type) === 'tiles') this.drawFrame(p.c, s, frameOf(s, 0));
      else if (kindOf(s.type) === 'colors') { p.c.width = p.c.height = 1; const ctx = p.c.getContext('2d')!; const v = snesColorToRGBA(frameOf(s, 0) ?? 0); ctx.fillStyle = `rgb(${v & 255},${(v >> 8) & 255},${(v >> 16) & 255})`; ctx.fillRect(0, 0, 1, 1); }
      else {
        const c = this.rotationColors(s, rotationStep(s.type, s.trigger, false));
        p.c.width = c.length; p.c.height = 1;
        const ctx = p.c.getContext('2d')!;
        c.forEach((v, i) => { ctx.fillStyle = cssOf(v); ctx.fillRect(i, 0, 1, 1); });
      }
    }
    const s = this.slot();
    if (!s) return;
    const strip = this.detail.querySelector<HTMLElement>('.at-rot-strip');
    if (strip && kindOf(s.type) === 'rotation') {
      const c = this.rotationColors(s, rotationStep(s.type, s.trigger, this.triggerOn));
      if (strip.childElementCount !== c.length) strip.replaceChildren(...c.map(() => h('div')));
      c.forEach((v, i) => { (strip.children[i] as HTMLElement).style.background = cssOf(v); });
    }
    const big = this.detail.querySelector<HTMLCanvasElement>('.at-big');
    if (big) this.drawFrame(big, s, frameOf(s, this.set));
    const cb = this.detail.querySelector<HTMLElement>('.at-color-big');
    if (cb) cb.style.background = cssOf(frameOf(s, this.set) ?? 0);
  }

  // a rotation's colors (SNES words, from the level's palette) at the current tick, turned `dir`
  private rotationColors(s: ExSlot, dir: 'right' | 'left' | null): number[] {
    const { first, count } = rotationRange(s), cg = this.app.render.cgram;
    const c = Array.from({ length: Math.min(count, 256 - first) }, (_, i) => cg[(first + i) * 2] | (cg[(first + i) * 2 + 1] << 8));
    return dir ? rotated(c, dir, Math.floor(this.tick / (s.framesLess1 + 1))) : c;
  }

  key(e: KeyboardEvent): boolean {
    if (e.key === 'Delete' && this.slot()) { void this.remove(); return true; }
    if (e.key === 'Escape' && this.picking) { this.picking = null; this.build(); return true; }
    return false;
  }
}
