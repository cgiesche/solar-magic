// The level tiles as objects on the map (the overworld view's "Levels" mode, ADR 0012): a click selects a level tile
// (its settings in the Properties panel), a drag moves it – it swaps with the tile where it is dropped, its translevel
// with it –, Delete leaves the stop tile, a right click places a level on a cell ("Place level here…": the level and
// its look chosen), a level without a level tile is dragged from the list onto the map. Each change one ROM edit of
// the map before events – with event X chosen in the strip a layer 1 change of that event (the level tiles as after it) –
// (owleveltiles.ts), made once the path kinds, the submaps' views and an event's maps are known.

import type { OverworldView, PickCheck } from './overworld.ts';
import type { Rom } from '../core/rom.ts';
import { h, toast, modal } from './dom.ts';
import { refusedToast } from './owrefusal.ts';
import { contextMenu } from './menu.ts';
import { levelPicker } from './levelpicker.ts';
import {
  l1Index, l1XY, translevelToLevel, freeTranslevel, translevelUse, enterableLevels, levelTilesOf, baseEvent, readTranslevels, NO_EVENT,
} from '../core/overworld.ts';
import {
  levelTileLooks, invisibleLevelTile, defaultLook, stopTile, moveLevelTile, removeLevelTile, placeLevelTile, levelsWithoutTile, moveLevelTileCheck, placeLevelTileCheck,
  type LevelTileEvent,
} from '../core/owleveltiles.ts';
import { hasMessages } from '../core/messages.ts';
import { levelName, hasLevelName } from '../core/levelnames.ts';
import { mainTranslevel } from '../core/level.ts';
import { l1Hex } from '../core/owl1sheet.ts';
import { cellText } from '../core/oweventtiles.ts';
import { hex } from '../core/names.ts';

// the level picker's note for a level no tile enters: what a tile choosing it gets (translevelUse)
function freeNote(rom: Rom, tl: number): string {
  if (translevelUse(rom, tl) === 2) return 'free · has a level';
  const has = [hasLevelName(rom, tl) && 'name', baseEvent(rom, tl) !== NO_EVENT && 'event', hasMessages(rom, tl) && 'message'].filter(Boolean);
  return has.length ? `free · has ${has.join(', ')}` : 'free';
}
// where layer 1 tile k (l1Index) is: its map region and cell
export const tilePlace = cellText;
const levelHex = (tl: number) => hex(translevelToLevel(tl), 3);

export class LevelTileLayer {
  // a level tile being dragged (l1Index) to the cell under the mouse
  drag: { from: number; to: number } | null = null;
  // the translevel of a level dragged from the list ("Without level tile") onto the map
  dragged = 0;
  constructor(private view: OverworldView) {}

  private get rom() { return this.view.app.rom; }

  // why the level tiles can't be changed now (null: they can): as layer 1 painting, not before the path kinds (which
  // tiles are level tiles), the submaps' views and, with an event chosen, its maps are known
  blocked(): string | null {
    const v = this.view;
    if (!v.pathKinds()) return 'The path tiles are still being learned – level tiles can be changed in a moment.';
    if (!v.views) return 'The submaps are still being loaded – level tiles can be changed in a moment.';
    const ev = v.levelEvent();
    return typeof ev === 'string' ? ev : null;
  }
  // whether the level tiles can be changed now; if not, said why
  private ready(): boolean {
    const why = this.blocked();
    if (why) toast(why);
    return !why;
  }
  // the event the changes go into (null: the map before events; once ready)
  private event(): LevelTileEvent | null {
    const ev = this.view.levelEvent();
    return typeof ev === 'string' ? null : ev;
  }
  // an edit's label: in an event, which one
  private where(label: string): string {
    const e = this.view.event;
    return e >= 0 ? `${label} (after event ${hex(e, 2)})` : label;
  }
  // the look of a level tile placed without choosing one (once the path kinds are known)
  private defaultLook(): number {
    return defaultLook(levelTileLooks(this.rom, this.view.pathKinds() ?? []));
  }
  // a level tile's ROM edit, the tile at `select` selected after it; false: not made (said why)
  private edit(label: string, f: () => void, select: number): boolean {
    if (!this.ready()) return false;
    try {
      this.view.selected = select;
      this.view.app.romEdit(this.where(label), f);
      return true;
    } catch (e) {
      refusedToast(this.rom, e);
      this.view.sync();
      return false;
    }
  }
  // the name of the level tile at i in an edit's label (in a sentence: `lower`)
  private label(i: number, lower = false): string {
    const tl = this.view.tls[i], { x, y } = l1XY(i);
    return `${lower ? 'l' : 'L'}${tl ? `evel ${levelHex(tl)}` : `evel tile ${hex(x, 2)},${hex(y, 2)}`}`;
  }
  // (the level tiles as after the event chosen)
  private isLevelAt(i: number): boolean { return this.view.isLevelTile(this.view.levelL1()[i]); }
  private inside(x: number, y: number): boolean { return x >= 0 && y >= 0 && x < 32 && y < 32; }

