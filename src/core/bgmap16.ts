// Extended BG Map16 ("SMWH"): BG tiles $200-$FFF (pages 2-F) for level background tilemaps, like
// Lunar Magic's BG Map16 pages.
//
// The game draws BG tilemap columns in a single routine ($058D7A, also used for the initial screen):
// tile = $7EB900 (low) | $7EBD00 (high) << 8, its 8 bytes of tile words at $0D:9100 + tile*8. The
// high plane already holds full bytes (the RLE decoder writes it like the low plane), so only the
// lookup needs a hook: at $058DE6 (LDA $00 : ASL : ASL : ASL : TAY) tiles >= $200 take their words
// from a table in free space, smaller ones keep the vanilla table.

import { Rom } from './rom.ts';
import { Asm } from './asm.ts';
import { ownerNote } from './patchreg.ts';
import { missingPatch } from './patches.ts';

export const BG_EXT_FIRST = 0x200;
export const BG_EXT_TILES = 0x1000; // BG tiles $000-$FFF
export const BG_HOOK_TILE = 0x058de6;
const MAGIC = [0x53, 0x4d, 0x57, 0x48]; // "SMWH"
const HEADER = 8; // +4 tile table pointer
const ORIG = [0xa5, 0x00, 0x0a, 0x0a, 0x0a, 0xa8];
export const BGMAP16_HOOKS: [number, number][] = [[BG_HOOK_TILE, ORIG.length]];
const VANILLA = 0x0d9100;

export interface BgMap16Ext { base: number; gfx: number }

export function bgMap16Ext(rom: Rom): BgMap16Ext | null {
  if (rom.r8(BG_HOOK_TILE) !== 0x22) return null;
  const base = rom.r24(BG_HOOK_TILE + 1) - HEADER;
  for (let i = 0; i < 4; i++) if (rom.r8(base + i) !== MAGIC[i]) return null;
  return { base, gfx: rom.r24(base + 4) };
}

// words of the vanilla BG tile (pages 0/1)
export function vanillaBgWords(rom: Rom, t: number): number[] {
  const a = VANILLA + (t & 0x1ff) * 8;
  return [rom.r16(a), rom.r16(a + 2), rom.r16(a + 4), rom.r16(a + 6)];
}

// new tiles start as the game's BG fill tile $025
export function installBgMap16Ext(rom: Rom): BgMap16Ext {
  const ex = bgMap16Ext(rom);
  if (ex) return ex;
  for (let i = 0; i < ORIG.length; i++) {
    if (rom.r8(BG_HOOK_TILE + i) !== ORIG[i]) throw new Error(`Unexpected code at $058DE6${ownerNote(rom, BG_HOOK_TILE, ORIG.length)} – extended BG Map16 not possible`);
  }
  const blank = vanillaBgWords(rom, 0x025);
  const n = BG_EXT_TILES - BG_EXT_FIRST;
  const gfxData = new Uint8Array(n * 8);
  for (let t = 0; t < n; t++) for (let k = 0; k < 4; k++) { gfxData[t * 8 + k * 2] = blank[k] & 0xff; gfxData[t * 8 + k * 2 + 1] = blank[k] >> 8; }
  const gfx = rom.allocWrite(gfxData);
  if ((gfx & 0xffff) + gfxData.length > 0x10000) throw new Error('BG Map16 table crosses a bank boundary');

  // M=16 X=16; $00 = tile. Out: Y = offset, [$0A] (bank $0C) = table
  const a = new Asm();
  a.b(...MAGIC); a.fill(HEADER - 4);
  a.label('Tile');
  a.b(0xa5, 0x00, 0xc9, 0x00, 0x02); // LDA $00 : CMP #$0200
  a.br(0xb0, 'ext');
  a.b(0x0a, 0x0a, 0x0a, 0xa8); // ASL ASL ASL TAY
  a.b(0xa9, VANILLA & 0xff, (VANILLA >> 8) & 0xff, 0x85, 0x0a); // LDA #$9100 : STA $0A
  a.b(0xe2, 0x20, 0xa9, VANILLA >> 16); // SEP #$20 : LDA #$0D
  a.br(0x80, 'bank');
  a.label('ext');
  a.b(0xc9, 0x00, 0x10); // CMP #$1000 (pages >= $10: draw tile $025)
  a.br(0x90, 'in');
  a.b(0xa9, 0x25, 0x00, 0x85, 0x00); // LDA #$0025 : STA $00
  a.br(0x80, 'Tile');
  a.label('in');
  a.b(0x38, 0xe9, 0x00, 0x02, 0x0a, 0x0a, 0x0a, 0xa8); // SEC : SBC #$0200 : ASL ASL ASL TAY
  a.b(0xa9, gfx & 0xff, (gfx >> 8) & 0xff, 0x85, 0x0a); // LDA #table : STA $0A
  a.b(0xe2, 0x20, 0xa9, gfx >> 16); // SEP #$20 : LDA #bank
  a.label('bank');
  a.b(0x85, 0x0c, 0xc2, 0x20, 0x6b); // STA $0C : REP #$20 : RTL
  const addr = rom.allocWrite(new Uint8Array(a.bytes.length));
  rom.writeBytes(addr, a.link(addr));
  rom.w24(addr + 4, gfx);
  const t = a.addrOf('Tile', addr);
  rom.writeBytes(BG_HOOK_TILE, Uint8Array.from([0x22, t & 0xff, (t >> 8) & 0xff, t >> 16, 0xea, 0xea]));
  return bgMap16Ext(rom)!;
}

const bgExt = (rom: Rom) => bgMap16Ext(rom) ?? missingPatch('Extended BG Map16 (SMWH)');
// tile words of an extended BG tile, null if t is not on pages 2-F
export function bgExtTileWords(rom: Rom, t: number): number[] | null {
  if (t < BG_EXT_FIRST || t >= BG_EXT_TILES) return null;
  const a = bgExt(rom).gfx + (t - BG_EXT_FIRST) * 8;
  return [rom.r16(a), rom.r16(a + 2), rom.r16(a + 4), rom.r16(a + 6)];
}

// ROM address of a BG tile's 8 bytes (vanilla table or extension)
export function bgTileAddr(rom: Rom, t: number): number | null {
  if (t < BG_EXT_FIRST) return VANILLA + t * 8;
  if (t >= BG_EXT_TILES) return null;
  return bgExt(rom).gfx + (t - BG_EXT_FIRST) * 8;
}

export function setBgExtTileWords(rom: Rom, t: number, words: number[]): void {
  const a = bgTileAddr(rom, t);
  if (a === null) throw new Error(`BG tile ${t.toString(16).toUpperCase()} outside 000–FFF`);
  words.forEach((w, k) => rom.w16(a + k * 2, w));
}

// any BG tile: words from the vanilla table or the extension (tile $025 outside 000-FFF)
export function bgTileWords(rom: Rom, t: number): number[] {
  if (t < BG_EXT_FIRST) return vanillaBgWords(rom, t);
  return bgExtTileWords(rom, t) ?? vanillaBgWords(rom, 0x025);
}
