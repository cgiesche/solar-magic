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

import type { Rom } from './rom.ts';
import { applyPatch, type ApplyResult } from './patchapply.ts';
import { listPatches } from './patchreg.ts';
import { installEditorPatch, editorPatch, missingPatch } from './patches.ts';
import { LAYER3_GFX_RAM } from './ram.ts';

export const LAYER3_PATCH_NAME = 'Layer 3 graphics per level (Lunar Magic format)';
export const LG_SLOT_NAMES = ['LG1', 'LG2', 'LG3', 'LG4'];
export const LT3_SLOT = 'LT3';
export const LAYER3_SLOT_NAMES = [...LG_SLOT_NAMES, LT3_SLOT];
export const GAME_LAYER3_GFX = 0x28; // the game's files 28-2B
export const LG_SIZE = 0x800;
export const LT3_DESTS = ['Under the status bar', 'Start of layer 3', 'Last line of the status bar', 'Bottom half of layer 3'];
export const LT3_SIZES = [0x2000, 0x1000, 0x800];
const GFX_HOOK = 0x00a9da, MAP_HOOK = 0x00a01f;
const MAGIC = [0x53, 0x4d, 0x57, 0x4c]; // "SMWL"
const hx = (n: number) => '$' + n.toString(16).toUpperCase();

// Tables (512 bytes each, by level): LT3 file ($FF none), LG1-LG4 ($FF the game's file), LT3's DDFF.
// LG: at the start of the graphics upload ($00A9DA, LDA #$80 : STA $2115), in levels the four files
// when one is the level's own, else 28-2B again when another level put its own there (!Own). A file
// stored raw is copied from the ROM, a compressed one through the game's decompression ($00BA28).
// LT3: where the game uploads the image of the layer 3 setting ($00A01F, LDA $1BE3 : BEQ : DEC, the
// place Lunar Magic changes); the image is skipped when the level has an LT3 file (stored raw).
function asm(rom: Rom): string {
  const p = editorPatch(rom) ?? missingPatch('Editor patch (SMWE)');
  return `asar 1.90
lorom
!Own = ${hx(LAYER3_GFX_RAM[0])}   ; 1: the layer 3 graphics in VRAM are not the game's
!GfxLo = ${hx(p.gfxLo)}
!GfxHi = ${hx(p.gfxHi)}
!GfxBk = ${hx(p.gfxBank)}
!GfxFlags = ${hx(p.gfxFlags)}

org ${hx(GFX_HOOK)}
  JSL Gfx
  NOP

org $00A044 : NoImage:   ; RTS
org ${hx(MAP_HOOK)}   ; A/X 8 bit, $00 = 3 * tileset (the game's)
  JSL Map
  BEQ NoImage           ; (a label: asar takes a long address in a branch as an offset)

freecode
  db ${MAGIC.map((m) => hx(m)).join(',')}
  dl Tbl
  db 0
Gfx:
  LDA #$80 : STA $2115
  PHP
  LDA.l $7E0100
  CMP #$0B : BCC .level
  CMP #$0F : BCC .game
.level
  REP #$30
  LDA.l $7E010B : AND #$01FF : TAX
  SEP #$20
  LDA.l Tbl+$200,x : AND.l Tbl+$400,x : AND.l Tbl+$600,x : AND.l Tbl+$800,x
  CMP #$FF : BEQ .game
  LDY #$0000
- PHY : PHX
  LDA.l Tbl+$200,x
  CMP #$FF : BNE +
  TYA : CLC : ADC #${hx(GAME_LAYER3_GFX)}
+ JSR Upload
  PLX : PLY
  REP #$20 : TXA : CLC : ADC #$0200 : TAX : SEP #$20
  INY : CPY #$0004 : BNE -
  LDA #$01 : STA.l !Own
  PLP
  RTL
.game
  LDA.l !Own : BEQ .done
  REP #$10
  LDY #$0000
- PHY
  TYA : CLC : ADC #${hx(GAME_LAYER3_GFX)}
  JSR Upload
  PLY : INY : CPY #$0004 : BNE -
  LDA #$00 : STA.l !Own
.done
  PLP
  RTL

; A = file (8 bit), Y = slot 0-3 (X/Y 16 bit): its 0x800 bytes to VRAM $4000 + slot * $400
Upload:
  SEP #$30
  PHA
  STZ $2116
  TYA : ASL #2 : ORA #$40 : STA $2117
  PLA : TAX : TAY
  LDA.l !GfxFlags,x : BNE .raw
  JSL $00BA28        ; decompressed to [$00]
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
  REP #$10
  RTS

; returns Z set: no image of the layer 3 setting (none, or the level's LT3 is there instead); else
; A = the setting - 1, as the game's code goes on
Map:
  PHP
  REP #$30
  LDA.l $7E010B : AND #$01FF : TAX
  LDA.l Tbl,x : AND #$00FF
  CMP #$00FF : BEQ .game
  PHX
  TAX
  SEP #$20
  LDA.l !GfxFlags,x : BEQ .packed
  LDA.l !GfxLo,x : STA $4302      ; source: the file in the ROM (+ the part skipped, below)
  LDA.l !GfxHi,x : STA $4303
  LDA.l !GfxBk,x : STA $4304
  PLX
  LDA.l Tbl+$A00,x : AND #$0F : ASL : TAX   ; DDFF * 2
  REP #$20
  LDA.l .vram,x : STA $2116
  LDA.l .skip,x : CLC : ADC $4302 : STA $4302
  LDA.l .len,x : STA $4305
  SEP #$20
  LDA #$80 : STA $2115
  LDA #$01 : STA $4300
  LDA #$18 : STA $4301
  LDA #$01 : STA $420B
  PLP
  SEP #$02
  RTL
.packed
  PLX
.game
  PLP
  LDA $1BE3 : BEQ +
  DEC
  REP #$02
+ RTL
; by DDFF: destination, the file's bytes skipped (the status bar's), the bytes copied (up to VRAM $6000)
.vram
  dw $50A0, $50A0, $50A0, $50A0, $5000, $5000, $5000, $5000, $5080, $5080, $5080, $5080, $5800, $5800, $5800, $5800
.skip
  dw $0140, $0140, $0140, $0140, $0000, $0000, $0000, $0000, $0100, $0100, $0100, $0100, $0000, $0000, $0000, $0000
.len
  dw $1EC0, $0EC0, $06C0, $1EC0, $2000, $1000, $0800, $2000, $1F00, $0F00, $0700, $1F00, $1000, $1000, $0800, $1000

Tbl:
  fillbyte $FF : fill $A00
  fillbyte $00 : fill $200
`;
}

