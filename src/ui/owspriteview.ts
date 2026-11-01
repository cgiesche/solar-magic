// The overworld's sprites on the map (the overworld view's "Sprites" mode, as the level editor's sprites: select,
// drag, properties): the 13 sprite slots drawn as the game shows them at the map and event progress (learned by
// emulation, owsprites.ts; a slot the game doesn't show there is a dashed box), Mario's and Luigi's start positions
// and where the Koopa Kids jump out. Dragging moves a sprite or where a Koopa Kid jumps out in 8px steps on the map's
// grid (1px with Shift), a start position by tiles; a click without a drag selects the next thing under the mouse
// (Luigi's start under Mario's). Each change is one ROM edit.
// Custom sprites (BOWSIE's, in Lunar Magic's table: owcustom.ts) of the submaps shown, drawn by emulation as well:
// placed from the palette of the installed ones (a click on the map), moved in 8px steps (to another submap by
// dragging them there), copied (Ctrl+C / Ctrl+V at the mouse, Ctrl+D), deleted; their sprite, height and extra bytes in
// the properties. With BOWSIE installed the game's sprite slots are gone (its loader is where their table was).

import type { OverworldView } from './overworld.ts';
import { h, select, hexInput, emptyState } from './dom.ts';
import { thumbCanvas } from './thumbs.ts';
import {
  readOwSprites, writeOwSprite, readStart, writeStart, koopaKidPos, setKoopaKidPos, OW_SPRITE_NAMES, OW_SPRITE_SLOTS, KOOPA_KIDS,
  type OwSpriteView,
} from '../core/owsprites.ts';
import { KOOPA_TILE } from '../core/owlinks.ts';
import { l1Index, MAP_NAMES } from '../core/overworld.ts';
import { hex } from '../core/names.ts';
import { toast } from './dom.ts';
import { hasOwSpriteSlots } from '../core/owsprites.ts';
import {
  readCustomSprites, writeCustomSprites, customSpritesProblem, customSizeTable, customExtraBytes, bowsieInstalled,
  OW_CUSTOM_POS_MAX, OW_CUSTOM_Z_MAX, type CustomOwSprite,
} from '../core/owcustom.ts';
import { loadBowsieProject, bowsieSprites, type BowsieSpriteInfo } from '../core/bowsie.ts';
import type { SpriteImage } from '../core/spritegfx.ts';

// what is selected or dragged: a sprite slot, a player's start, where a Koopa Kid jumps out
// (custom: entry k of submap map's list)
type Item = { kind: 'sprite'; k: number } | { kind: 'start'; player: number } | { kind: 'koopa'; k: number } | { kind: 'custom'; map: number; k: number };
type Drag = { item: Item; x0: number; y0: number; dx: number; dy: number };
const PLAYERS = ['Mario', 'Luigi'];
const NONE_SHOWN = { views: Array.from({ length: OW_SPRITE_SLOTS }, (): OwSpriteView => ({ image: null, z: 0 })), canvases: [] as (HTMLCanvasElement | null)[] };
const same = (a: Item | null, b: Item) => !!a && a.kind === b.kind && (a.kind === 'start' ? a.player === (b as typeof a).player
  : (a as { k: number }).k === (b as { k: number }).k && (a.kind !== 'custom' || a.map === (b as typeof a).map));
type Shown = { views: OwSpriteView[]; canvases: (HTMLCanvasElement | null)[] };

export class SpriteLayer {
  sel: Item | null = null;
  drag: Drag | null = null;
  showShadows = false; // a shadow on the ground under each sprite
  showHeights = true; // a line from a sprite's position up to it at its height
  private clicked = false; // the last mouse press was a click on the selection (the next one cycles)
  private views: { views: OwSpriteView[]; canvases: (HTMLCanvasElement | null)[] } | null = null;
  private custom = new Map<number, Shown>(); // per submap: its custom sprites as shown last
  private looks: { ids: string; images: (SpriteImage | null)[]; canvases: (HTMLCanvasElement | null)[] } | null = null;
  picked: number | null = null; // the custom sprite a click on the map places (palette)
  private clip: CustomOwSprite | null = null; // a copied custom sprite
  constructor(private view: OverworldView) {}

