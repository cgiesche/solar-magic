// Animations tab: ExAnimation in Lunar Magic's format (core/exanim.ts). A list for the level and a global
// one; each slot animates 8x8 tiles in VRAM (frames from an animation file, Anim-ExGFX60-63, or from
// RAM) or a color, with a trigger. Every frame of a slot shows for 8 game frames; longer frames are
// repeated frames. The level preview plays the real result (the engine runs in the emulator).
// With a submap as the workspace's target: the submap's list and the overworld's global one, the submap's settings
// (Lunar Magic's overworld ExAnimation), drawn with what the submap's load left in VRAM and CGRAM; its triggers 01–08
// are the overworld's event triggers.

import type { App } from '../app.ts';
import type { Watch } from '../../core/romwatch.ts';
import type { GfxWorkspace, WsPanel } from '../gfxworkspace.ts';
import { h, clear, toast, pickerOpen, modal, hexInput } from '../dom.ts';
import { menuButton, type MenuItem } from '../menu.ts';
import { hex } from '../../core/names.ts';
import { cgramToRGBA, decodeTile, snesColorToRGBA } from '../../core/gfx.ts';
import { map16Source, levelColorUsers, setFgWords } from '../../core/render.ts';
import { paletteOn } from '../../core/quarters.ts';
import { fgTileUsers } from '../../core/levelusage.ts';
import { EXT_TILES } from '../../core/map16ext.ts';
import {
  type ExList, type ExSlot, type ExListRef, emptyList, readList, writeList, levelSettings, setLevelSettings, submapAnimSettings, setSubmapAnimSettings, submapLightning, setSubmapLightning,
  kindOf, tilesOf, secondSet as secondSetOf, secondSetName as secondSetNameOf, triggerName as triggerNameOf, isEventTrigger, eventManual, TYPE_NAMES, SLOTS,
  NO_GAME_COLORS, NO_GAME_TILES, NO_LEVEL_LIST, NO_GLOBAL_LIST, NO_DOT_COLORS, altFileUsers, localizeFrames, shapeOf, exanimTiles, exanimColors, ALT_FILE_MAX,
  rotationRange, setRotationRange, rotationStep, rotated, stepsPerSecond, heldColors, reversesOnTrigger, ROTATION_MAX,
} from '../../core/exanim.ts';
import type { GfxTarget } from './target.ts';
import { gfxName, lmAnimName } from './map16tab.ts';
import { gfxBytes, hasGfx, createGfx, ANIM_FILE } from '../../core/gfxfiles.ts';
import { layerSlots, slotOfTile, type GfxSlot } from '../../core/gfxslots.ts';
import { cssOf, htmlOf } from './palettetab.ts';
import { remapSlot } from '../../core/remap.ts';
import { remapEditor } from '../remaplist.ts';
import type { LevelRender } from '../../core/levelemu.ts';
import type { Rom } from '../../core/rom.ts';
import {
  triggersFor, maxFrames, triggerRam, triggerProblems, customInit, setCustomInit, isManual, isCustom, isOneShot, playsOnce, slotName, PRECISION, OW_EVENTS, type CustomInit, type SlotRef,
} from '../../core/extrigger.ts';

// what the tab draws with: the level's render, or the console after the submap's load
type Shown = { vram: Uint8Array; cgram: Uint8Array; wram: Uint8Array; ppuRegs: Uint8Array };
const NOTHING_SHOWN: Shown = { vram: new Uint8Array(0x10000), cgram: new Uint8Array(0x200), wram: new Uint8Array(0x20000), ppuRegs: new Uint8Array(0x40) };
import { triggerPanel } from '../triggerpanel.ts';

const TILE_TYPES = [0x01, 0x02, 0x04, 0x08, 0x10, 0x11, 0x12, 0x03, 0x05, 0x06, 0x07, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e];
const COLOR_TYPES = [0x14, 0x13, 0x15, 0x16, 0x17];
const ROTATION_TYPES = [0x18, 0x1a, 0x19, 0x1b];
// the trigger choice, grouped (extrigger.ts triggersFor: what the slot's kind can take)
const TRIGGER_GROUPS: [string, (t: number) => boolean][] = [
  ['Game', (t) => t < 0x10 && t !== PRECISION], ['Timing', (t) => t === PRECISION], ['Manual (frame set by code)', isManual],
  ['Custom (switched by code)', isCustom], ['One shot (fired by code, plays once)', isOneShot],
];
// (ow: an overworld list's, its 01–08 the event triggers)
function triggerSelect(kind: 'tiles' | 'colors' | 'rotation', current: number, ow: boolean): HTMLSelectElement {
  const all = [...new Set([...triggersFor(kind, ow), current])];
  const groups: [string, (t: number) => boolean][] = ow ? [['Overworld event (its number in Trigger Init)', isEventTrigger], ...TRIGGER_GROUPS.slice(1)] : TRIGGER_GROUPS;
  const opt = (t: number) => h('option', { value: String(t), selected: t === current }, triggerNameOf(t, ow));
  return h('select', null, groups.map(([label, of]) => h('optgroup', { label }, all.filter(of).map(opt))), all.filter((t) => !groups.some(([, of]) => of(t))).map(opt));
}
// what a trigger does for a slot, in a line
function triggerHint(t: number, rotation: boolean, ow: boolean): string {
  if (ow && isEventTrigger(t)) return `Holds once the overworld event whose number Manual ${hex(eventManual(t), 1)} has is passed (set it in the list's Trigger Init)${rotation ? '' : ': the second frame sequence shows then'}.`;
  if (t === PRECISION) return `Always runs, with the frame counter of the first slot of its 8 (slots 0, 8, 10, 18)${rotation ? ': rotations of one group share their delay – for speeds between the steps' : ''}.`;
  if (isManual(t)) return 'Shows the frame your code sets and stays there; uploads only when it changes.';
  if (isCustom(t)) return 'Your code switches it on and off.';
  if (isOneShot(t)) return 'Holds until your code fires it, then plays once to the last frame and stays there (the engine clears the trigger). At most 255 frames.';
  if (playsOnce(t)) return 'Plays once to the last frame as soon as the condition occurs, and stays there. At most 255 frames.';
  return '';
}
const ALT = 0x8000;
// the bytes of Anim graphic k (A–D), null: none yet
const animBytes = (rom: Rom, k: number) => gfxBytes(rom, ANIM_FILE + k)?.data ?? null;

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

