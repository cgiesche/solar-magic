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

// L: the link layer's choice at the selected tile; S: a sprite of the sprites mode
export class OwGesture<L, S> {
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

  // The mode changed to `mode`, or the map: what belonged to the one before ends.
  leave(what: 'mode' | 'map', mode: OwMode): void {
    this.selectTile(-1, null);
    if (what === 'mode') this.sprite = null;
    if (what === 'map' || mode !== 'l2') this.pieces = null;
  }

  // The side panel's tabs in `mode`; `revealPick`: a reveal's new tile is being picked in the layer 1 sheet. Without
  // a selection the picker is the tab chosen again: the next selection shows its properties.
  tabs(mode: OwMode, revealPick: boolean): SideTabs & { selected: boolean } {
    const selected = mode === 'sprites' ? this.sprite !== null : this.cell >= 0;
    if (!selected) this.chosen = 'paint';
    return { ...sideTabs(mode, this.chosen, selected, revealPick), selected };
  }
}
