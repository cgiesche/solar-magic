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
import { LEVEL_HEIGHT_RAM, LEVEL_HEIGHT, SCREEN_PTRS } from './ram.ts';
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
!MaxHi = !Size+3       ; playing: Y high bytes inside the level (the game's 2)
!Height = $${hx(LEVEL_HEIGHT)}       ; playing: the level's height in pixels, a screen's bytes (Lunar Magic's)
!Ptr = $${hx(SCREEN_PTRS[0])}          ; per screen: 3-byte pointers to the low bytes (Lunar Magic's place)
!PtrHi = !Ptr+$60      ; to the high bytes
!Lo = !Ptr+$C0         ; the addresses' low bytes
!Hi = !Ptr+$E0         ; and high bytes

org !Table
  fillbyte $00 : fill 512

; the game's mode tables of a horizontal layer's screen pointers (tilemap columns, changing a tile, and code
; that finds a block the same way) point to the tables in RAM, which the setup builds for every level
!m = 0
while !m < 32
  if read2($00BDA8+!m*2) == $BAD8
    org $00BDA8+!m*2 : dw !Ptr
    org $00BDE8+!m*2 : dw !Ptr+$30
    org $00BE28+!m*2 : dw !PtrHi
    org $00BE68+!m*2 : dw !PtrHi+$30
  endif
  !m #= !m+1
endwhile

; finding the block at a position: layer 1 of a horizontal level, below the game's 27 rows too
org $00F478 : CMP.w !Height          ; Mario: CMP #$01B0
org $00F492 : ADC.l !Lo,x
org $00F49A : ADC.l !Hi,x
org $0194D6 : CMP.w !Height          ; sprites
org $019500 : LDA.l !Lo,x
org $019512 : LDA.l !Hi,x
org $01D97B : ADC.l !Lo,x            ; line-guided sprites
org $01D981 : LDA.l !Hi,x
org $0292D9 : JSL YHi02 : BCS $0292C9 ; bounce blocks (CMP #$02 : BCS : STA $02)
org $0292F9 : LDA.l !Lo,x
org $02930A : LDA.l !Hi,x
org $0295C0 : JSL YHi02 : BCS $0295AD ; cape
org $0295EC : LDA.l !Lo,x
org $0295FD : LDA.l !Hi,x
org $02A6BA : LDA.l !Lo,x            ; extended sprites (no Y limit)
org $02A6CB : LDA.l !Hi,x
org $02BA50 : JSL YHi0D : BCS $02BA47 ; wall-following sprites
org $02BA71 : LDA.l !Lo,x
org $02BA82 : LDA.l !Hi,x
org $02D15A : JSL YHi02 : BCS $02D148 ; sprites that check the block in front of them
org $02D18C : LDA.l !Lo,x
org $02D19D : LDA.l !Hi,x
org $03D793 : ADC.w !Height          ; a screen further on

; the camera's lowest position in a horizontal level: the height less $F0 (the game's $C0)
org $00F70D   ; LDA #$00C0 : JSR $F7F4 (A 16)
  JSL CameraY
  NOP #2

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
  REP #$20 : PHA : SEP #$20   ; the game's high byte of A (the entrance code below takes X from TAX)
  LDA $1692 : AND #$1F : STA $1692
  LDA #$00 : STA.l !Sub
  REP #$20
  TYX
  LDA.l !Table,x : AND #$001F : ASL : TAX
  LDA.l Sizes,x : STA.l !Size
  BNE + : LDA #$01B0 : +
  STA !Height
  CLC : ADC #$00FF : XBA : SEP #$20 : STA.l !MaxHi : REP #$20
  JSR Screens
  PLA
  SEP #$20
  PLX
  LDA.w $F200,y : AND #$C0 : CLC : ASL : ROL : ROL : STA $1BE3   ; (data bank $05)
  RTL

; the screens' Map16 addresses in the level data, each !Height bytes after the one before (A 16, X/Y 16,
; data bank $05: low RAM)
Screens:
  PHY
  LDX #$0000 : TXY
  LDA #$C800
- STA !Ptr,x : STA !PtrHi,x
  SEP #$20
  STA !Lo,y : XBA : STA !Hi,y : XBA
  PHA : LDA #$7E : STA !Ptr+2,x : INC : STA !PtrHi+2,x : PLA
  REP #$20
  CLC : ADC !Height
  INX #3 : INY
  CPY #$0020 : BCC -
  PLY
  RTS

; A (8 bit) = the Y high byte of a position: carry set when it is below the level; stored as the game's
; code does after its CMP #$02 (A 8)
YHi02:
  CMP.l !MaxHi : STA $02
  RTL
YHi0D:
  CMP.l !MaxHi : STA $0D
  RTL

; A 16, X 8: the camera's lowest Y for the game's vertical scroll ($00F7F4, which ends with RTS)
CameraY:
  LDA.l $7E0000+!Height : SEC : SBC #$00F0
  PHK : PEA.w .back-1
  PEA.w $F7F3-1          ; RTL at $00F7F3
  JML $00F7F4
.back
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
  return applyPatch(rom, { name: LEVEL_HEIGHT_PATCH_NAME, main: 'levelheight.asm', files: new Map([['levelheight.asm', LEVEL_HEIGHT_ASM]]), kind: 'levelheight', ram: [LEVEL_HEIGHT_RAM, [0x7e0000 | LEVEL_HEIGHT, 2], [0x7e0000 | SCREEN_PTRS[0], SCREEN_PTRS[1]]] });
}