  // the pick pending (#348): where the level tile dragged can go, or the level dragged from the list be placed (as after
  // the event chosen; null: none, or the level tiles can't be changed now)
  pickCheck(): PickCheck | null {
    if (this.blocked()) return null;
    const rom = this.rom, ev = this.event(), e = this.view.event, d = this.drag, tl = this.dragged;
    if (d) return { key: `move:${d.from}:${e}`, dep: ev?.after, make: () => moveLevelTileCheck(rom, d.from, ev) };
    if (tl) { const look = this.defaultLook(); return { key: `place:${tl}:${look}:${e}`, dep: ev?.after, make: () => placeLevelTileCheck(rom, look, tl, ev) }; }
    return null;
  }

  // ---- the mouse ----
  // a click on cell (x, y): a level tile selected and picked up, else nothing selected
  down(x: number, y: number): void {
    if (!this.inside(x, y)) return;
    const v = this.view, i = l1Index(v.region, x, y);
    if (!this.isLevelAt(i)) { v.selectTile(-1, false); return; }
    v.selectTile(i, false);
    this.drag = { from: i, to: i };
  }
  // (the view paints)
  move(x: number, y: number): void {
    const d = this.drag;
    if (!d) return;
    const to = l1Index(this.view.region, Math.max(0, Math.min(31, x)), Math.max(0, Math.min(31, y)));
    d.to = to;
  }
  // dropped: the level tile swaps with the tile there
  up(): void {
    const d = this.drag;
    this.drag = null;
    this.view.paint();
    this.view.updateStatus();
    if (!d || d.to === d.from) return;
    const { x, y } = l1XY(d.to);
    this.edit(`${this.label(d.from)}: moved to ${hex(x, 2)},${hex(y, 2)}`, () => moveLevelTile(this.rom, d.from, d.to, this.event()), d.to);
  }
  // Esc: the drag dropped, nothing changed; false: none
  cancel(): boolean {
    if (!this.drag) return false;
    this.drag = null;
    this.view.paint();
    this.view.updateStatus();
    return true;
  }

  // Delete: the selected level tile removed (the stop tile in its place); false: none selected
  remove(): boolean {
    const v = this.view, i = v.selected;
    if (i < 0 || !this.isLevelAt(i)) return false;
    // (in an event a level tile removed keeps its translevel where the cell has one on another map: the level keeps a tile)
    const label = this.label(i), tl = v.tls[i];
    if (this.edit(`${label}: level tile removed`, () => removeLevelTile(this.rom, i, stopTile(v.pathKinds()!), this.event()), i) && tl
      && levelsWithoutTile(readTranslevels(this.rom)).includes(tl))
      toast(`${label} has no level tile now (its settings stay with it): it is listed under "Without level tile".`);
    return true;
  }

