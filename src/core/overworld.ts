// Overworld data (vanilla formats) and emulation-based loading of OW graphics.

import { Rom, snesToPc } from './rom.ts';
import { Snes, type SnesState } from './snes.ts';
import { RomReads, record, countReads, bySince, type Since } from './romdeps.ts';
import { KeptResults } from './keptresults.ts';
import { rleDecode, rleEncode } from './rle.ts';
import { GM, RAM, SPECIAL_FLAG } from './ram.ts';
import { decodeTile } from './gfx.ts';
import { TileCache, blit8, charBase } from './render.ts';
import { assemble } from './asar.ts';
import { missingPatch } from './patches.ts';
import { lz2Compress, lz2Decompress } from './lz2.ts';
import { owExanimDataRanges, type RomRead } from './exanim.ts';
import { hasOwnContent } from './level.ts';
import { hasMessages, clearMessages } from './messages.ts';
import { levelName, hasLevelName, clearLevelName, levelNameRanges } from './levelnames.ts';
import { submapPaletteRanges } from './submapgfx.ts';
import { eventDataRanges } from './owevents.ts';
import { teleportDataRanges } from './owteleport.ts';
import { KOOPA_X, KOOPA_Y, KOOPAS } from './owlinks.ts';
import { START, OW_SPRITES, OW_SPRITE_SLOTS, KOOPA_KID, KOOPA_KIDS, hasOwSpriteSlots, hasKoopaKidTable } from './owsprites.ts';
import { customSpriteRanges } from './owcustom.ts';
import { LF_SAVE_SWITCH } from './owoptions.ts';
import type { Job } from './jobrunner.ts';
import type { LevelTileTest } from './owpaths.ts';

export const OW_L1 = 0x0cf7df; // 0x800 bytes: 2 maps × 32×32 16x16 tiles (quadrant layout)
export const OW_MAIN_TILES = 0x400; // the main map's tiles come first (l1Index), the submaps' after them
const L2_TILE_PTR = 0x04dc72; // LDA #$A533 operand
const L2_BANK = 0x04dc79; // LDA #$04 operand (shared bank of both streams)
const L2_ATTR_PTR = 0x04dc8d; // LDA #$C02B operand

export const MAP_NAMES = ['Main map', "Yoshi's Island", 'Vanilla Dome', 'Forest of Illusion', 'Valley of Bowser', 'Special World', 'Star World'];

export function l1Index(map: number, x: number, y: number): number {
  return map * 0x400 + ((y >> 4) * 2 + (x >> 4)) * 0x100 + (y & 15) * 16 + (x & 15);
}
// a layer 1 tile's position on its 512x512 map (l1Index without the map)
export function l1XY(i: number): { x: number; y: number } {
  return { x: ((i >> 8) & 1) * 16 + (i & 15), y: ((i >> 9) & 1) * 16 + ((i >> 4) & 15) };
}
// Where the overworld editor shows a pixel of a region's 512x512 map. The submaps' region is shown moved right by two
// and down by one 8x8 tile, wrapping around: the clean game puts its submaps there (the left ones' cameras at x −17,
// Yoshi's Island's ladder starting in the region's last row), the screen wrapping as the camera shows them. So each
// submap is shown whole. The main map is shown as it is.
export const SUBMAPS_SHOWN_SHIFT = { x: 16, y: 8 };
const shownShift = (region: number) => (region ? SUBMAPS_SHOWN_SHIFT : { x: 0, y: 0 });
// a map pixel's place as shown
export function owShownAt(region: number, x: number, y: number): { x: number; y: number } {
  const s = shownShift(region);
  return { x: (x + s.x) & 511, y: (y + s.y) & 511 };
}
// the map pixel shown at (x, y); outside the shown 512x512 moved back by the shift only (a drag past the edge)
export function owMapAt(region: number, x: number, y: number): { x: number; y: number } {
  const s = shownShift(region), back = (v: number, d: number) => (v >= 0 && v < 512 ? (v - d) & 511 : v - d);
  return { x: back(x, s.x), y: back(y, s.y) };
}
// the offsets to draw a map's pixels at, clipped to the shown 512x512, so that they appear where owShownAt shows them
export function owShownCopies(region: number): { x: number; y: number }[] {
  const s = shownShift(region);
  if (!s.x && !s.y) return [{ x: 0, y: 0 }];
  return [[0, 0], [-512, 0], [0, -512], [-512, -512]].map(([dx, dy]) => ({ x: s.x + dx, y: s.y + dy }));
}
export function l2Index(map: number, x: number, y: number): number {
  return map * 0x1000 + ((y >> 5) * 2 + (x >> 5)) * 0x400 + (y & 31) * 32 + (x & 31);
}

// A package that replaces the whole overworld, which the overworld workspace would corrupt (ADR 0005): its name, null
// when the overworld is the game's. Overworld Revolution (yoshifanatic) marks its ROMs with `YFOR` at $048000.
const OW_REPLACEMENTS = [{ addr: 0x048000, sig: 'YFOR', name: 'Overworld Revolution (yoshifanatic)' }];
export function overworldReplacement(rom: Rom): string | null {
  for (const r of OW_REPLACEMENTS) if ([...r.sig].every((c, k) => rom.r8(r.addr + k) === c.charCodeAt(0))) return r.name;
  return null;
}

// Layer 1: per tile (l1Index order) its low byte in the game's place (OW_L1, copied to $7EC800 as the overworld
// loads) and its high byte (the tile's Map16 page) from Lunar Magic's map of them (#90; LC_LZ2, decompressed to
// $7FC800 by the translevel table's hijack, its pointer at $04D822, bank at $04D827 – as in the ROMs Lunar Magic
// saved); without it the game clears $7FC800. The game reads the high byte only where it draws layer 1 (the load's
// $04DCF2 and the rows it draws as it scrolls); where Mario walks, enters levels and events reveal or destroy tiles it
// reads the low byte at $7EC800.
const L1_HI_PTR = 0x04d822, L1_HI_BANK = 0x04d827;
const L1_HI_SLACK = 0x40; // free bytes after the map in its block, so that later strokes still fit
export const hasL1HighMap = (rom: RomRead): boolean => hasTranslevelTable(rom) && rom.r8(L1_HI_PTR - 1) === 0xa2 && rom.r8(L1_HI_BANK - 1) === 0xa9;
function readL1High(rom: Rom): Uint8Array | null {
  if (!hasL1HighMap(rom)) return null;
  const at = snesToPc(packedAt(rom, L1_HI_PTR, L1_HI_BANK)), t = lz2Decompress(rom.data, at);
  rom.noteRead(at, t.size);
  return t.data.subarray(0, 0x800);
}
export function readL1(rom: Rom): Uint16Array {
  const out = Uint16Array.from(rom.bytes(OW_L1, 0x800));
  readL1High(rom)?.forEach((b, i) => { out[i] |= b << 8; });
  return out;
}
// tiles 100–1FF need the high byte map (an editor ROM has it)
export function writeL1(rom: Rom, d: ArrayLike<number>): void {
  const hi = Uint8Array.from(d, (t) => t >> 8), has = hasL1HighMap(rom);
  if (!has && hi.some((b) => b)) missingPatch('Overworld layer 1 tiles 100–1FF');
  rom.writeBytes(OW_L1, Uint8Array.from(d, (t) => t & 0xff));
  if (!has || readL1High(rom)!.every((b, i) => b === hi[i])) return;
  writePacked(rom, L1_HI_PTR, L1_HI_BANK, hi, L1_HI_SLACK);
}

