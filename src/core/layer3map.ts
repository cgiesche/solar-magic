// Editing a level's layer 3 tilemap over the level, as Lunar Magic's "Load Layer 3 of Level" in its
// overworld editor (LM help: ov_file_load_layer3_level.htm): saved into the level's LT3 file (layer3gfx.ts).
//
// The edited tilemap is the whole layer 3 tilemap, VRAM words $5000-$5FFF, as the level loaded it; what is
// saved of it is the part the level's LT3 file is copied to (lt3Copy). A level without an LT3 file (or with
// one the patch leaves out) gets a new one under the status bar, 0x2000 bytes, so all of layer 3 below the
// status bar can be edited. Before saving, the emulator loads the level with the file as edited (lt3Override).

import type { Rom } from './rom.ts';
import type { Level } from './level.ts';
import type { LevelRender } from './levelemu.ts';
import { layer3TileAddr, LAYER3_STATUS_ROWS, type Layer3Geometry } from './render.ts';
import { levelLayer3, setLevelLayer3, fitsLayer3Slot, lt3Copy, LT3_SIZES, LT3_SLOT, L3_MAP_START, L3_MAP_END, type Lt3Place } from './layer3gfx.ts';
import { freeGfx, gfxRangeFor } from './patches.ts';
import { gfxBytes, importGfxFile } from './gfxfiles.ts';

export const L3_MAP_VRAM = L3_MAP_START, L3_MAP_WORDS = L3_MAP_END - L3_MAP_START;
export const NEW_LT3: Lt3Place = { dest: 0, size: 0 }; // under the status bar, 0x2000 bytes
const NEW_SIZE = 0x2000;
const hx = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');

// entry i of the layer 3 tilemap in VRAM, and the whole tilemap
export const layer3Word = (vram: Uint8Array, i: number) => vram[(L3_MAP_VRAM + i) * 2] | (vram[(L3_MAP_VRAM + i) * 2 + 1] << 8);
export function layer3Map(vram: Uint8Array): Uint16Array {
  return Uint16Array.from({ length: L3_MAP_WORDS }, (_, i) => layer3Word(vram, i));
}

// a tilemap word: tile number (bits 0-9), palette (10-12), priority, X and Y flip
export const L3_TILE = 0x3ff, L3_PAL = 0x1c00, L3_PRIO = 0x2000, L3_FLIP_X = 0x4000, L3_FLIP_Y = 0x8000;
export const l3Palette = (w: number) => (w & L3_PAL) >> 10;
export const withL3Palette = (w: number, p: number) => (w & ~L3_PAL) | (p << 10);
export const layer3WordText = (w: number) =>
  `${(w & L3_TILE).toString(16).toUpperCase().padStart(3, '0')} pal ${l3Palette(w)}${w & L3_PRIO ? ' prio' : ''}${w & L3_FLIP_X ? ' X-flip' : ''}${w & L3_FLIP_Y ? ' Y-flip' : ''}`;

// entry i of the tilemap is in the part an LT3 file placed `place` is copied to
export function lt3Covers(place: Lt3Place, i: number): boolean {
  const c = lt3Copy(place), k = L3_MAP_VRAM + i - c.vram;
  return k >= 0 && k * 2 < c.len;
}

// the LT3 file with the tilemap's words where they are copied from; its other bytes those of `base` (the
// file as stored; a new one: zeros)
export function lt3File(map: Uint16Array, place: Lt3Place, base: Uint8Array = new Uint8Array(NEW_SIZE)): Uint8Array {
  const out = base.slice(), c = lt3Copy(place);
  for (let k = 0; k * 2 < c.len; k++) {
    const w = map[c.vram - L3_MAP_VRAM + k];
    out[c.skip + k * 2] = w & 0xff;
    out[c.skip + k * 2 + 1] = w >> 8;
  }
  return out;
}

// the level's LT3 file an edit goes into (null: a new one) and its place
export function lt3Target(rom: Rom, n: number): { file: number | null; place: Lt3Place } {
  const g = levelLayer3(rom, n);
  if (g.lt3 !== 0xff && fitsLayer3Slot(rom, LT3_SLOT, g.lt3, LT3_SIZES[g.size])) return { file: g.lt3, place: { dest: g.dest, size: g.size } };
  return { file: null, place: NEW_LT3 };
}

// the level's LT3 file with its edited tilemap, for the emulator (levelemu.ts; padded to 0x2000 bytes)
export function lt3Override(rom: Rom, lv: Level): { data: Uint8Array; place: Lt3Place } | undefined {
  if (!lv.layer3) return undefined;
  const t = lt3Target(rom, lv.number), f = t.file !== null ? gfxBytes(rom, t.file) : null;
  const base = new Uint8Array(NEW_SIZE);
  if (f) base.set(f.data.subarray(0, NEW_SIZE));
  return { data: lt3File(lv.layer3, t.place, base), place: t.place };
}

// writes the level's edited tilemap into its LT3 file (in place), or a new file it then uses
export function saveLayer3(rom: Rom, n: number, map: Uint16Array): string {
  const t = lt3Target(rom, n);
  if (t.file !== null) {
    importGfxFile(rom, t.file, lt3File(map, t.place, gfxBytes(rom, t.file)!.data));
    return `Layer 3: ExGFX ${hx(t.file)}`;
  }
  const num = freeGfx(rom, new Set(), gfxRangeFor({ slot: LT3_SLOT }));
  if (num < 0) throw new Error('No free ExGFX number left for the layer 3 tilemap');
  importGfxFile(rom, num, lt3File(map, NEW_LT3));
  setLevelLayer3(rom, n, { ...levelLayer3(rom, n), lt3: num, ...NEW_LT3 });
  return `Layer 3: new ExGFX ${hx(num)}`;
}

// the levels whose LT3 is the file `num`
export function lt3Users(rom: Rom, num: number): number[] {
  return Array.from({ length: 0x200 }, (_, i) => i).filter((i) => levelLayer3(rom, i).lt3 === num);
}

// The tilemap over the level (render.ts layer3Geometry): cell (cx, cy) is the 8x8 tile at level pixel
// (cx * 8 - dx, cy * 8 - dy), as the level view draws layer 3
export const layer3CellAt = (g: Layer3Geometry, px: number, py: number) => ({ cx: Math.floor((px + g.dx) / 8), cy: Math.floor((py + g.dy) / 8) });
// the tilemap entry of a cell, -1: none (the status bar's rows, below the tilemap, outside $5000-$5FFF)
export function layer3Index(g: Layer3Geometry, cx: number, cy: number): number {
  if (cy < LAYER3_STATUS_ROWS || cy >= g.mh / 8) return -1;
  const cols = g.mw / 8, i = (layer3TileAddr(g, ((cx % cols) + cols) % cols, cy) >> 1) - L3_MAP_VRAM;
  return i >= 0 && i < L3_MAP_WORDS ? i : -1;
}

// where layer 3's graphics are in VRAM (bytes), by BG34NBA
export const layer3CharBase = (ppuRegs: Uint8Array) => (ppuRegs[0x0c] & 0x0f) << 13;

// the first layer 3 tile without a visible pixel (its 2bpp graphics all 0): what erasing puts in
export function blankTile(vram: Uint8Array, charBase: number): number {
  for (let t = 0; t < 0x400; t++) {
    let blank = true;
    for (let k = 0; k < 16 && blank; k++) blank = vram[(charBase + t * 16 + k) & 0xffff] === 0;
    if (blank) return t;
  }
  return 0;
}
export const blankLayer3Tile = (r: LevelRender) => blankTile(r.vram, layer3CharBase(r.ppuRegs));
