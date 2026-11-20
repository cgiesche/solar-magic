// What is on in the overworld editor besides the map itself, in one place (#554): what is selected, and with it the
// side panel's tab. The view and its layers start and end these through here and keep the details (where a link's
// other end is, a sprite's box); what a change of mode or map ends is said here once (leave), not at each field.
// No DOM: tools/testowgesture.ts.
//
// The selection: a layer 1 tile (a level tile, a link end, a star or pipe clicked; any tile by Alt+click) with the
// link layer's choice of what is meant at it (`link`: which of the tile's links, a location, a Koopa Kid's place),
// or – in the sprites mode – a sprite. Beside it the pieces marked on layer 2 (`pieces`: where "Replace piece…"
// replaces; a rectangle picked into the brush leaves it). A tile selection belongs to the mode and map it was made
// in; a sprite's to its mode (the sprite slots are the same on every submap); the pieces to layer 2 and their map.
//
// The cell request (CONTEXT.md): the editor asking for a cell of the map by the next click – the tile a reveal or a
// destroyed level tile is added at (a reveal then asks for the tile it becomes, in the layer 1 sheet: `at` set), the
// piece to replace (`from`: then the new one), an overworld link's other end (`what`: the link layer's). At most one:
// asking for another ends the one before. What it outlives depends on what is asked (leave).
//
// What a press on the map means (press): the buttons are the level editor's – a click or drag takes tiles into the
// brush, a right click or Shift+click paints – and on layer 1 the level tiles and link ends are objects on top of
// the map (ADR 0012): a click selects one, a drag moves a level tile, a right click opens its menu; a star or pipe
// without a link is selected by a click too (#434: "Link to…" in its properties) while a right click paints over it.
// A cell asked for takes the left click before all of that. The view says what is under the mouse and carries the
// answer out.
//
// The side panel holds the tool and the selection as two tabs (ADR 0015, #460): "Picker | Properties", one shown. A
// selection switches to Properties (a tile clicked or Alt+clicked, a sprite clicked); when it ends (Esc, a click
// beside it) the picker comes back. The picker can be clicked with the selection kept (a right click paints with it
// meanwhile). Nothing selected: Properties disabled, its tooltip says how to select. While a reveal's new tile is
// picked in the layer 1 sheet, the picker is shown (the sheet).

import type { OwMode } from '../core/owlayers.ts';
import type { PathKind } from '../core/owpaths.ts';
import type { CellRect } from './dom.ts';

export type SideTab = 'paint' | 'props';

export interface SideTabs {
  shown: SideTab; // the tab shown
  labels: Record<SideTab, string>;
  propsEnabled: boolean; // something is selected (not while a reveal's new tile is picked)
}

// the side panel's tabs in mode `mode`, the tab chosen last `chosen` (by a selection or a click on a tab), whether
// something is selected and whether a reveal's new tile is being picked in the layer 1 sheet
export function sideTabs(mode: OwMode, chosen: SideTab, selected: boolean, revealPick: boolean): SideTabs {
  return {
    shown: selected && !revealPick ? chosen : 'paint',
    labels: { paint: 'Picker', props: 'Properties' }, // (the same in every editor, #478)
    propsEnabled: selected && !revealPick,
  };
}

// Whether a plain click on layer 1 tile `tile` in the layer 1 mode selects it rather than picking it into the brush
// (#434): an overworld link end (linkEnd; a right click its menu), or a star or pipe (5B, 82: path kind 'warp', kinds
// null while they are learned) – one without a link yet too, so a star or pipe just painted is linked by "Link to…" in its properties (a right click still paints over it: no
// link end, a brush tile). Picked as a brush from the sheet or by a rectangle starting beside it; Alt+click shows
// its info as for any tile.
export function clickSelects(tile: number, linkEnd: boolean, kinds: readonly PathKind[] | null): boolean {
  return linkEnd || kinds?.[tile] === 'warp';
}

