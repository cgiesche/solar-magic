// Which tilesets share a Map16 tile's data. The FG Map16 tiles 000-1FF draw from the pointers the level
// load puts at $0FBE (bank $0D addresses of their four 8x8 tiles); for the tileset tiles 073-0FF they
// depend on the level's tileset, and several tilesets point at the same data (in the clean game 0/7/C,
// 2/6/8, 3/9/A/B/E, 4/5/D): editing such a tile changes it in all of them. Learned by loading a level
// with each tileset in the emulator, not from a table.

import type { Rom } from './rom.ts';
import type { RomReads } from './romdeps.ts';
import type { LevelEmulator, LevelOverride } from './levelemu.ts';
import { L1_PTRS } from './level.ts';
import { map16Pointer } from './ram.ts';
import { gfxDisplaySkipMask } from './gfxpages.ts';

export const TILESETS = 16; // the header's 4 bits
const FG_TILES = 0x200;
const PROBE_LEVEL = 0x105; // the level loaded with each tileset (its own objects and sprites left out)

// the load of the probe level with tileset ts, no objects and no sprites
function probe(rom: Rom, ts: number): LevelOverride {
  const h = rom.bytes(rom.r24(L1_PTRS + PROBE_LEVEL * 3), 5);
  return { layer1: Uint8Array.of(h[0], h[1], h[2], h[3], (h[4] & 0xf0) | ts, 0xff), sprites: Uint8Array.of(0, 0xff) };
}

// the result cache key of tilesetPointers
export const pointersKey = (ts: number) => `tsp1:${ts}`;

// The pointers of FG Map16 tiles 000-1FF ($0FBE) as a level of tileset ts loads them, and what the load
// read. The reads leave out the display data (gfxDisplaySkipMask), the tiles' quarters included (the pointers
// don't depend on it, so drawing a tile or changing a color keeps the result): a first load finds where
// it is. Not on top of the boot's reads: the title screen's level read tile data too.
export function tilesetPointers(emu: LevelEmulator, ts: number): { result: number[]; reads: RomReads } {
  const rom = emu.rom;
  const load = () => { const r = emu.load(PROBE_LEVEL, probe(rom, ts)); return Array.from({ length: FG_TILES }, (_, t) => map16Pointer(r.wram, t)); };
  const mask = gfxDisplaySkipMask(rom, [load()]);
  return emu.withSkipMask(mask, () => emu.record('behaviour', load, { base: null }));
}

// the tilesets in which FG tile t has the same data as in tileset ts (ts included); ptrs: per tileset
// (tilesetPointers)
export function sharingTilesets(ptrs: number[][], ts: number, t: number): number[] {
  const p = ptrs[ts][t];
  return ptrs.flatMap((q, i) => (q[t] === p ? [i] : []));
}

// the words of FG Map16 tiles 000-1FF by a tileset's pointers (tilesetPointers)
export function tilesetWords(rom: Rom, ptrs: number[]): number[][] {
  return ptrs.map((p) => [0, 1, 2, 3].map((k) => rom.r16((0x0d0000 | p) + k * 2)));
}
