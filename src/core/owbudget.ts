// The overworld's ROM limits as budgets (#347): for each table an edit can run out of, how much of it is used – shown
// as a gauge next to the action the limit stops (the overworld editor), all of them together for the World check to
// list. One function counts them all, from the ROM; pure, nothing drawn.
//
// - destroys: the destroy list's entries set (0x18; a tile an event destroys)
// - revealPairs: the reveal list's pairs doing something (0x16): the last of a tile's pairs, turning it into another
// - l1Tiles: the layer 1 tiles not free (owl1sheet.ts freeL1Tiles: known once the path kinds are learned) of 0x200
// - stars: the star/pipe entries used (0x100): leading somewhere, taken from a tile or a location an exit teleports to
// - exitPaths: the exit path entries used (0x80)
// - translevels: the translevels a tile on a map holds (0x5F; the others are levels without level tile)
// - eventStorage: the event tile storage's places the events' layer 2 pieces use (0x3600)
// - customSprites: the custom overworld sprites on the submap (0x18)
// A table the ROM lacks (its patch not installed) has no budget.

import type { Rom } from './rom.ts';
import {
  readDestroyList, hasDestroyPatch, NO_EVENT, DESTROYS, readRevealList, readTranslevels, MAX_TRANSLEVEL,
  OW_L1_TILES, MAP_NAMES,
} from './overworld.ts';
import { readEvents, storagePlacesUsed, hasEventPatch, STORAGE_MAX } from './owevents.ts';
import { readTeleports, readExitPaths, hasOwTeleportPatch, TELEPORTS, EXIT_PATHS } from './owteleport.ts';
import { locationUses } from './owlinks.ts';
import { readCustomSprites, OW_CUSTOM_MAX } from './owcustom.ts';
import { levelsWithoutTile } from './owleveltiles.ts';
import { emptyL1Tiles, freeL1Tiles } from './owl1sheet.ts';
import type { PathKind } from './owpaths.ts';
import { hex } from './names.ts';

export type BudgetKey = 'destroys' | 'revealPairs' | 'l1Tiles' | 'stars' | 'exitPaths' | 'translevels' | 'eventStorage' | 'customSprites';
// a budget: `used` of `max`; `name` what it counts in the player's terms, `help` what using it up means
// (submap: the custom sprites' submap)
export interface Budget { key: BudgetKey; used: number; max: number; name: string; help: string; submap?: number }

// the reveal list's pairs doing something: the last pair of its tile (the game looks from the last one down), turning
// it into another tile
function revealPairsUsed(rom: Rom): number {
  const list = readRevealList(rom);
  return list.filter((p, k) => p.from !== p.to && !list.slice(k + 1).some((q) => q.from === p.from)).length;
}

// every budget of the ROM, those per submap for `submap` (0 the main map, 1–6: MAP_NAMES); kinds: the layer 1
// tiles' path kinds (owpaths.ts) – without them (being learned) no layer 1 tile budget
export function owBudgets(rom: Rom, submap: number, kinds: readonly PathKind[] | null = null): Budget[] {
  const out: Budget[] = [];
  const add = (key: BudgetKey, used: number, max: number, name: string, help: string, submap?: number) =>
    out.push({ key, used, max, name, help, ...(submap !== undefined ? { submap } : {}) });
  if (hasDestroyPatch(rom)) add('destroys', readDestroyList(rom).filter((d) => d.event !== NO_EVENT).length, DESTROYS,
    'Destroyed level tiles', 'Tiles events destroy (castles, fortresses and switch palaces collapsing) – an event destroys one');
  add('revealPairs', revealPairsUsed(rom), readRevealList(rom).length,
    'Reveal list', 'Kinds of tiles a reveal turns into another – a tile no pair turns into another needs a pair of its own (full: change one)');
  if (kinds) {
    const free = freeL1Tiles(emptyL1Tiles(rom), kinds).filter(Boolean).length;
    add('l1Tiles', OW_L1_TILES - free, OW_L1_TILES, 'Layer 1 tiles', 'Layer 1 tiles in use – a free one is room for a new tile');
  }
  if (hasOwTeleportPatch(rom)) {
    const kept = locationUses(rom);
    add('stars', readTeleports(rom).filter((t, i) => t.from || t.to || kept.has(i)).length, TELEPORTS,
      'Star and pipe links', 'Stars, pipes (a link both ways: one each way) and the places exits to the overworld teleport to');
    add('exitPaths', readExitPaths(rom).filter(Boolean).length, EXIT_PATHS,
      'Exit paths', 'Exit paths to another submap (a link both ways: one each way)');
  }
  add('translevels', MAX_TRANSLEVEL - levelsWithoutTile(readTranslevels(rom)).length, MAX_TRANSLEVEL,
    'Levels on the overworld', 'Levels a level tile enters or a stop tile holds (a route\'s stops: the ways Mario walks off them) – the others are without level tile, free to place');
  if (hasEventPatch(rom)) add('eventStorage', storagePlacesUsed(readEvents(rom)), STORAGE_MAX,
    'Event tile storage', 'Room for the layer 2 tiles events write (each step\'s piece of 2×2 or 6×6 tiles)');
  add('customSprites', readCustomSprites(rom)[submap]?.length ?? 0, OW_CUSTOM_MAX,
    `Custom sprites on ${MAP_NAMES[submap] ?? `submap ${submap}`}`, 'Custom overworld sprites placed on this submap', submap);
  return out;
}

// the submap with the most custom overworld sprites (of several the first): the one whose budget the World check lists
export function fullestSubmap(rom: Rom): number {
  const lists = readCustomSprites(rom), n = MAP_NAMES.map((_, m) => lists[m]?.length ?? 0);
  return n.indexOf(Math.max(...n));
}

// how full a budget is: below 80 % ok, from 80 % amber, full red
export type BudgetLevel = 'ok' | 'amber' | 'full';
export const budgetLevel = (b: { used: number; max: number }): BudgetLevel => (b.used >= b.max ? 'full' : b.used >= b.max * 0.8 ? 'amber' : 'ok');
// "16 of 24 used (0x18) – 8 left": the numbers, for a gauge's hover
export const budgetText = (b: Budget): string =>
  `${b.used} of ${b.max} used (0x${hex(b.max, 2)}) – ${b.max > b.used ? `${b.max - b.used} left` : 'none left'}`;