// what the view knows of a press: the mouse, and what is under it
export interface PressFacts {
  button: number; shift: boolean; alt: boolean; ctrl: boolean;
  mode: OwMode;
  jump: boolean; // on the link symbol of a label under a tile (where its link leads is shown)
  viewsKnown: boolean; // the submaps' views are known (a moved start is written with its tile's submap)
  // the layer 1 mode's:
  grab: boolean; // on what the selection leads to – the selected link's other end, location or Koopa Kid's place
  onMap: boolean; // on a cell of the map
  levelTile: boolean; // a level tile there
  tile: number; // the layer 1 tile there (onMap)
  linkEnd: boolean; // an overworld link ends there
  kinds: readonly PathKind[] | null; // the path kinds (null: being learned)
  brush: 'tiles' | 'route' | 'look'; // the brush: tiles, the route brush, a level tile's look
  unpaintable: 'learning' | 'noMap' | 'emulating' | null; // why layer 1 can't be painted just now
}
export type PressAction =
  | { kind: 'none' }
  | { kind: 'jump' } // the map of the link's other end shown
  | { kind: 'answer' } // the cell request answered with the cell (or piece) there
  | { kind: 'sprite' } // the sprites' own: select, drag
  | { kind: 'grab' } // the link end, location or place dragged
  // a level tile's or link end's menu; route: with the route brush a route may start there – the menu once the button
  // is released without a drag
  | { kind: 'menu'; of: 'level' | 'link'; route: boolean }
  | { kind: 'select' } // the tile selected
  | { kind: 'placeLevel' } // "Place level here…" with the look that is the brush
  | { kind: 'moveLevelTile' } // the level tile selected; a drag moves it
  | { kind: 'route' } // a route drawn
  | { kind: 'refused'; why: 'learning' | 'noMap' | 'emulating' } // no stroke on layer 1 just now
  | { kind: 'stroke' } // a paint stroke
  | { kind: 'info' } // the tile's info (Alt+click)
  | { kind: 'pick' }; // tiles taken into the brush (a selection ends)

// a right click, or Shift+click: the button that paints (brushsurface.ts paintButton)
const paints = (f: { button: number; shift: boolean; ctrl: boolean }) => f.button === 2 || (f.button === 0 && f.shift && !f.ctrl);

export type CellRequest<P> =
  | { kind: 'reveal' | 'destroy'; at: number } // at: the reveal's cell once chosen (l1Index; -1: the cell is asked for)
  | { kind: 'replace'; from: number[] | null } // from: the piece to replace once chosen (null: it is asked for)
  | { kind: 'link'; what: P };

// L: the link layer's choice at the selected tile; S: a sprite of the sprites mode; P: what the link layer asks a
// cell for
export class OwGesture<L, S, P> {
  private asked: CellRequest<P> | null = null;
  private cell = -1;
  private chosen: SideTab = 'paint';
  // what is meant at the selected tile (null: nothing of the link layer's, or no tile selected). Set by the link
  // layer; it ends with the tile's selection.
  link: L | null = null;
  // the sprite selected in the sprites mode
  sprite: S | null = null;
  // the pieces marked on layer 2 (cells of the layer 2 mode)
  pieces: CellRect | null = null;

  // the selected layer 1 tile (l1Index; -1: none)
  get tile(): number { return this.cell; }
  // Selects layer 1 tile `cell` with the link layer's choice at it (-1: the tile's selection ends). `show`: its
  // properties are shown (not after an edit that only keeps the selection on its tile).
  selectTile(cell: number, link: L | null, show = true): void {
    this.cell = cell;
    this.link = cell >= 0 ? link : null;
    if (cell >= 0 && show) this.chosen = 'props';
  }
  // the properties shown (a sprite selected), the picker (its tab clicked)
  show(tab: SideTab): void { this.chosen = tab; }

