// A submap's layer 3 tilemap (the overworld's border) edited in 8x8 tiles, as Lunar Magic's "Load Layer 3 of Submap"
// (issue #264): saved into the submap's LT3 file (layer3gfx.ts, its entry 200–206), which the overworld's load copies
// in place of the border; a submap without one gets a new file at the start of layer 3, 0x800 bytes (256x256, Lunar
// Magic's: the screen's part of the tilemap).
//
// Layer 3 is fixed on the screen: the editor draws it over the map at the camera of the load (a submap's view; on the
// main map where the load puts Mario), the screen's 32x28 tiles, from VRAM as the game shows it after the load – the
// level name's stripe and the lives the game writes over the file there, so what is shown of them is the game's.

import type { Rom } from './rom.ts';
import { cameraX, cameraY, get16, RAM } from './ram.ts';
import { layer3TileAddr, layer3Geometry } from './render.ts';
import { lt3Target, lt3Read, saveLayer3, layer3Map, L3_MAP_VRAM, L3_MAP_WORDS } from './layer3map.ts';
import type { Lt3Place } from './layer3gfx.ts';
import { gfxBytes } from './gfxfiles.ts';
import { submapGfxEntry, LEVEL_GFX_ENTRIES } from './patches.ts';
import { SUBMAP_LT3_DEST } from './submapgfx.ts';
import { MAP_NAMES } from './overworld.ts';

// a new LT3 file of a submap: the start of layer 3, 256x256
export const SUBMAP_NEW_LT3: Lt3Place = { dest: SUBMAP_LT3_DEST, size: 2 };
export const OW_L3_COLS = 32, OW_L3_ROWS = 28; // the screen's tiles

// the submap's LT3 file an edit goes into (null: a new one) and its place
export const submapLt3Target = (rom: Rom, map: number) => lt3Target(rom, submapGfxEntry(map), SUBMAP_NEW_LT3);

// The tilemap ($5000–$5FFF) the submap's file holds, for an edit: the file's words where it is copied to, VRAM's of
// the load (`vram`) elsewhere – with no file all VRAM's, which a new file starts from (the game's border, and what the
// game wrote over it, which it writes over the file again)
export function submapLayer3(rom: Rom, map: number, vram: Uint8Array): Uint16Array {
  const out = layer3Map(vram), t = submapLt3Target(rom, map);
  return t.file === null ? out : lt3Read(out, t.place, gfxBytes(rom, t.file)!.data);
}

// writes the submap's edited tilemap into its LT3 file (in place), or a new file it then uses; what was done
export function saveSubmapLayer3(rom: Rom, map: number, tilemap: Uint16Array): string {
  return saveLayer3(rom, submapGfxEntry(map), tilemap, SUBMAP_NEW_LT3);
}

// The screen's layer 3 tiles over the map of a load (OwRender, LevelRender): the screen's top left at map pixel
// (x, y), the camera; cell (c, r) of the screen (32x28 8x8 tiles) at (x + c * 8, y + r * 8) shows tilemap entry
// entry(c, r) (layer 3's scroll in whole tiles; -1: outside $5000–$5FFF, which an LT3 file can't hold)
export interface OwLayer3Grid { x: number; y: number; entry: (c: number, r: number) => number }
export function owLayer3Grid(r: { wram: Uint8Array; ppuRegs: Uint8Array }): OwLayer3Grid {
  const g = layer3Geometry(r), w = r.wram;
  const sx = get16(w, RAM.layer3X) >> 3, sy = get16(w, RAM.layer3Y) >> 3, cols = g.mw / 8, rows = g.mh / 8;
  return {
    x: (cameraX(w) << 16) >> 16, y: (cameraY(w) << 16) >> 16,
    entry: (c, rr) => {
      const i = (layer3TileAddr(g, (c + sx) % cols, (rr + sy) % rows) >> 1) - L3_MAP_VRAM;
      return i >= 0 && i < L3_MAP_WORDS ? i : -1;
    },
  };
}

// the levels and submaps (entries, lt3Users) as text: "level 105, Yoshi's Island"
export function lt3UserText(users: number[]): string {
  return users.map((n) => (n < LEVEL_GFX_ENTRIES ? `level ${n.toString(16).toUpperCase().padStart(3, '0')}` : MAP_NAMES[n - submapGfxEntry(0)])).join(', ');
}
