// Level heights: a horizontal level taller or shorter than the game's 27 rows, as Lunar Magic 3.00 has them
// (Vitor Vilela's level height hack in Lunar Magic). The level's size is a byte per level
// (LEVEL_SIZE_TABLE, Lunar Magic's TB0MMMMM); its height and screens share the game's 0x3800 bytes of
// level data (LEVEL_HEIGHTS, maxScreens in level.ts), a screen taking as many bytes as the level is high
// in pixels. Objects and sprites below row 31 are placed by subscreens of 32 rows (level.ts).
//
// The patch makes the game's own level load build such a level, which is what the editor shows:
//  - at the level's setup ($05D928, Y = the level) the screen size in bytes for the level's size (0 for
//    the game's); the sprite memory is the header's bits 4-0 (bit 5: Lunar Magic's new sprite format);
//  - per object ($0586BB, after the game took the screen's address from its table) the address from the
//    screen, the subscreen (the screen jump's low nibble of the second byte) and the high Y bit;
//  - where an object goes on to the next or previous screen ($0DA963, $0DA9D6, $0DA9EF, the places
//    Lunar Magic changes) the screen size instead of the game's $1B0;
//  - after the load ($058091) the size is cleared again: loads without the setup (the credits) are the game's.
// Playing such a level (camera, sprites, interaction) is not part of it yet.

import type { Rom } from './rom.ts';
import { LEVEL_SIZE_TABLE, LEVEL_HEIGHTS } from './level.ts';
import { LEVEL_HEIGHT_RAM } from './ram.ts';
import { applyPatch, type ApplyResult } from './patchapply.ts';
import { installEditorPatch } from './patches.ts';

export const LEVEL_HEIGHT_PATCH_NAME = 'Level heights (Lunar Magic format)';
const SETUP_HOOK = 0x05d928, POINTER_HOOK = 0x0586bb, RIGHT_HOOK = 0x0da963, BACK_HOOK = 0x0da9d6, ON_HOOK = 0x0da9ef, DONE_HOOK = 0x058091;
const hx = (v: number) => v.toString(16).toUpperCase();

export const LEVEL_HEIGHT_ASM = `asar 1.90
lorom
!Size = $${hx(LEVEL_HEIGHT_RAM[0])}      ; a screen's bytes in the level data (16-bit), 0: the game's
!Sub = !Size+2         ; subscreen of the objects that follow (screen jump)
!Table = $${hx(LEVEL_SIZE_TABLE)}

org !Table
  fillbyte $00 : fill 512

org $${hx(SETUP_HOOK)}   ; LDA $F200,y : AND #$C0 : CLC : ASL : ROL : ROL : STA $1BE3 (A 8, X/Y 16, Y = level)
  JSL Setup
  NOP #8

org $${hx(POINTER_HOOK)}   ; LDA $0A : AND #$10 : BEQ + : INC $6C : INC $6F (A 8, X/Y 8)
  JSL Pointer
  NOP #6

org $${hx(RIGHT_HOOK)}   ; $6B/$6E += $1B0 (A 8)
  JSL Right
  NOP #13

org $${hx(BACK_HOOK)}   ; $6B/$6E/$04 -= $1B0 (A 8), then DEC $1BA1 : RTS
  JSL Back
  NOP #17

org $${hx(ON_HOOK)}   ; $6B/$6E/$04 += $1B0 (A 8), then INC $1BA1 : RTS
  JSL On
  NOP #17

org $${hx(DONE_HOOK)}   ; LDA $0100 : CMP #$22 (after the level load)
  JSL Done
  NOP

freecode
Setup:
  PHX
  LDA $1692 : AND #$1F : STA $1692
  LDA #$00 : STA.l !Sub
  REP #$20
  TYX
  LDA.l !Table,x : AND #$001F : ASL : TAX
  LDA.l Sizes,x : STA.l !Size
  SEP #$20
  PLX
  LDA.w $F200,y : AND #$C0 : CLC : ASL : ROL : ROL : STA $1BE3   ; (data bank $05)
  RTL

Sizes:
  dw 0${LEVEL_HEIGHTS.slice(1).map((h) => `, $${hx(h)}`).join('')}

Pointer:
  REP #$20
  LDA.l !Size : BEQ .game
  SEP #$20
  LDA $1933 : BNE .game8
  LDA $5A : BNE +
  LDA $59 : CMP #$01 : BNE +   ; extended object $01: a screen jump
  LDA $0B : AND #$0F : STA.l !Sub
+ PHX
  LDA.l !Sub : AND #$0F : ASL : XBA : LDA #$00
  REP #$20                              ; subscreen * $200
  CLC : ADC #$C800
  LDX $1928
- DEX : BMI +
  CLC : ADC.l !Size
  BRA -
+ STA $6B : STA $6E
  PLX
.game
  SEP #$20
.game8
  LDA $0A : AND #$10 : BEQ +
  INC $6C : INC $6F
+ RTL

; the screen size: the level's, or the game's $1B0
ScreenSize:
  LDA.l !Size : BNE +
  LDA #$01B0
+ RTS

Right:
  REP #$20
  JSR ScreenSize
  CLC : ADC $6B : STA $6B : STA $6E
  SEP #$20
  RTL

Back:
  REP #$20
  JSR ScreenSize
  EOR #$FFFF : SEC : ADC $6B : STA $6B : STA $6E : STA $04
  SEP #$20
  RTL

On:
  REP #$20
  JSR ScreenSize
  CLC : ADC $6B : STA $6B : STA $6E : STA $04
  SEP #$20
  RTL

Done:
  REP #$20
  LDA #$0000 : STA.l !Size
  SEP #$20
  LDA $0100 : CMP #$22
  RTL
`;

export function installLevelHeightPatch(rom: Rom): ApplyResult {
  installEditorPatch(rom);
  return applyPatch(rom, { name: LEVEL_HEIGHT_PATCH_NAME, main: 'levelheight.asm', files: new Map([['levelheight.asm', LEVEL_HEIGHT_ASM]]), kind: 'levelheight', ram: [LEVEL_HEIGHT_RAM] });
}
