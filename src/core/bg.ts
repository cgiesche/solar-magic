// Level background tilemaps (layer 2 in levels without layer 2 objects): 32×27 BG Map16 tiles,
// two 16-column halves, decoded by the game to $7EB900 (low bytes) / $7EBD00 (high bytes).

import { rleEncode, rleDecode } from './rle.ts';

export const BG_W = 32, BG_H = 27;
export const BG_SIZE = 0x360; // entries per byte plane that the level uses

// WRAM offset of BG tile (x, y); the map repeats every 32 columns and 27 rows
export function bgIndex(tx: number, ty: number): number {
  const x = ((tx % BG_W) + BG_W) % BG_W, y = ((ty % BG_H) + BG_H) % BG_H;
  return (x >> 4) * 0x1b0 + y * 16 + (x & 15);
}

export function bgFromWram(wram: Uint8Array): Uint16Array {
  const bg = new Uint16Array(BG_SIZE);
  for (let o = 0; o < BG_SIZE; o++) bg[o] = wram[0xb900 + o] | (wram[0xbd00 + o] << 8);
  return bg;
}

// editor format: RLE of 0x800 bytes (low plane $B900-$BCFF, high plane $BD00-$C0FF) + FF FF;
// pages 2-F need the extended BG Map16 (bgmap16.ts); unused entries keep the game's fill values ($25 / page 0)
export function encodeBg(bg: Uint16Array): Uint8Array {
  const plane = new Array<number>(0x800);
  for (let o = 0; o < 0x400; o++) {
    plane[o] = o < BG_SIZE ? bg[o] & 0xff : 0x25;
    plane[0x400 + o] = o < BG_SIZE ? (bg[o] >> 8) & 0x0f : 0;
  }
  return Uint8Array.from([...rleEncode(plane, true), 0xff, 0xff]);
}

export function decodeBg(data: Uint8Array): Uint16Array {
  const plane = new Uint16Array(0x800);
  rleDecode(data, 0, plane, 0, 0x800);
  const bg = new Uint16Array(BG_SIZE);
  for (let o = 0; o < BG_SIZE; o++) bg[o] = plane[o] | ((plane[0x400 + o] & 0x0f) << 8);
  return bg;
}
