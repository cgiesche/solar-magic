// The overworld links on layer 1 (the overworld view's layer 1 mode, #413; no mode of their own): star/pipe and exit
// path links, the locations exits to the overworld teleport to and the Koopa Kids' places. Each cell a link ends at
// (owlinks.ts linkEndCells) is an object there: hatched, left alone by painting, with a mark of its kind in its corner;
// the arrows (one head one-way, two heads both ways; locations and Koopa Kids' places dashed from the tiles they belong
// to) only of the selected tile – all with View → "Link arrows". A tile is linked by "Link to…" (its menu or
// properties) and a click on the target (the pick pending: refused tiles hatched, the map's cursor a crosshair; Esc
// cancels): an exit path tile by an exit path (the side its path goes on found from the path tiles around it, the
// target's the opposite one), a star or pipe (a tile where A warps) by a star/pipe link, a Koopa Kid's tile by its place. Dragging the
// selected link's other end, a location or a Koopa Kid's place moves it; "Remove link" (menu, Delete) removes it, the
// tile staying. A link end dropped on a tile several submaps' views show asks which submap at the cursor, the one whose
// paths the tile is on first (core/owlinkends.ts endChoice). Each change is one ROM edit (owlinks.ts).

import type { OverworldView, PickCheck } from './overworld.ts';
import { l1Hex } from '../core/owl1sheet.ts';
import { h, toast, checkbox, select, emptyState } from './dom.ts';
import { refusedToast, refusalWords } from './owrefusal.ts';
import { OwRefusal, type OwRefusalData } from '../core/owrefusal.ts';
import { linkTableFix } from './owfixes.ts';
import {
  readLinks, linkEndCells, warpCells, makeLink, removeLink, setBothWays, moveLocation, locationUses, pathSide, koopaTeleport, setKoopaTeleport, sidesMatch, exitOut, exitOutText,
  KOOPAS, KOOPA_TILE, koopaOfTile, koopaPlaceRefusal, linkCheck, locationMoveRefusal, type OwLink, type LinkEnd, type LinkKind,
} from '../core/owlinks.ts';
import { readTeleports, tileText, sameTile, type OwTile } from '../core/owteleport.ts';
import { l1Index, l1XY, DIR_NAMES, DIR_ARROWS, MAP_NAMES } from '../core/overworld.ts';
import { inView } from '../core/owevents.ts';
import { endChoice, endChoiceText, clickedLinks, submapsShowing, endTile } from '../core/owlinkends.ts';
import { contextMenu, type MenuItem } from './menu.ts';
import { isPathKind, PATH_KIND_NAMES } from '../core/owpaths.ts';
import { ExitGraph } from '../core/exitgraph.ts';
import { readSecondaryEntrance, levelTranslevel } from '../core/level.ts';
import { hex } from '../core/names.ts';
import { stuckOnArrival, stuckOnArrivalText, ARRIVAL_RULE, type ArrivalHow } from '../core/owreach.ts';

// what is selected: a link, a location (a star/pipe entry exits to the overworld teleport to), a Koopa Kid's place,
// a tile no link starts at (to link it to a tile on another map)
type Sel = { kind: 'link'; link: OwLink } | { kind: 'location'; i: number } | { kind: 'koopa'; k: number } | { kind: 'tile'; t: OwTile };
// what is moved: the selected link's target (`target`) or source, a location, a Koopa Kid's place
type Moved = { sel: Sel; target: boolean };
// a drag from a tile (l1Index) to another: a new link, or moving something
type Drag = { from: number; to: number; move: Moved | null };
// what a tile links by: an exit path, a star/pipe link, a Koopa Kid's place; null with why it doesn't
type Source = { kind: LinkKind | 'koopa'; why?: undefined } | { kind: null; why: string; refusal?: OwRefusalData };

// a link end shown whose other end lies on another map: its tile (l1Index), the label's text, the link and the end
export type OffMapEnd = { i: number; text: string; link: OwLink | null; there: OwTile };

const COLORS = { star: '#c58cff', exit: '#ff6b6b', location: '#4cc2ff', koopa: '#ffa94c' };
const center = (t: { x: number; y: number }) => ({ x: t.x * 16 + 8, y: t.y * 16 + 8 });

export class LinkLayer {
  sel: Sel | null = null;
  drag: Drag | null = null;
  // a source chosen to be linked to a tile on another map (the next click), or what is moved there
  pending: { from: OwTile } | { move: Moved } | null = null;
  both = true; // new links both ways
  show = false; // every link's arrows (View → "Link arrows"); else the selected tile's
  // the ends of the links painted whose other end is on another map: labelled under their tile (owlevelname.ts
  // TileLabels), with a jump there; gathered by paint, cleared by the view before it paints the map
  offMap: OffMapEnd[] = [];
  private data: { gen: number; links: OwLink[]; uses: Map<number, number[]>; levels: Map<number, number[]> | null; warps: Set<number> | null } | null = null;
  constructor(private view: OverworldView) {}

