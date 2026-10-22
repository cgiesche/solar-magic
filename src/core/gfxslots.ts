// The graphics slots of a level: which file is in which slot (FG1-FG3/BG1 and SP1-SP4 of the level's GFX
// bypass, BG2/BG3 of the VRAM patch, layer 3's LG1-LG4 and LT3), with the defaults, and putting a file
// (or the default) into one. The tables they are kept in (patches.ts, layer3gfx.ts) stay behind it.
// - FG/BG/SP: FF in the bypass takes the file from the header's tileset / sprite set;
// - BG2/BG3, LT3: FF is none;
// - LG1-LG4: FF is the game's 28-2B;
// - an LT3 file copies at most its own length (its copy size shrinks to fit it, never grows).

import type { Rom } from './rom.ts';
import { gfxEntry, levelGfx, setLevelGfx, defaultGfx, levelExtGfx, setLevelExtGfx } from './patches.ts';
import { levelLayer3, setLevelLayer3, lt3SizeFor, LG_SLOT_NAMES, LT3_SLOT, GAME_LAYER3_GFX, type Lt3Place } from './layer3gfx.ts';

// slots of a level: name, where it is kept (the GFX bypass in levelGfx order, BG2/BG3, layer 3's LG1-LG4 or
// LT3) and its index there, file, default file; first: the first 8x8 tile number (Map16 tiles, for SP1-SP4
// the sprite tile number in OAM: 100-1FF = page 1, for LG1-LG4 the layer 3 tile number); map16: a layer
// slot the Map16 tiles draw from
export type SlotKind = 'gfx' | 'ext' | 'lg' | 'lt3';
export interface GfxSlot { name: string; kind: SlotKind; k: number; file: number; def: number; custom: boolean; first: number; sprite: boolean; map16: boolean }

// where each slot is kept and its first 8x8 tile, in the order the slots are listed
const LAYOUT: { name: string; kind: SlotKind; k: number; first: number }[] = [
  ...([['FG1', 7, 0], ['FG2', 6, 0x80], ['BG1', 5, 0x100], ['FG3', 4, 0x180], ['SP1', 3, 0x00], ['SP2', 2, 0x80], ['SP3', 1, 0x100], ['SP4', 0, 0x180]] as const)
    .map(([name, k, first]) => ({ name, kind: 'gfx' as const, k, first })),
  ...['BG2', 'BG3'].map((name, k) => ({ name, kind: 'ext' as const, k, first: 0x200 + k * 0x80 })),
  ...LG_SLOT_NAMES.map((name, k) => ({ name, kind: 'lg' as const, k, first: k * 0x80 })),
  { name: LT3_SLOT, kind: 'lt3', k: 0, first: 0 },
];

// the slots' names: those a file can be put into
export const GFX_SLOTS = LAYOUT.map((l) => l.name);

// all slots of level `level`; `header`: its tileset and sprite set (the open level's as edited)
export function levelSlots(rom: Rom, level: number, header: { tileset: number; spriteGfx: number }): GfxSlot[] {
  const set = levelGfx(rom, level), ex = levelExtGfx(rom, level), l3 = levelLayer3(rom, level);
  const def = defaultGfx(rom, header.tileset, header.spriteGfx);
  return LAYOUT.map((l) => {
    const own = l.kind === 'gfx' ? set[l.k] : l.kind === 'ext' ? ex[l.k] : l.kind === 'lg' ? l3.lg[l.k] : l3.lt3;
    const d = l.kind === 'gfx' ? def[l.k] : l.kind === 'lg' ? GAME_LAYER3_GFX + l.k : 0xff;
    const sprite = l.name.startsWith('SP');
    return { ...l, file: own !== 0xff ? own : d, def: d, custom: own !== 0xff, sprite, map16: (l.kind === 'gfx' && !sprite) || l.kind === 'ext' };
  });
}

// the layer slots the Map16 tiles draw from, in VRAM order (128 tiles each from tile 000): FG1-FG3/BG1,
// BG2/BG3 while they hold a file
export const layerSlots = (slots: GfxSlot[]): GfxSlot[] => slots.filter((s) => s.map16 && (s.kind === 'gfx' || s.file !== 0xff));
// the layer slot 8x8 tile `num` is loaded from
export const slotOfTile = (slots: GfxSlot[], num: number): GfxSlot | undefined => layerSlots(slots).find((s) => num >= s.first && num < s.first + 0x80);

// puts `file` into slot `name` of level `level` (FF: the default / none); an LT3 file goes to `place`
// when given (else where the level has it, its copy size fitted to the file)
export function assignSlot(rom: Rom, level: number, name: string, file: number, place?: Lt3Place): void {
  const s = LAYOUT.find((x) => x.name === name);
  if (!s) throw new Error(`No graphics slot ${name}`);
  if (s.kind === 'gfx') { const set = levelGfx(rom, level); set[s.k] = file; setLevelGfx(rom, level, set); }
  else if (s.kind === 'ext') { const ex = levelExtGfx(rom, level); ex[s.k] = file; setLevelExtGfx(rom, level, ex); }
  else {
    const g = levelLayer3(rom, level);
    if (s.kind === 'lg') g.lg[s.k] = file;
    else {
      g.lt3 = file;
      if (place) { g.dest = place.dest; g.size = place.size; }
      const e = file !== 0xff ? gfxEntry(rom, file) : null;
      if (e) g.size = Math.max(g.size, lt3SizeFor(e.size));
    }
    setLevelLayer3(rom, level, g);
  }
}