export function layer3Entry(rom: Rom) {
  return listPatches(rom).find((p) => p.kind === 'layer3') ?? null;
}

function table(rom: Rom): number {
  if (rom.r8(GFX_HOOK) === 0x22) {
    const base = rom.r24(GFX_HOOK + 1) - 8;
    if (MAGIC.every((m, i) => rom.r8(base + i) === m)) return rom.r24(base + 4);
  }
  return missingPatch('Layer 3 graphics (SMWL)');
}

// needs Asar (loadAsar) to be loaded
export function installLayer3Patch(rom: Rom): ApplyResult {
  const e = layer3Entry(rom);
  if (e) return { ok: true, errors: [], warnings: [], prints: [], entry: e };
  installEditorPatch(rom);
  return applyPatch(rom, { name: LAYER3_PATCH_NAME, main: 'layer3gfx.asm', files: new Map([['layer3gfx.asm', asm(rom)]]), kind: 'layer3', ram: [LAYER3_GFX_RAM] });
}

// a level's layer 3 files: lt3 ($FF none) with its destination (0-3, LT3_DESTS) and size (0-2,
// LT3_SIZES); lg: LG1-LG4 ($FF the game's file 28-2B)
export interface Layer3Gfx { lt3: number; dest: number; size: number; lg: number[] }

export function levelLayer3(rom: Rom, n: number): Layer3Gfx {
  const t = table(rom), f = rom.r8(t + 0xa00 + n);
  return { lt3: rom.r8(t + n), dest: (f >> 2) & 3, size: Math.min(f & 3, 2), lg: [1, 2, 3, 4].map((k) => rom.r8(t + k * 0x200 + n)) };
}
export function setLevelLayer3(rom: Rom, n: number, g: Layer3Gfx): void {
  const t = table(rom);
  rom.w8(t + n, g.lt3);
  g.lg.forEach((v, k) => rom.w8(t + (k + 1) * 0x200 + n, v));
  rom.w8(t + 0xa00 + n, ((g.dest & 3) << 2) | (g.size & 3));
}

// the file each LG slot shows
export const lgFile = (g: Layer3Gfx, k: number) => (g.lg[k] === 0xff ? GAME_LAYER3_GFX + k : g.lg[k]);
// Lunar Magic's DDFF of the LT3 word, and back
export const lt3Nibble = (g: Pick<Layer3Gfx, 'dest' | 'size'>) => (g.dest << 2) | g.size;
export const fromLt3Nibble = (v: number) => ({ dest: (v >> 2) & 3, size: Math.min(v & 3, 2) });
