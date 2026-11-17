// The overworld's layer 1 tiles as a graphics part (see CONTEXT.md: Graphics part): the layer 1 Map16 of Lunar
// Magic's overworld as Callisto exports it – a BPS from the clean game to a whole Lunar Magic ROM (the Romhack Races
// baserom's export/global/overworld.bps). A package that redraws the overworld's graphics (global GFX files) has the
// tiles drawing them there: without them the game's tiles draw 8x8 tiles that hold other pictures (#509). The tiles
// are read from the patch's target where its pointers say they are (overworld.ts: the game's table or Lunar Magic's
// expansion); the bytes the patch takes from the clean game come from this ROM where it still has them
// (cleangame.ts). Only the game's tiles 00–C0 are read, and only those differing from the clean game's are the
// package's; the rest of the patch's overworld (layers, events, names) is not taken over.

import { snesToPc } from './rom.ts';
import { cleanGameBps, known } from './cleangame.ts';
import { GAME_OW_MAP16, GAME_OW_TILES, OW_MAP16_LO, OW_MAP16_BANK, owTileAddr, owTileWords, sameOwTile } from './overworld.ts';

type Source = (o: number) => number | null;
// the clean game's bytes with its pointer to the tiles' table: the editor's own 0x200 tiles moved that pointer in
// this ROM (its block is no longer the clean game's), and a patch leaving the table where it is takes it from there
const POINTER = new Map([[snesToPc(OW_MAP16_LO), GAME_OW_MAP16 & 0xff], [snesToPc(OW_MAP16_LO) + 1, (GAME_OW_MAP16 >> 8) & 0xff], [snesToPc(OW_MAP16_BANK), GAME_OW_MAP16 >> 16]]);
const withPointer = (clean: Source | null): Source => (o) => POINTER.get(o) ?? clean?.(o) ?? null;

// whether a file is such a patch with layer 1 tiles of its own, told from the patch alone: a byte of the tiles' table
// that it brings itself or takes from another place of the clean game (tiles swapped, a tile blanked with bytes the
// game has elsewhere) – not the clean game's byte at that place
export function isOwTileBps(data: Uint8Array): boolean {
  const rom = cleanGameBps(data, withPointer(null));
  if (!rom) return false;
  const at = known(() => owTileAddr(rom, 0));
  if (at === 'not known') return false;
  let asked = -1; // the clean game's byte the patch's reader asked for
  const patch = cleanGameBps(data, (o) => { asked = o; return null; })!;
  for (let i = 0; i < GAME_OW_TILES * 8; i++) {
    const pc = snesToPc(at) + i;
    if (patch.byte(pc) !== null || asked !== pc) return true;
  }
  return false;
}

// the patch's layer 1 tiles 00–C0 (each one's four words); null when it is no such patch, 'not known' when it needs
// bytes of the clean game this ROM no longer has (`clean`: cleangame.ts cleanGameBytes)
export function owTilesOfBps(data: Uint8Array, clean: Source | null): number[][] | null | 'not known' {
  return known(() => {
    const rom = cleanGameBps(data, withPointer(clean));
    return rom && Array.from({ length: GAME_OW_TILES }, (_, t) => owTileWords(rom, t));
  });
}

// the clean game's layer 1 tiles 00–C0; null where this ROM no longer has them
export function cleanOwTiles(clean: Source | null): number[][] | null {
  if (!clean) return null;
  const table = snesToPc(GAME_OW_MAP16), out: number[][] = [];
  for (let t = 0; t < GAME_OW_TILES; t++) {
    const b = Array.from({ length: 8 }, (_, i) => clean(table + t * 8 + i));
    if (b.some((v) => v === null)) return null;
    out.push([0, 1, 2, 3].map((q) => b[q * 2]! | (b[q * 2 + 1]! << 8)));
  }
  return out;
}

// a patch's tiles differing from the clean game's (tile → its words); null when it is no such patch, 'not known'
// when the clean game's bytes it needs are not in this ROM
export function changedOwTiles(data: Uint8Array, clean: Source | null): Map<number, number[]> | null | 'not known' {
  const tiles = owTilesOfBps(data, clean), game = cleanOwTiles(clean);
  if (!tiles) return null;
  if (tiles === 'not known' || !game) return 'not known';
  return new Map(tiles.flatMap((w, t): [number, number[]][] => (sameOwTile(w, game[t]) ? [] : [[t, w]])));
}