  // a right click on cell (x, y) (cx, cy: where on the screen): "Place level here…", on a level tile also its removal
  menu(cx: number, cy: number, x: number, y: number): void {
    if (!this.inside(x, y)) return;
    const v = this.view, i = l1Index(v.region, x, y), level = this.isLevelAt(i);
    contextMenu(cx, cy, [
      { heading: `Tile ${hex(x, 2)},${hex(y, 2)} · ${l1Hex(v.levelL1()[i])}` },
      { label: level ? 'Place another level here…' : 'Place level here…', onClick: () => this.placeDialog(i) },
      ...(level ? [{ label: 'Remove level tile', shortcut: 'Del', onClick: () => { v.selectTile(i, false); this.remove(); } }] : []),
    ]);
  }

  // ---- placing ----
  // the dialog placing a level at i: the level (a free one proposed) and its look
  placeDialog(i: number): void {
    if (!this.ready()) return;
    const v = this.view, rom = this.rom, { x, y } = l1XY(i);
    const free = freeTranslevel(v.tls, (n) => translevelUse(rom, n));
    let tl = free || 1;
    let look = this.defaultLook();
    const body = h('div', { class: 'ow-place' });
    const build = () => body.replaceChildren(
      h('div', { class: 'prop' }, h('label', null, 'Level'), this.levelChoice(tl, i, (t) => { tl = t; build(); })),
      ...(free ? [] : [h('div', { class: 'hint warn-text' }, '⚠ Every level (001–024, 101–13B) already has a level tile: the one chosen will be entered from two.')]),
      ...(v.event >= 0 ? [h('div', { class: 'hint' }, `Placed as after event ${hex(v.event, 2)}: the map before it stays.`)] : []),
      h('div', { class: 'hint' }, `Tile ${hex(x, 2)},${hex(y, 2)} · now ${l1Hex(v.levelL1()[i])}${this.isLevelAt(i) ? ` (level ${levelHex(v.tls[i])}, which will have no level tile)` : ''}`),
      h('div', { class: 'prop' }, h('label', null, 'Look')),
      this.lookPicker(look, (t) => { look = t; build(); }));
    build();
    modal('Place level here', body, [{ label: 'Place', primary: true, onClick: () => { this.place(i, look, tl); } }, { label: 'Cancel' }]);
  }
  // a level (translevel tl) placed at i with look `look`
  place(i: number, look: number, tl: number): void {
    const v = this.view, { x, y } = l1XY(i);
    const others = levelTilesOf(v.levelL1(), v.tls, tl, v.isLevelTile).filter((k) => k !== i);
    if (this.edit(`Level ${levelHex(tl)}: placed at ${hex(x, 2)},${hex(y, 2)}`, () => placeLevelTile(this.rom, i, look, tl, this.event()), i) && others.length)
      toast(`Level ${levelHex(tl)} is entered from ${others.length + 1} tiles – drag a level tile to move it.`);
  }
  // a level dragged from the list dropped on cell (x, y): placed with the default look
  drop(x: number, y: number): void {
    const tl = this.dragged;
    this.dragged = 0;
    if (!tl || !this.inside(x, y) || !this.ready()) return;
    this.place(l1Index(this.view.region, x, y), this.defaultLook(), tl);
  }

  // the level a tile at i enters, chosen from the levels (notes: where another tile enters it, what a free one brings)
  levelChoice(tl: number, i: number, onPick: (tl: number) => void): HTMLElement {
    const v = this.view, rom = this.rom;
    const levels = v.levelL1(), onMap = (t: number) => v.tls.findIndex((n, k) => n === t && k !== i && v.isLevelTile(levels[k]));
    return levelPicker(v.app, translevelToLevel(tl), (lvl) => onPick(mainTranslevel(lvl)!), {
      levels: enterableLevels(),
      note: (lvl) => { const t = mainTranslevel(lvl)!, k = onMap(t); return k >= 0 ? `on ${tilePlace(k)}` : t === v.tls[i] ? '' : freeNote(rom, t); },
    });
  }

