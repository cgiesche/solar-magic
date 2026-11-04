// The custom overworld sprites on the map (BOWSIE's, in Lunar Magic's table: owcustom.ts), a part of the overworld
// view's "Sprites" mode (owspriteview.ts: selecting and dragging): the sprites of the submaps shown, drawn by emulation
// (owsprites.ts); placed from the palette of the installed ones (a click on the map), moved in 8px steps (to another
// submap by dragging them there), copied (Ctrl+C / Ctrl+V at the 8px cell under the mouse, Ctrl+D), deleted; their
// sprite, height and extra bytes in the properties. Each change is one ROM edit.

import type { OverworldView } from './overworld.ts';
import { h, select, hexInput, toast } from './dom.ts';
import { refusalToast } from './owrefusal.ts';
import { thumbCanvas } from './thumbs.ts';
import { budgetRow } from './budgetgauge.ts';
import type { OwSpriteView } from '../core/owsprites.ts';
import { l1Index, MAP_NAMES } from '../core/overworld.ts';
import { hex } from '../core/names.ts';
import {
  readCustomSprites, writeCustomSprites, customSpritesProblem, customSizeTable, fitCustomSprite, bowsieInstalled,
  OW_CUSTOM_POS_MAX, OW_CUSTOM_Z_MAX, OW_CUSTOM_SUBMAPS, type CustomOwSprite,
} from '../core/owcustom.ts';
import { loadBowsieProject, bowsieSprites, type BowsieSpriteInfo } from '../core/bowsie.ts';
import type { SpriteImage } from '../core/spritegfx.ts';

// a custom sprite: entry k of submap map's list
export type CustomItem = { kind: 'custom'; map: number; k: number };
export type Box = { x: number; y: number; w: number; h: number };
type Shown = { views: OwSpriteView[]; canvases: (HTMLCanvasElement | null)[] };
const label = (id: number) => `Custom overworld sprite ${hex(id, 2)}`;

export class CustomSpriteLayer {
  picked: number | null = null; // the custom sprite a click on the map places (palette)
  private clip: CustomOwSprite | null = null; // a copied custom sprite
  private custom = new Map<number, Shown>(); // per submap: its custom sprites as shown last
  private looks: { ids: string; images: (SpriteImage | null)[]; canvases: (HTMLCanvasElement | null)[] } | null = null;
  // select: the sprite selected after an edit (null: none)
  constructor(private view: OverworldView, private select: (it: CustomItem | null) => void) {}

  private get rom() { return this.view.app.rom; }
  // the custom sprites of every submap (7 lists)
  private lists(): CustomOwSprite[][] {
    try { return readCustomSprites(this.rom); } catch { return Array.from({ length: OW_CUSTOM_SUBMAPS }, () => []); }
  }
  private sprite(it: CustomItem): CustomOwSprite | undefined { return this.lists()[it.map]?.[it.k]; }
  // the item is (still) a sprite of the table (not undone, deleted)
  has(it: CustomItem): boolean { return !!this.sprite(it); }
  // the sprites of the region shown (the main map, or the 6 submaps)
  items(): CustomItem[] {
    const lists = this.lists();
    return (this.view.region ? [1, 2, 3, 4, 5, 6] : [0]).flatMap((map) => (lists[map] ?? []).map((_, k): CustomItem => ({ kind: 'custom', map, k })));
  }
  // a submap's custom sprites as the game shows them (emulated in the probe worker), the last ones meanwhile; images
  // only while they are as many as the list's
  private shown(map: number): Shown {
    const views = this.view.app.overworldCustomSprites(map, this.view.progress, this.learned);
    const had = this.custom.get(map);
    if (views && had?.views !== views) this.custom.set(map, { views, canvases: views.map((v) => (v.image ? thumbCanvas({ w: v.image.w, h: v.image.h, px: v.image.rgba }) : null)) });
    const got = this.custom.get(map);
    return got && got.views.length === (this.lists()[map]?.length ?? 0) ? got : { views: [], canvases: [] };
  }
  private learned = () => { this.view.paint(); if (this.view.mode === 'sprites') this.view.buildProps(); };