  private get rom() { return this.view.app.rom; }
  // the slots as the game shows them on the map at the event progress (emulated in the probe worker again when the map,
  // the progress or a ROM byte they read changes); while that runs the ones shown last (none at first: dashed boxes)
  private shown(): NonNullable<SpriteLayer['views']> {
    const views = this.view.owSprites();
    if (views && this.views?.views !== views) this.views = { views, canvases: views.map((v) => (v.image ? thumbCanvas({ w: v.image.w, h: v.image.h, px: v.image.rgba }) : null)) };
    return this.views ?? NONE_SHOWN;
  }
  // an item's box on the map (pixels), with a drag's offset
  private box(it: Item): { x: number; y: number; w: number; h: number } | null {
    const d = this.drag && same(this.drag.item, it) ? this.drag : null, dx = d?.dx ?? 0, dy = d?.dy ?? 0;
    if (it.kind === 'start') {
      const s = readStart(this.rom, it.player);
      return (s.submap ? 1 : 0) === this.view.region ? { x: s.x * 16 + dx, y: s.y * 16 + dy, w: 16, h: 16 } : null;
    }
    if (it.kind === 'koopa') {
      if (!this.koopaShown(it.k)) return null;
      const p = koopaKidPos(this.rom, it.k);
      return { x: p.x + dx, y: p.y + dy, w: 16, h: 16 };
    }
    if (it.kind === 'custom') {
      const s = this.lists()[it.map]?.[it.k];
      if (!s) return null;
      const img = this.customShown(it.map).views[it.k]?.image;
      return img ? { x: img.ox + dx, y: img.oy + dy, w: img.w, h: img.h } : { x: s.x * 8 + dx, y: s.y * 8 - s.z * 8 + dy, w: 16, h: 16 };
    }
    const sp = readOwSprites(this.rom)[it.k];
    if (!sp.num) return null;
    const img = this.shown().views[it.k].image;
    return img ? { x: img.ox + dx, y: img.oy + dy, w: img.w, h: img.h } : { x: sp.x + dx, y: sp.y + dy, w: 16, h: 16 };
  }
  // a Koopa Kid is shown where its tile is on the map
  private koopaShown(k: number): boolean {
    const base = this.view.region * 0x400, l1 = this.view.shown.l1;
    for (let i = base; i < base + 0x400; i++) if (l1[i] === KOOPA_TILE + k) return true;
    return false;
  }
  // the custom sprites of every submap (7 lists)
  private lists(): CustomOwSprite[][] {
    try { return readCustomSprites(this.rom); } catch { return Array.from({ length: 7 }, () => []); }
  }
  // the submaps of the region shown (the main map, or the 6 submaps)
  private maps(): number[] {
    return this.view.region ? [1, 2, 3, 4, 5, 6] : [0];
  }
  // a submap's custom sprites as the game shows them (emulated in the probe worker), the last ones meanwhile; images
  // only while they are as many as the list's
  private customShown(map: number): Shown {
    const views = this.view.app.overworldCustomSprites(map, this.view.progress, this.learned);
    const had = this.custom.get(map);
    if (views && had?.views !== views) this.custom.set(map, { views, canvases: views.map((v) => (v.image ? thumbCanvas({ w: v.image.w, h: v.image.h, px: v.image.rgba }) : null)) });
    const got = this.custom.get(map);
    return got && got.views.length === (this.lists()[map]?.length ?? 0) ? got : { views: [], canvases: [] };
  }
  private learned = () => { this.view.paint(); if (this.view.mode === 'sprites') this.view.buildProps(); };
  private items(): Item[] {
    const lists = this.lists();
    return [
      ...(hasOwSpriteSlots(this.rom) ? Array.from({ length: OW_SPRITE_SLOTS }, (_, k): Item => ({ kind: 'sprite', k })) : []),
      ...this.maps().flatMap((map) => (lists[map] ?? []).map((_, k): Item => ({ kind: 'custom', map, k }))),
      ...Array.from({ length: KOOPA_KIDS }, (_, k): Item => ({ kind: 'koopa', k })),
      { kind: 'start', player: 1 }, { kind: 'start', player: 0 },
    ];
  }

