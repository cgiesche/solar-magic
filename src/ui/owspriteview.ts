// The overworld's sprites on the map (the overworld view's "Sprites" mode, as the level editor's sprites: select,
// drag, properties): the 13 sprite slots drawn as the game shows them at the map and event progress (learned by
// emulation, owsprites.ts; a slot the game doesn't show there is a dashed box), Mario's and Luigi's start positions
// and where the Koopa Kids jump out. Dragging moves a sprite or where a Koopa Kid jumps out in 8px steps on the map's
// grid (1px with Shift), a start position by tiles; a click without a drag selects the next thing under the mouse
// (Luigi's start under Mario's). Each change is one ROM edit.

import type { OverworldView } from './overworld.ts';
import { h, select, hexInput, emptyState } from './dom.ts';
import { thumbCanvas } from './thumbs.ts';
import {
  readOwSprites, writeOwSprite, readStart, writeStart, koopaKidPos, setKoopaKidPos, owSpriteImages, OW_SPRITE_NAMES, OW_SPRITE_SLOTS, KOOPA_KIDS,
  type OwSpriteView,
} from '../core/owsprites.ts';
import { KOOPA_TILE } from '../core/owlinks.ts';
import { l1Index, MAP_NAMES } from '../core/overworld.ts';
import { submapOf } from '../core/owevents.ts';
import { hex } from '../core/names.ts';

// what is selected or dragged: a sprite slot, a player's start, where a Koopa Kid jumps out
type Item = { kind: 'sprite'; k: number } | { kind: 'start'; player: number } | { kind: 'koopa'; k: number };
type Drag = { item: Item; x0: number; y0: number; dx: number; dy: number };
const PLAYERS = ['Mario', 'Luigi'];
const same = (a: Item | null, b: Item) => !!a && a.kind === b.kind && (a.kind === 'start' ? a.player === (b as typeof a).player : (a as { k: number }).k === (b as { k: number }).k);

export class SpriteLayer {
  sel: Item | null = null;
  drag: Drag | null = null;
  showShadows = false; // a shadow on the ground under each sprite
  showHeights = true; // a line from a sprite's position up to it at its height
  private clicked = false; // the last mouse press was a click on the selection (the next one cycles)
  private views: { views: OwSpriteView[]; canvases: (HTMLCanvasElement | null)[] } | null = null;
  constructor(private view: OverworldView) {}

  private get rom() { return this.view.app.rom; }
  // the slots as the game shows them on the map at the event progress (emulated again when the map, the progress or
  // a ROM byte they read changes)
  private shown(): NonNullable<SpriteLayer['views']> {
    const views = owSpriteImages(this.view.loads, this.view.map, this.view.progress);
    if (this.views?.views !== views) this.views = { views, canvases: views.map((v) => (v.image ? thumbCanvas({ w: v.image.w, h: v.image.h, px: v.image.rgba }) : null)) };
    return this.views;
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
  private items(): Item[] {
    return [
      ...Array.from({ length: OW_SPRITE_SLOTS }, (_, k): Item => ({ kind: 'sprite', k })),
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
      if (it.kind === 'sprite') {
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
    const hits = this.hits(x, y), it = hits.find((i) => same(this.sel, i)) ?? hits[0] ?? null;
    if (!it || !same(this.sel, it)) this.clicked = false;
    this.sel = it;
    this.drag = it ? { item: it, x0: x, y0: y, dx: 0, dy: 0 } : null;
    this.view.paint();
    this.view.buildProps();
  }
  // where an item is (pixels; a start: its tile's)
  private pos(it: Item): { x: number; y: number } {
    if (it.kind === 'start') { const s = readStart(this.rom, it.player); return { x: s.x * 16, y: s.y * 16 }; }
    return it.kind === 'koopa' ? koopaKidPos(this.rom, it.k) : readOwSprites(this.rom)[it.k];
  }
  move(x: number, y: number, fine: boolean): void {
    const d = this.drag;
    if (!d) return;
    // on the grid of the step (a start's 16, else 8; 1 with Shift)
    const step = d.item.kind === 'start' ? 16 : fine ? 1 : 8, p = this.pos(d.item), snap = (v: number) => Math.round(v / step) * step;
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
    if (it.kind === 'sprite') {
      const s = readOwSprites(rom)[it.k];
      this.edit(`Overworld sprite ${it.k + 1}: moved`, () => writeOwSprite(rom, it.k, { ...s, x: (s.x + d.dx) & 0xffff, y: (s.y + d.dy) & 0xffff }));
    } else if (it.kind === 'koopa') {
      const p = koopaKidPos(rom, it.k);
      this.edit(`Koopa Kid ${it.k + 1}: jumps out elsewhere`, () => setKoopaKidPos(rom, it.k, { x: (p.x + d.dx) & 0xffff, y: (p.y + d.dy) & 0xffff }));
    } else {
      const s = readStart(rom, it.player), x = Math.max(0, Math.min(31, s.x + d.dx / 16)), y = Math.max(0, Math.min(31, s.y + d.dy / 16));
      const submap = submapOf(this.view.views, l1Index(this.view.region, x, y));
      this.edit(`${PLAYERS[it.player]}'s start: moved`, () => writeStart(rom, it.player, { submap, x, y }));
    }
  }
  // the selected sprite removed (its slot none)
  remove(): boolean {
    const s = this.sel;
    if (s?.kind !== 'sprite') return false;
    const sp = readOwSprites(this.rom)[s.k];
    if (sp.num) this.edit(`Overworld sprite ${s.k + 1}: none`, () => writeOwSprite(this.rom, s.k, { ...sp, num: 0 }));
    return true;
  }
  private edit(what: string, f: () => void): void { this.view.app.romEdit(what, f); }

  // ---- properties ----
  props(): HTMLElement {
    const s = this.sel, rom = this.rom;
    if (!s) return h('div', { class: 'ow-info' }, emptyState('Click a sprite, a start position (M, L) or where a Koopa Kid jumps out (K1–K3) to select it – again for the next one under it; drag to move it (8 pixels, 1 with Shift). The sprite slots are the same on every submap: each sprite shows where its code lets it.'));
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
        h('div', { class: 'hint' }, sp.num && !v.image ? `The game doesn't show it on ${MAP_NAMES[this.view.map]} at this event progress.` : v.z ? `Height ${hex(v.z, 2)} pixels.` : ''));
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
