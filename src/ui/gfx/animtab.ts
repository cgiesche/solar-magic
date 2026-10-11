// Animations tab: ExAnimation in Lunar Magic's format (core/exanim.ts). A list for the level and a global
// one; each slot animates 8x8 tiles in VRAM (frames from an animation file, Anim-ExGFX60-63, or from
// RAM) or a color, with a trigger. Every frame of a slot shows for 8 game frames; longer frames are
// repeated frames. The level preview plays the real result (the engine runs in the emulator).

import type { App } from '../app.ts';
import type { GfxWorkspace, WsPanel } from '../gfxworkspace.ts';
import { h, clear, toast, pickerOpen } from '../dom.ts';
import { menuButton, type MenuItem } from '../menu.ts';
import { hex } from '../../core/names.ts';
import { cgramToRGBA, decodeTile, snesColorToRGBA } from '../../core/gfx.ts';
import { map16Source } from '../../core/render.ts';
import { EXT_FIRST, EXT_TILES, map16Ext } from '../../core/map16ext.ts';
import {
  type ExList, type ExSlot, emptyList, readLevelList, readGlobalList, writeLevelList, writeGlobalList, levelSettings, setLevelSettings,
  readAltFile, writeAltFile, kindOf, tilesOf, secondSet, secondSetName, triggerName, TYPE_NAMES, SLOTS, exanimInstalled, exanimLayout,
  NO_GAME_COLORS, NO_GAME_TILES, NO_LEVEL_LIST, NO_GLOBAL_LIST, altFileUsers, localizeFrames, shapeOf, exanimTiles,
} from '../../core/exanim.ts';
import { levelSlots, gfxName, lmAnimName, ANIM_FILE } from './map16tab.ts';
import { confirmExAnim } from './gfxtab.ts';
import { cssOf, htmlOf } from './palettetab.ts';

const TILE_TYPES = [0x01, 0x02, 0x04, 0x08, 0x10, 0x11, 0x12, 0x03, 0x05, 0x06, 0x07, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e];
const COLOR_TYPES = [0x14, 0x13, 0x15, 0x16, 0x17];
const TRIGGERS = [0x00, 0x03, 0x01, 0x02, 0x04, 0x05, 0x07, 0x06, 0x08];
const ALT = 0x8000;