// a slot's frames at the trigger's limit (extrigger.ts maxFrames), said so
const full = (x: ExSlot, cs: number[][], ow: boolean) => { const max = maxFrames(x.trigger, ow); if (cs.length < max) return false; toast(`At most ${max} frames`); return true; };
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
  private palRows = new Map<string, number>(); // palette a tile slot's previews are drawn in (none: from the target's Map16 use)
  private visible = false;
  private tick = 0;
  private timer = 0;
  private picking: 'target' | null = null;
  private triggerOn = false; // a rotation's preview as while its trigger holds
  private triggers = false; // the side shows the trigger panel
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
  private watch: Watch; // the ROM bytes the tab was built from (romwatch.ts)

  constructor(app: App, ws: GfxWorkspace) {
    this.app = app;
    this.ws = ws;
    this.root = h('div', { class: 'at' }, this.bar, h('div', { class: 'at-main' }, this.slotsBox, this.detail, this.side));
    const rebuild = () => { if (this.visible) this.build(); };
    // (built again when a ROM change changed what it was built from)
    this.watch = app.watchRom(rebuild);
    app.on('level', () => { if (this.t.levelPreview) rebuild(); });
    app.on('render', () => { if (this.visible && this.t.levelPreview) this.buildSide(); });
    // (the submap's load came: what the tab draws with)
    ws.preview.onMap(rebuild);
  }

  // the workspace's target: the open level's lists or a submap's
  readonly submaps = true;
  private get t(): GfxTarget { return this.ws.desc; }
  // the overworld's ExAnimation (its settings, its triggers 01–08 are events), the submap's tilemaps instead of the
  // level's Map16 tiles
  private get ow(): boolean { return this.t.owAnims; }
  targetChanged(): void {
    this.global = false;
    this.sel = 0;
    this.frame = 0;
    this.set = 0;
    this.picking = null;
    this.triggers = false;
    this.triggerOn = false;
    // (the workspace shows the tab again)
  }
  // the list edited (the target's own or the global one) and the target's own
  private ref(global = this.global): ExListRef {
    return this.t.animList(global);
  }
  // the target's name: "level 105", "submap 1"
  private get own(): string { return this.t.short; }
  // the list's name: "global", "the overworld's global list" …
  private listName(global = this.global): string { return global ? (this.ow ? 'overworld global' : 'global') : this.own; }
  // what the tab draws with: the level as rendered, or the console after the submap's load (nothing while it is
  // emulated)
  private shown(): Shown {
    return this.t.levelPreview ? this.app.render : this.ws.preview.submapRender() ?? NOTHING_SHOWN;
  }
  private triggerName(t: number): string { return triggerNameOf(t, this.ow); }
  private secondSet(t: number): boolean { return secondSetOf(t, this.ow); }
  private secondSetName(t: number): string { return secondSetNameOf(t, this.ow); }

  previewHint(): string {
    return this.t.levelPreview ? 'Click: take the Map16 tile under the mouse as target (top left quarter)' : '';
  }

  // a slot's key there: the list's
  private palKey(slot = this.sel): string { const r = this.ref(); return `${r.kind}${'n' in r ? hex(r.n, 3) : ''}:${slot}`; }
  private get palRow(): number { return this.palRows.get(this.palKey()) ?? -1; }
  private set palRow(r: number) { const k = this.palKey(); if (r < 0) this.palRows.delete(k); else this.palRows.set(k, r); }

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
    this.watch.stop();
    clearInterval(this.timer);
  }

  // ---------- data ----------
  private list(): ExList {
    return readList(this.app.rom, this.ref()) ?? emptyList();
  }
  // the open level's graphics slots (the submap's)
  private gfxSlots(): GfxSlot[] {
    return this.t.slots();
  }

  private slot(): ExSlot | null {
    return this.view.slots.get(this.sel) ?? null;
  }

  private async save(list: ExList, label: string, key: string | null = null): Promise<void> {
    const app = this.app;
    try {
      const ref = this.ref();
      app.romEdit(`${this.global ? (this.ow ? 'Overworld global animation' : 'Global animation') : `Animation ${this.own}`}: ${label}`, () => writeList(app.rom, ref, list), { key });
    } catch (e) { toast(String(e instanceof Error ? e.message : e), 'error'); }
  }
  // the selected slot changed by `fn` and saved; nothing saved when it returns false
  private async editSlot(fn: (s: ExSlot) => void | false, label: string, key: string | null = null): Promise<void> {
    const l = this.list();
    const s = l.slots.get(this.sel);
    if (!s || fn(s) === false) return;
    await this.save(l, label, key);
  }

  // frames as columns: [set 0 frame, set 1 frame]
  private columns(s: ExSlot): number[][] {
    const n = s.framesLess1 + 1;
    return Array.from({ length: n }, (_, i) => (this.secondSet(s.trigger) ? [s.frames[i], s.frames[n + i]] : [s.frames[i]]));
  }
  private setColumns(s: ExSlot, cols: number[][]): void {
    s.framesLess1 = Math.max(0, cols.length - 1);
    s.frames = this.secondSet(s.trigger) ? [...cols.map((c) => c[0]), ...cols.map((c) => c[1] ?? c[0])] : cols.map((c) => c[0]);
  }

  private charWord(): number {
    return (this.shown().ppuRegs[0x0b] & 0x0f) << 12; // VRAM word address of layer 1/2 tile 000
  }
  private targetTile(s: ExSlot): number {
    return ((s.dest & 0x7fff) - this.charWord()) >> 4;
  }

  // palette the target tile is mostly drawn with in this level's Map16 tiles (on the submap: in its tilemaps)
  private rowFor(s: ExSlot): number {
    if (this.palRow >= 0) return this.palRow;
    const t = this.targetTile(s);
    const count = new Array(8).fill(0);
    if (this.ow) for (const w of this.mapWords()) { if ((w & 0x3ff) === t) count[(w >> 10) & 7]++; }
    else {
      const src = map16Source(this.app.rom, this.app.render);
      for (const m of new Set(this.app.images?.tiles1 ?? [])) for (const w of src.fg(m)) if ((w & 0x3ff) === t) count[(w >> 10) & 7]++;
    }
    const best = count.indexOf(Math.max(...count));
    return count[best] ? best : 2;
  }
  // the submap's layer 1 and 2 tilemaps after its load (8x8 tile entries, 64x64 each at BG1SC, BG2SC)
  private mapWords(): number[] {
    const r = this.shown(), out: number[] = [];
    for (const reg of [0x07, 0x08]) {
      const at = (r.ppuRegs[reg] & 0xfc) << 9, n = [0x400, 0x800, 0x800, 0x1000][r.ppuRegs[reg] & 3];
      for (let k = 0; k < n; k++) out.push(r.vram[(at + k * 2) & 0xffff] | (r.vram[(at + k * 2 + 1) & 0xffff] << 8));
    }
    return out;
  }

  // pixels of one 8x8 tile of a frame source (32 bytes): alternative file or RAM ($7E)
  private sourceBytes(s: ExSlot, word: number, tile: number): Uint8Array | null {
    const off = word + tile * 32;
    if (s.dest & ALT) {
      const f = this.altBytes;
      return f && off + 32 <= f.length ? f.subarray(off, off + 32) : null;
    }
    const w = this.shown().wram;
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
    const pal = cgramToRGBA(this.shown().cgram);
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
  // built from the ROM, watching what it read
  private build(): void {
    this.watch.run(() => this.buildAll());
  }
  private buildAll(): void {
    this.view = this.list();
    this.altBytes = animBytes(this.app.rom, this.view.altFile);
    this.buildBar();
    this.buildSlots();
    this.buildDetail();
    this.buildSide();
  }

  private buildBar(): void {
    const app = this.app, b = this.bar;
    clear(b);
    const scope = (g: boolean, label: string, title: string) => h('button', { class: this.global === g ? 'active' : '', title, onclick: () => { this.global = g; this.sel = 0; this.frame = 0; this.build(); } }, label);
    const m = this.t.at.submap;
    if (this.ow && m !== null) {
      b.append(h('span', { class: 'hint' }, 'List'), h('span', { class: 'btn-group' },
        scope(false, `Submap ${m}`, `Animations that run only on ${this.t.owner}`),
        scope(true, 'Overworld global', 'Animations that run on every submap (a submap can turn them off via “Play on submap …”)')));
      const key = `s${m}`;
      if (this.flagsLevel !== key) { this.flagsMenu = this.submapFlagsMenu(m, this.t.owner); this.flagsLevel = key; }
      b.append(h('span', { class: 'spacer' }), this.flagsMenu!);
      return;
    }
    b.append(h('span', { class: 'hint' }, 'List'), h('span', { class: 'btn-group' },
      scope(false, `Level ${hex(app.level.number, 3)}`, 'Animations that run only in this level'),
      scope(true, 'Global', 'Animations that run in all levels (a level can turn them off via “Play in level …”)')));
    const key = `l${app.level.number}`;
    if (this.flagsLevel !== key) { this.flagsMenu = this.levelFlagsMenu(); this.flagsLevel = key; }
    const n = app.levelTriggers().size;
    b.append(h('span', { class: 'spacer' }),
      h('button', { class: this.triggers ? 'active' : '', title: 'Switch the triggers of this level\'s animations for the preview and test play; their RAM and ASM', onclick: () => { this.triggers = !this.triggers; this.picking = null; this.build(); } }, `Triggers${n ? ` (${n})` : ''}`),
      this.flagsMenu!);
  }

  // the animation file all tile animations of the list take their frames from (one per list)
  private sourceSelect(l: ExList): HTMLElement {
    const app = this.app;
    const alt = h('select', { title: 'One animation graphic per list: changing it affects all tile animations of this list' },
      [0, 1, 2, 3].map((k) => h('option', { value: String(k), selected: l.altFile === k }, `${gfxName(ANIM_FILE + k)} (${lmAnimName(ANIM_FILE + k)})${hasGfx(app.rom, ANIM_FILE + k) ? '' : ' – empty'}`)));
    alt.addEventListener('change', () => { const nl = this.list(); nl.altFile = Number(alt.value); void this.save(nl, `Frames from ${gfxName(ANIM_FILE + nl.altFile)}`); });
    const n = [...l.slots.values()].filter((s) => kindOf(s.type) === 'tiles' && s.dest & ALT).length;
    // the graphic is shared: other lists animating from it change along when it is drawn on
    const u = altFileUsers(app.rom, l.altFile), self = this.ref();
    const others = [
      ...(u.global && self.kind !== 'global' ? ['the global list'] : []),
      ...u.levels.filter((x) => self.kind !== 'level' || x !== self.n).map((x) => `level ${hex(x, 3)}`),
      ...(u.owGlobal && self.kind !== 'owGlobal' ? ['the overworld\'s global list'] : []),
      ...u.submaps.filter((x) => self.kind !== 'submap' || x !== self.n).map((x) => `submap ${x}`),
    ];
    return h('div', { class: 'at-source' }, h('div', { class: 'row' }, h('span', { class: 'hint' }, 'Frames from'), alt),
      h('div', { class: 'hint' }, n > 1 ? `applies to all ${n} tile animations of this list` : 'applies to all tile animations of this list'),
      others.length ? h('div', { class: 'hint', title: others.join(', ') }, `Also used by ${others.slice(0, 3).join(', ')}${others.length > 3 ? ` and ${others.length - 3} more` : ''} – drawing on it changes their animations too`) : '');
  }

  // which animations play in the current level (always the level's settings, also in "Global"); kept across
  // rebuilds so the open menu stays open while toggling
  private flagsMenu: HTMLElement | null = null;
  private flagsLevel = '';
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
  // which animations play on submap m (Lunar Magic's overworld animation settings): a setting of the submap
  private submapFlagsMenu(m: number, name: string): HTMLElement {
    const app = this.app;
    const flag = (bit: number, label: string, title: string): MenuItem => ({
      label, title,
      checked: () => !(submapAnimSettings(app.rom, m) & bit),
      onToggle: async (on) => {
        const st = submapAnimSettings(app.rom, m);
        app.romEdit(`Submap ${m}: ${label} ${on ? 'on' : 'off'}`, () => setSubmapAnimSettings(app.rom, m, on ? st & ~bit : st | bit));
      },
    });
    return menuButton({ label: `Play on submap ${m}`, title: `Which animations run on ${name} (a setting of the submap, also for “Overworld global”; the Trigger Init is set either way)`, items: [
      { heading: 'Game' },
      flag(NO_GAME_TILES, 'Original tile animation', 'The game\'s animated tiles of the overworld (water, waves …)'),
      flag(NO_DOT_COLORS, 'Level dot colors', 'The game\'s flashing of colors 6·D and 7·D (the level dots)'),
      {
        label: 'Lightning', title: 'The game\'s lightning flashes of color 4·7 (in the game on the Valley of Bowser only)',
        checked: () => submapLightning(app.rom, m),
        onToggle: async (on) => { app.romEdit(`Submap ${m}: Lightning ${on ? 'on' : 'off'}`, () => setSubmapLightning(app.rom, m, on)); },
      },
      { heading: 'Own' },
      flag(NO_LEVEL_LIST, 'Submap animations', 'This submap\'s own animations'),
      flag(NO_GLOBAL_LIST, 'Overworld global animations', 'The overworld\'s global animations'),
    ] });
  }

  private buildSlots(): void {
    const box = this.slotsBox;
    clear(box);
    this.previews = [];
    const l = this.list();
    box.append(h('div', { class: 'panel-title' }, this.global ? (this.ow ? 'Overworld global animations' : 'Global animations') : `Animations of ${this.own}`, h('span', { class: 'hint' }, `${l.slots.size} of ${SLOTS}`)));
    if (!this.t.levelPreview && !this.ws.preview.submapRender()) box.append(h('p', { class: 'hint' }, `${this.t.owner} is loaded in the emulator …`));
    box.append(this.sourceSelect(l));
    for (const p of triggerProblems(readList(this.app.rom, this.ref(false)), readList(this.app.rom, this.ref(true)), this.ow)) {
      box.append(h('div', { class: 'warn-box' }, p.text, ' ', p.slots.map((r, i) => h('span', null, i ? ', ' : '', h('a', { href: '#', onclick: (e: Event) => { e.preventDefault(); this.select(r.global, r.slot); } }, slotName(r, this.ow))))));
    }
    const items = h('div', { class: 'at-slot-list' });
    for (const [n, s] of [...l.slots.entries()].sort((a, b) => a[0] - b[0])) {
      const c = h('canvas', { class: 'at-mini' });
      this.previews.push({ c, slot: n });
      const kind = kindOf(s.type);
      const pick = () => { this.sel = n; this.frame = 0; this.set = 0; };
      items.append(h('div', { class: `at-slot${n === this.sel ? ' sel' : ''}`, onclick: () => { pick(); this.build(); } },
        h('span', { class: 'mono hint' }, hex(n, 2)), c,
        h('div', { class: 'at-slot-text' },
          h('div', null, kind === 'tiles' ? `Tile ${hex(this.targetTile(s), 3)} · ${TYPE_NAMES[s.type] ?? ''}` : kind === 'colors' ? `Color ${hex(s.dest & 0xff, 2)} · ${TYPE_NAMES[s.type]}` : `Colors ${rangeName(s)} · ${TYPE_NAMES[s.type] ?? ''}`),
          h('div', { class: 'hint' }, kind === 'rotation' ? `${this.triggerName(s.trigger)} · ${speedName(s.framesLess1 + 1)}` : `${this.triggerName(s.trigger)} · ${s.framesLess1 + 1} frame${s.framesLess1 ? 's' : ''}`)),
        h('span', { class: 'at-slot-acts' },
          h('button', { class: 'icon-btn', title: 'Duplicate (into the next free slot)', 'aria-label': 'Duplicate', onclick: (e: Event) => { e.stopPropagation(); pick(); void this.duplicate(); } }, '⧉'),
          h('button', { class: 'icon-btn', title: 'Delete (Ctrl+Z brings it back)', 'aria-label': 'Delete', onclick: (e: Event) => { e.stopPropagation(); pick(); void this.remove(); } }, '✕'))));
    }
    if (!l.slots.size) items.append(h('p', { class: 'hint' }, 'No animations yet. A tile animation keeps replacing 8x8 tiles in VRAM with frames from an animation graphic – all Map16 tiles that use them animate along.'));
    const noSlot = l.slots.size >= SLOTS;
    box.append(items,
      h('div', { class: 'row at-slot-bar' },
        menuButton({ label: '+ New', title: noSlot ? 'All 32 slots are in use' : 'A new animation in the next free slot', items: [
          { label: 'Tile animation', title: '8x8 tiles in VRAM replaced by frames of the animation graphic', onClick: () => void this.add('tiles') },
          { label: 'Color animation', title: 'A palette color set to the colors of its frames', onClick: () => void this.add('colors') },
          { label: 'Color rotation', title: 'Colors of the palette that move along by one, again and again', onClick: () => void this.add('rotation') },
        ] }),
        h('span', { class: 'spacer' }),
        menuButton({ label: 'List', title: 'Tools for the whole list', items: [
          { label: 'Remap tile animations …', title: 'Change the frames and targets of tile animations by an offset or a list (Lunar Magic\'s Remap)',
            disabled: () => ![...this.list().slots.values()].some((x) => kindOf(x.type) === 'tiles'), onClick: () => this.openRemap() },
          { label: 'Trigger Init …', title: this.ow ? 'Custom triggers, manual frames and the event triggers\' events set when the submap loads (Lunar Magic\'s Trigger Init)' : 'Custom triggers and manual frames set when the level loads (Lunar Magic\'s Trigger Init)', onClick: () => this.openTriggerInit() },
        ] })));
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
      if (!hasGfx(this.app.rom, ANIM_FILE + l.altFile)) {
        this.app.romEdit(`${gfxName(ANIM_FILE + l.altFile)} created`, () => createGfx(this.app.rom, ANIM_FILE + l.altFile));
      }
      l.slots.set(n, { type: 0x01, trigger: 0, framesLess1: 1, dest: ALT | (this.charWord() + 0x60 * 16), frames: [0x00, 0x20] });
    } else if (kind === 'colors') {
      l.slots.set(n, { type: 0x14, trigger: 0, framesLess1: 1, dest: 0x21, frames: [0x001f, 0x7c00] });
    } else {
      const e: ExSlot = { type: 0x18, trigger: 0, framesLess1: 0, dest: 0, frames: [] };
      setRotationRange(e, 0x21, 4);
      l.slots.set(n, e);
    }
    this.palRows.delete(this.palKey(n));
    this.sel = n;
    this.frame = 0;
    this.triggerOn = false;
    await this.save(l, kind === 'tiles' ? 'new tile animation' : kind === 'colors' ? 'new color animation' : 'new color rotation');
  }
  private async duplicate(): Promise<void> {
    const l = this.list();
    const s = l.slots.get(this.sel);
    const n = this.freeSlot(l);
    if (!s) return;
    if (n < 0) { toast('All 32 slots are in use'); return; }
    l.slots.set(n, { ...s, frames: s.frames.slice() });
    const row = this.palRow;
    this.sel = n;
    this.palRow = row;
    await this.save(l, `Slot ${hex(n, 2)} duplicated`);
  }
  // Lunar Magic's ExAnimation Remap: the chosen tile slots' frames (tiles of the animation graphic) and
  // targets (VRAM tiles) by the same list as the Map16 remap; one undo step
  private openRemap(): void {
    const l = this.list();
    const tileSlots = [...l.slots.entries()].filter(([, x]) => kindOf(x.type) === 'tiles').sort((a, b) => a[0] - b[0]);
    const chosen = new Set(tileSlots.some(([n]) => n === this.sel) ? [this.sel] : tileSlots.map(([n]) => n));
    const what = { frames: true, target: true };
    const file = animBytes(this.app.rom, l.altFile);
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
    modal(`Remap ${this.listName()} tile animations`, body, [
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

  // Lunar Magic's Trigger Init: the custom triggers and manual frames this list sets when the level loads
  // (the global list's first, the level's over them); one undo step. On the overworld manual 8–F are the event
  // triggers' events.
  private openTriggerInit(): void {
    const draft = this.list(), ow = this.ow, where = ow ? 'submap' : 'level';
    const g = this.global ? null : readList(this.app.rom, this.ref(true));
    const custom = h('div', { class: 'ti-grid' }, Array.from({ length: 16 }, (_, n) => {
      const sel = h('select', { title: `${this.triggerName(0x20 + n)}: as it is (keep), or on / off when the ${where} loads` },
        (['keep', 'on', 'off'] as CustomInit[]).map((v) => h('option', { value: v, selected: customInit(draft, n) === v }, v === 'keep' ? (this.global ? 'keep' : `keep${g && customInit(g, n) !== 'keep' ? ` (global: ${customInit(g, n)})` : ''}`) : v)));
      sel.addEventListener('change', () => setCustomInit(draft, n, sel.value as CustomInit));
      return h('label', { class: 'ti-cell' }, h('span', { class: 'mono' }, `Custom ${hex(n, 1)}`), sel);
    }));
    const manual = h('div', { class: 'ti-grid' }, Array.from({ length: 16 }, (_, n) => {
      const cur = draft.manual.get(n), event = ow && n >= 8;
      const frame = hexInput(cur === undefined || cur === 0xff ? 0 : cur, 2, (f) => { draft.manual.set(n, f); on.checked = true; }, event ? OW_EVENTS - 1 : 0xfe);
      const on = h('input', { type: 'checkbox', checked: cur !== undefined, title: event ? `Set the event of ${this.triggerName(n - 7)} when the submap loads` : `Set the frame when the ${where} loads` });
      on.addEventListener('change', () => { if (on.checked) draft.manual.set(n, Number.parseInt(frame.value, 16) || 0); else draft.manual.delete(n); });
      const gf = g?.manual.get(n);
      return h('label', { class: 'ti-cell', title: gf !== undefined ? `The global list sets ${event ? 'event' : 'frame'} ${hex(gf, 2)}` : '' }, on, h('span', { class: 'mono' }, event ? `Event ${hex(n, 1)}` : `Manual ${hex(n, 1)}`), frame,
        cur === 0xff && !event ? h('span', { class: 'warn-box' }, 'was FF') : '', gf !== undefined && !this.global ? h('span', { class: 'hint' }, `global ${hex(gf, 2)}`) : '');
    }));
    const body = h('div', { class: 'ti' },
      h('p', { class: 'hint' }, ow
        ? (this.global ? 'Set on every submap when it loads (also when Mario walks there); a submap\'s own Trigger Init overrides these.' : 'Set when this submap loads (also when Mario walks there), over the overworld global list\'s. Also when the submap\'s animations are turned off.')
        : this.global ? 'Set in every level when it loads; a level\'s own Trigger Init overrides these.' : 'Set when this level loads, over the global list\'s (shown where it sets one). Also when the level\'s animations are turned off.'),
      h('div', { class: 'panel-title' }, 'Custom triggers', h('span', { class: 'hint' }, ow ? 'keep: as before the submap' : 'keep: as before the level (the last level left it)')), custom,
      h('div', { class: 'panel-title' }, ow ? 'Manual frames and events' : 'Manual frames', h('span', { class: 'hint' }, ow ? `0–7: the frame, 00–FE; 8–F: the event numbers of Event Manual 8–F, 00–${hex(OW_EVENTS - 1, 2)}` : '00–FE; FF is the engine\'s “nothing shown yet”')), manual);
    modal(`Trigger Init – ${this.listName()}`, body, [
      { label: 'Apply', primary: true, onClick: () => { void this.save(draft, 'Trigger Init'); } },
      { label: 'Cancel' },
    ]);
  }

  private async remove(): Promise<void> {
    const l = this.list();
    if (!l.slots.delete(this.sel)) return;
    this.palRow = -1;
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
    const ow = this.ow;
    const trig = triggerSelect(kind!, s.trigger, ow);
    trig.addEventListener('change', () => void this.editSlot((x) => {
      if (kind === 'rotation') { x.trigger = Number(trig.value); return; } // no frames
      const cols = this.columns(x);
      x.trigger = Number(trig.value);
      const max = maxFrames(x.trigger, ow);
      if (cols.length > max) { cols.length = max; toast(`${this.triggerName(x.trigger)}: at most ${max} frames – the last ones left out`); }
      this.setColumns(x, cols);
    }, `Trigger ${this.triggerName(Number(trig.value))}`));
    const ram = triggerRam(s.trigger, ow), hint = triggerHint(s.trigger, kind === 'rotation', ow);
    const trigger = [
      h('div', { class: 'prop' }, h('label', null, 'Trigger'), trig),
      hint ? h('p', { class: 'hint' }, hint) : '',
      ram?.asm ? h('div', { class: 'tp-asm' }, h('code', { class: 'mono', title: `${ram.ram}: ${ram.what}` }, ram.asm),
        ow ? '' : h('a', { href: '#', title: 'Switch it in the preview; RAM and ASM of all triggers', onclick: (e: Event) => { e.preventDefault(); this.triggers = true; this.picking = null; this.build(); } }, 'Triggers')) : '',
      this.secondSet(s.trigger) && kind !== 'rotation' ? h('p', { class: 'hint' }, `Two frame sequences: top normally, bottom while “${this.secondSetName(s.trigger)}”.`) : '',
    ];
    d.append(
      h('div', { class: 'prop-title' }, `Slot ${hex(this.sel, 2)}`, h('span', { class: 'hint' }, ` · ${this.listName()}`)),
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
    if (this.ow) {
      const layers = colors.filter((c) => c < 0x80), set = new Set(layers.map((c) => c >> 4));
      const n = this.mapWords().filter((w) => set.has((w >> 10) & 7)).length;
      return h('div', { class: 'at-users' }, layers.length ? h('div', { class: 'hint' }, n ? `Palette rows ${[...set].join(', ')}: ${n} tiles of the map's layers 1 and 2 are drawn with ${set.size === 1 ? 'it' : 'them'}.` : `No tile of the map's layers 1 and 2 is drawn with ${layers.length === 1 ? 'this color\'s row' : 'these colors\' rows'}.`) : '',
        layers.length < colors.length ? h('div', { class: 'hint' }, 'Colors of rows 8–F show on sprites that use them.') : '');
    }
    const layers = colors.filter((c) => c < 0x80), sprites = colors.length - layers.length;
    const u = im && layers.length ? levelColorUsers(app.rom, app.render, im, new Set(layers)) : { layer1: [], layer2: [], bg: [] };
    pv.highlight = new Set(u.layer1);
    pv.highlight2 = new Set(u.layer2);
    pv.highlightBg = new Set(u.bg);
    pv.drawHighlight();
    const links = (label: string, tiles: number[], bg: boolean) => tiles.length
      ? h('div', { class: 'gt-users' }, h('span', { class: 'hint' }, label), tiles.slice(0, 24).map((m) => h('a', { href: '#', class: 'mono', title: 'Open in the Map16 tab', onclick: (e: Event) => { e.preventDefault(); this.ws.showMap16(m, bg ? 'bg' : 'fg'); } }, hex(m, 3))), tiles.length > 24 ? h('span', { class: 'hint' }, `… (${tiles.length})`) : '')
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
      : reversible ? `Runs always and turns the other way while “${this.secondSetName(s.trigger)}”.` : `Runs only while “${this.secondSetName(s.trigger)}” – otherwise the colors stay.`));
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
      s.trigger ? h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: this.triggerOn, onchange: (e: Event) => { this.triggerOn = (e.target as HTMLInputElement).checked; this.buildDetail(); } }), `Preview while “${this.secondSetName(s.trigger)}”`) : '',
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
    if (this.ow) return null; // (learned in the emulated level only)
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
    const pal = cgramToRGBA(this.shown().cgram);
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

  // Map16 tiles that use one of the slot's target tiles (they animate with it; none on a submap)
  private targetUsers(s: ExSlot, limit = 64): number[] {
    if (this.ow) return [];
    const tiles = new Set(this.targetTiles(s));
    const src = map16Source(this.app.rom, this.app.render);
    const users: number[] = [];
    for (let m = 0; m < EXT_TILES && users.length < limit; m++) if (src.fg(m).some((w) => tiles.has(w & 0x3ff))) users.push(m);
    return users;
  }

  // on a submap: how often its layers 1 and 2 draw the target's tiles after its load
  private mapUse(s: ExSlot): HTMLElement {
    const tiles = new Set(this.targetTiles(s)), n = this.mapWords().filter((w) => tiles.has(w & 0x3ff)).length;
    return h('div', { class: 'hint' }, n ? `The map's layers 1 and 2 show this target ${n} time${n > 1 ? 's' : ''}.` : 'No tile of the map\'s layers 1 and 2 shows this target – the animation is not visible on the map.');
  }

  private tileDetail(d: HTMLElement, s: ExSlot, trigger: (HTMLElement | string)[]): void {
    const t = this.targetTile(s);
    const shape = shapeOf(s.type);
    const slot = slotOfTile(this.gfxSlots(), t);
    const users = this.targetUsers(s);
    // places in the level: marked in the preview
    this.ws.preview.highlight = new Set(users);
    this.ws.preview.drawHighlight();
    d.append(
      h('div', { class: 'panel-title at-step' }, '1 · Target', h('span', { class: 'hint' }, 'which 8x8 tiles are replaced')),
      h('div', { class: 'prop' }, h('label', null, 'Target'),
        h('span', { class: 'mono' }, `8x8 tile ${hex(t, 3)}`), slot ? h('span', { class: 'hint' }, ` ${slot.name}`) : '',
        h('button', { class: this.picking === 'target' ? 'active' : '', title: this.t.levelPreview ? 'Click in the VRAM grid on the right or in the level preview' : 'Click in the VRAM grid on the right', onclick: () => { this.picking = this.picking ? null : 'target'; this.triggers = false; this.buildSide(); this.buildDetail(); } }, 'Choose target')),
      h('div', { class: 'hint' }, `${shape.w}×${shape.h} tiles`, slot ? h('span', null, ' · ', h('a', { href: '#', title: `Open ${gfxName(slot.file)} in the Graphics tab`, onclick: (e: Event) => { e.preventDefault(); this.ws.showGfx(slot.file, t - slot.first); } }, `view in ${gfxName(slot.file)}`)) : ''),
      this.ow ? this.mapUse(s)
        : users.length
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
    const sets = this.secondSet(s.trigger) ? 2 : 1;
    const strip = h('div', { class: 'at-frames' });
    for (let set = 0; set < sets; set++) {
      const row = h('div', { class: 'at-frame-row' }, sets > 1 ? h('span', { class: 'hint at-set-label' }, set ? this.secondSetName(s.trigger) : 'normal') : '');
      cols.forEach((c, i) => {
        const cv = h('canvas', { class: 'at-frame-img' });
        this.drawFrame(cv, s, c[set]);
        row.append(h('div', { class: `at-frame${i === this.frame && set === this.set ? ' sel' : ''}`, title: `Frame ${i + 1}: ${s.dest & ALT ? `tile ${hex(c[set] >> 5, 3)} of the animation graphic` : `RAM $7E${hex(c[set], 4)}`}`,
          onclick: () => { this.frame = i; this.set = set; this.triggers = false; this.buildDetail(); this.buildSide(); } }, cv, h('span', { class: 'hint mono' }, s.dest & ALT ? hex(c[set] >> 5, 2) : '$' + hex(c[set], 4))));
      });
      strip.append(row);
    }
    const step = shape.w * shape.h * 32;
    d.append(strip,
      h('div', { class: 'row' },
        h('button', { title: 'New frame after the selected one (next tiles of the graphic)', onclick: () => void this.editSlot((x) => {
          const cs = this.columns(x);
          if (full(x, cs, this.ow)) return false;
          cs.splice(this.frame + 1, 0, cs[this.frame].map((v) => v + step));
          this.setColumns(x, cs);
          this.frame++;
        }, 'Frame added') }, '+ Frame'),
        h('button', { title: 'Selected frame once more (shows it twice as long)', onclick: () => void this.editSlot((x) => {
          const cs = this.columns(x);
          if (full(x, cs, this.ow)) return false;
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
        h('button', { class: this.picking === 'target' ? 'active' : '', onclick: () => { this.picking = this.picking ? null : 'target'; this.triggers = false; this.buildSide(); this.buildDetail(); } }, 'Choose color')));
      d.append(this.colorUsers(Array.from({ length: Math.min(count, 256 - c) }, (_, i) => c + i)));
    } else d.append(h('div', { class: 'hint' }, 'Shows wherever no layer draws (the back area).'));
    if (count > 1) { d.append(h('p', { class: 'hint' }, `This animation sets ${count} colors at once (from data) – not editable here yet.`)); return; }
    const cols = this.columns(s);
    const sets = this.secondSet(s.trigger) ? 2 : 1;
    const strip = h('div', { class: 'at-frames' });
    for (let set = 0; set < sets; set++) {
      const row = h('div', { class: 'at-frame-row' }, sets > 1 ? h('span', { class: 'hint at-set-label' }, set ? this.secondSetName(s.trigger) : 'normal') : '');
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
        h('button', { onclick: () => void this.editSlot((x) => { const cs = this.columns(x); if (full(x, cs, this.ow)) return false; cs.splice(this.frame + 1, 0, cs[this.frame].slice()); this.setColumns(x, cs); this.frame++; }, 'Frame added') }, '+ Frame'),
        h('button', { disabled: cols.length < 2, onclick: () => void this.editSlot((x) => { const cs = this.columns(x); cs.splice(this.frame, 1); this.setColumns(x, cs); this.frame = Math.max(0, this.frame - 1); }, 'Frame removed') }, 'Remove')),
      h('p', { class: 'hint' }, 'Each frame shows for 8 game frames (≈0.13 s). The same color twice in a row shows it longer.'));
  }

  // right: the source sheet (frame pick) or the target pick
  private buildSide(): void {
    const box = this.side;
    clear(box);
    const s = this.slot();
    if (this.ow && !s) { box.append(h('p', { class: 'hint' }, 'The overworld\'s triggers are its events (Event Manual 8–F, their numbers in the list\'s Trigger Init) and those your code sets.')); return; }
    if (this.triggers || !s) {
      box.append(triggerPanel(this.app, (r: SlotRef) => this.select(r.global, r.slot)));
      return;
    }
    const kind = kindOf(s.type);
    if (kind === 'colors') {
      if (this.picking !== 'target') { box.append(h('p', { class: 'hint' }, 'Use “Choose color” to set the palette color that is animated.')); return; }
      const pal = cgramToRGBA(this.shown().cgram);
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
    if (this.palRow >= 0 && !this.ow) this.paletteMismatch(box, s, row);
    if (this.picking === 'target') { this.targetPicker(box, s, row); return; }
    this.sourcePicker(box, s, row);
  }

  // the Map16 tiles placed in the level (layer 1, layer 2 objects)
  private placedTiles(): Set<number> {
    const im = this.app.images;
    return new Set([...(im?.tiles1 ?? []), ...(im?.tiles2 ?? [])]);
  }
  // Map16 tiles showing the slot's target in another palette than `row`, with the palettes they show it in
  private offPalette(s: ExSlot, row: number): { tile: number; pals: number[] }[] {
    const targets = new Set(this.targetTiles(s)), src = map16Source(this.app.rom, this.app.render);
    const out: { tile: number; pals: number[] }[] = [];
    for (let tile = 0; tile < EXT_TILES; tile++) {
      const words = src.fg(tile);
      if (paletteOn(words, targets, row)) out.push({ tile, pals: [...new Set(words.filter((w) => targets.has(w & 0x3ff)).map((w) => (w >> 10) & 7))].sort() });
    }
    return out;
  }

  // a palette chosen for the previews that Map16 tiles do not draw the target in: said so, and offered
  // to give them (never done by itself: the palette is the view's, the Map16 tiles are every level's)
  private paletteMismatch(box: HTMLElement, s: ExSlot, row: number): void {
    const off = this.offPalette(s, row);
    if (!off.length) return;
    const placed = this.placedTiles(), here = off.filter((o) => placed.has(o.tile));
    const name = (o: { tile: number; pals: number[] }) => `${hex(o.tile, 3)} (palette ${o.pals.join(', ')})`;
    const shown = here.length ? here : off;
    box.append(h('div', { class: 'at-palfix' },
      h('span', { class: 'hint' }, here.length
        ? `${here.length === 1 ? 'Map16 tile' : `${here.length} Map16 tiles`} of this level show${here.length === 1 ? 's' : ''} the target in another palette: ${shown.slice(0, 6).map(name).join(', ')}${shown.length > 6 ? ' …' : ''}`
        : `In this level every Map16 tile shows the target in this palette; ${off.length === 1 ? 'one tile not placed here does not' : `${off.length} tiles not placed here do not`}: ${shown.slice(0, 6).map(name).join(', ')}${shown.length > 6 ? ' …' : ''}`),
      h('button', { title: 'Choose the Map16 tiles whose quarters showing the target take this palette', onclick: () => this.openApplyPalette(s, row) }, `Apply palette ${row} …`)));
  }

  // the chosen Map16 tiles' quarters that show the target take palette `row`: one undo step
  private openApplyPalette(s: ExSlot, row: number): void {
    const app = this.app, off = this.offPalette(s, row), placed = this.placedTiles();
    const targets = new Set(this.targetTiles(s));
    // (the open level counts by its placed tiles: not as still looked through)
    const { levels, pending: all, open } = app.levelTiles(), pending = all - (open === 'pending' ? 1 : 0);
    // the tiles of this level first; when none is placed here, the user asks for the others
    const anyHere = off.some((o) => placed.has(o.tile));
    const chosen = new Set(off.filter((o) => !anyHere || placed.has(o.tile)).map((o) => o.tile));
    const where = (t: number) => {
      const lv = fgTileUsers(levels, t, app.tilesetsOf(t)).map((u) => u.level).filter((n) => n !== app.level.number);
      const here = placed.has(t) ? 'this level' : '';
      const others = lv.length ? `${lv.length === 1 ? 'level' : 'levels'} ${lv.slice(0, 4).map((n) => hex(n, 3)).join(', ')}${lv.length > 4 ? ` and ${lv.length - 4} more` : ''}` : '';
      return [here, others].filter(Boolean).join(', also ') || 'placed in no level';
    };
    const body = h('div', { class: 'at-palapply' },
      h('p', { class: 'hint' }, `The quarters showing 8x8 tile${targets.size > 1 ? 's' : ''} ${[...targets].slice(0, 4).map((t) => hex(t, 3)).join(', ')}${targets.size > 4 ? ' …' : ''} take palette ${row}; the other quarters stay. Map16 tiles are shared: the change shows in every level placing them.`),
      h('table', { class: 'at-remap-table' },
        h('tr', null, h('th', null, ''), h('th', null, 'Map16'), h('th', null, 'Palette'), h('th', null, 'Placed in')),
        off.map((o) => h('tr', null,
          h('td', null, h('input', { type: 'checkbox', checked: chosen.has(o.tile), onchange: (e: Event) => { if ((e.target as HTMLInputElement).checked) chosen.add(o.tile); else chosen.delete(o.tile); } })),
          h('td', { class: 'mono' }, hex(o.tile, 3)),
          h('td', { class: 'mono' }, `${o.pals.join(', ')} → ${row}`),
          h('td', { class: 'hint' }, where(o.tile))))),
      pending ? h('p', { class: 'hint' }, `${pending} more level${pending > 1 ? 's are' : ' is'} still being looked through – they may place these tiles too.`) : '');
    modal(`Palette ${row} for animation ${hex(this.sel, 2)}`, body, [
      { label: 'Apply', primary: true, onClick: () => {
        if (!chosen.size) { toast('No Map16 tile chosen'); return false; }
        const src = map16Source(app.rom, app.render);
        const tiles = off.map((o) => o.tile).filter((t) => chosen.has(t));
        try {
          app.romEdit(`${tiles.length === 1 ? `FG tile ${hex(tiles[0], 3)}` : `${tiles.length} FG tiles`}: palette ${row} (animation ${hex(this.sel, 2)})`, () => {
            for (const t of tiles) { const w = paletteOn(src.fg(t), targets, row); if (w) setFgWords(app.rom, app.render, t, w); }
          });
        } catch (e) { toast(String(e instanceof Error ? e.message : e), 'error'); }
      } },
      { label: 'Cancel' },
    ]);
  }

  private sheet(tiles: number, get: (t: number) => Uint8Array | null, row: number, Z = 3): HTMLCanvasElement {
    const rowsN = Math.ceil(tiles / 16);
    const c = h('canvas', { width: 128 * Z, height: rowsN * 8 * Z, class: 'at-sheet' });
    const off = document.createElement('canvas');
    off.width = 128; off.height = rowsN * 8;
    const octx = off.getContext('2d')!;
    const img = octx.createImageData(128, rowsN * 8);
    const px = new Uint32Array(img.data.buffer);
    const pal = cgramToRGBA(this.shown().cgram);
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
    const file = animBytes(this.app.rom, l.altFile);
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
      h('div', { class: 'hint' }, `Click the source for frame ${this.frame + 1}${this.secondSet(s.trigger) ? ` (${this.set ? this.secondSetName(s.trigger) : 'normal'})` : ''}`),
      h('div', { class: 'at-sheet-scroll' }, c));
  }

  // the selected RAM slot's frames (as the level's WRAM has them after its load, the submap's) into the list's graphic
  private async copyRamFrames(): Promise<void> {
    const app = this.app, l = this.list(), s = l.slots.get(this.sel), ref = this.ref(), wram = this.shown().wram;
    if (!s) return;
    try {
      app.romEdit(`Slot ${hex(this.sel, 2)}: frames copied into ${gfxName(ANIM_FILE + l.altFile)}`, () => {
        const r = localizeFrames(app.rom, [s], { ram: wram }, l.altFile, true);
        if (!r.slots[0]) throw new Error(r.notes.join(' '));
        l.slots.set(this.sel, r.slots[0]);
        writeList(app.rom, ref, l);
      });
    } catch (e) { toast(String(e instanceof Error ? e.message : e), 'error'); }
  }

  private async createAltFile(k: number): Promise<void> {
    try { this.app.romEdit(`${gfxName(ANIM_FILE + k)} created`, () => createGfx(this.app.rom, ANIM_FILE + k)); }
    catch (e) { toast(String(e instanceof Error ? e.message : e), 'error'); }
  }

  private targetPicker(box: HTMLElement, s: ExSlot, row: number): void {
    const app = this.app;
    const base = this.charWord() * 2;
    const vram = this.shown().vram;
    const slots = layerSlots(this.gfxSlots());
    const shape = shapeOf(s.type);
    box.append(h('div', { class: 'panel-title' }, 'Choose target in VRAM'), h('div', { class: 'hint' }, `Click a tile (top left of the ${shape.w}×${shape.h} tiles).${this.ow ? '' : ' A click into the level preview works too.'}`));
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
    if (!s || !this.t.levelPreview) return;
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
    const { first, count } = rotationRange(s), cg = this.shown().cgram;
    const c = Array.from({ length: Math.min(count, 256 - first) }, (_, i) => cg[(first + i) * 2] | (cg[(first + i) * 2 + 1] << 8));
    return dir ? rotated(c, dir, Math.floor(this.tick / (s.framesLess1 + 1))) : c;
  }

  key(e: KeyboardEvent): boolean {
    if (e.key === 'Delete' && this.slot()) { void this.remove(); return true; }
    if (e.key === 'Escape' && this.picking) { this.picking = null; this.build(); return true; }
    return false;
  }
}
