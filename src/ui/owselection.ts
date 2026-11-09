// Whether the overworld's Paint panel is hidden for the selection (#421): a level tile, star or pipe 5B (owstars.ts
// ownsTranslevel; clicked as an overworld link end – a click on one without a link picks it into the brush, it is a
// brush tile) selected in the layer 1 mode shows only its properties – the paint sheet, "Path (auto)" and
// the Levels section go, the properties move up. Not for a tile's info shown by Alt/Ctrl+click, nor in another mode
// (there the user paints), nor while a reveal's new tile is picked in the sheet. The selection ends by a left click on
// another cell (picked into the brush) or Esc, and Paint comes back.

import { ownsTranslevel } from '../core/owstars.ts';
import type { OwMode } from '../core/owlayers.ts';

export interface OwSelection {
  mode: OwMode;
  selected: number; // the layer 1 tile selected (l1Index; -1: none)
  tile: number; // its layer 1 tile number (as after the event chosen)
  byInfo: boolean; // selected by Alt/Ctrl+click (its info)
  levelTile: boolean; // a level tile (the path kinds say so)
  kindsKnown: boolean; // the path kinds are learned (until then not even a star is known)
  revealPick: boolean; // a reveal's new tile is being picked in the layer 1 sheet
}

export function selectionHidesPaint(s: OwSelection): boolean {
  if (s.mode !== 'l1' || s.selected < 0 || s.byInfo || s.revealPick) return false;
  return s.levelTile || (s.kindsKnown && ownsTranslevel(s.tile));
}