  // the cell asked for (null: none)
  get request(): CellRequest<P> | null { return this.asked; }
  // asks for a cell (or goes on with the request: a reveal's cell chosen, the piece to replace); a request before ends
  ask(r: CellRequest<P>): void { this.asked = r; }
  // the request ended (answered, Esc); false: there was none
  endRequest(): boolean {
    const had = this.asked !== null;
    this.asked = null;
    return had;
  }
  // What the request asks for on the map, which the frame under the mouse shows: a layer 1 cell, a piece of layer 2,
  // or nothing there (none, or a reveal's new tile: asked for in the layer 1 sheet).
  asksFor(): 'cell' | 'piece' | null {
    const r = this.asked;
    return !r ? null : r.kind === 'replace' ? 'piece' : r.kind === 'link' || r.at < 0 ? 'cell' : null;
  }

  // What a press means, by what is asked for and what is under the mouse.
  press(f: PressFacts): PressAction {
    const left = f.button === 0, paint = paints(f), plain = !f.shift && !f.alt && !f.ctrl, r = this.asked;
    if (left && f.jump) return { kind: 'jump' };
    // (a reveal's or destroy's cell is asked for in every mode; a reveal's new tile in the sheet, not here)
    if (left && r && (r.kind === 'replace' || (r.kind !== 'link' && r.at < 0))) return { kind: 'answer' };
    if (f.mode === 'sprites') return { kind: f.viewsKnown && left ? 'sprite' : 'none' };
    if (left && r?.kind === 'link') return { kind: 'answer' };
    if (f.mode === 'l1') {
      if (left && plain && f.grab) return { kind: 'grab' };
      const route = f.brush === 'route';
      // the level tiles, objects on top of layer 1: a right click (or Shift+click), any brush – its menu
      if (paint && f.levelTile) return { kind: 'menu', of: 'level', route };
      // a link end (not a level tile): an object too; a star or pipe without a link is selected, and painted over
      if (!f.levelTile && f.onMap && clickSelects(f.tile, f.linkEnd, f.kinds)) {
        if (paint && f.linkEnd) return { kind: 'menu', of: 'link', route };
        if (left && plain) return { kind: 'select' };
      }
      // a look as the brush places a level (a drag places nothing more)
      if (paint && f.brush === 'look') return { kind: f.onMap ? 'placeLevel' : 'none' };
      // a click on a level tile selects it, a drag moves it (a pick starts beside one)
      if (left && plain && f.levelTile) return { kind: 'moveLevelTile' };
    }
    if (paint) {
      if (f.mode === 'l1' && f.brush === 'route') return { kind: 'route' };
      if (f.mode === 'l1' && f.unpaintable) return { kind: 'refused', why: f.unpaintable };
      return { kind: 'stroke' };
    }
    if (!left) return { kind: 'none' };
    return { kind: f.alt ? 'info' : 'pick' }; // (Alt+click: the tile's info; Ctrl+click no longer, #482)
  }

  // The mode changed to `mode`, or the map: what belonged to the one before ends. The selection as said above. A
  // request: a link's other end with the mode (it may be on another map: that is what it is asked across maps for);
  // the piece to replace outside layer 2 and with the map; a reveal's new tile outside layer 1, where its sheet is;
  // a reveal's or destroy's cell with neither. Whether a request ended.
  leave(what: 'mode' | 'map', mode: OwMode): boolean {
    this.selectTile(-1, null);
    if (what === 'mode') this.sprite = null;
    if (what === 'map' || mode !== 'l2') this.pieces = null;
    const r = this.asked;
    const ends = !!r && (what === 'map' ? r.kind === 'replace'
      : r.kind === 'link' || (r.kind === 'replace' && mode !== 'l2') || (r.kind === 'reveal' && r.at >= 0 && mode !== 'l1'));
    if (ends) this.asked = null;
    return ends;
  }

  // The side panel's tabs in `mode`; `revealPick`: a reveal's new tile is being picked in the layer 1 sheet. Without
  // a selection the picker is the tab chosen again: the next selection shows its properties.
  tabs(mode: OwMode, revealPick: boolean): SideTabs & { selected: boolean } {
    const selected = mode === 'sprites' ? this.sprite !== null : this.cell >= 0;
    if (!selected) this.chosen = 'paint';
    return { ...sideTabs(mode, this.chosen, selected, revealPick), selected };
  }
}
