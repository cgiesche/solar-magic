// Changing a level's header (the level header dialog's Apply): the level sizes possible for a level and
// mode, each with the reason it is not, and a header change applied to the level by the rules a level
// mode sets – or refused with the reason.
//  - a mode without heights (hasLevelSize) takes the game's height: refused while objects or sprites lie
//    below what it reaches; the screens are clamped to what the level size leaves room for;
//  - switching to a mode with layer 2 objects gives the level empty layer 2 object data, switching away
//    drops it, layer 2 then a BG tilemap: level 105's (BG_FALLBACK_LEVEL) unless it is an edited one;
//  - layer 2 scroll rates: the paired setting, or separate horizontal and vertical rates (l2scroll.ts).

import type { Rom } from './rom.ts';
import {
  L2_PTRS, MAX_LEVEL_SIZE, SUBSCREEN_ROWS, hasLayer2Objects, hasLevelSize, levelRows, maxScreens,
  type Level, type PrimaryHeader, type SecondaryHeader,
} from './level.ts';
import { withRates } from './l2scroll.ts';

// the level whose BG tilemap a level without one of its own takes (one of layer 2 objects, measuring levels)
export const BG_FALLBACK_LEVEL = 0x105;
export const fallbackBgPointer = (rom: Rom): number => rom.r24(L2_PTRS + BG_FALLBACK_LEVEL * 3);
// the BG tilemap a level shows: its own, or for a level of layer 2 objects level 105's
export const levelBgPointer = (rom: Rom, lv: Pick<Level, 'layer2Objects' | 'layer2Pointer'>): number =>
  lv.layer2Objects ? fallbackBgPointer(rom) : lv.layer2Pointer;

const hex3 = (v: number) => v.toString(16).toUpperCase().padStart(3, '0');
const hex2 = (v: number) => v.toString(16).toUpperCase().padStart(2, '0');

export const NO_HEIGHTS = 'Horizontal levels without layer 2 objects only';

// the lowest row the level's objects and sprites lie in (-1: none)
export const lowestRow = (lv: Pick<Level, 'objects' | 'sprites'>): number =>
  Math.max(-1, ...lv.objects.map((o) => o.y), ...lv.sprites.map((q) => q.y));

// why the level's objects and sprites don't fit a level size ('': they do)
export function objectsBelow(lv: Pick<Level, 'objects' | 'sprites'>, size: number): string {
  const lowest = lowestRow(lv);
  return lowest >= Math.max(levelRows({ levelSize: size }), SUBSCREEN_ROWS) ? `Objects or sprites lie down to row ${hex3(lowest)}` : '';
}

export interface LevelSizeOption {
  size: number;
  rows: number;
  screens: number; // the most screens the size leaves room for
  reason: string; // why the size can't be chosen ('': it can)
}

// the level sizes (00-1C) for the level in a mode with a number of screens
export function levelSizeOptions(rom: Rom, lv: Pick<Level, 'objects' | 'sprites'>, mode: number, screens: number): LevelSizeOption[] {
  return Array.from({ length: MAX_LEVEL_SIZE + 1 }, (_, size) => {
    const rows = levelRows({ levelSize: size }), most = maxScreens({ levelSize: size });
    const reason = !hasLevelSize(rom, mode) && size ? NO_HEIGHTS : screens > most ? `The level has ${screens} screens` : objectsBelow(lv, size);
    return { size, rows, screens: most, reason };
  });
}

export interface HeaderChange {
  header: PrimaryHeader;
  secondary: SecondaryHeader; // with the paired layer 2 setting (layer2Scroll) when rates is null
  rates: { h: number; v: number } | null; // separate horizontal and vertical layer 2 rates (RATE_OPTIONS)
  spriteHeader: number;
  bgPointer: number | null; // the BG tilemap (a pointer); null: the level's own stays (an edited one)
}

// the level size a change gives the level: a mode without heights takes the game's
const changedSize = (rom: Rom, c: HeaderChange): number => (hasLevelSize(rom, c.header.mode) ? c.secondary.levelSize : 0);

// why the change can't be applied to the level ('': it can)
export function headerRefusal(rom: Rom, lv: Level, c: HeaderChange): string {
  const size = changedSize(rom, c);
  if (size === lv.secondary.levelSize) return '';
  const why = objectsBelow(lv, size);
  return !why ? '' : !hasLevelSize(rom, c.header.mode)
    ? `Level mode ${hex2(c.header.mode)} has no heights, and ${why[0].toLowerCase()}${why.slice(1)} – move them up first.`
    : `Level size ${hex2(size)}: ${why[0].toLowerCase()}${why.slice(1)} – move them up first.`;
}

// applies the change to the level; the reason it is refused (the level unchanged), '' when applied
export function applyHeaderChange(rom: Rom, lv: Level, c: HeaderChange): string {
  const why = headerRefusal(rom, lv, c);
  if (why) return why;
  const toL2 = hasLayer2Objects(c.header.mode), modeChangedL2 = toL2 !== hasLayer2Objects(lv.header.mode);
  const sd: SecondaryHeader = { ...c.secondary, levelSize: changedSize(rom, c) };
  lv.header = { ...c.header, screens: Math.min(c.header.screens, maxScreens(sd)) };
  lv.secondary = c.rates ? withRates(sd, c.rates.h, c.rates.v) : { ...sd, layer2Separate: 0, layer2HAuto: 0, layer2V: 0 };
  lv.spriteHeader = c.spriteHeader;
  if (c.bgPointer !== null) { lv.bg = null; lv.layer2Pointer = c.bgPointer; }
  if (modeChangedL2 && toL2 && !lv.layer2Objects) { lv.layer2Objects = []; lv.layer2Header = new Uint8Array(5); }
  if (modeChangedL2 && !toL2 && lv.layer2Objects) {
    lv.layer2Objects = null;
    if (lv.layer2Pointer >> 16 !== 0xff) lv.layer2Pointer = fallbackBgPointer(rom);
  }
  return '';
}