// The layer 1 tiles' Map16: per tile its four quarters (8x8 tile words in the order TL, BL, TR, BR, as the FG Map16
// tiles), 8 bytes each. The game has tiles 00–C0 at $05D000; Lunar Magic's expansion (#90), as in the ROMs it saved,
// has 0x200 tiles (pages 0 and 1) in a block of free space, pointed to where the game points to $05D000: the first of
// the Map16 pointers the overworld's load puts at $0FBE (0x200 of them in the game already; $04DC3B, low word), the
// load's drawing of layer 1 ($04DCBC low word, $04DCC1 bank) and the bank of the rows the game draws as it scrolls
// ($058B22, LDY #$05 where the tileset is the overworld's). The editor's patch moves them so, the new tiles C1–1FF
// starting as tile 00 (empty).
const OW_MAP16_PTRS = 0x04dc3b, OW_MAP16_LO = 0x04dcbc, OW_MAP16_BANK = 0x04dcc1, OW_MAP16_ROW_BANK = 0x058b22;
const GAME_OW_MAP16 = 0x05d000, GAME_OW_TILES = 0xc1;
// the operands the patch changes, Lunar Magic's hijack: a third-party patch may not change them (patchapply.ts)
export const OW_MAP16_HOOKS: [number, number][] = [[OW_MAP16_PTRS, 2], [OW_MAP16_LO, 2], [OW_MAP16_BANK, 1], [OW_MAP16_ROW_BANK, 1]];
export const OW_L1_TILES = 0x200;
const owMap16 = (rom: RomRead): number => (rom.r8(OW_MAP16_BANK) << 16) | rom.r16(OW_MAP16_LO);
export const hasOwMap16Ext = (rom: RomRead): boolean => owMap16(rom) !== GAME_OW_MAP16;
export const owTileAddr = (rom: RomRead, t: number): number => owMap16(rom) + t * 8;
export function owTileWords(rom: RomRead, t: number): number[] {
  const at = owTileAddr(rom, t);
  return [0, 1, 2, 3].map((q) => rom.r16(at + q * 2));
}
export function setOwTileWords(rom: Rom, t: number, ws: number[]): void {
  if (t < 0 || t >= OW_L1_TILES) throw new Error(`No overworld layer 1 tile ${t.toString(16).toUpperCase()}`);
  if (!hasOwMap16Ext(rom)) missingPatch('Overworld layer 1 Map16 (0x200 tiles)');
  const at = owTileAddr(rom, t);
  ws.forEach((w, q) => rom.w16(at + q * 2, w));
}
export function installOwMap16Patch(rom: Rom): void {
  if (hasOwMap16Ext(rom)) return;
  const d = new Uint8Array(OW_L1_TILES * 8);
  d.set(rom.bytes(GAME_OW_MAP16, GAME_OW_TILES * 8));
  for (let t = GAME_OW_TILES; t < OW_L1_TILES; t++) d.copyWithin(t * 8, 0, 8);
  const at = rom.allocWrite(d);
  rom.w16(OW_MAP16_PTRS, at & 0xffff);
  rom.w16(OW_MAP16_LO, at & 0xffff);
  rom.w8(OW_MAP16_BANK, at >> 16);
  rom.w8(OW_MAP16_ROW_BANK, at >> 16);
}
// how often layer 1 has tile t as in the ROM (before events): on the main map and on the submaps
export function owTileUses(rom: Rom, t: number): { main: number; submaps: number } {
  const l1 = readL1(rom);
  let main = 0, submaps = 0;
  for (let k = 0; k < 0x800; k++) if (l1[k] === t) { if (k < 0x400) main++; else submaps++; }
  return { main, submaps };
}

export function l2Pointers(rom: Rom): { tiles: number; attrs: number } {
  const bank = rom.r8(L2_BANK);
  return { tiles: (bank << 16) | rom.r16(L2_TILE_PTR), attrs: (bank << 16) | rom.r16(L2_ATTR_PTR) };
}

export function readL2(rom: Rom): Uint16Array {
  const out = new Uint16Array(0x2000);
  const p = l2Pointers(rom);
  rom.noteRead(snesToPc(p.tiles), rleDecode(rom.data, snesToPc(p.tiles), out, 0, 0x2000));
  rom.noteRead(snesToPc(p.attrs), rleDecode(rom.data, snesToPc(p.attrs), out, 8, 0x2000));
  return out;
}

// free space a moved layer 2 gets between its two streams, so that later strokes still fit in its block
const L2_SLACK = 0x200;

// Writes layer 2 where it is when it fits: a stream that didn't change keeps its bytes, one that did is written in
// its own space (the tile stream up to the attribute stream, the attribute stream up to the end of its RATS block or
// its old length); else both go to the space from the tile stream on (the attributes at its end), else to free space.
// Returns the bytes of the two streams.
export function writeL2(rom: Rom, entries: Uint16Array): number {
  const old = l2Pointers(rom), d = rom.data;
  const oldT = new Uint16Array(0x2000), oldA = new Uint16Array(0x2000);
  const tLen = rleDecode(d, snesToPc(old.tiles), oldT, 0, 0x2000);
  const aLen = rleDecode(d, snesToPc(old.attrs), oldA, 0, 0x2000);
  const stream = (shift: number, was: Uint16Array, at: number, len: number) => {
    const v = Array.from(entries, (e) => (e >> shift) & 0xff);
    return v.every((b, i) => b === was[i]) ? d.slice(snesToPc(at), snesToPc(at) + len) : Uint8Array.from(rleEncode(v));
  };
  const t = stream(0, oldT, old.tiles, tLen), a = stream(8, oldA, old.attrs, aLen);
  const rats = old.attrs > old.tiles ? rom.isRatsAt(snesToPc(old.tiles) - 8) : -1;
  const end = rats > 0 ? old.tiles + rats : old.attrs + aLen;
  const tRoom = old.attrs > old.tiles ? old.attrs - old.tiles : tLen;
  if (t.length <= tRoom && a.length <= end - old.attrs) {
    rom.writeBytes(old.tiles, t);
    rom.writeBytes(old.attrs, a);
  } else if (old.attrs > old.tiles && t.length + a.length <= end - old.tiles) {
    rom.writeBytes(old.tiles, t);
    rom.writeBytes(end - a.length, a);
    rom.w16(L2_ATTR_PTR, (end - a.length) & 0xffff);
  } else {
    const payload = new Uint8Array(t.length + L2_SLACK + a.length);
    payload.set(t);
    payload.set(a, t.length + L2_SLACK);
    rom.freeAt(old.tiles);
    const addr = rom.allocWrite(payload);
    rom.w16(L2_TILE_PTR, addr & 0xffff);
    rom.w16(L2_ATTR_PTR, (addr + t.length + L2_SLACK) & 0xffff);
    rom.w8(L2_BANK, addr >> 16);
  }
  return t.length + a.length;
}

// ---- level tiles and their translevels ----
// Level tiles and the translevel each enters, stored per tile in Lunar Magic's translevel table (ADR 0005): the
// game numbers the level tiles by scanning layer 1 ($04D7F2), so placing one shifts every later
// level's number, name, base event and flags. Lunar Magic replaces the scan with a table of the 0x800 tiles'
// translevels, LC_LZ2 compressed and decompressed to $7ED000 (its pointer at $04D803, bank at $04D808 –
// Ankouno's OverworldTables.asm), then the layer 1 tiles' high bytes (readL1) to $7FC800. The patch writes Lunar
// Magic's code of the two byte for byte (as in a ROM it saved); after them its own: each level tile's initial flags
// ($04D678 by translevel) to $7ED800, as the game's routine, and the event tiles' YXPCCCTT decompressed again
// ($04DD40), $7F0000 being the VRAM patch's in a level; then, as the game's and Lunar Magic's, the passed events.
// Translevel 0 is no level (the scan starts at 1); a level tile has one, any other tile 0. Which tiles are level
// tiles the game's code decides: learned by emulation (owpaths.ts levelTileTest), passed in where it matters.

export function translevelToLevel(t: number): number {
  return t < 0x25 ? t : t + 0xdc;
}

const TL_HOOK = 0x04d7f2, TL_HOOK_END = 0x04d85d;
const TL_PTR = 0x04d803; // LDX #$xxxx operand: the table's address
const TL_BANK = 0x04d808; // LDA #$xx operand: its bank
const TL_COUNT = 0x04d859; // CMP #$xx operand: the events the load runs (owevents.ts)
export const MAX_TRANSLEVEL = 0x5f; // level 13B
const TL_SLACK = 0x40; // free bytes after the table in its block, so that later changes still fit
// the game's code the patch replaces (SNES address, length), Lunar Magic's hijack: a third-party patch may not change it (patchapply.ts)
export const TRANSLEVEL_HOOKS: [number, number][] = [[TL_HOOK, TL_HOOK_END - TL_HOOK]];
const TL_CODE_SIZE = 0x30;
const hx = (n: number) => '$' + n.toString(16).toUpperCase();

