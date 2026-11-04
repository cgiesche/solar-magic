// A submap's layer 3 tilemap (the overworld's border) edited in 8x8 tiles, as Lunar Magic's "Load Layer 3 of Submap"
// (issue #264): saved into the submap's LT3 file (layer3gfx.ts, its entry 200–206), which the overworld's load copies
// in place of the border; a submap without one gets a new file at the start of layer 3, 0x800 bytes (256x256, Lunar
// Magic's: the screen's part of the tilemap).
//
// Layer 3 is fixed on the screen: the Game workspace edits it as the screen (owborder.ts, #330), the screen's 32x28
// tiles from VRAM as the game shows them after the load – the level name's stripe and the lives the game writes over
// the file there (owL3GameWrites), so what is shown of them is the game's – in front of the screen behind it (owScreen).

import type { Rom } from './rom.ts';
import { cameraX, cameraY, get16, RAM } from './ram.ts';
import { layer3TileAddr, layer3Geometry } from './render.ts';
import { lt3Target, lt3Read, saveLayer3, layer3Map, lt3Users, lt3Covers, L3_MAP_VRAM, L3_MAP_WORDS } from './layer3map.ts';
import { levelLayer3, setLevelLayer3, LT3_SLOT, type Lt3Place } from './layer3gfx.ts';
import { gfxBytes, importGfxFile } from './gfxfiles.ts';
import { submapGfxEntry, freeGfx, gfxRangeFor, LEVEL_GFX_ENTRIES } from './patches.ts';
import { SUBMAP_LT3_DEST } from './submapgfx.ts';
import { MAP_NAMES, type OverworldLoads } from './overworld.ts';
import { PPU } from './ppu.ts';
import type { Job } from './jobrunner.ts';
import { hex } from './names.ts';
import { OwRefusal } from './owrefusal.ts';

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

// The border edited as the screen (the Game workspace, #330): cell (c, r) of the screen's 32x28.

// whether the game writes over cell (c, r) of the border as the overworld loads: row 4, the lives (columns 8–9) and the
// level name's stripe (11–29), whatever the file has there (testowborder: what a load draws over a border painted whole)
export const owL3GameWrites = (c: number, r: number) => r === 4 && ((c >= 8 && c <= 9) || (c >= 11 && c <= 29));

// the cells brush `b` put at cell (cx, cy) paints (tilemap entry → word): those the map's file holds (`place`), the game
// doesn't write over (owL3GameWrites) and that don't show the word already (`shown`: the entry's word now)
export function borderStamp(g: OwLayer3Grid, place: Lt3Place, b: { w: number; h: number; tiles: number[] }, cx: number, cy: number,
  shown: (i: number) => number): Map<number, number> {
  const out = new Map<number, number>();
  b.tiles.forEach((w, k) => {
    const x = cx + (k % b.w), y = cy + Math.floor(k / b.w);
    if (x < 0 || y < 0 || x >= OW_L3_COLS || y >= OW_L3_ROWS || owL3GameWrites(x, y)) return;
    const i = g.entry(x, y);
    if (i >= 0 && lt3Covers(place, i) && shown(i) !== w) out.set(i, w);
  });
  return out;
}

// where map `map`'s border is saved: its LT3 file (null: none yet, the game's border; the first edit makes one) and the
// other entries using that file (levels, submaps: lt3Users)
export function submapBorderFile(rom: Rom, map: number): { file: number | null; others: number[] } {
  const t = submapLt3Target(rom, map), own = submapGfxEntry(map);
  return { file: t.file, others: t.file === null ? [] : lt3Users(rom, t.file).filter((n) => n !== own) };
}
// map `map` gets a border file of its own: a copy of the file it shares (same bytes and place) under a free number;
// the others keep theirs. What was done
export function ownBorderFile(rom: Rom, map: number): string {
  const t = submapLt3Target(rom, map);
  if (t.file === null) throw new OwRefusal({ kind: 'borderNoFile', map: MAP_NAMES[map] });
  const num = freeGfx(rom, new Set(), gfxRangeFor({ slot: LT3_SLOT }));
  if (num < 0) throw new OwRefusal({ kind: 'borderNoExGfx' });
  importGfxFile(rom, num, gfxBytes(rom, t.file)!.data.slice());
  const e = submapGfxEntry(map);
  setLevelLayer3(rom, e, { ...levelLayer3(rom, e), lt3: num, ...t.place });
  return `Border: ExGFX ${hex(num, 3)}, a copy of ${hex(t.file, 3)}`;
}
// map `map` shows the border of map `from` (fromVram: VRAM after `from`'s load), saved as an edit of its own
// (saveSubmapLayer3: into its file, else a new one); the cells the game writes stay the game's
export function takeBorder(rom: Rom, map: number, from: number, fromVram: Uint8Array): string {
  return saveSubmapLayer3(rom, map, submapLayer3(rom, from, fromVram));
}
// map `map` shows the game's border again: it uses no LT3 file (the file stays in the ROM, for its other users)
export function resetBorder(rom: Rom, map: number): void {
  const e = submapGfxEntry(map);
  setLevelLayer3(rom, e, { ...levelLayer3(rom, e), lt3: 0xff });
}

// The screen behind the border: map `map` (special: after the special world) at event progress 0 as the game shows
// it after the load – the map, the sprites, Mario – without layer 3 (256x224 RGBA). Kept as the loads' derived results.
export function owScreen(loads: OverworldLoads, map: number, special: boolean): Uint32Array {
  return loads.derive('owScreen', () => {
    loads.restore(map, 0, special);
    const s = loads.emu.snes, ppu = new PPU(s), hook = s.hook;
    s.ppu = ppu;
    s.hook = null;
    try {
      // (the first frame is drawn before the NMI sets the scroll registers of a PPU new to them)
      s.runFrame();
      s.runFrame();
      // drawn again, layer 3 off on the main and the sub screen
      const regs = s.ppuRegs.slice();
      for (let y = 0; y < 224; y++) {
        s.ppuRegs.set(regs);
        s.ppuRegs[0x2c] &= ~0x04;
        s.ppuRegs[0x2d] &= ~0x04;
        ppu.renderLine(y);
      }
      s.ppuRegs.set(regs);
      return ppu.frame.slice();
    } finally {
      s.ppu = null;
      s.hook = hook;
    }
  }, `${map}${special ? ':special' : ''}`);
}
export function* owScreenJob(loads: OverworldLoads, map: number, special: boolean): Job<Uint32Array> {
  return owScreen(loads, map, special);
}