  // its box on the map (pixels), moved by (dx, dy)
  box(it: CustomItem, dx: number, dy: number): Box | null {
    const s = this.sprite(it);
    if (!s) return null;
    const img = this.shown(it.map).views[it.k]?.image;
    return img ? { x: img.ox + dx, y: img.oy + dy, w: img.w, h: img.h } : { x: s.x * 8 + dx, y: s.y * 8 - s.z * 8 + dy, w: 16, h: 16 };
  }
  // where it is (pixels)
  pos(it: CustomItem): { x: number; y: number } {
    const s = this.sprite(it)!;
    return { x: s.x * 8, y: s.y * 8 };
  }
  paint(ctx: CanvasRenderingContext2D, it: CustomItem, b: Box, lw: number, shadows: boolean, heights: boolean): void {
    const s = this.sprite(it)!, sh = this.shown(it.map), c = sh.canvases[it.k] ?? null, v = sh.views[it.k];
    const dx = b.x - (v?.image?.ox ?? s.x * 8), dy = b.y - (v?.image?.oy ?? s.y * 8 - s.z * 8);
    const gx = s.x * 8 + dx + 8, gy = s.y * 8 + dy + 8 + (v?.image ? 0 : s.z * 8); // the position on the ground
    if (shadows) { ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.beginPath(); ctx.ellipse(gx, gy + 4, 7, 3, 0, 0, Math.PI * 2); ctx.fill(); }
    if (heights && s.z) { ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = lw; ctx.setLineDash([2 * lw, 2 * lw]); ctx.beginPath(); ctx.moveTo(gx, gy); ctx.lineTo(gx, gy - s.z * 8); ctx.stroke(); ctx.setLineDash([]); }
    if (c) ctx.drawImage(c, b.x, b.y);
    else { ctx.strokeStyle = 'rgba(255,200,120,0.9)'; ctx.lineWidth = lw; ctx.setLineDash([2 * lw, 2 * lw]); ctx.strokeRect(b.x, b.y, 16, 16); ctx.setLineDash([]); tag(ctx, hex(s.id, 2), b.x + 1, b.y + 7, '#ffc878'); }
  }

  // ---- editing ----
  // the lists changed by f written as one ROM edit (Lunar Magic's limits checked first); false: not written
  private edit(what: string, f: (lists: CustomOwSprite[][]) => void): boolean {
    const lists = this.lists();
    f(lists);
    const why = customSpritesProblem(lists, bowsieInstalled(this.rom));
    if (why) { refusalToast(this.rom, why); this.view.paint(); return false; }
    this.view.app.romEdit(what, () => writeCustomSprites(this.rom, lists));
    return true;
  }
  // the submap a custom sprite at (x, y) (8px steps) is on in the region shown
  private submapAt(x: number, y: number): number {
    return this.view.region ? this.view.submapAt(l1Index(1, Math.min(31, x >> 1), Math.min(31, y >> 1))) : 0;
  }
  // a custom sprite added (a new one, a copy) at its position on the region shown, selected
  private place(s: CustomOwSprite, what: string): void {
    const sp = fitCustomSprite(customSizeTable(this.rom), s), map = this.submapAt(sp.x, sp.y);
    let k = -1;
    if (this.edit(what, (l) => { k = l[map].push(sp) - 1; })) this.select({ kind: 'custom', map, k });
  }
  // the palette's sprite placed at the map's pixel (x, y); false: none picked
  placeAt(x: number, y: number): boolean {
    if (this.picked === null) return false;
    this.place({ id: this.picked, x: Math.floor(x / 8), y: Math.floor(y / 8), z: 0, extra: [] }, `${label(this.picked)}: placed`);
    return true;
  }
  // moved by (dx, dy) 8px steps (onto the submap it then is on)
  moveBy(it: CustomItem, dx: number, dy: number): void {
    const s = this.sprite(it)!, moved = fitCustomSprite(customSizeTable(this.rom), { ...s, x: s.x + dx, y: s.y + dy }), map = this.submapAt(moved.x, moved.y);
    let k = it.k;
    const ok = this.edit(map === it.map ? `${label(s.id)}: moved` : `${label(s.id)}: moved to ${MAP_NAMES[map]}`, (l) => {
      if (map === it.map) { l[map][it.k] = moved; return; }
      l[it.map].splice(it.k, 1);
      k = l[map].push(moved) - 1;
    });
    if (ok) this.select({ kind: 'custom', map, k });
  }
  // Ctrl+C: copied; Ctrl+V: pasted at the 8px cell of the map's pixel (x, y); Ctrl+D: a copy next to it
  copy(it: CustomItem): void {
    this.clip = { ...this.sprite(it)! };
    toast(`${label(this.clip.id)} copied`);
  }
  paste(x: number, y: number): boolean {
    if (!this.clip) return false;
    this.place({ ...this.clip, x: Math.floor(x / 8), y: Math.floor(y / 8) }, `${label(this.clip.id)}: pasted`);
    return true;
  }
  duplicate(it: CustomItem): void {
    const sp = this.sprite(it)!;
    this.place({ ...sp, x: sp.x + 1, y: sp.y + 1 }, `${label(sp.id)}: copied`);
  }
  remove(it: CustomItem): void {
    const sp = this.sprite(it)!;
    if (this.edit(`${label(sp.id)}: deleted`, (l) => { l[it.map].splice(it.k, 1); })) this.select(null);
  }
  // a palette entry picked (again: none)
  pick(id: number | null): void {
    this.picked = this.picked === id ? null : id;
    this.view.buildSide();
  }

