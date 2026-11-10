// Whether the overworld's Paint panel is hidden for the selection (#421): a level tile, star or pipe 5B (owstars.ts
// ownsTranslevel; a click selects one with or without a link, #434: clickSelects) selected in the layer 1 mode shows
// only its properties – the paint sheet, "Path (auto)" and the Levels section go, the properties move up (the pipe 82,
// no translevel of its own: Paint stays). Not for a tile's info shown by Alt/Ctrl+click, nor in another mode
// (there the user paints), nor while a reveal's new tile is picked in the sheet. The selection ends by a left click on
// another cell (picked into the brush) or Esc, and Paint comes back.

import { ownsTranslevel } from '../core/owstars.ts';
import type { OwMode } from '../core/owlayers.ts';
import type { PathKind } from '../core/owpaths.ts';

export interface OwSelection {
  mode: OwMode;
  selected: number; // the layer 1 tile selected (l1Index; -1: none)
  tile: number; // its layer 1 tile number (as after the event chosen)
  byInfo: boolean; // selected by Alt/Ctrl+click (its info)
  levelTile: boolean; // a level tile (the path kinds say so)
  kinds: readonly PathKind[] | null; // the path kinds (null while they are learned: until then not even a star is known)
  revealPick: boolean; // a reveal's new tile is being picked in the layer 1 sheet
}

export function selectionHidesPaint(s: OwSelection): boolean {
  if (s.mode !== 'l1' || s.selected < 0 || s.byInfo || s.revealPick) return false;
  return s.levelTile || (!!s.kinds && ownsTranslevel(s.kinds, s.tile));
}

// Whether a plain click on layer 1 tile `tile` in the layer 1 mode selects it rather than picking it into the brush
// (#434): an overworld link end (linkEnd; a right click its menu), or a star or pipe (5B, 82: path kind 'warp', kinds
// null while they are learned) – one without a link yet too, so a star or pipe just painted is linked by "Link to…" in its properties (a right click still paints over it: no
// link end, a brush tile). Picked as a brush from the sheet or by a rectangle starting beside it; Alt/Ctrl+click shows
// its info as for any tile.
export function clickSelects(tile: number, linkEnd: boolean, kinds: readonly PathKind[] | null): boolean {
  return linkEnd || kinds?.[tile] === 'warp';
}
