// Layer 3 graphics and tilemap per level, as Lunar Magic's "Layer 3 GFX/Tilemap Bypass" (LM help:
// level_layer3_gfx.htm): LG1-LG4 replace the game's layer 3 files 28-2B (2bpp, 0x800 bytes each, VRAM
// $4000-$4FFF), LT3 is a file of tilemap data copied into the layer 3 tilemap (VRAM $5000-$5FFF, 64x64
// tiles) in place of the image of the level's layer 3 setting; the setting's behaviour (tides …) stays.
// The game uploads 28-2B once at boot; levels after one with its own LG files get 28-2B back, the
// overworld too.
//
// The LT3 settings are Lunar Magic's nibble DDFF (the high nibble of the LT3 word in its ExGFX table and a
// .mwl's section 7), observed in a Lunar Magic-saved ROM by changing it and looking at VRAM after the
// level load: DD the destination – 0 under the status bar ($50A0, the file's first $A0 words skipped),
// 1 the start of layer 3 ($5000), 2 the status bar's last line ($5080, $80 words skipped), 3 the bottom
// half ($5800); FF the file's size – 0 0x2000 bytes (512x512), 1 0x1000 (512x256), 2 0x800 (256x256).
// The editor keeps them in a table of its own (Lunar Magic's table, at no fixed place, also holds the
// other slots, which the editor keeps elsewhere).
// The submaps have the same (Lunar Magic's "Submap Layer 3 GFX/Tilemap Bypass", ov_overworld_layer3_gfx.htm): entries
// 200–206 of the table (submapgfx.ts), read while the overworld loads for the submap Mario is on – LG1–LG4 also when
// he walks to another submap (the graphics upload runs again there), LT3 in place of the game's border (stripe image
// 6, set at $00A153: Lunar Magic's place), not reloaded when he walks.

import type { Rom } from './rom.ts';
import { applyPatch, type ApplyResult } from './patchapply.ts';
import { listPatches } from './patchreg.ts';
import { installEditorPatch, editorPatch, missingPatch, gfxEntry, gfxNum, freeGfx, gfxRangeFor, GFX_NONE, RAW_GFX_SIZES, LT3_SLOT } from './patches.ts';
import { lz2Decompress } from './lz2.ts';
import { snesToPc } from './rom.ts';
import { LAYER3_GFX_RAM, RAM } from './ram.ts';

export const LAYER3_PATCH_NAME = 'Layer 3 graphics per level (Lunar Magic format)';
export { LG_SLOT_NAMES, LT3_SLOT, LAYER3_SLOT_NAMES } from './patches.ts';
export const GAME_LAYER3_GFX = 0x28; // the game's files 28-2B
export const LG_SIZE = 0x800;
export const LT3_DESTS = ['Under the status bar', 'Start of layer 3', 'Last line of the status bar', 'Bottom half of layer 3'];
export const LT3_SIZES = [0x2000, 0x1000, 0x800];
const GFX_HOOK = 0x00a9da, MAP_HOOK = 0x00a01f, BORDER_HOOK = 0x00a153;
const MAGIC = [0x53, 0x4d, 0x57, 0x4c]; // "SMWL"
// the table's parts: LT3 and LG1-LG4 a word per entry (levels 000–1FF, then submaps 0–6), then LT3's DDFF a byte per entry
const ENTRIES = 0x207, PART = ENTRIES * 2;
const LT3_TBL = 0, LG_TBL = PART, DDFF_TBL = 5 * PART;
const hx = (n: number) => '$' + n.toString(16).toUpperCase();
const hx4 = (n: number) => '$' + n.toString(16).toUpperCase().padStart(4, '0');