// (code: the free space of the flags' routine)
const translevelAsm = (code: number) => `lorom
org ${hx(TL_HOOK)}
Translevels:
  REP #$30 : LDA.w #$0000 : SEP #$20
  LDX.w #${hx(RAM.owTranslevels)} : STX $00 : LDA.b #$7E : STA $02     ; the translevels to $7E${hx(RAM.owTranslevels).slice(1)}
  assert pc() == ${hx(TL_PTR - 1)}
  LDX.w #$0000 : STX $8A                                         ; (the table, written by the editor)
  assert pc() == ${hx(TL_BANK - 1)}
  LDA.b #$00 : STA $8C
  PHP : PHK : PER .tl-1 : PEA.w $804C                            ; the game's decompression (RTS) through an RTL of bank 0
  JML $80B8DE
.tl
  PLP
  LDX.w #${hx(RAM.owLayer1)} : STX $00 : LDA.b #$7F : STA $02     ; the tiles' high bytes to $7F${hx(RAM.owLayer1).slice(1)}
  assert pc() == ${hx(L1_HI_PTR - 1)}
  LDX.w #$0000 : STX $8A
  assert pc() == ${hx(L1_HI_BANK - 1)}
  LDA.b #$00 : STA $8C
  PHP : PHK : PER .hi-1 : PEA.w $804C
  JML $80B8DE
.hi
  PLP
  JSL Flags
  TSC : STA $0E                                ; the event tiles' YXPCCCTT to $7F0000 again: in a level it is the VRAM patch's;
  JSL $84DD40                                  ; called long, its end an RTS or an RTL (Free $7F0000 makes it one), the
  TSC : CMP $0E : BEQ + : PLA                  ; bank an RTS leaves dropped
+
  padbyte $EA : pad $04D84F
  STZ $0F                                      ; the passed events, as the game's
- JSR $DA49
  INC $0F : LDA $0F
  assert pc() == ${hx(TL_COUNT - 1)}           ; the count where Lunar Magic's is (owevents.ts: 0x78)
  CMP #$6F : BNE -
  RTS
assert pc() == ${hx(TL_HOOK_END)}

org ${hx(code)}
Flags:
  REP #$30 : TDC : SEP #$20
  LDX.w #${hx(RAM.owTileFlags)} : STX $0A : LDA.b #$7E : STA $0C   ; the flags, as the game's
  LDY.w #$07FF
- TYX
  LDA.l $7E${hx(RAM.owTranslevels).slice(1)},x : BEQ +
  TAX : LDA.l $04D678,x                        ; the translevel's initial flags
+ STA [$0A],y
  DEY : BPL -
  RTL
warnpc ${hx(code + TL_CODE_SIZE)}
`;

// Lunar Magic's hijack, detected as OverworldTables.asm does
export function hasTranslevelTable(rom: RomRead): boolean {
  return rom.r8(TL_BANK - 1) === 0xa9;
}
// a packed table's address (the operands of its long pointer)
const packedAt = (rom: RomRead, ptr: number, bank: number) => (rom.r8(bank) << 16) | rom.r16(ptr);
// its block in free space (its payload with the room after it), null: none
function packedBlock(rom: Rom, ptr: number, bank: number): { snes: number; size: number } | null {
  const at = packedAt(rom, ptr, bank);
  const size = at && snesToPc(at) >= 0x80008 ? rom.isRatsAt(snesToPc(at) - 8) : -1;
  return size > 0 ? { snes: at, size } : null;
}
// writes a table (LC_LZ2) where it is when it fits its block, else to free space (with `slack` bytes after it)
function writePacked(rom: Rom, ptr: number, bank: number, data: Uint8Array, slack: number): void {
  const block = packedBlock(rom, ptr, bank); // null: the patch being installed
  const packed = lz2Compress(data);
  if (block && packed.length <= block.size) { rom.writeBytes(block.snes, packed); return; }
  if (block) rom.freeAt(block.snes);
  const payload = new Uint8Array(packed.length + slack);
  payload.set(packed);
  const addr = rom.allocWrite(payload);
  rom.w16(ptr, addr & 0xffff);
  rom.w8(bank, addr >> 16);
}

// the translevel of every layer 1 tile (l1Index order)
export function readTranslevels(rom: Rom): Uint8Array {
  if (!hasTranslevelTable(rom)) missingPatch('Translevels per level tile');
  const out = new Uint8Array(0x800);
  const at = snesToPc(packedAt(rom, TL_PTR, TL_BANK)), t = lz2Decompress(rom.data, at);
  rom.noteRead(at, t.size);
  out.set(t.data.subarray(0, 0x800));
  return out;
}

// the maps as in the ROM: layer 1, layer 2 and the translevel of each layer 1 tile (what the overworld view shows)
export function readMaps(rom: Rom): { l1: Uint16Array; l2: Uint16Array; tls: Uint8Array } {
  return { l1: readL1(rom), l2: readL2(rom), tls: readTranslevels(rom) };
}

// the level each level tile enters (l1Index → level number) in a ROM read through `r` – another than the
// open one, e.g. the Lunar Magic ROM a BPS makes (cleangame.ts), whose reads may throw; null without
// Lunar Magic's translevel table. The tiles the table gives a translevel, without a test of the tile: the editor gives
// one only to a level tile placed in the Levels mode (owleveltiles.ts; also one placed after an event); the game's
// scan and Lunar Magic also to the star tiles (5F), which enter no level
export function levelTileLevels(r: RomRead): Map<number, number> | null {
  if (!hasTranslevelTable(r)) return null;
  const at = packedAt(r, TL_PTR, TL_BANK);
  const packed = new Proxy({} as { readonly [i: number]: number }, { get: (_, k) => r.r8(at + Number(k)) });
  const t = lz2Decompress(packed, 0).data;
  const out = new Map<number, number>();
  for (let i = 0; i < 0x800; i++) if (t[i]) out.set(i, translevelToLevel(t[i]));
  return out;
}

// writes the table where it is when it fits its block, else to free space; unchanged: nothing written
export function writeTranslevels(rom: Rom, t: Uint8Array): void {
  if (!hasTranslevelTable(rom)) missingPatch('Translevels per level tile');
  if (packedBlock(rom, TL_PTR, TL_BANK) && readTranslevels(rom).every((v, i) => v === t[i])) return;
  writePacked(rom, TL_PTR, TL_BANK, t, TL_SLACK);
}

// needs Asar (loadAsar) to be loaded; every tile gets the translevel the game gives it (its table in WRAM, emulated)
// and the high byte 0
export function installTranslevelPatch(rom: Rom): void {
  if (hasTranslevelTable(rom)) return;
  const game = new OverworldEmulator(rom).load(0, 0);
  if (!game.ok) throw new Error('The overworld did not load – translevel table not installed');
  const t = game.wram.slice(RAM.owTranslevels, RAM.owTranslevelsEnd);
  const code = rom.allocWrite(new Uint8Array(TL_CODE_SIZE));
  const r = assemble(rom.data, new Map([['translevels.asm', translevelAsm(code)]]), 'translevels.asm');
  if (!r.ok) throw new Error(r.errors.map((e) => e.message).join(' '));
  for (const [a, n] of [...TRANSLEVEL_HOOKS, [code, TL_CODE_SIZE]]) rom.writeAt(snesToPc(a), r.rom.subarray(snesToPc(a), snesToPc(a) + n));
  writeTranslevels(rom, t);
  writePacked(rom, L1_HI_PTR, L1_HI_BANK, new Uint8Array(0x800), L1_HI_SLACK);
}

// the translevel no tile enters that `rank` (lower first, translevelUse) prefers, the lowest of equals (0: all are entered)
export function freeTranslevel(t: Uint8Array, rank: (tl: number) => number = () => 0): number {
  const used = new Set(t);
  let best = 0, bestRank = Infinity;
  for (let n = 1; n <= MAX_TRANSLEVEL; n++) {
    if (used.has(n)) continue;
    const r = rank(n);
    if (r < bestRank) { best = n; bestRank = r; }
  }
  return best;
}

// paints tile v at i (l1 and t changed): a level tile (isLevel) takes `carried` (the translevel it was picked up from the
// map with), else keeps the one there (a level tile painted over), else gets a free one (as freeTranslevel); any
// other tile none, so the translevel of a level tile painted over is free again (its level keeps its settings)
export function placeTile(l1: Uint16Array, t: Uint8Array, i: number, v: number, isLevel: LevelTileTest, carried = 0, rank?: (tl: number) => number): void {
  l1[i] = v;
  if (!isLevel(v)) t[i] = 0;
  else if (carried) t[i] = carried;
  else if (!t[i]) t[i] = freeTranslevel(t, rank);
}

// the translevels more than one level tile enters, with their tiles
export function sharedTranslevels(l1: ArrayLike<number>, t: Uint8Array, isLevel: LevelTileTest): Map<number, number[]> {
  const tiles = new Map<number, number[]>();
  t.forEach((n, i) => { if (n && isLevel(l1[i])) (tiles.get(n) ?? tiles.set(n, []).get(n)!).push(i); });
  for (const [n, l] of tiles) if (l.length < 2) tiles.delete(n);
  return tiles;
}

// the layer 1 tiles (l1Index) entering translevel tl
export function levelTilesOf(l1: ArrayLike<number>, t: ArrayLike<number>, tl: number, isLevel: LevelTileTest): number[] {
  const out: number[] = [];
  for (let i = 0; i < t.length; i++) if (tl && t[i] === tl && isLevel(l1[i])) out.push(i);
  return out;
}

