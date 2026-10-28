// Overworld data (vanilla formats) and emulation-based loading of OW graphics.

import { Rom, snesToPc } from './rom.ts';
import { Snes, type SnesState } from './snes.ts';
import { RomReads, updateBytePages } from './romdeps.ts';
import { rleDecode, rleEncode } from './rle.ts';
import { GM, RAM } from './ram.ts';
import { assemble } from './asar.ts';
import { missingPatch } from './patches.ts';
import { lz2Compress, lz2Decompress } from './lz2.ts';
import type { RomRead } from './exanim.ts';
import { hasOwnContent } from './level.ts';
import { messageSlots, unassignMessageSlot } from './messages.ts';
import { eventDataRanges } from './owevents.ts';
import { teleportDataRanges } from './owteleport.ts';
import { KOOPA_X, KOOPA_Y, KOOPAS } from './owlinks.ts';
import { START, OW_SPRITES, OW_SPRITE_SLOTS, KOOPA_KID, KOOPA_KIDS } from './owsprites.ts';

export const OW_L1 = 0x0cf7df; // 0x800 bytes: 2 maps × 32×32 16x16 tiles (quadrant layout)
const L2_TILE_PTR = 0x04dc72; // LDA #$A533 operand
const L2_BANK = 0x04dc79; // LDA #$04 operand (shared bank of both streams)
const L2_ATTR_PTR = 0x04dc8d; // LDA #$C02B operand
export const NAME_CODES = 0x04a0fc; // 16-bit per translevel
const NAME_CHARS = 0x049ac5;
const NAME_P1 = 0x049c91; // 31 entries
const NAME_P2 = 0x049ccf; // 15 entries
const NAME_P3 = 0x049ced; // 10 entries
export const NAME_PART_COUNTS = [31, 15, 10];

export const MAP_NAMES = ['Main map', "Yoshi's Island", 'Vanilla Dome', 'Forest of Illusion', 'Valley of Bowser', 'Special World', 'Star World'];

export function l1Index(map: number, x: number, y: number): number {
  return map * 0x400 + ((y >> 4) * 2 + (x >> 4)) * 0x100 + (y & 15) * 16 + (x & 15);
}
// a layer 1 tile's position on its 512x512 map (l1Index without the map)
export function l1XY(i: number): { x: number; y: number } {
  return { x: ((i >> 8) & 1) * 16 + (i & 15), y: ((i >> 9) & 1) * 16 + ((i >> 4) & 15) };
}
export function l2Index(map: number, x: number, y: number): number {
  return map * 0x1000 + ((y >> 5) * 2 + (x >> 5)) * 0x400 + (y & 31) * 32 + (x & 31);
}

export function readL1(rom: Rom): Uint8Array {
  return rom.bytes(OW_L1, 0x800);
}
export function writeL1(rom: Rom, d: Uint8Array): void {
  rom.writeBytes(OW_L1, d);
}

export function l2Pointers(rom: Rom): { tiles: number; attrs: number } {
  const bank = rom.r8(L2_BANK);
  return { tiles: (bank << 16) | rom.r16(L2_TILE_PTR), attrs: (bank << 16) | rom.r16(L2_ATTR_PTR) };
}