// Tables (by level): LT3 file, LG1-LG4 (a word each, 0FF: none / the game's file), LT3's DDFF (a byte).
// LG: at the start of the graphics upload ($00A9DA, LDA #$80 : STA $2115), in levels the four files
// when one is the level's own, else 28-2B again when another level put its own there (!Own). A file
// stored raw is copied from the ROM, a compressed one through the game's decompression (the editor
// patch's entry to $00BA28 for any file number).
// LT3: where the game uploads the image of the layer 3 setting ($00A01F, LDA $1BE3 : BEQ : DEC, the
// place Lunar Magic changes); the image is skipped when the level has an LT3 file (stored raw).
function asm(rom: Rom): string {
  const p = editorPatch(rom) ?? missingPatch('Editor patch (SMWE)');
  const copies = Array.from({ length: 16 }, (_, v) => lt3Copy(fromLt3Nibble(v)));
  return `asar 1.90
lorom
!Own = ${hx(LAYER3_GFX_RAM[0])}   ; 1: the layer 3 graphics in VRAM are not the game's
!GameMode = ${hx(0x7e0000 | RAM.gameMode)}
!Setting = ${hx(RAM.layer3Setting)}   ; the level's layer 3 setting
!GfxLo = ${hx(p.gfxLo)}
!GfxHi = ${hx(p.gfxHi)}
!GfxBk = ${hx(p.gfxBank)}
!GfxFlags = ${hx(p.gfxFlags)}
!GfxDecomp = ${hx(p.decomp)}
!Player = ${hx(0x7e0000 | RAM.playerIndex)}
!Submap = ${hx(0x7e0000 | RAM.submap)}

org ${hx(GFX_HOOK)}
  JSL Gfx
  NOP

org $00A044 : NoImage:   ; RTS
org ${hx(MAP_HOOK)}   ; A/X 8 bit, $00 = 3 * tileset (the game's)
  JSL Map
  BEQ NoImage           ; (a label: asar takes a long address in a branch as an offset)

org ${hx(BORDER_HOOK)}  ; the overworld loads: LDA #$06 : STA $12 (the border's stripe image)
  JSL Border

freecode
  db ${MAGIC.map((m) => hx(m)).join(',')}
  dl Tbl
  db 0
Gfx:
  LDA #$80 : STA $2115
  PHP
  LDA.l !GameMode    ; (below $0B the title screen and file select, which load a level too)
  CMP #$0B : BCC .level
  CMP #$0F : BCC .ow
.level
  REP #$30
  LDA.l $7E010B : AND #$01FF : ASL : TAX
  BRA .check
.ow                  ; the submap's entry
  REP #$30
  JSR Entry : ASL : TAX
.check
  LDA.l Tbl+${hx(LG_TBL)},x : CMP #$00FF : BNE .own
  LDA.l Tbl+${hx(LG_TBL + PART)},x : CMP #$00FF : BNE .own
  LDA.l Tbl+${hx(LG_TBL + 2 * PART)},x : CMP #$00FF : BNE .own
  LDA.l Tbl+${hx(LG_TBL + 3 * PART)},x : CMP #$00FF : BNE .own
  SEP #$20
  BRA .game
.own
  LDY #$0000
- PHY : PHX
  LDA.l Tbl+${hx(LG_TBL)},x
  CMP #$00FF : BNE +
  TYA : CLC : ADC #${hx4(GAME_LAYER3_GFX)}
+ JSR Upload
  PLX : PLY
  TXA : CLC : ADC #${hx4(PART)} : TAX
  INY : CPY #$0004 : BNE -
  SEP #$20
  LDA #$01 : STA.l !Own
  PLP
  RTL
.game
  LDA.l !Own : BEQ .done
  REP #$30
  LDY #$0000
- PHY
  TYA : CLC : ADC #${hx4(GAME_LAYER3_GFX)}
  JSR Upload
  PLY : INY : CPY #$0004 : BNE -
  SEP #$20
  LDA #$00 : STA.l !Own
.done
  PLP
  RTL

; A = file, Y = slot 0-3 (A/X/Y 16 bit): its 0x800 bytes to VRAM $4000 + slot * $400
Upload:
  TAX
  SEP #$20
  STZ $2116
  TYA : ASL #2 : ORA #$40 : STA $2117
  LDA.l !GfxFlags,x : BNE .raw
  JSL !GfxDecomp     ; decompressed to [$00]
  LDA $00 : STA $4302
  LDA $01 : STA $4303
  LDA $02 : STA $4304
  BRA .dma
.raw
  LDA.l !GfxLo,x : STA $4302
  LDA.l !GfxHi,x : STA $4303
  LDA.l !GfxBk,x : STA $4304
.dma
  LDA #$01 : STA $4300
  LDA #$18 : STA $4301
  LDA #${hx(LG_SIZE & 0xff)} : STA $4305
  LDA #${hx(LG_SIZE >> 8)} : STA $4306
  LDA #$01 : STA $420B
  REP #$30
  RTS

; (A/X 16 bit) the overworld's entry: 200 + the submap of the player
Entry:
  LDA.l !Player : AND #$00FF : TAX
  LDA.l !Submap,x : AND #$00FF : CLC : ADC #$0200
  RTS

; the overworld loads (JSL from $00A153, A 8 bit, the screen off): the submap's LT3 copied in place of the game's
; border, else the border's stripe image as the game
Border:
  PHP
  REP #$30
  JSR Entry
  JSR Lt3
  BNE +
  SEP #$20
  LDA #$06 : STA $12
+ PLP
  RTL

; returns Z set: no image of the layer 3 setting (none, or the level's LT3 is there instead); else
; A = the setting - 1, as the game's code goes on. The LT3 file is uncompressed and at least as long as its
; size says (the editor offers only such); a compressed one is left out
Map:
  PHP
  REP #$30
  LDA.l $7E010B : AND #$01FF
  JSR Lt3
  BEQ .game
  PLP
  SEP #$02
  RTL
.game
  PLP
  LDA !Setting : BEQ +
  DEC
  REP #$02
+ RTL

; (A/X 16 bit) entry A's LT3 file copied to VRAM; Z clear: copied
Lt3:
  TAX
  PHX
  ASL : TAX
  LDA.l Tbl+${hx(LT3_TBL)},x
  CMP #$00FF : BEQ .none
  TAX
  SEP #$20
  LDA.l !GfxFlags,x : BEQ .packed
  LDA.l !GfxLo,x : STA $4302      ; source: the file in the ROM (+ the part skipped, below)
  LDA.l !GfxHi,x : STA $4303
  LDA.l !GfxBk,x : STA $4304
  PLX
  REP #$20
  LDA.l Tbl+${hx(DDFF_TBL)},x : AND #$000F : ASL : TAX   ; DDFF * 2
  LDA.l .vram,x : STA $2116
  LDA.l .skip,x : CLC : ADC $4302 : STA $4302
  LDA.l .len,x : STA $4305
  SEP #$20
  LDA #$80 : STA $2115
  LDA #$01 : STA $4300
  LDA #$18 : STA $4301
  LDA #$01 : STA $420B
  REP #$20
  LDA #$0001
  RTS
.packed
.none
  PLX
  REP #$20
  LDA #$0000
  RTS
; by DDFF: destination, the file's bytes skipped (the status bar's), the bytes copied (up to VRAM $6000)
.vram
  dw ${copies.map((c) => hx4(c.vram)).join(', ')}
.skip
  dw ${copies.map((c) => hx4(c.skip)).join(', ')}
.len
  dw ${copies.map((c) => hx4(c.len)).join(', ')}

Tbl:
  fillword $00FF : fill ${hx(DDFF_TBL)}
  fillbyte $00 : fill ${hx(ENTRIES)}
`;
}