// the levels a level tile can enter (001–024, 101–13B: translevels 1–5F)
export const enterableLevels = (): number[] => Array.from({ length: MAX_TRANSLEVEL }, (_, k) => translevelToLevel(k + 1));

// ---- a translevel's settings ----
// The name, base event, exit reveal directions and messages belong to the level (its translevel), not to a
// tile: a level tile painted over leaves them, a new one entering the level shows them. The editor resets them only
// when asked (resetTranslevel), never the level's data.

// per translevel ($04D678): the direction each exit (normal, secret 1–3; bits 7-6 … 1-0) reveals the path in when
// first passed, copied per tile to $7ED800 by the patch; every value is a direction (0 up, 1 down, 2 left, 3 right)
export const EXIT_DIRS = 0x04d678;
export const DIR_ARROWS = ['↑', '↓', '←', '→'];
export const DIR_NAMES = ['up', 'down', 'left', 'right'];
export const EXIT_NAMES = ['Normal exit', 'Secret exit 1', 'Secret exit 2', 'Secret exit 3'];
export const exitDirections = (rom: Rom, tl: number): number[] => [6, 4, 2, 0].map((b) => (rom.r8(EXIT_DIRS + tl) >> b) & 3);
// exit 0 normal, 1–3 the secret exits ($0DD5 - 1)
export function setExitDirection(rom: Rom, tl: number, exit: number, dir: number): void {
  const b = 6 - exit * 2;
  rom.w8(EXIT_DIRS + tl, (rom.r8(EXIT_DIRS + tl) & ~(3 << b)) | ((dir & 3) << b));
}

export const NO_EVENT = 0xff; // a base event no exit runs (the clean game's Top Secret Area, Star Roads)

// ---- initial level flags (Lunar Magic's) ----
// The flags ($1EA2, ram.ts levelFlags) each translevel starts a new game with: the directions Mario may walk
// from its tiles, passed, midway, and Lunar Magic's "no entry if passed" and "save prompt". The game sets 8 of
// them from a list ($009EE0); as Lunar Magic, the patch copies a table of all 0x60 into the new file instead
// ($05DDA0, at $009F19 by a JSL to $05DD80), and checks the two flags of its own where the game enters a level
// ($049199, $03BA50) and decides on the save prompt after one passed ($048F8A, $03BA10) – the places and bits
// SMW Central's hijack map gives and Lunar Magic's code in a ROM it saved uses; the editor's code is its own.
export const LEVEL_FLAGS = 0x05dda0;
export const FLAG = { right: 0x01, left: 0x02, down: 0x04, up: 0x08, savePrompt: 0x10, noEntry: 0x20, midway: 0x40, passed: 0x80 } as const;
// the flag of each direction (DIR_NAMES order) – the game's joypad bits
export const DIR_FLAGS = [FLAG.up, FLAG.down, FLAG.left, FLAG.right];
const LF_INIT_HOOK = 0x009f19, LF_INIT = 0x05dd80;
const LF_SAVE_HOOK = 0x048f8a, LF_SAVE_LOOP = 0x049001, LF_SAVE = 0x03ba10;
const LF_ENTER_HOOK = 0x049199, LF_ENTER = 0x03ba50, LF_END = 0x03bae6;
// the places of the game the patch writes its code to (SNES address, length), Lunar Magic's hijack
const LF_CODE: [number, number][] = [[LF_INIT_HOOK, 4], [LF_INIT, LEVEL_FLAGS - LF_INIT], [LF_SAVE_HOOK, 5], [LF_SAVE_LOOP, 2], [LF_ENTER_HOOK, 4], [LF_SAVE, LF_END - LF_SAVE]];
// …with the table: a third-party patch may change none of it (patchapply.ts)
export const LEVEL_FLAGS_HOOKS: [number, number][] = [...LF_CODE, [LEVEL_FLAGS, MAX_TRANSLEVEL + 1]];

const levelFlagsAsm = () => `lorom
; a new file: the initial flags of every translevel (the game's loop of 8 has run once)
org ${hx(LF_INIT_HOOK)}
  JSL InitFlags
org ${hx(LF_INIT)}
InitFlags:
  PHP
  REP #$30
  LDX #$005E
- LDA.l ${hx(LEVEL_FLAGS)},x : STA.l $7E${hx(RAM.fileLevelFlags).slice(1)},x
  DEX : DEX : BPL -
  PLP
  RTL
warnpc ${hx(LEVEL_FLAGS)}

; a level passed (A/X/Y 8, $04 Mario's tile): the tile the game looks up in its list of save tiles – the
; list's last one ($80) when the translevel's save prompt flag is set, $FF (none) when the switch is 0 (Lunar
; Magic's option "save prompt after castles …", owoptions.ts); the list's loop goes on with A. Lunar Magic's
; routine byte for byte, the switch at +$16
org ${hx(LF_SAVE_HOOK)}
  JSL SavePrompt : NOP
org ${hx(LF_SAVE_LOOP)}
  db $10, ${hx((LF_SAVE_HOOK + 5 - (LF_SAVE_LOOP + 2)) & 0xff)}        ; BPL to the CMP after the hook
org ${hx(LF_SAVE)}
SavePrompt:
  PHP
  REP #$30
  LDX $04
  LDA.l $7E${hx(RAM.owTranslevels).slice(1)},x : AND.w #$00FF : TAX
  LDA.w ${hx(RAM.levelFlags)},x : AND.w #${hx(FLAG.savePrompt)} : BNE .flag
  assert pc() == ${hx(LF_SAVE_SWITCH - 1)}           ; the overworld option's switch (owoptions.ts)
  LDA.w #$0001 : BEQ .none
  LDA.w ${hx(RAM.owTile)}
.ret:
  LDX.w #$0007
  PLP
  RTL
.flag:
  LDA.w #$0080 : BRA .ret
.none:
  LDA.w #$00FF : BRA .ret
warnpc ${hx(LF_ENTER)}

; A pressed on a tile (A 8 = the tile): carry set when Mario doesn't enter – a tile above $80, as the game's
; CMP #$81 : BEQ/BCS, or a translevel passed with its no entry flag set
org ${hx(LF_ENTER_HOOK)}
  JSL NoEntry
org ${hx(LF_ENTER)}
NoEntry:
  PHP
  REP #$30
  PHX : PHY
  LDX ${hx(RAM.currentPlayer)}
  ; Mario's layer 1 tile, as the game's $049885
  LDA ${hx(RAM.owPlayerTileX)},x : AND #$000F : PHA
  LDA ${hx(RAM.owPlayerTileX)},x : AND #$0010 : ASL #4 : ORA 1,s : STA 1,s
  LDA ${hx(RAM.owPlayerTileY)},x : ASL #4 : AND #$00FF : ORA 1,s : STA 1,s
  LDA ${hx(RAM.owPlayerTileY)},x : AND #$0010 : ASL #5 : ORA 1,s : STA 1,s
  TXA : LSR #2 : TAX
  LDA ${hx(RAM.submap)},x : AND #$00FF : BEQ +
  LDA #$0400 : ORA 1,s : STA 1,s
+ PLX
  LDA.l $7E${hx(RAM.owTranslevels).slice(1)},x : AND #$00FF : TAX
  LDA.l $7E${hx(RAM.levelFlags).slice(1)},x : AND.w #${hx(FLAG.passed | FLAG.noEntry)} : CMP.w #${hx(FLAG.passed | FLAG.noEntry)}
  PLY : PLX
  SEP #$20
  BCC +
  LDA #$FF
  BRA ++
+ LDA.l $7E${hx(RAM.owTile).slice(1)}
++ PLP
  CMP #$81
  RTL
warnpc ${hx(LF_END)}
`;

// detected as OverworldTables.asm does
export function hasLevelFlagsPatch(rom: Rom): boolean {
  return rom.r8(LF_INIT_HOOK) === 0x22;
}
export function initialFlags(rom: Rom, tl: number): number {
  if (!hasLevelFlagsPatch(rom)) missingPatch('Initial level flags');
  return rom.r8(LEVEL_FLAGS + tl);
}
export function setInitialFlags(rom: Rom, tl: number, v: number): void {
  if (!hasLevelFlagsPatch(rom)) missingPatch('Initial level flags');
  rom.w8(LEVEL_FLAGS + tl, v);
}

// needs Asar (loadAsar) to be loaded; the table starts as the flags of the game's new file (emulated)
export function installLevelFlagsPatch(rom: Rom): void {
  if (hasLevelFlagsPatch(rom)) return;
  const game = new OverworldEmulator(rom).load(0, 0);
  if (!game.ok) throw new Error('The overworld did not load – initial level flags not installed');
  const flags = game.wram.slice(RAM.levelFlags, RAM.levelFlags + MAX_TRANSLEVEL + 1);
  const r = assemble(rom.data, new Map([['levelflags.asm', levelFlagsAsm()]]), 'levelflags.asm');
  if (!r.ok) throw new Error(r.errors.map((e) => e.message).join(' '));
  for (const [a, n] of LF_CODE) {
    rom.writeAt(snesToPc(a), r.rom.subarray(snesToPc(a), snesToPc(a) + n));
  }
  rom.writeBytes(LEVEL_FLAGS, flags);
}