  // ---- drawing ----
  paint(ctx: CanvasRenderingContext2D, lw: number): void {
    const { views, canvases } = this.shown(), sprites = readOwSprites(this.rom);
    ctx.font = 'bold 7px monospace';
    for (const it of this.items()) {
      const b = this.box(it);
      if (!b) continue;
      const on = same(this.sel, it);
      if (it.kind === 'custom') {
        const s = this.lists()[it.map][it.k], sh = this.customShown(it.map), c = sh.canvases[it.k] ?? null, v = sh.views[it.k];
        const dx = b.x - (v?.image?.ox ?? s.x * 8), dy = b.y - (v?.image?.oy ?? s.y * 8 - s.z * 8);
        const gx = s.x * 8 + dx + 8, gy = s.y * 8 + dy + 8 + (v?.image ? 0 : s.z * 8);
        if (this.showShadows) { ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.beginPath(); ctx.ellipse(gx, gy + 4, 7, 3, 0, 0, Math.PI * 2); ctx.fill(); }
        if (this.showHeights && s.z) { ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = lw; ctx.setLineDash([2 * lw, 2 * lw]); ctx.beginPath(); ctx.moveTo(gx, gy); ctx.lineTo(gx, gy - s.z * 8); ctx.stroke(); ctx.setLineDash([]); }
        if (c) ctx.drawImage(c, b.x, b.y);
        else { ctx.strokeStyle = 'rgba(255,200,120,0.9)'; ctx.lineWidth = lw; ctx.setLineDash([2 * lw, 2 * lw]); ctx.strokeRect(b.x, b.y, 16, 16); ctx.setLineDash([]); tag(ctx, hex(s.id, 2), b.x + 1, b.y + 7, '#ffc878'); }
      } else if (it.kind === 'sprite') {
        const v = views[it.k], c = canvases[it.k], sp = sprites[it.k], dx = b.x - (v.image?.ox ?? sp.x), dy = b.y - (v.image?.oy ?? sp.y);
        const gx = sp.x + dx + 8, gy = sp.y + dy + 8; // the position on the ground
        if (this.showShadows) { ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.beginPath(); ctx.ellipse(gx, gy + 4, 7, 3, 0, 0, Math.PI * 2); ctx.fill(); }
        if (this.showHeights && v.z) { ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = lw; ctx.setLineDash([2 * lw, 2 * lw]); ctx.beginPath(); ctx.moveTo(gx, gy); ctx.lineTo(gx, gy - v.z); ctx.stroke(); ctx.setLineDash([]); }
        if (c) ctx.drawImage(c, b.x, b.y);
        else { ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.lineWidth = lw; ctx.setLineDash([2 * lw, 2 * lw]); ctx.strokeRect(b.x, b.y, 16, 16); ctx.setLineDash([]); tag(ctx, hex(sp.num, 2), b.x + 1, b.y + 7, '#fff'); }
      } else {
        const color = it.kind === 'start' ? (it.player ? '#5fd35f' : '#ff5f5f') : '#ffa94c';
        ctx.strokeStyle = color; ctx.lineWidth = 1.5 * lw; ctx.strokeRect(b.x + 0.5, b.y + 0.5, 15, 15);
        tag(ctx, it.kind === 'start' ? PLAYERS[it.player][0] : `K${it.k + 1}`, b.x + 1, b.y + 7, color);
      }
      if (on) { ctx.strokeStyle = '#4cc2ff'; ctx.lineWidth = 2 * lw; ctx.strokeRect(b.x - 1, b.y - 1, b.w + 2, b.h + 2); }
    }
  }