export function layer3Entry(rom: Rom) {
  return listPatches(rom).find((p) => p.kind === 'layer3') ?? null;
}

function findTable(rom: Rom): number | null {
  if (rom.r8(GFX_HOOK) === 0x22) {
    const base = rom.r24(GFX_HOOK + 1) - 8;
    if (MAGIC.every((m, i) => rom.r8(base + i) === m)) return rom.r24(base + 4);
  }
  return null;
}
const table = (rom: Rom): number => findTable(rom) ?? missingPatch('Layer 3 graphics (SMWL)');

// needs Asar (loadAsar) to be loaded
export function installLayer3Patch(rom: Rom): ApplyResult {
  const e = layer3Entry(rom);
  if (e) return { ok: true, errors: [], warnings: [], prints: [], entry: e };
  installEditorPatch(rom);
  return applyPatch(rom, { name: LAYER3_PATCH_NAME, main: 'layer3gfx.asm', files: new Map([['layer3gfx.asm', asm(rom)]]), kind: 'layer3', ram: [LAYER3_GFX_RAM] });
}

// a level's layer 3 files: lt3 ($FF none) with its destination (0-3, LT3_DESTS) and size (0-2,
// LT3_SIZES); lg: LG1-LG4 ($FF the game's file 28-2B)
export interface Lt3Place { dest: number; size: number }
export interface Layer3Gfx extends Lt3Place { lt3: number; lg: number[] }