// own tile animations of the current level (its list and the global one) that overwrite a VRAM tile
export function animsAt(app: App, tile: number): { global: boolean; slot: number }[] {
  return exanimTiles(app.rom, app.level.number, (app.render.ppuRegs[0x0b] & 0x0f) << 12).get(tile) ?? [];
}

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

  // opens a slot of the level's or the global list
  select(global: boolean, slot: number): void {
    this.global = global;
    this.sel = slot;
    this.frame = 0;
    this.set = 0;
    this.picking = null;
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
    if (!(await confirmExAnim(this.app))) return;
    const app = this.app;
    try {
      app.romEdit(`${this.global ? 'Global animation' : `Animation level ${hex(app.level.number, 3)}`}: ${label}`, () => {
        if (this.global) writeGlobalList(app.rom, list); else writeLevelList(app.rom, app.level.number, list);
      }, key);
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
    const installed = exanimInstalled(app.rom);
    if (!installed && exanimLayout(app.rom) === null && app.rom.r8(0x0583ad) === 0x22) {
      b.append(h('span', { class: 'hint' }, 'This ROM has ExAnimation in an older Lunar Magic format – not supported.'));
      return;
    }
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
        if (!(await confirmExAnim(app))) return;
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
    if (exanimInstalled(this.app.rom) || l.slots.size) box.append(this.sourceSelect(l));
    const items = h('div', { class: 'at-slot-list' });
    for (const [n, s] of [...l.slots.entries()].sort((a, b) => a[0] - b[0])) {
      const c = h('canvas', { class: 'at-mini' });
      this.previews.push({ c, slot: n });
      const kind = kindOf(s.type);
      items.append(h('div', { class: `at-slot${n === this.sel ? ' sel' : ''}`, onclick: () => { this.sel = n; this.frame = 0; this.set = 0; this.build(); } },
        h('span', { class: 'mono hint' }, hex(n, 2)), c,
        h('div', { class: 'at-slot-text' },
          h('div', null, kind === 'tiles' ? `Tile ${hex(this.targetTile(s), 3)} · ${TYPE_NAMES[s.type] ?? ''}` : kind === 'colors' ? `Color ${hex(s.dest & 0xff, 2)} · ${TYPE_NAMES[s.type]}` : TYPE_NAMES[s.type] ?? ''),
          h('div', { class: 'hint' }, `${triggerName(s.trigger)} · ${s.framesLess1 + 1} frame${s.framesLess1 ? 's' : ''}`))));
    }
    if (!l.slots.size) items.append(h('p', { class: 'hint' }, 'No animations yet. A tile animation keeps replacing 8x8 tiles in VRAM with frames from an animation graphic – all Map16 tiles that use them animate along.'));
    box.append(items,
      h('div', { class: 'row' },
        h('button', { onclick: () => void this.add('tiles') }, '+ Tile animation'),
        h('button', { onclick: () => void this.add('colors') }, '+ Color animation')),
      h('div', { class: 'row' },
        h('button', { disabled: !this.slot(), onclick: () => void this.duplicate() }, 'Duplicate'),
        h('button', { disabled: !this.slot(), onclick: () => void this.remove() }, 'Delete')));
    this.animate();
  }

  private freeSlot(l: ExList): number {
    for (let s = 0; s < SLOTS; s++) if (!l.slots.has(s)) return s;
    return -1;
  }

  private async add(kind: 'tiles' | 'colors'): Promise<void> {
    const l = this.list();
    const n = this.freeSlot(l);
    if (n < 0) { toast('All 32 slots are in use'); return; }
    if (kind === 'tiles') {
      if (!readAltFile(this.app.rom, l.altFile)) {
        if (!(await confirmExAnim(this.app))) return;
        this.app.romEdit(`${gfxName(ANIM_FILE + l.altFile)} created`, () => writeAltFile(this.app.rom, l.altFile, new Uint8Array(0x1000)));
      }
      l.slots.set(n, { type: 0x01, trigger: 0, framesLess1: 1, dest: ALT | (this.charWord() + 0x60 * 16), frames: [0x00, 0x20] });
    } else {
      l.slots.set(n, { type: 0x14, trigger: 0, framesLess1: 1, dest: 0x21, frames: [0x001f, 0x7c00] });
    }
    this.sel = n;
    this.frame = 0;
    await this.save(l, kind === 'tiles' ? 'new tile animation' : 'new color animation');
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
    if (this.ws.preview.highlight.size) { this.ws.preview.highlight.clear(); this.ws.preview.drawHighlight(); }
    const s = this.slot();
    if (!s) { d.append(h('p', { class: 'hint' }, 'Select or create an animation on the left.')); return; }
    const kind = kindOf(s.type);
    const typeSel = h('select', null, (kind === 'colors' ? COLOR_TYPES : kind === 'tiles' ? TILE_TYPES : [s.type]).map((t) => h('option', { value: String(t), selected: t === s.type }, TYPE_NAMES[t] ?? hex(t, 2))));
    typeSel.addEventListener('change', () => void this.editSlot((x) => { x.type = Number(typeSel.value); }, `Type ${TYPE_NAMES[Number(typeSel.value)]}`));
    const trig = h('select', null, [...new Set([...TRIGGERS, s.trigger])].map((t) => h('option', { value: String(t), selected: t === s.trigger }, triggerName(t))));
    trig.addEventListener('change', () => void this.editSlot((x) => {
      const cols = this.columns(x);
      x.trigger = Number(trig.value);
      this.setColumns(x, cols);
    }, `Trigger ${triggerName(Number(trig.value))}`));
    const trigger = [
      h('div', { class: 'prop' }, h('label', null, 'Trigger'), trig),
      secondSet(s.trigger) ? h('p', { class: 'hint' }, `Two frame sequences: top normally, bottom while “${secondSetName(s.trigger)}”.`) : '',
      s.trigger === 6 || s.trigger === 8 ? h('p', { class: 'hint' }, 'Runs once up to the last frame as soon as the condition occurs, and stays there.') : '',
    ];
    d.append(
      h('div', { class: 'prop-title' }, `Slot ${hex(this.sel, 2)}`, h('span', { class: 'hint' }, this.global ? ' · global' : ` · level ${hex(this.app.level.number, 3)}`)),
      h('div', { class: 'prop' }, h('label', null, 'Type'), typeSel),
    );
    if (kind === 'tiles') { this.tileDetail(d, s, trigger); return; }
    d.append(...trigger);
    if (kind === 'colors') this.colorDetail(d, s);
    else d.append(h('p', { class: 'hint' }, 'Color rotations cannot be edited here yet (created in Lunar Magic).'));
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
    const max = map16Ext(this.app.rom) ? EXT_TILES : EXT_FIRST;
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
    }
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
    if (!(await confirmExAnim(this.app))) return;
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
    if (!(await confirmExAnim(this.app))) return;
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
    }
    const s = this.slot();
    if (!s) return;
    const big = this.detail.querySelector<HTMLCanvasElement>('.at-big');
    if (big) this.drawFrame(big, s, frameOf(s, this.set));
    const cb = this.detail.querySelector<HTMLElement>('.at-color-big');
    if (cb) cb.style.background = cssOf(frameOf(s, this.set) ?? 0);
  }

  key(e: KeyboardEvent): boolean {
    if (e.key === 'Delete' && this.slot()) { void this.remove(); return true; }
    if (e.key === 'Escape' && this.picking) { this.picking = null; this.build(); return true; }
    return false;
  }
}
