// The overworld's sprites on the map (the overworld view's "Sprites" mode, as the level editor's sprites: select,
// drag, properties): the 13 sprite slots drawn as the game shows them at the map and event progress (learned by
// emulation, owsprites.ts; a slot the game doesn't show there is a dashed box), Mario's and Luigi's start positions
// and where the Koopa Kids jump out. Dragging moves a sprite or where a Koopa Kid jumps out in 8px steps on the map's
// grid (1px with Shift), a start position by tiles; a click without a drag selects the next thing under the mouse
// (Luigi's start under Mario's). Each change is one ROM edit.
// The custom sprites of the submaps shown are selected and dragged with them (their own layer: owcustomview.ts). With
// BOWSIE installed the game's sprite slots are gone (its loader is where their table was).

import type { OverworldView } from './overworld.ts';
import { h, select, hexInput, emptyState } from './dom.ts';
import { refusedToast } from './owrefusal.ts';
import { CustomSpriteLayer, tag, type CustomItem, type Box } from './owcustomview.ts';
import { thumbCanvas } from './thumbs.ts';
import {
  readOwSprites, writeOwSprite, readStart, writeStart, koopaKidPos, setKoopaKidPos, OW_SPRITE_NAMES, OW_SPRITE_SLOTS, KOOPA_KIDS,
  type OwSpriteView,
} from '../core/owsprites.ts';
import { KOOPA_TILE, koopaOfTile } from '../core/owlinks.ts';
import { l1Index, MAP_NAMES } from '../core/overworld.ts';
import { hex } from '../core/names.ts';
import { hasOwSpriteSlots, hasKoopaKidTable } from '../core/owsprites.ts';
import { bowsieInstalled } from '../core/owcustom.ts';
import { MARK } from './marks.ts';

// what is selected or dragged: a sprite slot, a player's start, where a Koopa Kid jumps out, a custom sprite
export type SpriteItem = { kind: 'sprite'; k: number } | { kind: 'start'; player: number } | { kind: 'koopa'; k: number } | CustomItem;
type Drag = { item: SpriteItem; x0: number; y0: number; dx: number; dy: number };
const PLAYERS = ['Mario', 'Luigi'];
const NONE_SHOWN = { views: Array.from({ length: OW_SPRITE_SLOTS }, (): OwSpriteView => ({ image: null, z: 0 })), canvases: [] as (HTMLCanvasElement | null)[] };
const same = (a: SpriteItem | null, b: SpriteItem) => !!a && a.kind === b.kind && (a.kind === 'start' ? a.player === (b as typeof a).player
  : (a as { k: number }).k === (b as { k: number }).k && (a.kind !== 'custom' || a.map === (b as typeof a).map));

export class SpriteLayer {
  // the sprite selected: the view's (owgesture.ts), it ends with the sprites mode
  get sel(): SpriteItem | null { return this.view.gesture.sprite; }
  set sel(s: SpriteItem | null) { this.view.gesture.sprite = s; }
  drag: Drag | null = null;
  showShadows = false; // a shadow on the ground under each sprite
  showHeights = true; // a line from a sprite's position up to it at its height
  private clicked = false; // the last mouse press was a click on the selection (the next one cycles)
  private views: { views: OwSpriteView[]; canvases: (HTMLCanvasElement | null)[] } | null = null;
  readonly custom: CustomSpriteLayer;
  constructor(private view: OverworldView) {
    this.custom = new CustomSpriteLayer(view, (it) => this.select(it));
  }

