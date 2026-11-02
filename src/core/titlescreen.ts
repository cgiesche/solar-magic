// The title screen's layer 3 tilemap: the logo, the frame and the copyright line, drawn over the title screen
// level's layers 1 and 2 with layer 3's graphics as that level has them.
//
// The game draws it with stripe image 03 (the stripe image table's entry at $0084D3, the clean game's data
// at $05B375: 17 stripes). Lunar Magic (its overworld editor's "Title Screen" mode) writes it anew as one
// stripe at VRAM $5000 of 32 × 29 tiles – the 28 rows on screen and the row below them – ended by $80, in a
// RATS block in free space, and points the entry there (seen in ROMs Lunar Magic saved: header 50 00 07 3F,
// RATS size 0x745; older versions wrote 28 rows, 06 FF, some also the right screen at $5400). The editor
// writes that layout. What it edits is read from VRAM once the game reached the title screen, so a tilemap
// the game's stripes left partly unwritten (what the game cleared VRAM to) is kept as shown.

import { Rom, snesToPc } from './rom.ts';
import type { LevelEmulator } from './levelemu.ts';
import { PPU } from './ppu.ts';
import { L3_MAP_VRAM, layer3Word, layer3CharBase } from './layer3map.ts';

export const TITLE_COLS = 32, TITLE_ROWS = 29, TITLE_SHOWN_ROWS = 28;
export const TITLE_STRIPE_PTR = 0x0084d3; // the stripe image table ($0084D0), entry 03
const VRAM = L3_MAP_VRAM; // layer 3's tilemap
const LEN = TITLE_COLS * TITLE_ROWS * 2;
const END = 0x80; // ends the stripe image (any byte with bit 7 where a header would start)

// where the title screen's stripe image is (SNES address)
export function titleStripeAddr(rom: Rom): number {
  const o = snesToPc(TITLE_STRIPE_PTR);
  return rom.data[o] | (rom.data[o + 1] << 8) | (rom.data[o + 2] << 16);
}

// the tilemap as the game shows it on the title screen (32 × 29 words, row by row)
export function titleTilemap(emu: LevelEmulator): Uint16Array {
  const v = emu.bootState().vram as Uint8Array;
  return Uint16Array.from({ length: TITLE_COLS * TITLE_ROWS }, (_, i) => layer3Word(v, i));
}

// Lunar Magic's stripe image of a tilemap
export function titleStripe(map: Uint16Array): Uint8Array {
  const out = new Uint8Array(4 + LEN + 1);
  out.set([VRAM >> 8, VRAM & 0xff, (LEN - 1) >> 8, (LEN - 1) & 0xff]);
  map.forEach((w, i) => { out[4 + i * 2] = w & 0xff; out[5 + i * 2] = w >> 8; });
  out[4 + LEN] = END;
  return out;
}

// writes the tilemap as the title screen's stripe image: a new RATS block (the one written before freed; the
// game's own data stays where it is, unused). The whole stripe image is replaced: a further stripe Lunar Magic
// may have written (the right screen) would be dropped – the editor opens only the clean game and its own ROMs.
export function writeTitleScreen(rom: Rom, map: Uint16Array): void {
  if (map.length !== TITLE_COLS * TITLE_ROWS) throw new Error('A title screen has 32 × 29 tiles');
  rom.freeAt(titleStripeAddr(rom));
  const at = rom.allocWrite(titleStripe(map));
  rom.writeAt(snesToPc(TITLE_STRIPE_PTR), Uint8Array.from([at & 0xff, (at >> 8) & 0xff, at >> 16]));
}

export interface TitlePicture {
  frame: Uint32Array; // 256 × 224, as the game draws it
  vram: Uint8Array;
  cgram: Uint8Array;
  charBase: number; // layer 3's graphics in VRAM (bytes)
}

// the title screen as the game draws it, with `map` as its tilemap (default: its own); the emulator's state
// state at the title screen stays as booted (its machine is left after the frames drawn)
export function titlePicture(emu: LevelEmulator, map?: Uint16Array): TitlePicture {
  const s = emu.snes, ppu = new PPU(s), hook = s.hook;
  s.loadState(emu.bootState());
  if (map) map.forEach((w, i) => { s.vram[(VRAM + i) * 2] = w & 0xff; s.vram[(VRAM + i) * 2 + 1] = w >> 8; });
  s.ppu = ppu;
  s.hook = null;
  try {
    // the first frame is drawn before the NMI sets the scroll registers of a PPU new to them
    s.runFrame();
    s.runFrame();
  } finally {
    s.ppu = null;
    s.hook = hook;
  }
  return { frame: ppu.frame.slice(), vram: s.vram.slice(), cgram: s.cgram.slice(), charBase: layer3CharBase(s.ppuRegs) };
}