export function readL2(rom: Rom): Uint16Array {
  const out = new Uint16Array(0x2000);
  const p = l2Pointers(rom);
  rleDecode(rom.data, snesToPc(p.tiles), out, 0, 0x2000);
  rleDecode(rom.data, snesToPc(p.attrs), out, 8, 0x2000);
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
// Ankouno's OverworldTables.asm); the patch writes its own code there in that layout. The rest of the game's
// routine stays: each level tile's initial flags ($04D678 by translevel) to $7ED800, then the passed events; before
// them the event tiles' YXPCCCTT are decompressed again ($04DD40), $7F0000 being the VRAM patch's in a level.
// Translevel 0 is no level (the scan starts at 1); a level tile has one, any other tile 0.

export function isLevelTile(t: number): boolean {
  return t >= 0x56 && t < 0x81;
}
export function translevelToLevel(t: number): number {
  return t < 0x25 ? t : t + 0xdc;
}

const TL_HOOK = 0x04d7f2, TL_HOOK_END = 0x04d85d;
const TL_PTR = 0x04d803; // LDA #$xxxx operand: the table's address
const TL_BANK = 0x04d808; // LDA #$xx operand: its bank
export const MAX_TRANSLEVEL = 0x5f; // level 13B
const TL_SLACK = 0x40; // free bytes after the table in its block, so that later changes still fit
const hx = (n: number) => '$' + n.toString(16).toUpperCase();

const translevelAsm = () => `lorom
org ${hx(TL_HOOK)}
  PHB
  SEP #$20 : REP #$10
  LDY #${hx(RAM.owTranslevels)} : STY $00 : LDA #$7E : STA $02     ; to $7E${hx(RAM.owTranslevels).slice(1)}
  REP #$20
  assert pc() == $04D802
  LDA.w #$0000 : STA $8A                       ; the table (written by the editor)
  assert pc() == $04D807
  LDA.w #$0000 : STA $8C
  SEP #$20
  LDA #$00 : PHA : PLB
  PHK : PEA.w Decompressed-1 : PEA.w $804C     ; the game's decompression (RTS) through an RTL of bank 0
  JML $80B8DE
Decompressed:
  PLB
  REP #$30 : TDC : SEP #$20
  LDX #${hx(RAM.owTileFlags)} : STX $0A : LDA #$7E : STA $0C   ; the flags, as the game's
  LDY #$07FF
- TYX
  LDA.l $7E${hx(RAM.owTranslevels).slice(1)},x : BEQ +
  TAX : LDA.l $04D678,x                        ; the translevel's initial flags
+ STA [$0A],y
  DEY : BPL -
  TSC : STA $0E                                ; the event tiles' YXPCCCTT to $7F0000 again: in a level it is the VRAM patch's;
  JSL $84DD40                                  ; called long, its end an RTS or an RTL (Free $7F0000 makes it one), the
  TSC : CMP $0E : BEQ + : PLA                  ; bank an RTS leaves dropped
+
  STZ $0F                                      ; the passed events, as the game's
- JSR $DA49
  INC $0F : LDA $0F
  padbyte $EA : pad $04D858                    ; the count where Lunar Magic's is (owevents.ts: 0x78)
  CMP #$6F : BNE -
  RTS
assert pc() == ${hx(TL_HOOK_END)}
`;

// Lunar Magic's hijack, detected as OverworldTables.asm does
export function hasTranslevelTable(rom: RomRead): boolean {
  return rom.r8(TL_BANK - 1) === 0xa9;
}
const tableAt = (rom: RomRead) => (rom.r8(TL_BANK) << 16) | rom.r16(TL_PTR);
// the table's block in free space (its payload with the room after it), null: none
export function translevelTableBlock(rom: Rom): { snes: number; size: number } | null {
  const at = hasTranslevelTable(rom) ? tableAt(rom) : 0;
  const size = at && snesToPc(at) >= 0x80008 ? rom.isRatsAt(snesToPc(at) - 8) : -1;
  return size > 0 ? { snes: at, size } : null;
}

// the translevel of every layer 1 tile (l1Index order)
export function readTranslevels(rom: Rom): Uint8Array {
  if (!hasTranslevelTable(rom)) missingPatch('Translevels per level tile');
  const out = new Uint8Array(0x800);
  out.set(lz2Decompress(rom.data, snesToPc(tableAt(rom))).data.subarray(0, 0x800));
  return out;
}

// the level each level tile enters (l1Index → level number) in a ROM read through `r` – another than the
// open one, e.g. the Lunar Magic ROM a BPS makes (cleangame.ts), whose reads may throw; null without
// Lunar Magic's translevel table
export function levelTileLevels(r: RomRead): Map<number, number> | null {
  if (!hasTranslevelTable(r)) return null;
  const at = tableAt(r);
  const packed = new Proxy({} as { readonly [i: number]: number }, { get: (_, k) => r.r8(at + Number(k)) });
  const t = lz2Decompress(packed, 0).data;
  const out = new Map<number, number>();
  for (let i = 0; i < 0x800; i++) {
    const tile = r.r8(OW_L1 + i);
    if (isLevelTile(tile) && t[i]) out.set(i, translevelToLevel(t[i]));
  }
  return out;
}

// writes the table where it is when it fits its block, else to free space; unchanged: nothing written
export function writeTranslevels(rom: Rom, t: Uint8Array): void {
  if (!hasTranslevelTable(rom)) missingPatch('Translevels per level tile');
  const block = translevelTableBlock(rom); // null: the patch being installed
  if (block && readTranslevels(rom).every((v, i) => v === t[i])) return;
  const packed = lz2Compress(t);
  if (block && packed.length <= block.size) { rom.writeBytes(block.snes, packed); return; }
  if (block) rom.freeAt(block.snes);
  const payload = new Uint8Array(packed.length + TL_SLACK);
  payload.set(packed);
  const addr = rom.allocWrite(payload);
  rom.w16(TL_PTR, addr & 0xffff);
  rom.w8(TL_BANK, addr >> 16);
}

// needs Asar (loadAsar) to be loaded; every tile gets the translevel the game gives it (its table in WRAM, emulated)
export function installTranslevelPatch(rom: Rom): void {
  if (hasTranslevelTable(rom)) return;
  const game = new OverworldEmulator(rom).load(0, 0);
  if (!game.ok) throw new Error('The overworld did not load – translevel table not installed');
  const t = game.wram.slice(RAM.owTranslevels, RAM.owTranslevelsEnd);
  const r = assemble(rom.data, new Map([['translevels.asm', translevelAsm()]]), 'translevels.asm');
  if (!r.ok) throw new Error(r.errors.map((e) => e.message).join(' '));
  rom.writeAt(snesToPc(TL_HOOK), r.rom.subarray(snesToPc(TL_HOOK), snesToPc(TL_HOOK_END)));
  writeTranslevels(rom, t);
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

// paints tile v at i (l1 and t changed): a level tile takes `carried` (the translevel it was picked up from the
// map with), else keeps the one there (a level tile painted over), else gets a free one (as freeTranslevel); any
// other tile none, so the translevel of a level tile painted over is free again (its level keeps its settings)
export function placeTile(l1: Uint8Array, t: Uint8Array, i: number, v: number, carried = 0, rank?: (tl: number) => number): void {
  l1[i] = v;
  if (!isLevelTile(v)) t[i] = 0;
  else if (carried) t[i] = carried;
  else if (!t[i]) t[i] = freeTranslevel(t, rank);
}

// the translevels more than one level tile enters, with their tiles
export function sharedTranslevels(l1: Uint8Array, t: Uint8Array): Map<number, number[]> {
  const tiles = new Map<number, number[]>();
  t.forEach((n, i) => { if (n && isLevelTile(l1[i])) (tiles.get(n) ?? tiles.set(n, []).get(n)!).push(i); });
  for (const [n, l] of tiles) if (l.length < 2) tiles.delete(n);
  return tiles;
}

// the layer 1 tiles (l1Index) entering translevel tl
export function levelTilesOf(l1: ArrayLike<number>, t: ArrayLike<number>, tl: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < t.length; i++) if (tl && t[i] === tl && isLevelTile(l1[i])) out.push(i);
  return out;
}

// the levels a level tile can enter (001–024, 101–13B: translevels 1–5F)
export const enterableLevels = (): number[] => Array.from({ length: MAX_TRANSLEVEL }, (_, k) => translevelToLevel(k + 1));

// ---- a translevel's settings ----
// The name, base event, exit reveal directions and message slots belong to the level (its translevel), not to a
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
export const NO_NAME = 0x0000; // blank in the game; $FFFF (the unused translevels') shows RAM as letters
export const isNameless = (code: number): boolean => code === 0x0000 || code === 0xffff;

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
const SAVE_TILES = 0x048f7f; // the game's 8 layer 1 tiles that bring up the save prompt when passed

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
; list's last one when the translevel's save prompt flag is set; the list's loop goes on with A
org ${hx(LF_SAVE_HOOK)}
  JSL SavePrompt : NOP
org ${hx(LF_SAVE_LOOP)}
  db $10, ${hx((LF_SAVE_HOOK + 5 - (LF_SAVE_LOOP + 2)) & 0xff)}        ; BPL to the CMP after the hook
org ${hx(LF_SAVE)}
SavePrompt:
  PHP
  REP #$30
  LDX $04
  LDA.l $7E${hx(RAM.owTranslevels).slice(1)},x : AND #$00FF : TAX
  SEP #$20
  LDA.l $7E${hx(RAM.levelFlags).slice(1)},x : AND #${hx(FLAG.savePrompt)} : BEQ +
  LDA.l ${hx(SAVE_TILES + 7)}
  BRA ++
+ LDA.l $7E${hx(RAM.owTile).slice(1)}
++ LDX.w #$0007
  PLP
  RTL
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
  for (const [a, n] of [[LF_INIT_HOOK, 4], [LF_INIT, LEVEL_FLAGS - LF_INIT], [LF_SAVE_HOOK, 5], [LF_SAVE_LOOP, 2], [LF_ENTER_HOOK, 4], [LF_SAVE, LF_END - LF_SAVE]]) {
    rom.writeAt(snesToPc(a), r.rom.subarray(snesToPc(a), snesToPc(a) + n));
  }
  rom.writeBytes(LEVEL_FLAGS, flags);
}