// (n: a level 000–1FF, or a submap's entry 200–206: submapgfx.ts)
export function levelLayer3(rom: Rom, n: number): Layer3Gfx {
  const t = table(rom);
  return { lt3: rom.r16(t + LT3_TBL + n * 2), ...fromLt3Nibble(rom.r8(t + DDFF_TBL + n)), lg: [0, 1, 2, 3].map((k) => rom.r16(t + LG_TBL + k * PART + n * 2)) };
}
export function setLevelLayer3(rom: Rom, n: number, g: Layer3Gfx): void {
  const t = table(rom);
  rom.w16(t + LT3_TBL + n * 2, gfxNum(g.lt3));
  g.lg.forEach((v, k) => rom.w16(t + LG_TBL + k * PART + n * 2, gfxNum(v)));
  rom.w8(t + DDFF_TBL + n, lt3Nibble(g));
}

// the ROM bytes ([SNES address, value]) that make the uncompressed 0x2000-byte file at `addr` level n's LT3,
// placed `place`: the emulator's temporary patches for an LT3 file not saved yet (levelemu.ts). The file
// takes the level's LT3 number, or one without a file. None without the patch
export function lt3Patches(rom: Rom, n: number, addr: number, place: Lt3Place): [number, number][] {
  const t = findTable(rom), p = editorPatch(rom);
  if (t === null || !p) return [];
  let num = rom.r16(t + LT3_TBL + n * 2);
  if (num === GFX_NONE) num = freeGfx(rom, new Set(), gfxRangeFor({ slot: LT3_SLOT }));
  if (num < 0) return [];
  const at = t + LT3_TBL + n * 2;
  return [[at, num & 0xff], [at + 1, num >> 8], [t + DDFF_TBL + n, lt3Nibble(place)],
    [p.gfxLo + num, addr & 0xff], [p.gfxHi + num, (addr >> 8) & 0xff], [p.gfxBank + num, addr >> 16], [p.gfxFlags + num, RAW_GFX_SIZES.indexOf(0x2000) + 1]];
}

// how the patch copies an LT3 file: to VRAM word `vram`, the file's first `skip` bytes left out (the status
// bar's part of the tilemap: the file is laid out as the whole tilemap from $5000, or from $5800 for the
// bottom half), `len` bytes: the size less what is skipped, at most up to the tilemap's end ($6000)
export const L3_MAP_START = 0x5000, L3_MAP_END = 0x6000;
const LT3_VRAM = [0x50a0, 0x5000, 0x5080, 0x5800];
const LT3_SKIP = [0x140, 0, 0x100, 0];
export function lt3Copy(p: Lt3Place): { vram: number; skip: number; len: number } {
  const vram = LT3_VRAM[p.dest], skip = LT3_SKIP[p.dest];
  return { vram, skip, len: Math.min(LT3_SIZES[p.size] - skip, (L3_MAP_END - vram) * 2) };
}

// Lunar Magic's DDFF of the LT3 word (its size 3 reads as 0x2000 bytes, as in its code), and back
export const lt3Nibble = (g: Lt3Place) => ((g.dest & 3) << 2) | (g.size & 3);
export const fromLt3Nibble = (v: number): Lt3Place => ({ dest: (v >> 2) & 3, size: (v & 3) === 3 ? 0 : v & 3 });

// the files a slot can take: LG 2bpp graphics (0x800 bytes, uncompressed or not), LT3 an uncompressed file
// at least `size` bytes long (any, without `size`)
export function fitsLayer3Slot(rom: Rom, slot: string, num: number, size?: number): boolean {
  const e = gfxEntry(rom, num);
  if (!e) return false;
  if (slot === LT3_SLOT) return e.raw && e.size >= (size ?? 0);
  if (e.raw) return e.size === LG_SIZE;
  try { return lz2Decompress(rom.data, snesToPc(e.addr)).data.length === LG_SIZE; } catch { return false; }
}
// the largest LT3 size (LT3_SIZES index) an uncompressed file of `bytes` has room for
export const lt3SizeFor = (bytes: number) => Math.max(0, LT3_SIZES.findIndex((b) => b <= bytes));