// how much a translevel no tile enters would bring along to a new one: 0 nothing (no name, base event or message
// slot, the level's data the game's blank one), 1 settings resetTranslevel resets, 2 a level of its own
export type TranslevelUse = 0 | 1 | 2;
export function translevelUse(rom: Rom, tl: number): TranslevelUse {
  if (hasOwnContent(rom, translevelToLevel(tl))) return 2;
  return hasLevelName(rom, tl) || baseEvent(rom, tl) !== NO_EVENT || hasMessages(rom, tl) || initialFlags(rom, tl) ? 1 : 0;
}

// the settings of translevel tl as the game's unused ones: no name, no base event, every exit enabling up, no
// message, no initial flags
export function resetTranslevel(rom: Rom, tl: number): void {
  clearLevelName(rom, tl);
  rom.w8(BASE_EVENTS + tl, NO_EVENT);
  rom.w8(EXIT_DIRS + tl, 0);
  setInitialFlags(rom, tl, 0);
  clearMessages(rom, tl);
}

// ---- events ----
// per translevel: the event its normal exit runs (the secret exit's the next one; $FF none), $1DEA (ram.ts)
export const BASE_EVENTS = 0x05d608;
export const OW_EVENTS = 0x78; // 15 bytes of event bits
// the event bits ($1F02) of a game in which events 0 … n-1 passed: event e is bit $80 >> e%8 of byte e/8 (the
// game's masks at $04E44B)
export function eventBits(n: number): Uint8Array {
  const b = new Uint8Array(OW_EVENTS / 8);
  for (let e = 0; e < Math.min(n, OW_EVENTS); e++) b[e >> 3] |= 0x80 >> (e & 7);
  return b;
}
export const baseEvent = (rom: Rom, tl: number): number => rom.r8(BASE_EVENTS + tl);
export function setBaseEvent(rom: Rom, tl: number, e: number): void {
  rom.w8(BASE_EVENTS + tl, e);
}

// ---- reveals ----
// per event (the game's $04D85D, 0x70 events 00–6F, the next table follows; with the event steps patch Lunar
// Magic's place in free space, all 0x78 – its pointer at $04DA74): the layer 1 tile (l1Index, 0 none) it
// reveals – turned into its counterpart of the game's reveal list ($04DA1D → $04DA33, 0x16 tiles) when the event
// passes. One tile per event, a tile by any number of events (Lunar Magic's "reveal this level tile on events").
const REVEAL_PTR = 0x04da74, GAME_REVEAL_AT = 0x04d85d;
const REVEAL_FROM = 0x04da1d, REVEAL_TO = 0x04da33, REVEALS = 0x16;
const revealTable = (rom: Rom) => rom.r24(REVEAL_PTR);
// the events a tile can be revealed on (0x70 in the game)
export const revealEventCount = (rom: Rom): number => (revealTable(rom) === GAME_REVEAL_AT ? 0x70 : OW_EVENTS);
export const revealAt = (rom: Rom, e: number): number => rom.r16(revealTable(rom) + e * 2);
// the events that reveal tile i (none for tile 0, which stands for none)
export function revealEvents(rom: Rom, i: number): number[] {
  if (!i) return [];
  return Array.from({ length: revealEventCount(rom) }, (_, e) => e).filter((e) => revealAt(rom, e) === i);
}
// the tile event e reveals (0 none)
export function setRevealAt(rom: Rom, e: number, i: number): void {
  rom.w16(revealTable(rom) + e * 2, i);
}
// tile i revealed on exactly `events` (each then reveals only it)
export function setRevealEvents(rom: Rom, i: number, events: number[]): void {
  const at = revealTable(rom);
  for (let e = 0; e < revealEventCount(rom); e++) {
    if (events.includes(e)) rom.w16(at + e * 2, i);
    else if (revealAt(rom, e) === i) rom.w16(at + e * 2, 0);
  }
}
// the tile layer 1 tile t turns into when revealed, -1: it has none (a reveal does nothing). The game looks up and
// writes the low byte ($7EC800, $04EDA0): a tile 1xx turns into 1yy
export function revealedTile(rom: Rom, t: number): number {
  for (let k = REVEALS - 1; k >= 0; k--) if (rom.r8(REVEAL_FROM + k) === (t & 0xff)) return (t & 0xff00) | rom.r8(REVEAL_TO + k);
  return -1;
}
// The reveal list (Lunar Magic's "Edit Reveal Tile List"): which layer 1 tile a revealed tile becomes, 0x16 pairs
// in the game's place ($04DA1D → $04DA33; also those for tiles 52–54, which the game doesn't use). The game looks
// it through from the last pair down.
export interface RevealPair { from: number; to: number }
export const readRevealList = (rom: Rom): RevealPair[] =>
  Array.from({ length: REVEALS }, (_, k) => ({ from: rom.r8(REVEAL_FROM + k), to: rom.r8(REVEAL_TO + k) }));
export function writeRevealList(rom: Rom, list: RevealPair[]): void {
  if (list.length !== REVEALS) throw new Error(`The reveal list has ${REVEALS} entries`);
  rom.writeBytes(REVEAL_FROM, Uint8Array.from(list, (p) => p.from));
  rom.writeBytes(REVEAL_TO, Uint8Array.from(list, (p) => p.to));
}

// ---- destroyed level tiles ----
// Lunar Magic's "Destroy Level Tile Settings": 0x18 entries of an event and the layer 1 tile ($7EC800 offset) it
// destroys – the game's own code ($04E677, when the event passes and on every overworld load after it) turns the
// tile into its destroyed one (a castle's top and the tile below it). The game has 0x10 entries ($04E5D6 events,
// $04E5B6 tiles; its loop reads 0x18, the rest being the next tables); as in Lunar Magic, the patch moves both
// to free space with 0x18 entries (pointers $04E67C, $04E69C; event FF none), finds the tile below a castle's top
// on a 16x16 block's bottom row (rows F and 2F: the game adds $10, landing in the block to the right; a JSL at
// $04E6C5) and turns off the game's unused second tile of a revealed tile 54 ($04DA98) – the places SMW Central's
// hijack map gives and Lunar Magic's code in the ROMs it saved uses; the editor's code is its own.
export const DESTROYS = 0x18;
const DESTROY_EV_OP = 0x04e67c, DESTROY_LOC_OP = 0x04e69c, DESTROY_FIX = 0x04e6c5, REVEAL54 = 0x04da98;
const GAME_DESTROYS = 0x10, DESTROY_CALL = 0x04e677;
// the game's code the patch changes (SNES address, length), Lunar Magic's hijack: the tables' pointers, the JSL, the
// BRA; a third-party patch may not change it (patchapply.ts)
export const DESTROY_HOOKS: [number, number][] = [[DESTROY_EV_OP, 3], [DESTROY_LOC_OP, 3], [DESTROY_FIX, 4], [REVEAL54, 1]];
export interface Destroy { event: number; tile: number }

const destroyAsm = (code: number) => `lorom
org ${hx(DESTROY_FIX)}
  JSL Below
org ${hx(REVEAL54)}
  db $80                                       ; BRA: a revealed tile 54 is one tile
org ${hx(code)}
Below:                                         ; A (16) a tile's offset: the tile below it, across a block's bottom row too
  PHA : AND.w #$00F0 : CMP.w #$00F0 : PLA
  BCC +
  ADC.w #$00FF                                 ; (carry set) the block below
+ CLC : ADC.w #$0010
  RTL
`;
const DESTROY_CODE_SIZE = 0x18;