// how much a translevel no tile enters would bring along to a new one: 0 nothing (no name, base event or message
// slot, the level's data the game's blank one), 1 settings resetTranslevel resets, 2 a level of its own
export type TranslevelUse = 0 | 1 | 2;
export function translevelUse(rom: Rom, tl: number): TranslevelUse {
  if (hasOwnContent(rom, translevelToLevel(tl))) return 2;
  return !isNameless(nameCode(rom, tl)) || baseEvent(rom, tl) !== NO_EVENT || messageSlots(rom, tl).length || initialFlags(rom, tl) ? 1 : 0;
}

// the settings of translevel tl as the game's unused ones: no name, no base event, every exit enabling up, no
// message, no initial flags
export function resetTranslevel(rom: Rom, tl: number): void {
  setNameCode(rom, tl, NO_NAME);
  rom.w8(BASE_EVENTS + tl, NO_EVENT);
  rom.w8(EXIT_DIRS + tl, 0);
  setInitialFlags(rom, tl, 0);
  for (const s of messageSlots(rom, tl)) unassignMessageSlot(rom, s.slot);
}

// ---- level names ----
const CHARMAP: Record<number, string> = { 0x1f: ' ', 0x5d: "'", 0x5a: '#', 0x1c: '-', 0x1b: '!', 0x1d: '.' };
for (let i = 0; i < 26; i++) CHARMAP[i] = String.fromCharCode(65 + i);
for (let i = 0; i < 9; i++) CHARMAP[0x64 + i] = String(i + 1);