  // ---- panels ----
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
  // the side panel's palette: the installed custom sprites to place
  palette(): HTMLElement[] {
    const inst = this.installed(), looks = this.looked(inst.map((i) => i.num));
    const out: HTMLElement[] = [h('div', { class: 'panel-title' }, 'Custom sprites')];
    if (!inst.length) {
      out.push(h('div', { class: 'hint' }, 'None installed – overworld sprites in BOWSIE\'s format come as packages (ROM → Packages …). Placed, they are kept in Lunar Magic\'s custom overworld sprite table.'));
    } else {
      out.push(budgetRow('Pick one, then click on the map to place it (again to stop).', this.view.budget('customSprites')),
        h('div', { class: 'ow-cpal' }, inst.map((i, k) => h('button', { class: 'ow-cpal-item' + (this.picked === i.num ? ' active' : ''), title: `${hex(i.num, 2)} ${i.name}${i.description ? '\n' + i.description : ''}`, onclick: () => this.pick(i.num) },
          looks[k] ?? h('span', { class: 'ow-cpal-none' }, hex(i.num, 2)), h('span', null, `${hex(i.num, 2)} ${i.name}`)))));
    }
    return out;
  }
  props(it: CustomItem): HTMLElement {
    const rom = this.rom, sp = this.sprite(it)!, inst = this.installed(), info = inst.find((i) => i.num === sp.id);
    const set = (what: string, p: Partial<CustomOwSprite>) => {
      if (p.x !== undefined || p.y !== undefined) { this.moveBy(it, (p.x ?? sp.x) - sp.x, (p.y ?? sp.y) - sp.y); return; }
      const next = fitCustomSprite(customSizeTable(rom), { ...sp, ...p });
      if (this.edit(`${label(sp.id)}: ${what}`, (l) => { l[it.map][it.k] = next; })) this.view.buildProps();
    };
    const names: [number, string][] = inst.map((i) => [i.num, `${hex(i.num, 2)} ${i.name}`]);
    if (!info) names.push([sp.id, `${hex(sp.id, 2)} (not installed)`]);
    const shown = this.shown(it.map), v = shown.views[it.k];
    return h('div', { class: 'ow-info' },
      h('div', null, h('b', null, `Custom sprite ${hex(sp.id, 2)}`), h('span', { class: 'hint' }, ` · ${MAP_NAMES[it.map]}, entry ${it.k + 1}`)),
      h('div', { class: 'prop' }, h('label', null, 'Sprite'), select(names, sp.id, (n) => set('sprite changed', { id: n }))),
      h('div', { class: 'row' }, h('label', null, 'X '), hexInput(sp.x, 2, (x) => set('moved', { x }), OW_CUSTOM_POS_MAX), h('label', null, ' Y '), hexInput(sp.y, 2, (y) => set('moved', { y }), OW_CUSTOM_POS_MAX),
        h('span', { class: 'hint' }, ' ×8 px')),
      h('div', { class: 'row' }, h('label', null, 'Height '), hexInput(sp.z, 2, (z) => set('height', { z }), OW_CUSTOM_Z_MAX), h('span', { class: 'hint' }, ' ×8 px')),
      sp.extra.length ? h('div', { class: 'row' }, h('label', null, 'Extra bytes '), ...sp.extra.map((b, k) => hexInput(b, 2, (nb) => set('extra bytes', { extra: sp.extra.map((o, j) => (j === k ? nb : o)) })))) : h('div', { class: 'hint' }, 'No extra bytes.'),
      h('div', { class: 'hint' }, info?.description ?? ''),
      h('div', { class: 'hint' }, !bowsieInstalled(rom) ? 'Not drawn: BOWSIE isn\'t installed – no code reads the table.' : shown.views.length && !v?.image ? `The game doesn't show it on ${MAP_NAMES[it.map]} at this event progress.` : ''),
      h('div', { class: 'row' }, h('button', { onclick: () => this.duplicate(it), title: 'A copy next to it (Ctrl+D)' }, 'Copy'), h('button', { onclick: () => this.remove(it), title: 'Delete' }, 'Delete')));
  }
}

// a label on the map: text on a dark box
export function tag(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string): void {
  const w = ctx.measureText(text).width;
  ctx.fillStyle = 'rgba(0,0,0,0.75)';
  ctx.fillRect(x - 1, y - 7, w + 2, 8);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}