export const hasDestroyPatch = (rom: Rom): boolean => rom.r8(DESTROY_FIX) === 0x22;
const destroyTables = (rom: Rom) => { if (!hasDestroyPatch(rom)) missingPatch('Destroyed level tiles (Lunar Magic format)'); return { ev: rom.r24(DESTROY_EV_OP), loc: rom.r24(DESTROY_LOC_OP) }; };
export function readDestroyList(rom: Rom): Destroy[] {
  const t = destroyTables(rom);
  return Array.from({ length: DESTROYS }, (_, k) => ({ event: rom.r8(t.ev + k), tile: rom.r16(t.loc + k * 2) }));
}
export function writeDestroyList(rom: Rom, list: Destroy[]): void {
  const t = destroyTables(rom);
  rom.writeBytes(t.ev, Uint8Array.from(list, (d) => d.event));
  rom.writeBytes(t.loc, Uint8Array.from(list.flatMap((d) => [d.tile & 0xff, d.tile >> 8])));
}
// the event destroying layer 1 tile i, NO_EVENT none (of several the last entry's, as the game looks)
export function destroyEvent(rom: Rom, i: number): number {
  const l = readDestroyList(rom);
  for (let k = l.length - 1; k >= 0; k--) if (l[k].event !== NO_EVENT && l[k].tile === i) return l[k].event;
  return NO_EVENT;
}
// tile i destroyed by event e (NO_EVENT: by none); an event destroys one tile: one it destroyed before isn't
export function setDestroyEvent(rom: Rom, i: number, e: number): void {
  const l = readDestroyList(rom).map((d) => (d.event !== NO_EVENT && (d.tile === i || d.event === e) ? { event: NO_EVENT, tile: 0 } : d));
  if (e !== NO_EVENT) {
    const k = l.findIndex((d) => d.event === NO_EVENT);
    if (k < 0) throw new Error(`Every one of the ${DESTROYS} destroyed level tiles is used`);
    l[k] = { event: e, tile: i };
  }
  writeDestroyList(rom, l);
}

// needs Asar (loadAsar) to be loaded; the game's 0x10 entries, 8 more none
export function installDestroyPatch(rom: Rom): void {
  if (hasDestroyPatch(rom)) return;
  const ev = new Uint8Array(DESTROYS).fill(NO_EVENT), loc = new Uint8Array(DESTROYS * 2);
  ev.set(rom.bytes(rom.r24(DESTROY_EV_OP), GAME_DESTROYS));
  loc.set(rom.bytes(rom.r24(DESTROY_LOC_OP), GAME_DESTROYS * 2));
  rom.w24(DESTROY_EV_OP, rom.allocWrite(ev));
  rom.w24(DESTROY_LOC_OP, rom.allocWrite(loc));
  const code = rom.allocWrite(new Uint8Array(DESTROY_CODE_SIZE));
  const r = assemble(rom.data, new Map([['destroy.asm', destroyAsm(code)]]), 'destroy.asm');
  if (!r.ok) throw new Error(r.errors.map((e) => e.message).join(' '));
  for (const [a, n] of [[DESTROY_FIX, 4], [REVEAL54, 1], [code, DESTROY_CODE_SIZE]]) rom.writeAt(snesToPc(a), r.rom.subarray(snesToPc(a), snesToPc(a) + n));
}

// a tile a destroy changes, relative to the destroyed one (16x16 tiles on its map)
export interface DestroyChange { dx: number; dy: number; tile: number }
const effectsMemo = new WeakMap<Rom, { gen: number; effects: DestroyChange[][] }>();
// what destroying each layer 1 tile 000–1FF does (the changes, [] none): learned by running the game's code on a map
// holding the tile (its high byte at $7FC800), an entry destroying it
export function destroyEffects(rom: Rom): DestroyChange[][] {
  const memo = effectsMemo.get(rom);
  if (memo?.gen === rom.gen) return memo.effects;
  const probe = new Rom(rom.data.slice()), at = l1Index(0, 4, 4), RET = 0x8000;
  writeDestroyList(probe, Array.from({ length: DESTROYS }, (_, k) => (k ? { event: NO_EVENT, tile: 0 } : { event: 0, tile: at })));
  const s = new Snes(probe.data), cpu = s.cpu, w = s.wram, fresh = s.saveState();
  const lo = w.subarray(RAM.owLayer1, RAM.owLayer1End), hi = w.subarray(RAM.owLayer1High, RAM.owLayer1High + 0x800);
  const map = { keys: () => lo.keys(), get: (i: number) => lo[i] | (hi[i] << 8) };
  const effects: DestroyChange[][] = [];
  for (let t = 0; t < OW_L1_TILES; t++) {
    s.loadState(fresh);
    lo[at] = t & 0xff;
    hi[at] = t >> 8;
    const before = Uint16Array.from(lo, (_, i) => map.get(i));
    // JSR $04E677 with the event in A, its RTS to RET
    Object.assign(cpu, { e: false, p: 0x30, d: 0, dbr: 0, pbr: DESTROY_CALL >> 16, pc: DESTROY_CALL & 0xffff, a: 0, s: 0x1fd, waiting: false, stopped: false });
    w[0x1fe] = (RET - 1) & 0xff; w[0x1ff] = (RET - 1) >> 8;
    for (let n = 0; n < 5000 && cpu.pc !== RET; n++) cpu.step();
    const o = l1XY(at);
    effects.push([...map.keys()].filter((i) => map.get(i) !== before[i]).map((i) => { const p = l1XY(i); return { dx: p.x - o.x, dy: p.y - o.y, tile: map.get(i) }; }));
  }
  effectsMemo.set(rom, { gen: rom.gen, effects });
  return effects;
}
// the cells (l1Index) destroying tile j changes and the tiles they get (l1: the tiles, j's what is destroyed; cells
// off its map left out)
export function destroyChanges(effects: DestroyChange[][], l1: ArrayLike<number>, j: number): { cell: number; tile: number }[] {
  const { x, y } = l1XY(j), base = j & 0x400;
  return effects[l1[j]].flatMap((c) => {
    const cx = x + c.dx, cy = y + c.dy;
    return cx >= 0 && cy >= 0 && cx < 32 && cy < 32 ? [{ cell: base + l1Index(0, cx, cy), tile: c.tile }] : [];
  });
}
// the cells (l1Index) destroying tile j touches: j and those destroyChanges gives
export const destroyedCells = (effects: DestroyChange[][], l1: ArrayLike<number>, j: number): number[] =>
  [j, ...destroyChanges(effects, l1, j).map((c) => c.cell)];
// the layer 1 tile whose destroy changes tile i (l1: the tiles; i itself first, else a neighbour), -1 none
export function destroyedAt(effects: DestroyChange[][], l1: ArrayLike<number>, i: number): number {
  if (effects[l1[i]].length) return i;
  const { x, y } = l1XY(i), base = i & 0x400;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const jx = x - dx, jy = y - dy;
    if ((!dx && !dy) || jx < 0 || jy < 0 || jx >= 32 || jy >= 32) continue;
    const j = base + l1Index(0, jx, jy);
    if (effects[l1[j]].some((c) => c.dx === dx && c.dy === dy)) return j;
  }
  return -1;
}

// the tile whose destroy setting tile i shows (destroyedAt), -1 none: one set there, else by the tile as the game
// may see it when an event runs – on the map before events (l1), revealed, as shown (at the event progress) – and
// that tile's value
export function destroySettingAt(rom: Rom, l1: ArrayLike<number>, shown: ArrayLike<number>, i: number): { at: number; tile: number | undefined } {
  return destroySettings(rom, l1, shown)(i);
}
// destroySettingAt for many cells: the ROM read once
export function destroySettings(rom: Rom, l1: ArrayLike<number>, shown: ArrayLike<number>): (i: number) => { at: number; tile: number | undefined } {
  const effects = destroyEffects(rom), revealed = Array.from(l1, (t) => { const r = revealedTile(rom, t); return r >= 0 ? r : t; });
  const maps = [l1, revealed, shown];
  const set = new Set(readDestroyList(rom).filter((d) => d.event !== NO_EVENT).map((d) => d.tile));
  return (i) => {
    let at = set.has(i) ? i : -1;
    for (const m of maps) if (at < 0) at = destroyedAt(effects, m, i);
    return { at, tile: at < 0 ? undefined : maps.map((m) => m[at]).find((v) => effects[v].length) };
  };
}

// the overworld's events by the level exits that run them ("105 YOSHI'S ISLAND 1 – normal exit"), of the levels on
// the map; an event no normal exit runs by the secret exits that do (the game numbers a level's events one after
// the other: after one without a secret exit its next event is the next level's)
export function eventNames(rom: Rom): Map<number, string> {
  const normal = new Map<number, string[]>(), secret = new Map<number, string[]>();
  const add = (m: Map<number, string[]>, e: number, n: string) => { if (e < OW_EVENTS) (m.get(e) ?? m.set(e, []).get(e)!).push(n); };
  const tls = [...new Set(readTranslevels(rom))].filter((t) => t).sort((a, b) => a - b);
  for (const tl of tls) {
    const b = baseEvent(rom, tl);
    if (b >= OW_EVENTS) continue;
    const name = `${translevelToLevel(tl).toString(16).toUpperCase().padStart(3, '0')} ${levelName(rom, tl)}`;
    add(normal, b, `${name} – normal exit`);
    add(secret, b + 1, `${name} – secret exit`);
  }
  const out = new Map<number, string>();
  for (let e = 0; e < OW_EVENTS; e++) {
    const n = normal.get(e) ?? secret.get(e) ?? [];
    if (n.length) out.set(e, n.join(' · '));
  }
  return out;
}

