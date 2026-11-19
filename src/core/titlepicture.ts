// Where the title screen picture is in the ROM (titlescreen.ts reads and writes it): on its own, without that
// module's imports, for the boot (levelemu.ts), which leaves it out of its reads.

import { snesToPc, type Rom, type RomRange } from './rom.ts';

export const TITLE_STRIPE_PTR = 0x0084d3; // the stripe image table ($0084D0), entry 03

// where the title screen's stripe image is (SNES address)
export function titleStripeAddr(rom: Rom): number {
  const o = snesToPc(TITLE_STRIPE_PTR);
  return rom.data[o] | (rom.data[o + 1] << 8) | (rom.data[o + 2] << 16);
}

// [start, end) ROM offsets of the title screen picture: its entry of the stripe image table and the stripe image
// there, to its end byte (a stripe: VRAM address, flags and length – bit 6 a run of one word –, the data; a first
// byte with bit 7 ends the image; walked as menutext.ts walks a menu's). What the game reads to draw it and nothing else reads: it only reaches layer 3's
// tilemap, which a level's load writes anew (levelemu.ts boot).
export function titlePictureRanges(rom: Rom): RomRange[] {
  const d = rom.data, ptr = snesToPc(TITLE_STRIPE_PTR), start = snesToPc(titleStripeAddr(rom));
  const out: RomRange[] = [[ptr, ptr + 3]];
  if (start >= d.length) return out;
  let o = start;
  while (o + 4 <= d.length && !(d[o] & 0x80)) o += 4 + (d[o + 2] & 0x40 ? 2 : (((d[o + 2] & 0x3f) << 8) | d[o + 3]) + 1);
  out.push([start, Math.min(o + 1, d.length)]);
  return out;
}