  private get rom() { return this.view.app.rom; }
  // the links of the ROM, the locations entrances teleport to (read again after a ROM change)
  info(): NonNullable<LinkLayer['data']> {
    const gen = this.rom.gen;
    if (this.data?.gen !== gen) {
      const kinds = this.view.pathKinds();
      const isExit = (t: OwTile) => kinds?.[this.view.shown.l1[this.index(t)]] === 'exit';
      this.data = { gen, links: readLinks(this.rom, isExit), uses: locationUses(this.rom), levels: null, warps: null };
      // the selection follows the ROM (undo, another change): the link of the same tile and kind, else none
      const s = this.sel;
      if (s?.kind === 'link') {
        const l = this.data.links.find((k) => k.kind === s.link.kind && sameTile(k.a, s.link.a));
        this.sel = l ? { kind: 'link', link: l } : null;
      }
    }
    return this.data;
  }
  // the levels whose exits lead through each location's entrances (the entrance's own level when none does): the
  // exits of every level, read once per ROM change and only when a location is used
  private locationLevels(i: number): number[] {
    const d = this.info();
    if (!d.levels) {
      const g = new ExitGraph(this.rom);
      d.levels = new Map([...d.uses].map(([k, ents]) => [k, [...new Set(ents.flatMap((e) => {
        const from = g.usersOfEntrance(e).map((r) => r.from);
        return from.length ? from : [readSecondaryEntrance(this.rom, e).destLevel];
      }))]]));
    }
    return d.levels.get(i) ?? [];
  }

  // the layer 1 cells link ends are at on the map shown (owlinks.ts linkEndCells): objects there, left alone by painting
  private cellsOf: { gen: number; l1: ArrayLike<number>; cells: Set<number> } | null = null;
  cells(): Set<number> {
    const gen = this.rom.gen, l1 = this.view.shown.l1;
    if (this.cellsOf?.gen !== gen || this.cellsOf.l1 !== l1) this.cellsOf = { gen, l1, cells: linkEndCells(this.rom, l1, this.info().links) };
    return this.cellsOf.cells;
  }

  // ---- tiles ----
  private index(t: OwTile): number { return endTile(t); }
  // the tile at i where the user acts: on the submap shown when i shows in its view (OverworldView.submapHere)
  private tile(i: number): OwTile {
    const { x, y } = l1XY(i);
    return { submap: this.view.submapHere(i), x, y };
  }
  // the tile at i the ROM has (a Koopa Kid's tile): only the tile known, on the submap submapOf gives
  private romTile(i: number): OwTile {
    return { submap: this.view.submapAt(i), ...l1XY(i) };
  }
  private shown(t: OwTile): boolean { return (t.submap ? 1 : 0) === this.view.region; }
  // the submaps a link end at tile i can be on, the one preselected first (core/owlinkends.ts endChoice: the submap whose
  // paths it is on – the map with every event passed, as searched – else the one shown, else the nearest view's)
  private choice(i: number): number[] {
    const views = this.view.views, kinds = this.view.pathKinds();
    if (!views || !kinds) return [this.view.submapHere(i)];
    return endChoice(this.view.reach.state()?.all.inp.l1 ?? this.view.shown.l1, kinds, views, i, this.view.map);
  }
  // the submaps whose views show tile i, the one the user acts on first: where links ending at i are looked for
  private around(i: number): number[] {
    const here = this.view.submapHere(i), views = this.view.views;
    return [here, ...views ? submapsShowing(views, i).filter((s) => s !== here) : []];
  }
  // whether link end e is at tile i on one of the submaps whose views show it
  private endsAt(e: OwTile, i: number): boolean { return this.index(e) === i && this.around(i).includes(e.submap); }
  // whether Mario, put on tile i standing by a star/pipe link or a teleport, can't move there (core/owreach.ts
  // stuckOnArrival, the search at the event progress shown; false while it is learned); back: the tile gets an entry back
  private stuck(i: number, back = false): boolean {
    const now = this.view.reach.state()?.now;
    return !!now && stuckOnArrival(now.inp, now.r.flags, i, back);
  }
  // the warning of tile t Mario arrives at standing (null: he can move there)
  private stuckBox(t: OwTile, how: ArrivalHow): HTMLElement | null {
    const now = this.view.reach.state()?.now, i = this.index(t);
    if (!now || !this.stuck(i)) return null;
    return h('div', { class: 'warn-box', title: `${ARRIVAL_RULE} At the event progress shown.` }, `${stuckOnArrivalText(now.inp, i, tileText(t), how)}.`);
  }
  // what the end of a drag or pending choice (`move`, else a new link from tile `from`) at tile i says when Mario would
  // arrive there standing and can't move: a star/pipe link's target, a location
  private stuckNote(move: Moved | null, from: number, i: number): string {
    // (what is dropped: a link's target – its source is where Mario takes it –, a location, a new link's target)
    const s = move?.sel;
    let kind: string | null, back: boolean;
    if (!s) { kind = this.source(from).kind; back = this.both; }
    else if (s.kind === 'link') { kind = move!.target ? s.link.kind : null; back = s.link.both; }
    else { kind = s.kind; back = false; }
    return (kind === 'star' || kind === 'location') && this.stuck(i, back) ? ' · Mario can\'t move there' : '';
  }
  // the tile i as a link end goes there: on the submap chosen – asked at the cursor (cx, cy) when several views show it
  // (a menu, the preselected first: Enter takes it; Esc or a click elsewhere: nothing done)
  // (note: said beside each choice – " · Mario can't move there")
  private ask(i: number, cx: number, cy: number, then: (t: OwTile) => void, note = ''): void {
    const choice = this.choice(i), { x, y } = l1XY(i);
    if (choice.length < 2) { then({ submap: choice[0], x, y }); return; }
    contextMenu(cx, cy, [{ heading: 'In an overlap of submaps' }, ...choice.map((s, k) => ({
      label: `${tileText({ submap: s, x, y })}${note}`, title: k ? undefined : 'Its paths are this submap\'s (Enter)', onClick: () => then({ submap: s, x, y }),
    }))], true);
  }
  // what tile i links by: an exit path from an exit path tile (or one an exit path already starts at, as the game's
  // cave), a star/pipe link from a tile where A warps – a star or pipe – at some event progress (owlinks.ts warpCells,
  // #455: not a level tile nor a plain stop tile), a Koopa Kid's place from its tile
  private source(i: number, t = this.tile(i)): Source {
    if (this.koopaAt(i) >= 0) return { kind: 'koopa' };
    if (this.info().links.some((l) => l.kind === 'exit' && (sameTile(l.a, t) || (l.both && sameTile(l.b, t))))) return { kind: 'exit' };
    const kinds = this.view.pathKinds();
    if (!kinds) return { kind: null, why: 'the path tiles are still being learned – try again in a moment' };
    const k = kinds[this.view.shown.l1[i]];
    if (k === 'exit') return { kind: 'exit' };
    const info = this.info();
    if (k === 'warp' || (info.warps ??= warpCells(this.rom, kinds)).has(i)) return { kind: 'star' };
    const refusal: OwRefusalData = { kind: 'linkNoStart', tile: this.view.shown.l1[i], path: PATH_KIND_NAMES[k].toLowerCase() };
    return { kind: null, why: refusalWords(this.rom, refusal).reason, refusal };
  }
  // an exit path tile's end: the side its path goes on (toward a path tile around it)
  private exitEnd(t: OwTile): LinkEnd {
    const kinds = this.view.pathKinds(), region = t.submap ? 1 : 0;
    const side = pathSide(t, (x, y) => { const k = kinds?.[this.view.shown.l1[l1Index(region, x, y)]]; return !!k && (isPathKind(k) || k === 'level') && k !== 'exit'; });
    return { ...t, side };
  }
  // the Koopa Kid whose tile i is (-1 none)
  private koopaAt(i: number): number { return koopaOfTile(this.view.shown.l1[i]); }
  // the tiles of the shown region with Koopa Kid k's tile
  private koopaTiles(k: number): number[] {
    const base = this.view.region * 0x400;
    return Array.from({ length: 0x400 }, (_, j) => base + j).filter((j) => this.koopaAt(j) === k);
  }
  // the level tiles of the shown region entering these levels
  private levelTiles(levels: number[]): number[] {
    const tls = new Set(levels.map((l) => levelTranslevel(this.rom, l)).filter((t) => t > 0)), base = this.view.region * 0x400, out: number[] = [];
    for (let i = base; i < base + 0x400; i++) if (tls.has(this.view.tls[i]) && this.view.isLevelTile(this.view.l1[i])) out.push(i);
    return out;
  }