// The ROM bytes (PC offsets, [start, end)) of the overworld's data that the editor writes: layer 1, layer 2 with its
// pointers, the translevel table with its pointer, per translevel the exit directions, initial flags and name, the
// layer 1 tiles' Map16, the reveals with the reveal list, the destroyed level tiles, the event steps, the links (star/pipe, exit path and
// Koopa Kid tables), the start positions and the sprites (owsprites.ts), the custom sprites' table (owcustom.ts), the
// submaps' animations (exanim.ts).
// Learned results that load the overworld without depending on what is painted there leave them out (owpaths.ts).
export function overworldDataRanges(rom: Rom): [number, number][] {
  const at = (snes: number, len: number): [number, number] => [snesToPc(snes), snesToPc(snes) + len];
  const p = l2Pointers(rom), d = rom.data, scratch = new Uint16Array(0x2000);
  const out = [
    at(OW_L1, 0x800),
    at(owTileAddr(rom, 0), (hasOwMap16Ext(rom) ? OW_L1_TILES : GAME_OW_TILES) * 8),
    ...OW_MAP16_HOOKS.map(([a, n]) => at(a, n)),
    at(p.tiles, rleDecode(d, snesToPc(p.tiles), scratch, 0, 0x2000)),
    at(p.attrs, rleDecode(d, snesToPc(p.attrs), scratch, 8, 0x2000)),
    at(L2_TILE_PTR, 2), at(L2_BANK, 1), at(L2_ATTR_PTR, 2),
    at(EXIT_DIRS, MAX_TRANSLEVEL + 1),
  ];
  out.push(...levelNameRanges(rom), ...submapPaletteRanges(rom));
  for (const [ptr, bank] of [[TL_PTR, TL_BANK], [L1_HI_PTR, L1_HI_BANK]]) {
    const b = packedBlock(rom, ptr, bank);
    if (b) out.push(at(b.snes, b.size), at(ptr, 2), at(bank, 1));
  }
  if (hasLevelFlagsPatch(rom)) out.push(at(LEVEL_FLAGS, MAX_TRANSLEVEL + 1));
  out.push(at(revealTable(rom), revealEventCount(rom) * 2), at(REVEAL_FROM, REVEALS), at(REVEAL_TO, REVEALS), ...eventDataRanges(rom));
  if (hasDestroyPatch(rom)) out.push(at(rom.r24(DESTROY_EV_OP), DESTROYS), at(rom.r24(DESTROY_LOC_OP), DESTROYS * 2));
  out.push(...teleportDataRanges(rom), at(KOOPA_X, KOOPAS * 2), at(KOOPA_Y, KOOPAS * 2));
  out.push(at(START, 0x16), ...(hasOwSpriteSlots(rom) ? [at(OW_SPRITES, OW_SPRITE_SLOTS * 5)] : []), ...(hasKoopaKidTable(rom) ? Object.values(KOOPA_KID).map((t) => at(t, KOOPA_KIDS)) : []));
  out.push(...customSpriteRanges(rom), ...owExanimDataRanges(rom));
  return out;
}

// ---- emulation: load the overworld to obtain VRAM / CGRAM / Map16 tables ----
export interface OwRender {
  vram: Uint8Array;
  cgram: Uint8Array;
  wram: Uint8Array;
  ppuRegs: Uint8Array;
  ok: boolean;
}
// layer 1 as the game shows it, its events applied (l1Index order; the tiles' low and high bytes, readL1)
export const gameL1 = (r: OwRender): Uint16Array => {
  const w = r.wram, lo = RAM.owLayer1, hi = RAM.owLayer1High;
  return Uint16Array.from({ length: 0x800 }, (_, i) => w[lo + i] | (w[hi + i] << 8));
};
// layer 2 of the loaded map's region as the game shows it, its events applied: the BG2 tilemap in VRAM (64x64 at
// BG2SC, $2108; l2Index order within the region)
export function gameL2(r: OwRender): Uint16Array {
  const at = (r.ppuRegs[0x08] & 0xfc) << 9;
  return Uint16Array.from({ length: 0x1000 }, (_, k) => r.vram[at + k * 2] | (r.vram[at + k * 2 + 1] << 8));
}
// where a load's layer 1 (BG1) or layer 2 (BG2) 8x8 tiles start in VRAM (bytes): BG12NBA ($210B) as the overworld's
// load sets it – 0 in the game, Journey to Kaizo's $77 puts both at $E000 (8x8 tiles past the end wrap around to 0)
export const owCharBase = (r: Pick<OwRender, 'ppuRegs'>, layer: 1 | 2): number => charBase(r, layer === 2);
// a load's 8x8 tiles of layer 1 and of layer 2, each from its character base
export interface OwTileCaches { l1: TileCache; l2: TileCache }
export const owTileCaches = (r: OwRender): OwTileCaches =>
  ({ l1: new TileCache(r.vram, r.cgram, owCharBase(r, 1)), l2: new TileCache(r.vram, r.cgram, owCharBase(r, 2)) });
// the 512x512 image of a map region (0 the main map, 1 the submaps) drawn with a load's graphics: layer 2 (`l2`), then
// layer 1 (`l1`, null: the state after the events in `r`) with its Map16 tiles from the ROM; undefined leaves a layer out
// (tcs: the load's 8x8 tiles, passed to share them between the layers drawn apart)
export function drawOwMap(rom: RomRead, r: OwRender, region: number, l1: Uint16Array | null | undefined, l2: Uint16Array | undefined, tcs = owTileCaches(r)): Uint32Array {
  const W = 512;
  const img = new Uint32Array(W * W);
  if (l2) for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) blit8(img, W, W, tcs.l2.get(l2[l2Index(region, x, y)]), x * 8, y * 8);
  if (l1 !== undefined) {
    const src = l1 ?? gameL1(r);
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) drawL1Tile(rom, img, tcs.l1, src[l1Index(region, x, y)], x * 16, y * 16);
  }
  return img;
}
// layer 1 tile t (its Map16 tile's four 8x8 tiles, tc: a load's graphics) drawn at (px, py) of a W×H image
export function drawL1Tile(rom: RomRead, img: Uint32Array, tc: TileCache, t: number, px: number, py: number, W = 512, H = 512): void {
  const w = owTileWords(rom, t);
  blit8(img, W, H, tc.get(w[0]), px, py);
  blit8(img, W, H, tc.get(w[1]), px, py + 8);
  blit8(img, W, H, tc.get(w[2]), px + 8, py);
  blit8(img, W, H, tc.get(w[3]), px + 8, py + 8);
}
// the word of the 8x8 cell (x, y) of a 64x64 tilemap in VRAM (four 32x32 screens) based at PPU register `reg`
// ($2107 BG1SC, $2108 BG2SC)
function tilemapWord(r: OwRender, reg: number, x: number, y: number): number {
  const a = ((r.ppuRegs[reg] & 0xfc) << 9) + (((y >> 5) * 2 + (x >> 5)) * 0x400 + (y & 31) * 32 + (x & 31)) * 2;
  return r.vram[a] | (r.vram[a + 1] << 8);
}
// the 64 color indexes of layer `layer`'s 8x8 tile of word `w` (4bpp from the layer's character base, as drawOwMap
// draws it; no flips) into `out`
export function owTileIndexes(r: Pick<OwRender, 'vram' | 'ppuRegs'>, layer: 1 | 2, w: number, out: Uint8Array): Uint8Array {
  decodeTile(r.vram, (owCharBase(r, layer) + (w & 0x3ff) * 32) & 0xffff, 4, out);
  return out;
}
// the color index of pixel (x, y) of layer `layer`'s tilemap word `w`'s 8x8 tile (flips applied)
const pixelBuf = new Uint8Array(64);
function tilePixel(r: OwRender, layer: 1 | 2, w: number, x: number, y: number): number {
  owTileIndexes(r, layer, w, pixelBuf);
  return pixelBuf[((w & 0x8000) ? 7 - y : y) * 8 + ((w & 0x4000) ? 7 - x : x)];
}
// The 8x8 tile shown at pixel (x, y) of the loaded region's 512x512 map (r: its load), from the BG1 and BG2 tilemaps
// as the game shows them: layer 1's word where its pixel is not transparent, else layer 2's; null where neither has a
// pixel (the back area color) or outside the map
export function owTileAt(r: OwRender, x: number, y: number): { word: number; layer: 1 | 2 } | null {
  if (x < 0 || y < 0 || x >= 512 || y >= 512) return null;
  for (const [layer, reg] of [[1, 0x07], [2, 0x08]] as const) {
    const word = tilemapWord(r, reg, x >> 3, y >> 3);
    if (tilePixel(r, layer, word, x & 7, y & 7)) return { word, layer };
  }
  return null;
}