  private get rom() { return this.view.app.rom; }
  // the slots as the game shows them on the map at the event progress (emulated in the probe worker again when the map,
  // the progress or a ROM byte they read changes); while that runs the ones shown last (none at first: dashed boxes)
  private shown(): NonNullable<SpriteLayer['views']> {
    const views = this.view.owSprites();
    if (views && this.views?.views !== views) this.views = { views, canvases: views.map((v) => (v.image ? thumbCanvas({ w: v.image.w, h: v.image.h, px: v.image.rgba }) : null)) };
    return this.views ?? NONE_SHOWN;
  }
  // an item's box on the map (pixels), with a drag's offset
  private box(it: SpriteItem): Box | null {
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
    if (it.kind === 'custom') return this.custom.box(it, dx, dy);
    const sp = readOwSprites(this.rom)[it.k];
    if (!sp.num) return null;
    const img = this.shown().views[it.k].image;
    return img ? { x: img.ox + dx, y: img.oy + dy, w: img.w, h: img.h } : { x: sp.x + dx, y: sp.y + dy, w: 16, h: 16 };
  }
  // a Koopa Kid is shown where its tile is on the map
  private koopaShown(k: number): boolean {
    const base = this.view.region * 0x400, l1 = this.view.shown.l1;
    for (let i = base; i < base + 0x400; i++) if (koopaOfTile(l1[i]) === k) return true;
    return false;
  }
  private items(): SpriteItem[] {
    return [
      ...(hasOwSpriteSlots(this.rom) ? Array.from({ length: OW_SPRITE_SLOTS }, (_, k): SpriteItem => ({ kind: 'sprite', k })) : []),
      ...this.custom.items(),
      ...(hasKoopaKidTable(this.rom) ? Array.from({ length: KOOPA_KIDS }, (_, k): SpriteItem => ({ kind: 'koopa', k })) : []),
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
      if (it.kind === 'custom') this.custom.paint(ctx, it, b, lw, this.showShadows, this.showHeights);
      else if (it.kind === 'sprite') {
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
      if (on) { ctx.strokeStyle = MARK.select; ctx.lineWidth = 2 * lw; ctx.strokeRect(b.x - 1, b.y - 1, b.w + 2, b.h + 2); }
    }
  }

  // ---- interaction (pixels of the map) ----
  // the things under the map's pixel, the topmost first
  private hits(x: number, y: number): SpriteItem[] {
    return this.items().reverse().filter((it) => { const b = this.box(it); return !!b && x >= b.x && y >= b.y && x < b.x + b.w && y < b.y + b.h; });
  }
  down(x: number, y: number): void {
    const hits = this.hits(x, y);
    if (!hits.length && this.custom.placeAt(x, y)) return;
    const it = hits.find((i) => same(this.sel, i)) ?? hits[0] ?? null;
    if (!it || !same(this.sel, it)) this.clicked = false;
    this.sel = it;
    this.drag = it ? { item: it, x0: x, y0: y, dx: 0, dy: 0 } : null;
    this.view.paint();
    // (one clicked: its properties shown, the Sprite tab – one placed or pasted is selected without leaving the palette)
    if (it) this.view.showProps(); else this.view.buildProps();
  }
  // where an item is (pixels; a start: its tile's)
  private pos(it: SpriteItem): { x: number; y: number } {
    if (it.kind === 'start') { const s = readStart(this.rom, it.player); return { x: s.x * 16, y: s.y * 16 }; }
    if (it.kind === 'custom') return this.custom.pos(it);
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
    if (it.kind === 'custom') { this.custom.moveBy(it, d.dx / 8, d.dy / 8); return; }
    if (it.kind === 'sprite') {
      const s = readOwSprites(rom)[it.k];
      this.edit(`Overworld sprite ${it.k + 1}: moved`, () => writeOwSprite(rom, it.k, { ...s, x: (s.x + d.dx) & 0xffff, y: (s.y + d.dy) & 0xffff }));
    } else if (it.kind === 'koopa') {
      const p = koopaKidPos(rom, it.k);
      this.edit(`Koopa Kid ${it.k + 1}: jumps out elsewhere`, () => setKoopaKidPos(rom, it.k, { x: (p.x + d.dx) & 0xffff, y: (p.y + d.dy) & 0xffff }));
    } else {
      const s = readStart(rom, it.player), x = Math.max(0, Math.min(31, s.x + d.dx / 16)), y = Math.max(0, Math.min(31, s.y + d.dy / 16));
      const submap = this.view.submapHere(l1Index(this.view.region, x, y));
      this.edit(`${PLAYERS[it.player]}'s start: moved`, () => writeStart(rom, it.player, { submap, x, y }));
    }
  }
  private select(it: SpriteItem | null): void {
    this.sel = it;
    this.view.paint();
    this.view.buildProps();
  }
  // Ctrl+C: the selected custom sprite copied; Ctrl+V: pasted at the 8px cell under the mouse; Ctrl+D: a copy next to it
  copy(): boolean {
    if (this.sel?.kind !== 'custom') return false;
    this.custom.copy(this.sel);
    return true;
  }
  paste(): boolean {
    const m = this.view.mouse;
    return !!m && this.custom.paste(m.x, m.y);
  }
  duplicate(): boolean {
    if (this.sel?.kind !== 'custom') return false;
    this.custom.duplicate(this.sel);
    return true;
  }
  // the palette's pick dropped (Escape); false: none was picked
  unpick(): boolean {
    if (this.custom.picked === null) return false;
    this.custom.pick(null);
    return true;
  }

  // the selection ended (Escape); false: none was selected
  deselect(): boolean {
    if (!this.sel) return false;
    this.select(null);
    return true;
  }

  // the selected sprite removed (its slot none)
  remove(): boolean {
    const s = this.sel;
    if (s?.kind === 'custom') { this.custom.remove(s); return true; }
    if (s?.kind !== 'sprite') return false;
    const sp = readOwSprites(this.rom)[s.k];
    if (sp.num) this.edit(`Overworld sprite ${s.k + 1}: none`, () => writeOwSprite(this.rom, s.k, { ...sp, num: 0 }));
    return true;
  }
  private edit(what: string, f: () => void): void { try { this.view.app.romEdit(what, f); } catch (e) { refusedToast(this.rom, e); } }

  // the side panel in the sprites mode: the installed custom sprites to place
  palette(): HTMLElement[] {
    const out = this.custom.palette();
    out.push(h('div', { class: 'hint' }, bowsieInstalled(this.rom) ? 'BOWSIE is installed: the game\'s 13 sprite slots are gone – its sprites come as custom overworld sprites now (BOWSIE\'s “originals”).'
      : 'The game\'s sprites: drawn as the game shows them on this map at the event progress; a dashed box where it doesn\'t show the sprite.'),
      h('div', { class: 'hint' }, 'Shadows and height marks: View.'));
    return out;
  }
  // ---- properties ----
  // how a sprite is selected (the Sprite tab's tooltip while nothing is)
  howToSelect(): string {
    return 'Click a sprite, a start position (M, L) or where a Koopa Kid jumps out (K1–K3) to select it – again for the next one under it; drag to move it (8 pixels, 1 with Shift). ' +
      (hasOwSpriteSlots(this.rom) ? 'The sprite slots are the same on every submap: each sprite shows where its code lets it. ' : '') + 'Custom sprites: pick one in the palette and click on the map to place it; Ctrl+C / Ctrl+V copy one, Delete removes it.';
  }
  // whether a sprite is selected (one gone – undone, deleted, BOWSIE's MaxTile took the Koopa Kids' table – no longer)
  hasSelection(): boolean {
    if (this.sel?.kind === 'custom' && !this.custom.has(this.sel)) this.sel = null;
    if (this.sel?.kind === 'koopa' && !hasKoopaKidTable(this.rom)) this.sel = null;
    return !!this.sel;
  }
  props(): HTMLElement {
    this.hasSelection();
    const s = this.sel, rom = this.rom;
    if (!s) return h('div', { class: 'ow-info' }, emptyState(this.howToSelect()));
    if (s.kind === 'custom') return this.custom.props(s);
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
        h('div', { class: 'hint' }, `Jumps out here when Mario stands on its tile (paint tile ${hex(KOOPA_TILE + s.k, 2)} on layer 1); its place, where Mario goes after losing to it, is set in the layer 1 mode (its tile's menu: Mario is put at…).`),
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
