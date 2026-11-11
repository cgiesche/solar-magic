// The overworld's side panel holds the tool and the selection as two tabs (ADR 0015, #460): "Paint | Properties" ("Sprites |
// Sprite" in the sprites mode), one shown. A selection switches to Properties (overworld.ts showProps: a tile clicked or
// Alt/Ctrl+clicked, a sprite clicked); when it ends (Esc, a click beside it) Paint comes back. Paint can be clicked
// with the selection kept (a right click paints with it meanwhile). Nothing selected: Properties disabled, its tooltip
// says how to select. While a reveal's new tile is picked in the layer 1 sheet, Paint is shown (the sheet).

import type { OwMode } from '../core/owlayers.ts';
import type { PathKind } from '../core/owpaths.ts';

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
    labels: mode === 'sprites' ? { paint: 'Sprites', props: 'Sprite' } : { paint: 'Paint', props: 'Properties' },
    propsEnabled: selected && !revealPick,
  };
}

// Whether a plain click on layer 1 tile `tile` in the layer 1 mode selects it rather than picking it into the brush
// (#434): an overworld link end (linkEnd; a right click its menu), or a star or pipe (5B, 82: path kind 'warp', kinds
// null while they are learned) – one without a link yet too, so a star or pipe just painted is linked by "Link to…" in its properties (a right click still paints over it: no
// link end, a brush tile). Picked as a brush from the sheet or by a rectangle starting beside it; Alt/Ctrl+click shows
// its info as for any tile.
export function clickSelects(tile: number, linkEnd: boolean, kinds: readonly PathKind[] | null): boolean {
  return linkEnd || kinds?.[tile] === 'warp';
}