export class OverworldEmulator {
  rom: Rom;
  snes: Snes;
  titleState: SnesState | null = null;
  private title: { reads: RomReads; rom: Uint8Array } | null = null; // what reaching the title screen read
  private lastReads: RomReads | null = null; // what the last load read (reaching the title screen, too)
  private after: { r: OwRender; cycles: number } | null = null; // the last load, while the console is right after it
  private romGen: number;
  constructor(rom: Rom) {
    this.rom = rom;
    this.snes = new Snes(rom.data);
    this.romGen = rom.gen;
  }
  // catches up with a changed ROM (rom.gen): a change of what reaching the title screen read makes its snapshot stale
  // (as LevelEmulator's boot snapshot). (The byte pages follow its data by themselves: a recorder takes the ROM
  // state's, overworld data moved to free space is recorded by byte at its new place.)
  private sync(): void {
    this.snes.rom = this.rom.data;
    if (this.romGen === this.rom.gen) return;
    this.romGen = this.rom.gen;
    if (this.title?.reads.differ(this.title.rom, this.rom.data)) { this.titleState = null; this.title = null; }
  }
  // map `map` at event progress `progress` (events 0 … progress-1 passed), as after loading a save: the game draws
  // their layer 2 tiles when the file is loaded (file select) and applies them to layer 1 in their number order
  // while it loads the overworld (a new file's events are set again there). special: the special world passed (its
  // last translevel's passed flag, set as the overworld loads)
  load(map: number, progress: number, special = false): OwRender {
    this.sync();
    const s = this.snes;
    this.after = null;
    if (!this.titleState) {
      // (an outer recorder gets these reads with the load's, which start from them)
      const outer = s.romReads, reads = new RomReads(this.rom);
      s.romReads = reads;
      try {
        s.reset();
        let f = 0;
        while (s.wram[RAM.gameMode] !== GM.title && f++ < 2000) s.runFrame();
      } finally { s.romReads = outer; }
      this.titleState = s.saveState();
      this.title = { reads, rom: this.rom.data.slice() };
    } else s.loadState(this.titleState);
    const w = s.wram;
    let n = 0;
    const outer = s.romReads, reads = new RomReads(this.rom, this.title!.reads);
    this.lastReads = reads;
    s.romReads = reads;
    try {
      while (w[RAM.gameMode] !== GM.overworld && n < 1500) {
        if (w[RAM.gameMode] === GM.fileSelect) w.set(eventBits(progress), RAM.owEvents);
        if (w[RAM.gameMode] === GM.overworldLoad) {
          w[RAM.introLevel] = 0;
          w[RAM.submap] = map;
          w[RAM.submap + 1] = map;
          w.set(eventBits(progress), RAM.owEvents);
          if (special) w[SPECIAL_FLAG] |= 0x80;
        }
        s.joy1 = (n % 16) < 4 ? (w[RAM.gameMode] === GM.title ? 0x1000 : 0x0080) : 0;
        s.runFrame();
        n++;
      }
      s.joy1 = 0;
      for (let i = 0; i < 3; i++) s.runFrame();
    } catch {
      return this.loaded({ vram: s.vram.slice(), cgram: s.cgram.slice(), wram: s.wram.slice(), ppuRegs: s.ppuRegs.slice(), ok: false });
    } finally {
      s.romReads = outer;
      outer?.add(reads);
    }
    return this.loaded({ vram: s.vram.slice(), cgram: s.cgram.slice(), wram: s.wram.slice(), ppuRegs: s.ppuRegs.slice(), ok: w[RAM.gameMode] === GM.overworld });
  }
  private loaded(r: OwRender): OwRender {
    this.after = { r, cycles: this.snes.cpu.cycles };
    return r;
  }
  // load, with the ROM bytes it read (reaching the title screen, too): what the map shown depends on
  loadRecorded(map: number, progress: number, special = false): { result: OwRender; reads: RomReads } {
    const result = this.load(map, progress, special);
    return { result, reads: this.lastReads! };
  }
  // the console right after the load that gave `r` (the game run on from there: restore), while nothing ran since;
  // else null. Taken once: the console is then the caller's to change (a poke runs no CPU cycle)
  stateAfter(r: OwRender): SnesState | null {
    const a = this.after;
    this.after = null;
    if (a?.r !== r || a.cycles !== this.snes.cpu.cycles) return null;
    this.sync();
    return this.snes.saveState();
  }
  // the console as `state` (stateAfter's), on the current ROM
  restore(state: SnesState): void {
    this.sync();
    this.after = null;
    this.snes.loadState(state);
  }
}

// a kept load: what it shows and the console right after it (saved when first asked for: restore)
interface KeptLoad { r: OwRender; state: SnesState | null }
// the key of a map at an event progress (a load's, what is derived from one)
export const loadKey = (map: number, progress: number) => `${map}-${progress}`;

// emulated overworlds by map and event progress, the latest used `max` (a slider moved through every progress): each
// kept while the ROM edits since its load changed no byte the load read (painting the map or its events loads it
// again, a tile name or a level's graphics don't), as App.refresh keeps the level render; and what is derived from
// them (derive), kept while none of the loads it used would load again and the frames run on from them read the same
export class OverworldLoads {
  emu: OverworldEmulator;
  private kept: KeptResults<Since>;
  private derived: KeptResults<Since>; // by key, for one `of` each
  constructor(emu: OverworldEmulator, max: number) {
    this.emu = emu;
    this.kept = new KeptResults({ validity: bySince(emu.rom), limit: max, inputsPerKey: 1 });
    this.derived = new KeptResults({ validity: bySince(emu.rom), inputsPerKey: 1 });
  }
  // (special: after the special world, OverworldEmulator.load)
  get(map: number, progress: number, special = false): OwRender {
    return this.load(map, progress, true, special).r;
  }
  // the emulator's console as right after loading map `map` at event progress `progress` (to run the game on); the
  // load keeps it from the first time it is asked for (taken while the console is still right after the load, else
  // loaded again). special: after the special world (OverworldEmulator.load)
  restore(map: number, progress: number, special = false): void {
    const k = this.load(map, progress, true, special), emu = this.emu;
    if (k.state) { emu.restore(k.state); return; }
    k.state = emu.stateAfter(k.r) ?? emu.stateAfter(emu.loadRecorded(map, progress, special).result)!;
  }
  // `make`'s result from the loads it asks for (`load`, or restore to run the game on), kept under `key` for `of`
  // (one per key) while the ROM edits since changed no byte it read: the loads', the frames it runs on from them
  // and the editor code's; a load not kept yet isn't kept for `load` (the slider's stay)
  derive<T>(key: string, make: (load: (map: number, progress: number) => OwRender) => T, of = ''): T {
    const d = this.derived.entry<T>(key, of);
    if (d) { this.count(d.deps.reads); return d.data; }
    // (the emulated CPU's reads and the editor code's; they count for the recorders running)
    const { result, reads, gen } = record(this.emu.rom, () => make((map, progress) => this.load(map, progress, false).r), { cpu: this.emu.snes });
    this.derived.set(key, result, { gen, reads }, of);
    return result;
  }
  // reads (of a kept result) count for the recorders running (a derive's, an outer one) as if read now
  private count(reads: RomReads): void {
    countReads(this.emu.rom, this.emu.snes, reads);
  }
  // the kept load, else a new one (kept when `keep`; one kept is kept as the latest used)
  private load(map: number, progress: number, keep = true, special = false): KeptLoad {
    const key = `${loadKey(map, progress)}${special ? ':special' : ''}`;
    let k = this.kept.entry<KeptLoad>(key);
    if (!k) {
      const gen = this.emu.rom.gen, { result, reads } = this.emu.loadRecorded(map, progress, special);
      k = { data: { r: result, state: null }, deps: { gen, reads } };
      if (keep) this.kept.set(key, k.data, k.deps);
    }
    this.count(k.deps.reads);
    return k.data;
  }
}

// The map `map` at event progress `progress` as a job of the result learner (probe worker: the overworld view asks for
// it there), from `loads` (the learner's own, kept between jobs). One step: the loads' emulator is shared by the
// overworld's jobs (owSpritesJob, submapViewsJob), so none may stop halfway. Its reads go to the job's (the ROM's
// recorder, OverworldLoads.count). special: after the special world (the graphics workspace's preview of a submap).
export function* overworldMapJob(loads: OverworldLoads, map: number, progress: number, special = false): Job<OwRender> {
  return loads.get(map, progress, special);
}
export const OW_LOADS_KEPT = 16; // emulated overworlds kept (map and event progress: a slider moved through them)