  // ---- interaction (pixels of the map) ----
  // the things under the map's pixel, the topmost first
  private hits(x: number, y: number): Item[] {
    return this.items().reverse().filter((it) => { const b = this.box(it); return !!b && x >= b.x && y >= b.y && x < b.x + b.w && y < b.y + b.h; });
  }
  down(x: number, y: number): void {
    const hits = this.hits(x, y);
    if (!hits.length && this.picked !== null) { this.place({ id: this.picked, x: Math.floor(x / 8), y: Math.floor(y / 8), z: 0, extra: [] }, `Custom overworld sprite ${hex(this.picked, 2)}: placed`); return; }
    const it = hits.find((i) => same(this.sel, i)) ?? hits[0] ?? null;
    if (!it || !same(this.sel, it)) this.clicked = false;
    this.sel = it;
    this.drag = it ? { item: it, x0: x, y0: y, dx: 0, dy: 0 } : null;
    this.view.paint();
    this.view.buildProps();
  }
  // where an item is (pixels; a start: its tile's)
  private pos(it: Item): { x: number; y: number } {
    if (it.kind === 'start') { const s = readStart(this.rom, it.player); return { x: s.x * 16, y: s.y * 16 }; }
    if (it.kind === 'custom') { const s = this.lists()[it.map][it.k]; return { x: s.x * 8, y: s.y * 8 }; }
    return it.kind === 'koopa' ? koopaKidPos(this.rom, it.k) : readOwSprites(this.rom)[it.k];
  }
  move(x: number, y: number, fine: boolean): void {
    const d = this.drag;
    if (!d) return;
    // on the grid of the step (a start's 16, else 8; 1 with Shift)
    const step = d.item.kind === 'start' ? 16 : fine && d.item.kind !== 'custom' ? 1 : 8, p = this.pos(d.item), snap = (v: number) => Math.round(v / step) * step;
    d.dx = snap(p.x + x - d.x0) - p.x; d.dy = snap(p.y + y - d.y0) - p.y;
    this.view.paint();
  }
  up(x: number, y: number): void {
    const d = this.drag;
    this.drag = null;
    if (d && !d.dx && !d.dy && Math.abs(x - d.x0) < 2 && Math.abs(y - d.y0) < 2) {
      // a click on the selected one: the next one under it
      const hits = this.hits(x, y), k = hits.findIndex((i) => same(d.item, i));
      if (hits.length > 1 && same(this.sel, d.item) && this.clicked) this.sel = hits[(k + 1) % hits.length];
      this.clicked = true;
      this.view.paint();
      this.view.buildProps();
      return;
    }
    this.clicked = false;
    if (!d || (!d.dx && !d.dy)) { this.view.paint(); return; }
    const it = d.item, rom = this.rom;
    if (it.kind === 'custom') { this.moveCustom(it, d.dx / 8, d.dy / 8); return; }
    if (it.kind === 'sprite') {
      const s = readOwSprites(rom)[it.k];
      this.edit(`Overworld sprite ${it.k + 1}: moved`, () => writeOwSprite(rom, it.k, { ...s, x: (s.x + d.dx) & 0xffff, y: (s.y + d.dy) & 0xffff }));
    } else if (it.kind === 'koopa') {
      const p = koopaKidPos(rom, it.k);
      this.edit(`Koopa Kid ${it.k + 1}: jumps out elsewhere`, () => setKoopaKidPos(rom, it.k, { x: (p.x + d.dx) & 0xffff, y: (p.y + d.dy) & 0xffff }));
    } else {
      const s = readStart(rom, it.player), x = Math.max(0, Math.min(31, s.x + d.dx / 16)), y = Math.max(0, Math.min(31, s.y + d.dy / 16));
      const submap = this.view.submapAt(l1Index(this.view.region, x, y));
      this.edit(`${PLAYERS[it.player]}'s start: moved`, () => writeStart(rom, it.player, { submap, x, y }));
    }
  }
  // ---- custom sprites ----
  // the lists changed by f written as one ROM edit (Lunar Magic's limits checked first); false: not written
  private editCustom(what: string, f: (lists: CustomOwSprite[][]) => void): boolean {
    const lists = this.lists();
    f(lists);
    const why = customSpritesProblem(lists);
    if (why) { toast(why, 'error'); this.view.paint(); return false; }
    this.edit(what, () => writeCustomSprites(this.rom, lists));
    return true;
  }
  // the submap a custom sprite at (x, y) (8px steps) is on in the region shown
  private submapAt(x: number, y: number): number {
    return this.view.region ? this.view.submapAt(l1Index(1, Math.min(31, x >> 1), Math.min(31, y >> 1))) : 0;
  }
  // a custom sprite added (a new one, a copy) at its position on the region shown, selected
  place(s: CustomOwSprite, what: string): void {
    const c = (v: number) => Math.max(0, Math.min(OW_CUSTOM_POS_MAX, v));
    const sp = { ...s, x: c(s.x), y: c(s.y), extra: Array.from({ length: customExtraBytes(customSizeTable(this.rom), s.id) }, (_, k) => s.extra[k] ?? 0) };
    const map = this.submapAt(sp.x, sp.y);
    let k = -1;
    if (this.editCustom(what, (l) => { k = l[map].push(sp) - 1; })) this.select({ kind: 'custom', map, k });
  }
  private moveCustom(it: Extract<Item, { kind: 'custom' }>, dx: number, dy: number): void {
    const s = this.lists()[it.map][it.k], c = (v: number) => Math.max(0, Math.min(OW_CUSTOM_POS_MAX, v));
    const moved = { ...s, x: c(s.x + dx), y: c(s.y + dy) }, map = this.submapAt(moved.x, moved.y);
    let k = it.k;
    const ok = this.editCustom(map === it.map ? `Custom overworld sprite ${hex(s.id, 2)}: moved` : `Custom overworld sprite ${hex(s.id, 2)}: moved to ${MAP_NAMES[map]}`, (l) => {
      if (map === it.map) { l[map][it.k] = moved; return; }
      l[it.map].splice(it.k, 1);
      k = l[map].push(moved) - 1;
    });
    if (ok) this.select({ kind: 'custom', map, k });
  }
  private select(it: Item | null): void {
    this.sel = it;
    this.view.paint();
    this.view.buildProps();
  }
  // Ctrl+C: the selected custom sprite copied; Ctrl+V: pasted at the mouse; Ctrl+D: a copy next to it
  copy(): boolean {
    const s = this.sel;
    if (s?.kind !== 'custom') return false;
    this.clip = { ...this.lists()[s.map][s.k] };
    toast(`Custom overworld sprite ${hex(this.clip.id, 2)} copied`);
    return true;
  }
  paste(): boolean {
    const h = this.view.hover;
    if (!this.clip || !h) return false;
    this.place({ ...this.clip, x: h.x * 2, y: h.y * 2 }, `Custom overworld sprite ${hex(this.clip.id, 2)}: pasted`);
    return true;
  }
  duplicate(): boolean {
    const s = this.sel;
    if (s?.kind !== 'custom') return false;
    const sp = this.lists()[s.map][s.k];
    this.place({ ...sp, x: sp.x + 1, y: sp.y + 1 }, `Custom overworld sprite ${hex(sp.id, 2)}: copied`);
    return true;
  }
  // a palette entry picked (again: none)
  pick(id: number | null): void {
    this.picked = this.picked === id ? null : id;
    this.view.buildSide();
  }