  // ---- drawing ----
  // the marks of the link ends of the region shown, and the arrows: the selected tile's (its links, the locations its
  // level's exits teleport to, its Koopa Kid's place) or, with `show`, all; what is dragged or chosen where it goes
  paint(ctx: CanvasRenderingContext2D, lw: number): void {
    const { links, uses } = this.info(), sel = this.sel, d = this.drag, moving = d?.move ?? null, at = this.view.selected;
    const isMoved = (s: Sel) => !!moving && JSON.stringify(moving.sel) === JSON.stringify(s);
    this.marks(ctx, lw);
    for (const l of links) {
      const on = sel?.kind === 'link' && sel.link === l;
      if (on && moving) continue;
      if (!this.show && !on && !(at >= 0 && (this.endsAt(l.a, at) || this.endsAt(l.b, at)))) continue;
      this.link(ctx, lw, l.a, l.b, COLORS[l.kind], l.both, on, l);
    }
    const teleports = readTeleports(this.rom);
    for (const [i] of uses) {
      const to = isMoved({ kind: 'location', i }) ? this.tile(d!.to) : teleports[i].to;
      if (!to || !this.shown(to)) continue;
      // (the selected level tile's: drawn with its exits' results – paintExitResults)
      const on = sel?.kind === 'location' && sel.i === i, from = this.levelTiles(this.locationLevels(i));
      if (!this.show && !on && this.index(to) !== at) continue;
      for (const t of from) arrow(ctx, lw, center(l1XY(t)), center(to), COLORS.location, false, on, true);
      marker(ctx, lw, center(to), COLORS.location, on);
    }
    for (let k = 0; k < KOOPAS; k++) {
      const place = isMoved({ kind: 'koopa', k }) ? l1XY(d!.to) : koopaTeleport(this.rom, k), from = this.koopaTiles(k);
      if (!place || !from.length) continue;
      const on = sel?.kind === 'koopa' && sel.k === k;
      if (!this.show && !on && !from.includes(at)) continue;
      for (const t of from) arrow(ctx, lw, center(l1XY(t)), center(place), COLORS.koopa, false, on, true);
      marker(ctx, lw, center(place), COLORS.koopa, on);
    }
    if (d && moving?.sel.kind === 'link') {
      const l = moving.sel.link, to = this.tile(d.to);
      this.link(ctx, lw, moving.target ? l.a : to, moving.target ? to : l.b, COLORS[l.kind], l.both, true);
    }
    // (a link being made: from its tile to the cell under the mouse)
    const p = this.pending, hover = this.view.hover;
    if (p && 'from' in p && this.shown(p.from) && hover && hover.x >= 0 && hover.y >= 0 && hover.x < 32 && hover.y < 32) {
      const k = this.source(this.index(p.from), p.from).kind;
      if (k) arrow(ctx, lw, center(p.from), { x: hover.x * 16 + 8, y: hover.y * 16 + 8 }, COLORS[k], this.both && k !== 'koopa', true, k === 'koopa');
    }
  }
  // a small dot of its kind's colour in the top right corner of each cell a link ends at (the region shown)
  private marks(ctx: CanvasRenderingContext2D, lw: number): void {
    const { links, uses } = this.info(), dots = new Map<number, string>();
    const put = (t: OwTile, c: string) => { if (this.shown(t) && !dots.has(this.index(t))) dots.set(this.index(t), c); };
    for (const l of links) { put(l.a, COLORS[l.kind]); put(l.b, COLORS[l.kind]); }
    const teleports = readTeleports(this.rom);
    for (const [i] of uses) { const to = teleports[i].to; if (to) put(to, COLORS.location); }
    for (let k = 0; k < KOOPAS; k++) {
      const p = koopaTeleport(this.rom, k), from = this.koopaTiles(k);
      if (!p || !from.length) continue;
      for (const t of from) dots.set(t, COLORS.koopa);
      dots.set(l1Index(this.view.region, p.x, p.y), COLORS.koopa);
    }
    for (const [i, c] of dots) {
      const { x, y } = l1XY(i);
      ctx.beginPath();
      ctx.arc(x * 16 + 13, y * 16 + 3, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = c;
      ctx.fill();
      ctx.lineWidth = lw;
      ctx.strokeStyle = 'rgba(0,0,0,0.85)';
      ctx.stroke();
    }
  }
  // a link's arrow; an end whose other end is on another map: labelled under its tile with where it leads (offMap)
  private link(ctx: CanvasRenderingContext2D, lw: number, a: OwTile, b: OwTile, color: string, both: boolean, on: boolean, l: OwLink | null = null): void {
    if (this.shown(a) && this.shown(b)) { arrow(ctx, lw, center(a), center(b), color, both, on, false); return; }
    const [here, there, out] = this.shown(a) ? [a, b, true] : this.shown(b) ? [b, a, both] : [null, null, false];
    if (!here || !there) return;
    const i = this.index(here), text = `${both ? '↔' : out ? '→' : '←'} ${tileText(there)}`;
    if (!this.offMap.some((e) => e.i === i && e.text === text)) this.offMap.push({ i, text, link: l, there });
  }
  // the map of an off-map end's other end shown, its tile selected, the link selected (a click on its label's jump)
  jump(e: OffMapEnd): void {
    if (e.link) this.sel = { kind: 'link', link: e.link };
    this.goTo(e.there);
  }

  // the pick pending (#348): the tiles the link dragged (or chosen to lead to a tile on another map) can lead to, where
  // its moved end or a Koopa Kid's place can go (null: none, or a drag from a tile that links nothing)
  pickCheck(): PickCheck | null {
    const d = this.drag, p = this.pending, rom = this.rom, dep = this.view.shown.l1;
    if (!d && !p) return null;
    const move = d ? d.move : p && 'move' in p ? p.move : null;
    // (tile(i) takes the submap shown: the key has the map)
    const key = (what: object) => JSON.stringify({ ...what, both: this.both, map: this.view.map });
    if (move) {
      const s = move.sel;
      if (s.kind === 'link') {
        const l = s.link, end = this.endOf(l.kind);
        return { key: key({ move: l.entries, target: move.target }), dep, make: () => {
          const c = linkCheck(rom, l.kind, l.both, l);
          return (i) => (move.target ? c(l.a, end(this.tile(i))) : c(end(this.tile(i)), l.b));
        } };
      }
      if (s.kind === 'location') return { key: key({ location: s.i }), dep, make: () => { const why = locationMoveRefusal(rom, s.i); return () => why; } };
      if (s.kind !== 'koopa') return null;
      const from = this.koopaTiles(s.k)[0];
      if (from === undefined) return null;
      return { key: key({ koopa: s.k, from }), dep, make: () => (i) => koopaPlaceRefusal(this.romTile(from), this.tile(i)) };
    }
    // (a pending link's source as chosen, on the map shown then)
    const chosen = !d && p && 'from' in p ? p.from : null, from = d ? d.from : chosen ? this.index(chosen) : -1;
    if (from < 0) return null;
    const a = chosen ?? this.tile(from), src = this.source(from, a);
    if (src.kind === 'koopa') return { key: key({ koopaFrom: from }), dep, make: () => (i) => koopaPlaceRefusal(a, this.tile(i)) };
    const kind = src.kind;
    if (!kind) return null;
    const end = this.endOf(kind);
    return { key: key({ from, kind }), dep, make: () => { const c = linkCheck(rom, kind, this.both); return (i) => c(end(a), end(this.tile(i))); } };
  }
  // a tile's end of a link of `kind` (an exit path tile's: with the side its path goes on)
  private endOf(kind: LinkKind): (t: OwTile) => LinkEnd {
    return (t) => (kind === 'exit' ? this.exitEnd(t) : t);
  }

  // ---- interaction (cells of layer 1) ----
  // the selection of what is at cell i (l1Index; -1 none), as a click on the map selects the tile: a link ending there
  // (the one on the submap the user acts on first), else a location there, a Koopa Kid's place or tile, else the tile
  selectAt(i: number): void {
    if (i < 0) { this.sel = null; return; }
    const t = this.tile(i), found = clickedLinks(this.info().links, i, this.around(i));
    const loc = this.locationAt(t), place = this.koopaPlaceAt(i), koopa = place >= 0 ? place : this.koopaAt(i);
    this.sel = found[0] ? { kind: 'link', link: found[0] } : loc >= 0 ? { kind: 'location', i: loc } : koopa >= 0 ? { kind: 'koopa', k: koopa } : { kind: 'tile', t };
  }
  // a press at map cell x, y on what the selection leads to – the selected link's other end (not the selected tile
  // itself), the selected location or Koopa Kid's place – not a level tile (moved itself): dragged to move it (released
  // without moving: its tile selected). Whether it was
  grab(x: number, y: number): boolean {
    if (x < 0 || y < 0 || x >= 32 || y >= 32 || !this.view.views) return false;
    const i = l1Index(this.view.region, x, y), s = this.sel;
    // (a level tile there is dragged as itself: moved; its link end is moved by "Change target…")
    if (!s || this.view.isLevelTile(this.view.levelL1()[i])) return false;
    let move: Moved | null = null;
    if (s.kind === 'link') {
      for (const target of [true, false]) {
        const e = target ? s.link.b : s.link.a;
        if (!move && i !== this.view.selected && this.shown(e) && this.index(e) === i) move = { sel: s, target };
      }
    } else if (s.kind === 'location') {
      const to = readTeleports(this.rom)[s.i].to;
      if (to && this.shown(to) && this.index(to) === i) move = { sel: s, target: true };
    } else if (s.kind === 'koopa') {
      const p = koopaTeleport(this.rom, s.k);
      if (p && this.koopaTiles(s.k).length && l1Index(this.view.region, p.x, p.y) === i) move = { sel: s, target: true };
    }
    if (!move) return false;
    this.drag = { from: i, to: i, move };
    this.view.paint();
    return true;
  }
  // a press while a tile is to be chosen (pending): the tile at cell x, y (the cursor at cx, cy), outside the map
  // cancelled. Whether one was pending
  pickPending(x: number, y: number, cx: number, cy: number): boolean {
    if (!this.pending) return false;
    if (x < 0 || y < 0 || x >= 32 || y >= 32) { this.cancelPending(); this.view.paint(); return true; }
    this.finishPending(l1Index(this.view.region, x, y), cx, cy);
    return true;
  }
  move(x: number, y: number): void {
    if (!this.drag || x < 0 || y < 0 || x >= 32 || y >= 32) return;
    this.drag.to = l1Index(this.view.region, x, y);
    this.view.paint();
    this.view.updateStatus();
  }
  // the release (the cursor at cx, cy): a link end dropped in an overlap of submaps' views asks which submap
  up(cx: number, cy: number): void {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    if (d.to === d.from || !d.move) { this.view.selectTile(d.from, false); return; }
    this.view.updateStatus();
    const m = d.move, drop = (to: OwTile) => this.apply(() => this.moveTo(m, to));
    if (this.asks(m, d.from)) this.ask(d.to, cx, cy, drop, this.stuckNote(m, d.from, d.to));
    else drop(this.tile(d.to));
  }
  // the map of link end t shown, its tile selected (the link kept selected)
  private goTo(t: OwTile): void {
    const s = this.sel;
    this.view.setMap(t.submap);
    this.view.selectTile(this.index(t), true);
    if (s?.kind === 'link') { this.sel = s; this.view.buildProps(); this.view.paint(); }
  }
  // "Link to…": the next click on a map chooses the tile `t` leads to (a Koopa Kid's tile: its place)
  startLink(t: OwTile): void {
    this.pending = { from: t };
    this.view.paint();
    this.view.updateStatus();
  }
  // the menu entries of cell i (a right click on it): linking it, removing its links or Koopa Kid's place
  menuItems(i: number): MenuItem[] {
    if (!this.view.views) return [];
    const t = this.tile(i), src = this.source(i, t), out: MenuItem[] = [];
    const koopa = this.koopaAt(i);
    if (koopa >= 0) {
      out.push({ label: 'Mario is put at…', title: 'Choose where Mario is put after losing to this Koopa Kid (the next click)', onClick: () => this.startLink(t) });
      if (koopaTeleport(this.rom, koopa)) out.push({ label: 'Remove place', onClick: () => { this.sel = { kind: 'koopa', k: koopa }; this.remove(); } });
      return out;
    }
    if (src.kind) out.push({ label: 'Link to…', title: 'Choose the tile it leads to (the next click, on any map); a link it has is replaced', onClick: () => this.startLink(t) });
    for (const l of clickedLinks(this.info().links, i, this.around(i))) {
      out.push({ label: `Remove link ${tileText(l.a)} ${l.both ? '↔' : '→'} ${tileText(l.b)}`, title: 'The tile stays (and can be painted over again)', onClick: () => { this.sel = { kind: 'link', link: l }; this.remove(); } });
    }
    return out;
  }
  // whether a drop of `move` (or of a new link from tile `from`) takes the submap asked in an overlap: a link's end or a
  // location, not a Koopa Kid's place (on the submap of its tile) nor a tile no link starts at (refused at once)
  private asks(move: Moved | null, from: number): boolean {
    if (move) return move.sel.kind === 'link' || move.sel.kind === 'location';
    const k = this.source(from).kind;
    return k === 'star' || k === 'exit';
  }
  private apply(f: () => void): void {
    // (a link table full: the unused entries freed and the change made in one ROM edit)
    const app = this.view.app, done = () => { this.view.paint(); this.view.buildProps(); this.view.updateStatus(); };
    try { f(); } catch (e) { refusedToast(this.rom, e, 'Overworld link not changed: ', (r) => linkTableFix(app, r, f, done)); }
    done();
  }
  // the next click on a map chooses the tile (i, the cursor at cx, cy): of a link from `from`, or where `move` goes –
  // asked in an overlap of submaps' views (Esc there: nothing done, the pending choice ended)
  private finishPending(i: number, cx: number, cy: number): void {
    const p = this.pending!;
    this.pending = null;
    this.view.updateStatus();
    const finish = (t: OwTile) => this.apply(() => ('from' in p ? this.make(p.from, t) : this.moveTo(p.move, t)));
    const move = 'from' in p ? null : p.move, from = 'from' in p ? this.index(p.from) : -1;
    if (this.asks(move, from)) this.ask(i, cx, cy, finish, this.stuckNote(move, from, i));
    else finish(this.tile(i));
  }
  cancelPending(): boolean {
    if (!this.pending) return false;
    this.pending = null;
    this.view.updateStatus();
    return true;
  }
  private locationAt(t: OwTile): number {
    const all = readTeleports(this.rom);
    for (const [k] of this.info().uses) { const to = all[k].to; if (to && sameTile(to, t)) return k; }
    return -1;
  }
  private koopaPlaceAt(i: number): number {
    for (let k = 0; k < KOOPAS; k++) {
      const p = koopaTeleport(this.rom, k);
      if (p && this.koopaTiles(k).length && l1Index(this.view.region, p.x, p.y) === i) return k;
    }
    return -1;
  }
  private edit(what: string, f: () => void): void { this.view.app.romEdit(what, f); }

  // a new link from tile a to tile b
  private make(a: OwTile, b: OwTile): void {
    const src = this.source(this.index(a), a);
    if (!src.kind) throw src.refusal ? new OwRefusal(src.refusal) : new Error(src.why);
    if (src.kind === 'koopa') { this.setKoopa(this.koopaAt(this.index(a)), a, b); return; }
    const kind = src.kind, end = this.endOf(kind), ea = end(a), eb = end(b);
    let made: OwLink | null = null;
    this.edit(`Overworld link ${tileText(a)} ${this.both ? '↔' : '→'} ${tileText(b)}`, () => { made = makeLink(this.rom, kind, ea, eb, this.both); });
    if (made) this.sel = { kind: 'link', link: made };
  }
  // Koopa Kid k (of tile `from`) puts Mario at `to`: a place of the submap of its tile
  private setKoopa(k: number, from: OwTile, to: OwTile): void {
    const why = koopaPlaceRefusal(from, to);
    if (why) throw new OwRefusal(why);
    this.edit(`Koopa Kid ${k + 1}: place`, () => setKoopaTeleport(this.rom, k, to));
    this.sel = { kind: 'koopa', k };
  }
  // the moved end at tile `to`
  private moveTo(m: Moved, to: OwTile): void {
    const s = m.sel;
    if (s.kind === 'location') { this.edit(`Location ${hex(s.i, 2)}: moved`, () => moveLocation(this.rom, s.i, to)); return; }
    if (s.kind === 'koopa') {
      const from = this.koopaTiles(s.k)[0];
      if (from === undefined) throw new Error(`Koopa Kid ${s.k + 1}'s tile is on the other map`);
      this.setKoopa(s.k, this.romTile(from), to);
      return;
    }
    if (s.kind !== 'link') return;
    const l = s.link, end = this.endOf(l.kind)(to);
    const a = m.target ? l.a : end, b = m.target ? end : l.b;
    let made: OwLink | null = null;
    this.edit(`Overworld link ${tileText(a)} ${l.both ? '↔' : '→'} ${tileText(b)}`, () => {
      removeLink(this.rom, l);
      made = makeLink(this.rom, l.kind, a, b, l.both);
    });
    if (made) this.sel = { kind: 'link', link: made };
  }
  // removes the selected link, or clears the selected Koopa Kid's place
  remove(): boolean {
    const s = this.sel;
    if (!s || s.kind === 'tile') return false;
    if (s.kind === 'location') { toast('Exits to the overworld teleport to a location (set in their entrance) – drag it to move it'); return true; }
    if (s.kind === 'koopa') this.edit(`Koopa Kid ${s.k + 1}: no place`, () => setKoopaTeleport(this.rom, s.k, null));
    else this.edit(`Overworld link ${tileText(s.link.a)} removed`, () => removeLink(this.rom, s.link));
    this.sel = null;
    this.view.buildProps();
    return true;
  }

  // the status bar while a link end is dragged (where it would go: "→ Vanilla Dome 05,14", "· in an overlap, you'll be
  // asked" where a menu will ask) or a tile on another map is to be chosen
  status(): string | null {
    const d = this.drag;
    if (d && d.to !== d.from && this.asks(d.move, d.from)) return endChoiceText(this.choice(d.to), d.to) + this.stuckNote(d.move, d.from, d.to);
    if (!this.pending) return null;
    return `Choose the map and click the tile ${'from' in this.pending ? `${tileText(this.pending.from)} leads to` : 'it goes to'} · Esc cancels`;
  }

  // ---- properties ----
  // the selected tile's overworld links, under its other properties (null: nothing to say – a tile no link can start at)
  props(): HTMLElement | null {
    const s = this.sel, rom = this.rom;
    if (!s || !this.view.views) return null;
    const both = checkbox('New links both ways', 'A link made by "Link to…" leads back too (two entries)', this.both, (on) => (this.both = on));
    const other = (label: string, title: string, p: NonNullable<LinkLayer['pending']>) =>
      h('button', { title, onclick: () => { this.pending = p; this.view.paint(); this.view.updateStatus(); } }, label);
    const section = (...c: (HTMLElement | null)[]) => h('div', { class: 'ow-info' }, h('div', { class: 'panel-subtitle' }, 'Overworld link'), ...c);
    if (s.kind === 'tile') {
      // (a level tile's locations: moved at its exits' sentences, "When beaten…")
      const src = this.source(this.index(s.t), s.t);
      if (!src.kind) return null;
      return section(
        h('div', { class: 'row' }, h('span', { class: 'hint' }, 'No link starts here. '), h('button', { title: 'Choose the tile it leads to (the next click, on any map)', onclick: () => this.startLink(s.t) }, 'Link to…')),
        both);
    }
    if (s.kind === 'location') {
      const to = readTeleports(rom)[s.i].to, levels = this.locationLevels(s.i);
      return section(
        h('div', null, h('b', null, `Location ${hex(s.i, 2)}`), ` · ${to ? tileText(to) : 'not set up'}`),
        h('div', { class: 'hint' }, `Exits to the overworld of level${levels.length > 1 ? 's' : ''} ${levels.map((l) => hex(l, 3)).join(', ')} teleport here (set in the level's entrance) – drag the ring to move it.`),
        to && levels.length ? this.stuckBox(to, 'teleport') : null,
        other('Move…', 'Choose the tile it teleports to (the next click, on any map)', { move: { sel: s, target: true } }));
    }
    if (s.kind === 'koopa') {
      const p = koopaTeleport(rom, s.k), tile = this.koopaTiles(s.k)[0];
      return section(
        h('div', null, h('b', null, `Koopa Kid ${s.k + 1}`), ` · tile ${hex(KOOPA_TILE + s.k, 2)}`),
        h('div', { class: 'hint' }, `Losing to it puts Mario at ${p ? `${hex(p.x, 2)},${hex(p.y, 2)} of his submap – drag the ring to move it` : 'no place (the game\'s 0,0)'}.`),
        h('div', { class: 'row' },
          tile !== undefined ? h('button', { title: 'Choose the place (the next click, on the submap of its tile)', onclick: () => this.startLink(this.romTile(tile)) }, 'Mario is put at…') : null,
          p ? h('button', { title: 'Mario is put nowhere (the game\'s 0,0)', onclick: () => this.remove() }, 'Remove place') : null));
    }
    const l = s.link, name = l.kind === 'exit' ? 'Exit path' : 'Star/pipe';
    // the source's side chosen; the target's derived from it (owlinks.ts linkedTarget), shown – one a ROM has
    // otherwise said so (the World check warns of it)
    const relink = (a: LinkEnd) => this.apply(() => this.edit(`${name}: path side`, () => { removeLink(rom, l); this.sel = { kind: 'link', link: makeLink(rom, l.kind, a, l.b, l.both) }; }));
    const sourceSide = () => h('div', { class: 'prop' }, h('label', { title: 'The side of the tile its path goes on: Mario leaves the tile walking from there; the target\'s side is the opposite one' }, `Path at ${tileText(l.a)}`),
      select(DIR_NAMES.map((n, d) => [d, `${DIR_ARROWS[d]} ${n}`] as [number, string]), l.a.side ?? 0, (v) => relink({ ...l.a, side: v })));
    const tb = l.b.side ?? 0, targetSide = () => h('div', { class: 'prop' }, h('label', { title: 'Follows the source\'s side: the opposite one, the only one putting Mario on the path (the game moves him on by the source exit tile\'s way, not by this side)' }, `Path at ${tileText(l.b)}`),
      h('span', null, `${DIR_ARROWS[tb]} ${DIR_NAMES[tb]}${sidesMatch(l) ? ' (opposite the source\'s)' : ''}`));
    const shapes = this.view.pathShapes(), tileOf = (t: OwTile) => this.view.shown.l1[this.index(t)];
    const out = (from: LinkEnd, to: LinkEnd) => `${exitOutText(exitOut(from, to, tileOf(from), shapes), tileText(to))}.`;
    const exitInfo = l.kind !== 'exit' ? [] : [sourceSide(), targetSide(),
      sidesMatch(l) ? null : h('div', { class: 'warn-box' }, `The ROM has the target's path ${DIR_NAMES[tb]}, not opposite the source's – the World check warns where Mario comes out off the path. `,
        h('button', { title: 'Set the target\'s side opposite to the source\'s (one ROM edit)', onclick: () => relink(l.a) }, 'Put it opposite')),
      h('div', { class: 'hint' }, out(l.a, l.b), l.both ? ` Back: ${out(l.b, l.a)}` : '')];
    // (#403) an end on a submap whose view doesn't show its tile: likely meant for another submap sharing the region
    const views = this.view.views, offView = [l.a, l.b].filter((t) => t.submap > 0 && views && !inView(views[t.submap], this.index(t)))
      .map((t) => h('div', { class: 'warn-box' }, `${tileText(t)} lies outside ${MAP_NAMES[t.submap]}'s view (the part of the map the game shows there): Mario would be where the player can't see him – likely meant for another submap.`));
    // (several links ending at the selected tile: each chosen here)
    const at = this.view.selected, here = at >= 0 ? clickedLinks(this.info().links, at, this.around(at)) : [];
    const others = here.length < 2 ? null : h('div', { class: 'row' }, ...here.map((k) => h('button', { class: k === l ? 'active' : '', onclick: () => { this.sel = { kind: 'link', link: k }; this.view.paint(); this.view.buildProps(); } },
      `${tileText(k.a)} ${k.both ? '↔' : '→'} ${tileText(k.b)}`)));
    return section(
      others,
      h('div', null, h('b', null, name), ` · ${tileText(l.a)} ${l.both ? '↔' : '→'} ${tileText(l.b)}`),
      // (the other end: a jump there, its tile selected)
      h('div', { class: 'row' }, h('button', { class: 'link-btn', title: 'Shows the other end, on its map, selected', onclick: () => this.goTo(at >= 0 && this.endsAt(l.a, at) ? l.b : l.a) },
        `Leads to ${tileText(at >= 0 && this.endsAt(l.a, at) ? l.b : l.a)}`)),
      h('div', { class: 'hint' }, `Entr${l.entries.length > 1 ? 'ies' : 'y'} ${l.entries.map((i) => hex(i, 2)).join(', ')} of the ${l.kind === 'exit' ? 'exit path' : 'star/pipe'} table`),
      checkbox('Both ways', 'The target leads back to this tile', l.both, (on) => this.apply(() => this.edit(`${name}: ${on ? 'both ways' : 'one-way'}`, () => { this.sel = { kind: 'link', link: setBothWays(rom, l, on) }; }))),
      ...exitInfo,
      ...offView,
      ...l.kind === 'star' ? [this.stuckBox(l.b, 'star'), l.both ? this.stuckBox(l.a, 'star') : null] : [],
      h('div', { class: 'hint' }, 'Drag its other end on the map to move it.'),
      h('div', { class: 'row' },
        other('Change target…', 'Choose the tile it leads to (the next click, on any map)', { move: { sel: s, target: true } }),
        h('button', { title: 'Remove the overworld link (Delete): the tile stays and can be painted over again', onclick: () => this.remove() }, 'Remove link')));
  }
}

// an arrow from p to q (heads at q, and at p with `both`), drawn over a dark outline; `on`: selected
export function arrow(ctx: CanvasRenderingContext2D, lw: number, p: { x: number; y: number }, q: { x: number; y: number }, color: string, both: boolean, on: boolean, dashed: boolean): void {
  const dx = q.x - p.x, dy = q.y - p.y, len = Math.hypot(dx, dy);
  if (len < 1) return;
  const ux = dx / len, uy = dy / len, s = 4, inset = 5;
  const a = { x: p.x + ux * (both ? inset : 2), y: p.y + uy * (both ? inset : 2) }, b = { x: q.x - ux * inset, y: q.y - uy * inset };
  const headAt = (t: { x: number; y: number }, vx: number, vy: number) => { ctx.moveTo(t.x - vx * s - vy * s * 0.7, t.y - vy * s + vx * s * 0.7); ctx.lineTo(t.x, t.y); ctx.lineTo(t.x - vx * s + vy * s * 0.7, t.y - vy * s - vx * s * 0.7); };
  for (const [c, w] of [['rgba(0,0,0,0.75)', on ? 5 : 3.5], [on ? '#fff' : color, on ? 2.5 : 1.5]] as [string, number][]) {
    ctx.strokeStyle = c;
    ctx.lineWidth = w * lw;
    ctx.setLineDash(dashed ? [8 * lw, 6 * lw] : []);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    headAt(b, ux, uy);
    if (both) headAt(a, -ux, -uy);
    ctx.stroke();
  }
}
// a place teleported to: a ring on its tile
function marker(ctx: CanvasRenderingContext2D, lw: number, p: { x: number; y: number }, color: string, on: boolean): void {
  for (const [c, w] of [['rgba(0,0,0,0.75)', 4], [on ? '#fff' : color, 2]] as [string, number][]) {
    ctx.strokeStyle = c;
    ctx.lineWidth = w * lw;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
    ctx.stroke();
  }
}