export function nameWord(rom: Rom, part: number, idx: number): string {
  const table = [NAME_P1, NAME_P2, NAME_P3][part];
  const off = rom.r16(table + idx * 2);
  let s = '';
  for (let i = 0; i < 40; i++) {
    const b = rom.r8(NAME_CHARS + off + i);
    const c = b & 0x7f;
    s += CHARMAP[c] ?? '·';
    if (b & 0x80) break;
  }
  return s;
}
export function nameCode(rom: Rom, translevel: number): number {
  return rom.r16(NAME_CODES + translevel * 2);
}
export function setNameCode(rom: Rom, translevel: number, code: number): void {
  rom.w16(NAME_CODES + translevel * 2, code);
}
export function splitNameCode(code: number): [number, number, number] {
  return [(code >> 8) & 0x7f, (code >> 4) & 0x0f, code & 0x0f];
}
export function joinNameCode(p: [number, number, number]): number {
  return ((p[0] & 0x7f) << 8) | ((p[1] & 15) << 4) | (p[2] & 15);
}
// "(no name)" for $0000 and $FFFF
export function levelName(rom: Rom, translevel: number): string {
  const code = nameCode(rom, translevel);
  if (isNameless(code)) return '(no name)';
  const [a, b, c] = splitNameCode(code);
  return (nameWord(rom, 0, a) + nameWord(rom, 1, b) + nameWord(rom, 2, c)).replace(/\s+/g, ' ').trim();
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
// tile i revealed on exactly `events` (each then reveals only it)
export function setRevealEvents(rom: Rom, i: number, events: number[]): void {
  const at = revealTable(rom);
  for (let e = 0; e < revealEventCount(rom); e++) {
    if (events.includes(e)) rom.w16(at + e * 2, i);
    else if (revealAt(rom, e) === i) rom.w16(at + e * 2, 0);
  }
}
// the tile layer 1 tile t turns into when revealed, -1: it has none (a reveal does nothing)
export function revealedTile(rom: Rom, t: number): number {
  for (let k = REVEALS - 1; k >= 0; k--) if (rom.r8(REVEAL_FROM + k) === t) return rom.r8(REVEAL_TO + k);
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
function writeDestroyList(rom: Rom, list: Destroy[]): void {
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
// what destroying each layer 1 tile 00–FF does (the changes, [] none): learned by running the game's code on a map
// holding the tile, an entry destroying it
export function destroyEffects(rom: Rom): DestroyChange[][] {
  const memo = effectsMemo.get(rom);
  if (memo?.gen === rom.gen) return memo.effects;
  const probe = new Rom(rom.data.slice()), at = l1Index(0, 4, 4), RET = 0x8000;
  writeDestroyList(probe, Array.from({ length: DESTROYS }, (_, k) => (k ? { event: NO_EVENT, tile: 0 } : { event: 0, tile: at })));
  const s = new Snes(probe.data), cpu = s.cpu, w = s.wram, map = w.subarray(RAM.owLayer1, RAM.owLayer1End), fresh = s.saveState();
  const effects: DestroyChange[][] = [];
  for (let t = 0; t < 0x100; t++) {
    s.loadState(fresh);
    map[at] = t;
    const before = map.slice();
    // JSR $04E677 with the event in A, its RTS to RET
    Object.assign(cpu, { e: false, p: 0x30, d: 0, dbr: 0, pbr: DESTROY_CALL >> 16, pc: DESTROY_CALL & 0xffff, a: 0, s: 0x1fd, waiting: false, stopped: false });
    w[0x1fe] = (RET - 1) & 0xff; w[0x1ff] = (RET - 1) >> 8;
    for (let n = 0; n < 5000 && cpu.pc !== RET; n++) cpu.step();
    const o = l1XY(at);
    effects.push([...map.keys()].filter((i) => map[i] !== before[i]).map((i) => { const p = l1XY(i); return { dx: p.x - o.x, dy: p.y - o.y, tile: map[i] }; }));
  }
  effectsMemo.set(rom, { gen: rom.gen, effects });
  return effects;
}
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
export function destroySettingAt(rom: Rom, l1: Uint8Array, shown: Uint8Array, i: number): { at: number; tile: number | undefined } {
  const effects = destroyEffects(rom), revealed = l1.map((t) => { const r = revealedTile(rom, t); return r >= 0 ? r : t; });
  const maps = [l1, revealed, shown];
  let at = destroyEvent(rom, i) !== NO_EVENT ? i : -1;
  for (const m of maps) if (at < 0) at = destroyedAt(effects, m, i);
  return { at, tile: at < 0 ? undefined : maps.map((m) => m[at]).find((v) => effects[v].length) };
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
// reveals with the reveal list, the destroyed level tiles, the event steps, the links (star/pipe, exit path and
// Koopa Kid tables), the start positions and the sprites (owsprites.ts).
// Learned results that load the overworld without depending on what is painted there leave them out (owpaths.ts).
export function overworldDataRanges(rom: Rom): [number, number][] {
  const at = (snes: number, len: number): [number, number] => [snesToPc(snes), snesToPc(snes) + len];
  const p = l2Pointers(rom), d = rom.data, scratch = new Uint16Array(0x2000);
  const out = [
    at(OW_L1, 0x800),
    at(p.tiles, rleDecode(d, snesToPc(p.tiles), scratch, 0, 0x2000)),
    at(p.attrs, rleDecode(d, snesToPc(p.attrs), scratch, 8, 0x2000)),
    at(L2_TILE_PTR, 2), at(L2_BANK, 1), at(L2_ATTR_PTR, 2),
    at(EXIT_DIRS, MAX_TRANSLEVEL + 1),
    at(NAME_CODES, (MAX_TRANSLEVEL + 1) * 2),
  ];
  const tl = translevelTableBlock(rom);
  if (tl) out.push(at(tl.snes, tl.size), at(TL_PTR, 2), at(TL_BANK, 1));
  if (hasLevelFlagsPatch(rom)) out.push(at(LEVEL_FLAGS, MAX_TRANSLEVEL + 1));
  out.push(at(revealTable(rom), revealEventCount(rom) * 2), at(REVEAL_FROM, REVEALS), at(REVEAL_TO, REVEALS), ...eventDataRanges(rom));
  if (hasDestroyPatch(rom)) out.push(at(rom.r24(DESTROY_EV_OP), DESTROYS), at(rom.r24(DESTROY_LOC_OP), DESTROYS * 2));
  out.push(...teleportDataRanges(rom), at(KOOPA_X, KOOPAS * 2), at(KOOPA_Y, KOOPAS * 2));
  out.push(at(START, 0x16), at(OW_SPRITES, OW_SPRITE_SLOTS * 5), ...Object.values(KOOPA_KID).map((t) => at(t, KOOPA_KIDS)));
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
// layer 1 as the game shows it, its events applied (l1Index order)
export const gameL1 = (r: OwRender): Uint8Array => r.wram.subarray(RAM.owLayer1, RAM.owLayer1End);
// layer 2 of the loaded map's region as the game shows it, its events applied: the BG2 tilemap in VRAM (64x64 at
// BG2SC, $2108; l2Index order within the region)
export function gameL2(r: OwRender): Uint16Array {
  const at = (r.ppuRegs[0x08] & 0xfc) << 9;
  return Uint16Array.from({ length: 0x1000 }, (_, k) => r.vram[at + k * 2] | (r.vram[at + k * 2 + 1] << 8));
}

export class OverworldEmulator {
  rom: Rom;
  snes: Snes;
  titleState: SnesState | null = null;
  private title: { reads: RomReads; rom: Uint8Array } | null = null; // what reaching the title screen read
  private romGen: number;
  constructor(rom: Rom) {
    this.rom = rom;
    this.snes = new Snes(rom.data);
    this.romGen = rom.gen;
  }
  // catches up with a changed ROM (rom.gen); a change of what reaching the title screen read makes its
  // snapshot stale (as LevelEmulator's boot snapshot)
  private sync(): void {
    this.snes.rom = this.rom.data;
    if (this.romGen === this.rom.gen) return;
    this.romGen = this.rom.gen;
    if (this.title?.reads.differ(this.title.rom, this.rom.data)) { this.titleState = null; this.title = null; }
  }
  // map `map` at event progress `progress` (events 0 … progress-1 passed), as after loading a save: the game draws
  // their layer 2 tiles when the file is loaded (file select) and applies them to layer 1 in their number order
  // while it loads the overworld (a new file's events are set again there)
  load(map: number, progress: number): OwRender {
    this.sync();
    const s = this.snes;
    if (!this.titleState) {
      updateBytePages(this.rom);
      const reads = new RomReads(this.rom.data.length);
      s.romReads = reads;
      try {
        s.reset();
        let f = 0;
        while (s.wram[RAM.gameMode] !== GM.title && f++ < 2000) s.runFrame();
      } finally { s.romReads = null; }
      this.titleState = s.saveState();
      this.title = { reads, rom: this.rom.data.slice() };
    } else s.loadState(this.titleState);
    const w = s.wram;
    let n = 0;
    try {
      while (w[RAM.gameMode] !== GM.overworld && n < 1500) {
        if (w[RAM.gameMode] === GM.fileSelect) w.set(eventBits(progress), RAM.owEvents);
        if (w[RAM.gameMode] === GM.overworldLoad) {
          w[RAM.introLevel] = 0;
          w[RAM.submap] = map;
          w[RAM.submap + 1] = map;
          w.set(eventBits(progress), RAM.owEvents);
        }
        s.joy1 = (n % 16) < 4 ? (w[RAM.gameMode] === GM.title ? 0x1000 : 0x0080) : 0;
        s.runFrame();
        n++;
      }
      s.joy1 = 0;
      for (let i = 0; i < 3; i++) s.runFrame();
    } catch {
      return { vram: s.vram.slice(), cgram: s.cgram.slice(), wram: s.wram.slice(), ppuRegs: s.ppuRegs.slice(), ok: false };
    }
    return { vram: s.vram.slice(), cgram: s.cgram.slice(), wram: s.wram.slice(), ppuRegs: s.ppuRegs.slice(), ok: w[RAM.gameMode] === GM.overworld };
  }
}