  // the level tiles' looks (the visible tiles the path kinds call "level", and one drawn on layer 2) as a row of
  // tiles, `current` marked; a click picks one
  lookPicker(current: number, onPick: (t: number) => void): HTMLElement {
    const v = this.view, kinds = v.pathKinds();
    if (!kinds) return h('div', { class: 'hint' }, 'The level tiles are being learned …');
    const inv = invisibleLevelTile(this.rom, kinds);
    const looks = [...levelTileLooks(this.rom, kinds), ...(inv >= 0 ? [inv] : [])];
    if (!looks.includes(current)) looks.push(current);
    return h('div', { class: 'ow-looks' }, ...looks.map((t) => h('button', {
      class: `ow-look${t === current ? ' current' : ''}`,
      title: `Tile ${l1Hex(t)}${t === inv ? ' · invisible: for a level drawn on layer 2 (a castle, a fortress)' : ''}`,
      onclick: () => { if (t !== current) onPick(t); },
    }, v.tileImage(t))));
  }
  // the look of the level tile at i changed (its translevel kept)
  setLook(i: number, look: number): void {
    this.edit(`${this.label(i)}: look ${l1Hex(look)}`, () => placeLevelTile(this.rom, i, look, this.view.tls[i], this.event()), i);
  }

  // ---- drawing ----
  // a level tile being dragged: the two cells as after the swap (layer 1 of each in the other's place), the target
  // outlined; else the cell under the mouse
  paint(ctx: CanvasRenderingContext2D, lw: number): void {
    const v = this.view, d = this.drag;
    if (d && d.to !== d.from) {
      const a = l1XY(d.from), b = l1XY(d.to), l1 = v.l1Image;
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(a.x * 16, a.y * 16, 16, 16);
      ctx.fillRect(b.x * 16, b.y * 16, 16, 16);
      ctx.drawImage(l1, b.x * 16, b.y * 16, 16, 16, a.x * 16, a.y * 16, 16, 16);
      ctx.drawImage(l1, a.x * 16, a.y * 16, 16, 16, b.x * 16, b.y * 16, 16, 16);
      ctx.lineWidth = lw;
      ctx.setLineDash([3 * lw, 2 * lw]);
      ctx.strokeStyle = '#4cc2ff';
      ctx.strokeRect(a.x * 16, a.y * 16, 16, 16);
      ctx.setLineDash([]);
      ctx.strokeStyle = 'rgba(255,255,0,0.9)';
      ctx.strokeRect(b.x * 16, b.y * 16, 16, 16);
      return;
    }
    const c = v.hover;
    if (!c || !this.inside(c.x, c.y)) return;
    ctx.strokeStyle = 'rgba(255,255,0,0.9)';
    ctx.lineWidth = lw;
    ctx.strokeRect(c.x * 16, c.y * 16, 16, 16);
  }

  // the status bar while a level tile is dragged (null: none)
  status(): string | null {
    const v = this.view, d = this.drag;
    if (!d || d.to === d.from) return null;
    const { x, y } = l1XY(d.to), there = this.isLevelAt(d.to) && v.tls[d.to] ? `level ${levelHex(v.tls[d.to])}` : `tile ${l1Hex(v.levelL1()[d.to])}`;
    return `Drop: ${this.label(d.from, true)} to ${hex(x, 2)},${hex(y, 2)}, swapping with ${there} · Esc cancels`;
  }

  // the list's levels without a level tile (translevels no tile on any map holds), each dragged onto the map in the
  // levels mode to place it; a double click opens it
  withoutTile(tls: number[]): HTMLElement[] {
    const rom = this.rom, look = l1Hex(this.defaultLook()), on = this.view.mode === 'levels';
    return tls.map((tl) => h('div', {
      class: 'level-item unused', draggable: on,
      title: `${levelName(rom, tl)}\n${on ? `Drag onto the map to place it (look ${look}) · Right click on the map: Place level here…` : 'Placed in the Levels mode (3)'} · Double click: open in the level editor`,
      ondragstart: (e: DragEvent) => { this.dragged = tl; e.dataTransfer?.setData('text/plain', levelHex(tl)); },
      ondragend: () => { this.dragged = 0; this.view.hover = null; this.view.paint(); },
      ondblclick: () => this.view.onOpenLevel(translevelToLevel(tl)),
    }, levelHex(tl), h('span', { class: 'lname' }, ` ${levelName(rom, tl)}`)));
  }
}