  // the selected sprite removed (its slot none)
  remove(): boolean {
    const s = this.sel;
    if (s?.kind === 'custom') {
      const sp = this.lists()[s.map][s.k];
      if (this.editCustom(`Custom overworld sprite ${hex(sp.id, 2)}: deleted`, (l) => { l[s.map].splice(s.k, 1); })) this.select(null);
      return true;
    }
    if (s?.kind !== 'sprite') return false;
    const sp = readOwSprites(this.rom)[s.k];
    if (sp.num) this.edit(`Overworld sprite ${s.k + 1}: none`, () => writeOwSprite(this.rom, s.k, { ...sp, num: 0 }));
    return true;
  }
  private edit(what: string, f: () => void): void { this.view.app.romEdit(what, f); }

  // the installed custom sprites (BOWSIE project), with how they look (emulated)
  private installed(): BowsieSpriteInfo[] {
    try { const p = loadBowsieProject(this.rom); return p ? bowsieSprites(p) : []; } catch { return []; }
  }
  private looked(ids: number[]): (HTMLCanvasElement | null)[] {
    const key = ids.join(',');
    const images = ids.length ? this.view.app.overworldSpriteLooks(ids, this.learnedLooks) : [];
    if (images && (this.looks?.ids !== key || this.looks.images !== images)) this.looks = { ids: key, images, canvases: images.map((i) => (i ? thumbCanvas({ w: i.w, h: i.h, px: i.rgba }) : null)) };
    return this.looks?.ids === key ? this.looks.canvases : ids.map(() => null);
  }
  private learnedLooks = () => { if (this.view.mode === 'sprites') this.view.buildSide(); };
  // the side panel in the sprites mode: the installed custom sprites to place
  palette(): HTMLElement[] {
    const inst = this.installed(), looks = this.looked(inst.map((i) => i.num));
    const out: HTMLElement[] = [h('div', { class: 'panel-title' }, 'Custom sprites')];
    if (!inst.length) {
      out.push(h('div', { class: 'hint' }, 'None installed – overworld sprites in BOWSIE\'s format come as packages (ROM → Packages …). Placed, they are kept in Lunar Magic\'s custom overworld sprite table.'));
    } else {
      out.push(h('div', { class: 'hint' }, 'Pick one, then click on the map to place it (again to stop).'),
        h('div', { class: 'ow-cpal' }, inst.map((i, k) => h('button', { class: 'ow-cpal-item' + (this.picked === i.num ? ' active' : ''), title: `${hex(i.num, 2)} ${i.name}${i.description ? '\n' + i.description : ''}`, onclick: () => this.pick(i.num) },
          looks[k] ?? h('span', { class: 'ow-cpal-none' }, hex(i.num, 2)), h('span', null, `${hex(i.num, 2)} ${i.name}`)))));
    }
    out.push(h('div', { class: 'hint' }, bowsieInstalled(this.rom) ? 'BOWSIE is installed: the game\'s 13 sprite slots are gone – its sprites are BOWSIE sprites now (BOWSIE comes with them as its “originals”).'
      : 'The game\'s sprites: drawn as the game shows them on this map at the event progress; a dashed box where it doesn\'t show the sprite.'),
      h('div', { class: 'hint' }, 'Shadows and height marks: View.'));
    return out;
  }
  private customProps(s: Extract<Item, { kind: 'custom' }>): HTMLElement {
    const rom = this.rom, sp = this.lists()[s.map][s.k], inst = this.installed(), info = inst.find((i) => i.num === sp.id);
    const set = (what: string, p: Partial<CustomOwSprite>) => {
      const next = { ...sp, ...p };
      if (p.id !== undefined) next.extra = Array.from({ length: customExtraBytes(customSizeTable(rom), p.id) }, (_, k) => sp.extra[k] ?? 0);
      if (p.x !== undefined || p.y !== undefined) { this.moveCustom(s, next.x - sp.x, next.y - sp.y); return; }
      if (this.editCustom(`Custom overworld sprite ${hex(sp.id, 2)}: ${what}`, (l) => { l[s.map][s.k] = next; })) this.view.buildProps();
    };
    const names: [number, string][] = inst.map((i) => [i.num, `${hex(i.num, 2)} ${i.name}`]);
    if (!info) names.push([sp.id, `${hex(sp.id, 2)} (not installed)`]);
    const v = this.customShown(s.map).views[s.k];
    return h('div', { class: 'ow-info' },
      h('div', null, h('b', null, `Custom sprite ${hex(sp.id, 2)}`), h('span', { class: 'hint' }, ` · ${MAP_NAMES[s.map]}, entry ${s.k + 1}`)),
      h('div', { class: 'prop' }, h('label', null, 'Sprite'), select(names, sp.id, (n) => set('sprite changed', { id: n }))),
      h('div', { class: 'row' }, h('label', null, 'X '), hexInput(sp.x, 2, (x) => set('moved', { x }), OW_CUSTOM_POS_MAX), h('label', null, ' Y '), hexInput(sp.y, 2, (y) => set('moved', { y }), OW_CUSTOM_POS_MAX),
        h('span', { class: 'hint' }, ' ×8 px')),
      h('div', { class: 'row' }, h('label', null, 'Height '), hexInput(sp.z, 2, (z) => set('height', { z }), OW_CUSTOM_Z_MAX), h('span', { class: 'hint' }, ' ×8 px')),
      sp.extra.length ? h('div', { class: 'row' }, h('label', null, 'Extra bytes '), ...sp.extra.map((b, k) => hexInput(b, 2, (nb) => set('extra bytes', { extra: sp.extra.map((o, j) => (j === k ? nb : o)) })))) : h('div', { class: 'hint' }, 'No extra bytes.'),
      h('div', { class: 'hint' }, info?.description ?? ''),
      h('div', { class: 'hint' }, !bowsieInstalled(rom) ? 'Not drawn: BOWSIE isn\'t installed – no code reads the table.' : this.customShown(s.map).views.length && !v?.image ? `The game doesn't show it on ${MAP_NAMES[s.map]} at this event progress.` : ''),
      h('div', { class: 'row' }, h('button', { onclick: () => this.duplicate(), title: 'A copy next to it (Ctrl+D)' }, 'Copy'), h('button', { onclick: () => this.remove(), title: 'Delete' }, 'Delete')));
  }

  // ---- properties ----
  props(): HTMLElement {
    if (this.sel?.kind === 'custom' && !this.lists()[this.sel.map]?.[this.sel.k]) this.sel = null; // (gone: undone, deleted)
    const s = this.sel, rom = this.rom;
    if (!s) return h('div', { class: 'ow-info' }, emptyState('Click a sprite, a start position (M, L) or where a Koopa Kid jumps out (K1–K3) to select it – again for the next one under it; drag to move it (8 pixels, 1 with Shift). ' +
      (hasOwSpriteSlots(rom) ? 'The sprite slots are the same on every submap: each sprite shows where its code lets it. ' : '') + 'Custom sprites: pick one in the palette and click on the map to place it; Ctrl+C / Ctrl+V copy one, Delete removes it.'));
    if (s.kind === 'custom') return this.customProps(s);
    const pos = (x: number, y: number, set: (x: number, y: number) => void) => h('div', { class: 'row' },
      h('label', null, 'X '), hexInput(x, 4, (v) => set(v, y)), h('label', null, ' Y '), hexInput(y, 4, (v) => set(x, v)));
    if (s.kind === 'sprite') {
      const sp = readOwSprites(rom)[s.k], v = this.shown().views[s.k];
      const names: [number, string][] = OW_SPRITE_NAMES.map((n, i) => [i, `${hex(i, 2)} ${n}`]);
      if (sp.num >= OW_SPRITE_NAMES.length) names.push([sp.num, `${hex(sp.num, 2)} (not one of the game's)`]);
      return h('div', { class: 'ow-info' },
        h('div', null, h('b', null, `Sprite slot ${s.k + 1}`), h('span', { class: 'hint' }, ` · RAM slot ${s.k + 3}`)),
        h('div', { class: 'prop' }, h('label', null, 'Sprite'), select(names, sp.num, (n) => this.edit(`Overworld sprite ${s.k + 1}: ${OW_SPRITE_NAMES[n] ?? hex(n, 2)}`, () => writeOwSprite(rom, s.k, { ...sp, num: n })))),
        pos(sp.x, sp.y, (x, y) => this.edit(`Overworld sprite ${s.k + 1}: moved`, () => writeOwSprite(rom, s.k, { ...sp, x, y }))),
        h('div', { class: 'hint' }, !this.view.owSprites() ? '' : sp.num && !v.image ? `The game doesn't show it on ${MAP_NAMES[this.view.map]} at this event progress.` : v.z ? `Height ${hex(v.z, 2)} pixels.` : ''));
    }
    if (s.kind === 'koopa') {
      const p = koopaKidPos(rom, s.k);
      return h('div', { class: 'ow-info' },
        h('div', null, h('b', null, `Koopa Kid ${s.k + 1}`), h('span', { class: 'hint' }, ` · tile ${hex(KOOPA_TILE + s.k, 2)}`)),
        h('div', { class: 'hint' }, `Jumps out here when Mario stands on its tile (paint tile ${hex(KOOPA_TILE + s.k, 2)} on layer 1); its place, where Mario goes after losing to it, is set in the Overworld links mode.`),
        pos(p.x, p.y, (x, y) => this.edit(`Koopa Kid ${s.k + 1}: jumps out elsewhere`, () => setKoopaKidPos(rom, s.k, { x, y }))));
    }
    const st = readStart(rom, s.player), set = (p: Partial<typeof st>) => this.edit(`${PLAYERS[s.player]}'s start: moved`, () => writeStart(rom, s.player, { ...st, ...p }));
    return h('div', { class: 'ow-info' },
      h('div', null, h('b', null, `${PLAYERS[s.player]}'s start`)),
      h('div', { class: 'prop' }, h('label', null, 'Submap'), select(MAP_NAMES.map((n, i) => [i, n] as [number, string]), st.submap, (v) => set({ submap: v }))),
      h('div', { class: 'row' }, h('label', null, 'Tile X '), hexInput(st.x, 2, (v) => set({ x: v }), 0x1f), h('label', null, ' Y '), hexInput(st.y, 2, (v) => set({ y: v }), 0x1f)),
      h('div', { class: 'hint' }, 'A new game starts here – drag it to another tile (its submap then the one the tile is on).'));
  }
}

function tag(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string): void {
  const w = ctx.measureText(text).width;
  ctx.fillStyle = 'rgba(0,0,0,0.75)';
  ctx.fillRect(x - 1, y - 7, w + 2, 8);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}
