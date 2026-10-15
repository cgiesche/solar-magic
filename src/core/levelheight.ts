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
//
// Playing it, as Lunar Magic does (the RAM where it keeps them, the places it changes, observed in a Lunar
// Magic-saved ROM; the code is the editor's):
//  - the setup also sets the height in pixels ($13D7, for every level; the game's $1B0) and the screens'
//    Map16 addresses in bank 0's RAM ($0BF6-$0CF5); the game's mode tables of horizontal screen pointers
//    point there, so the tilemap, changing a tile and code finding a block the game's way follow the height;
//  - finding a block: the 27-row limit (CMP #$01B0) and the Y high byte limit (CMP #$02) follow the height,
//    the screens' address tables are read from RAM (Mario, sprites, line guides, bounce blocks, the cape,
//    extended sprites, wall-following sprites, sprites checking the block ahead); changing a tile ($00BEB0)
//    below row 31; a sprite is erased below the height instead of row 27;
//  - the camera goes down to the height less $F0;
//  - sprites load from Lunar Magic's new format ($FF V: subscreen V), the subscreen in their Y high byte;
//  - entrances: Mario at a tile (Lunar Magic's tile position) and the camera relative to him, the BG then
//    bottom-aligned with the level (the BG's height) or relative to the FG (SEC_HDR, SEC_ENT);
//  - Mario facing left and a water level, set for the main entrance, a secondary entrance or a secondary
//    screen exit (its w); a screen keeps its exit's flags 0000wush ($19D8, which community code such as
//    GPS's teleport routine writes too), and only s makes the level's exits secondary.
// The tilemap of such a level is SMWV's (vrampatch.ts): a window of 16 block rows built from the level data.

import type { Rom } from './rom.ts';
import { LEVEL_SIZE_TABLE, LEVEL_HEIGHTS, SEC_HDR, SEC_ENT } from './level.ts';
import { RAM, LEVEL_HEIGHT_RAM, LEVEL_HEIGHT, SCREEN_PTRS, LEVEL_MAX_Y, LEVEL_ROW_MASK, EXIT_FLAGS_RAM } from './ram.ts';
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
!MaxY = $${hx(LEVEL_MAX_Y)}        ; changing a tile: positions inside the level (16-bit, the game's $200)
!RowMask = $${hx(LEVEL_ROW_MASK)}     ; and a position's row bits (the game's $01F0)
!NewSpr = !Size+8      ; the level's sprite data is in Lunar Magic's new format (header bit 5)
!SprSub = !Size+9      ; loading sprites: the subscreen of the sprites that follow, * 2 (a Y high byte)
!Level = !Size+10      ; the level being loaded (16-bit)
!Ent = !Size+12        ; the secondary entrance it is entered by (16-bit)
!Tmp = !Size+14        ; (16-bit)
!Align = !Size+16      ; the BG's bottom + $8000 for CameraY to align layer 2 with (16-bit, 0: none)
!ExitFlags = $${hx(EXIT_FLAGS_RAM[0])}   ; the flags of the screen exit Mario left by (0000wush, w: water with s)
!Ent1 = $${hx(SEC_HDR[6])}       ; per level, Lunar Magic's: IWPXXtTT (W: water, P: the entrance at tile X/Y, XX: X bits 4-3)
!Ent2 = $${hx(SEC_HDR[7])}       ; OFYYYYYY (O: BG relative to FG, F: camera offset bit 4, Y: Y bits 9-4)
!Ent3 = $${hx(SEC_HDR[8])}       ; RL-ooooo (R: camera relative to Mario, L: face left, o: BG height - 1, or with O its offset)
!SecFE = $${hx(SEC_ENT[3])}       ; per secondary entrance: IPXXDAAA (P: at tile X/Y, XX: X bits 4-3)
!SecY = $${hx(SEC_ENT[4])}        ; EFYYYYYY (Lunar Magic's, at a place of its own: F camera offset bit 4, Y: Y bits 9-4)
!SecR = $${hx(SEC_ENT[5])}        ; RLW----- (R: camera relative to Mario, L: face left, W: water)
!Height = $${hx(LEVEL_HEIGHT)}       ; playing: the level's height in pixels, a screen's bytes (Lunar Magic's)
!Ptr = $${hx(SCREEN_PTRS[0])}          ; per screen: 3-byte pointers to the low bytes (Lunar Magic's place)
!PtrHi = !Ptr+$60      ; to the high bytes
!Lo = !Ptr+$C0         ; the addresses' low bytes
!Hi = !Ptr+$E0         ; and high bytes

org !Table
  fillbyte $00 : fill 512
org !Ent1 : fill 512
org !Ent2 : fill 512
org !Ent3 : fill 512
org !SecY : fill 512
org !SecR : fill 512

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

; where the game's checks below branch to when a position is outside the level
org $00BEBB : Out00BEBB:
org $0292C9 : Out0292C9:
org $0295AD : Out0295AD:
org $02A84B : Out02A84B:
org $02BA47 : Out02BA47:
org $02D148 : Out02D148:

; finding the block at a position: layer 1 of a horizontal level, below the game's 27 rows too
org $00F478 : CMP.w !Height          ; Mario: CMP #$01B0
org $00F492 : ADC.l !Lo,x
org $00F49A : ADC.l !Hi,x
org $0194D6 : CMP.w !Height          ; sprites
org $019500 : LDA.l !Lo,x
org $019512 : LDA.l !Hi,x
org $01D97B : ADC.l !Lo,x            ; line-guided sprites
org $01D981 : LDA.l !Hi,x
org $0292D9 : JSL YHi02 : BCS Out0292C9 ; bounce blocks (CMP #$02 : BCS : STA $02)
org $0292F9 : LDA.l !Lo,x
org $02930A : LDA.l !Hi,x
org $0295C0 : JSL YHi02 : BCS Out0295AD ; cape
org $0295EC : LDA.l !Lo,x
org $0295FD : LDA.l !Hi,x
org $02A6BA : LDA.l !Lo,x            ; extended sprites (no Y limit)
org $02A6CB : LDA.l !Hi,x
org $02BA50 : JSL YHi0D : BCS Out02BA47 ; wall-following sprites
org $02BA71 : LDA.l !Lo,x
org $02BA82 : LDA.l !Hi,x
org $02D15A : JSL YHi02 : BCS Out02D148 ; sprites that check the block in front of them
org $02D18C : LDA.l !Lo,x
org $02D19D : LDA.l !Hi,x
org $03D793 : ADC.w !Height          ; a screen further on

; changing a tile ($00BEB0) below the game's 32 rows
org $00BEEC : JSL TileBound : BCS Out00BEBB : NOP #2   ; CPY #$0200 : BCS : LDA $1933
org $00BF41 : JSL TileVram : NOP         ; LDA $9B : LSR : LDA $99 (then ROL: the VRAM address's row bit 5)
org $00C079 : JSL TileRow : NOP          ; LDA $98 : AND #$01F0 (A 16)
org $00C0C6 : JSL TileRow : NOP
org $00C1B1 : JSL TileRow : NOP
org $00C3D3 : JSL TileRow : NOP

; entrances (Lunar Magic's format): Mario at a tile (screen * 256 + X * 16, Y * 16), the camera relative to
; him (Y * 16 + offset * 16, the 5-bit offset from the FG and BG start settings), the BG then bottom-aligned
; with the level (or relative to the FG)
org $05D7E0 : JSL SecEntrance : NOP        ; LDY $0E : LDA $F800,y (Y = the secondary entrance)
org $05DA17 : JSL Entrance : NOP           ; SEP #$30 : LDA $13BF (both entrances set up)

; a screen keeps its exit's flags 0000wush (the game's only h), and only s makes the level's exits secondary
; (the game's $0B >> 1 would make w or u do it too); the places Lunar Magic changes
org $0DA532 : db $0F                       ; LDA $0B : AND #$01 : STA $19D8,x
org $0DA536 : AND #$02                     ; LDA $0B (then LSR : STA $1B93; A = $0B & $0F)
; Mario's direction and the water level, once the game's entrance action has set them up ($00A635, which
; clears $70-$93)
org $009708 : JSL Options                  ; LDA #$20 : STA $5E

; loading sprites from the level's data: Lunar Magic's new format ($FF V: the sprites that follow are in
; subscreen V, $FF $FE: the end, $FF $FF: a sprite starting with $FF); a sprite's Y high byte gets the subscreen
org $02A82E : JSL SprEntry : BEQ Out02A84B   ; LDA [$CE],y : CMP #$FF : BEQ (the list's end)
org $02A968 : JSL SprY                     ; LDA $00 : STA $E4,x (after the Y high byte $14D4,x)
org $02ABD0 : JSL ShooterY : NOP           ; AND #$01 : STA $1793,x
org $02AB54 : JSL GroupY : NOP             ; AND #$01 : STA $0FB8,y
org $02AA5F : JSL ClusterY : NOP           ; AND #$01 : STA $1E2A,x
org $02AF3D : JSL GenY                     ; AND #$01 : STA $09
org $02AFA7 : JSL GenY

; a sprite below the level is erased: the game's copies of the off-screen check test Y + $50 >= $200
org $01AC3E : JSL BelowLevel : NOP #8      ; LDA $D8,x : CLC : ADC #$50 : LDA $14D4,x : ADC #$00 : CMP #$02 (: BPL)
org $02D038 : JSL BelowLevel : NOP #8
org $03B86A : JSL BelowLevel : NOP #8

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
  LDA $1692 : AND #$20 : STA.l !NewSpr
  LDA $1692 : AND #$1F : STA $1692
  LDA #$00 : STA.l !Sub
  REP #$20
  TYA : STA.l !Level
  TYX
  LDA.l !Table,x : AND #$001F : ASL : TAX
  LDA.l Sizes,x : STA.l !Size
  BNE + : LDA #$01B0 : +
  STA !Height
  CLC : ADC #$00FF : XBA : SEP #$20 : STA.l !MaxHi : REP #$20
  LDA #$0200 : STA.l !MaxY : LDA #$01F0 : STA.l !RowMask
  LDA !Height : CMP #$0201 : BCC +
  STA.l !MaxY : LDA #$FFF0 : STA.l !RowMask
+
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

; Y (16 bit) = the position along the screens' rows: carry set when it is outside the level; then the
; game's LDA $1933 (A 8)
TileBound:
  REP #$20 : TYA : CMP.l !MaxY
  LDA #$0000 : SEP #$20                    ; the high byte 0, as the game's (a 16-bit TAX follows)
  LDA.l $7E1933
  RTL
; the tilemap holds rows modulo 64: only bit 0 of the Y high byte goes into the address (A 8)
TileVram:
  LDA $9B : LSR
  LDA $99 : AND #$01                       ; (carry kept)
  RTL
; the row bits of Y position $98 (A 16)
TileRow:
  LDA $98 : AND.l !RowMask
  RTL

; the secondary entrance (A 8, X/Y 16, data bank $05): kept, then the game's LDY $0E : LDA $F800,y. A's
; high byte stays the game's 0: its code takes table indexes with a 16-bit TAX
SecEntrance:
  LDA.l $7E${hx(RAM.screenExitHi)},x : STA.l !ExitFlags       ; X = the screen Mario left by
  LDY $0E
  REP #$20 : TYA : STA.l !Ent : LDA #$0000 : SEP #$20
  LDA $F800,y
  RTL

; both entrances set up (Mario $94-$97, camera $1C, BG $20 from the game's tables): Lunar Magic's tile
; position and relative camera; then the game's SEP #$30 : LDA $13BF
Entrance:
  PHP
  REP #$30
  LDA #$0000 : STA.l !Align
  LDA $1B93 : AND #$00FF : BNE +
  JMP .main
+
  ; a secondary entrance: P, XX in $05FE00, xxx in $05FC00, Y bits 9-4 in !SecY, yyyy in $05FA00
  LDA.l !Ent : TAX
  LDA.l !SecFE,x : AND #$0040 : BEQ +
  LDA.l !SecFE,x : AND #$0030 : LSR : STA.l !Tmp
  LDA.l $05FC00,x : AND #$00E0 : LSR #5 : ORA.l !Tmp : TAY
  LDA.l !SecY,x : AND #$003F : ASL #4 : STA.l !Tmp
  LDA.l $05FA00,x : AND #$000F : ORA.l !Tmp
  JSR TilePos
+ LDA.l !SecR,x : AND #$0080 : BNE +
  JMP .done
+
  ; offset: F (!SecY bit 6), ff ($05FA00 bits 5-4), bb ($05FA00 bits 7-6)
  LDA.l !SecY,x : AND #$0040 : LSR #2 : STA.l !Tmp
  LDA.l $05FA00,x : AND #$0030 : LSR #2 : ORA.l !Tmp : STA.l !Tmp
  LDA.l $05FA00,x : AND #$00C0 : ASL #2 : XBA : ORA.l !Tmp
  JSR Relative
  BRA .done
.main
  ; the main entrance: P, XX in !Ent1, xxx in $05F200, Y bits 9-4 in !Ent2, yyyy in $05F000
  LDA.l !Level : TAX
  LDA.l !Ent1,x : AND #$0020 : BEQ +
  LDA.l !Ent1,x : AND #$0018 : STA.l !Tmp
  LDA.l $05F200,x : AND #$0007 : ORA.l !Tmp : TAY
  LDA.l !Ent2,x : AND #$003F : ASL #4 : STA.l !Tmp
  LDA.l $05F000,x : AND #$000F : ORA.l !Tmp
  JSR TilePos
+ LDA.l !Ent3,x : AND #$0080 : BEQ .done
  ; offset: F (!Ent2 bit 6), ff, bb ($05F400 bits 3-0)
  LDA.l !Ent2,x : AND #$0040 : LSR #2 : STA.l !Tmp
  LDA.l $05F400,x : AND #$000F : ORA.l !Tmp
  JSR Relative
.done
  PLP
  SEP #$30 : LDA $13BF
  RTL

; Mario faces left ($76 = 0) and the level is a water level ($85 = 1) as the entrance sets: the main
; entrance's (also the midway point's), or a secondary entrance's or the screen exit's water (!Ent and
; !ExitFlags from SecEntrance) (A 8, X/Y 8); then the game's LDA #$20 : STA $5E
Options:
  PHP
  REP #$30 : PHX
  LDA.l $7E${hx(RAM.useSecondaryExit)} : AND #$00FF : BEQ .main
  LDA.l !Ent : TAX
  SEP #$20
  LDA.l !ExitFlags : AND #$08 : BNE .water
  LDA.l !SecR,x : AND #$20 : BEQ .dry
.water
  LDA #$01 : STA $${hx(RAM.waterLevel)}
.dry
  LDA.l !SecR,x
  BRA .face
.main
  LDA.l !Level : TAX
  SEP #$20
  LDA.l !Ent1,x : AND #$40 : BEQ +
  LDA #$01 : STA $${hx(RAM.waterLevel)}
+ LDA.l !Ent3,x
.face
  AND #$40 : BEQ +
  STZ $${hx(RAM.marioDir)}
+ PLX
  PLP
  LDA #$20 : STA $5E
  RTL

; Mario at tile X = Y, Y = A of the entrance's screen ($95, or $97 in a vertical level) (A/X/Y 16; X kept)
TilePos:
  ASL #4 : STA.l !Tmp
  TYA : ASL #4 : TAY
  LDA $5B : AND #$0001 : BNE .vert
  LDA $95 : AND #$00FF : XBA : PHA
  TYA : CLC : ADC $01,s : STA $94
  PLA
  LDA.l !Tmp : STA $96
  RTS
.vert
  STY $94
  LDA $97 : AND #$00FF : XBA : CLC : ADC.l !Tmp : STA $96
  RTS

; the camera relative to Mario: Y + 16 * the 5-bit signed offset A, inside the level; the BG to match
; (A/X/Y 16; X = !Level after it: the BG settings are the level's, also for a secondary entrance)
Relative:
  PHA
  LDA $5B : AND #$0003 : BEQ +                 ; horizontal levels only (layer 2 not vertical either)
  PLA
  RTS
+ PLA
  AND #$001F : CMP #$0010 : BCC + : ORA #$FFE0 : +
  ASL #4 : CLC : ADC $96 : BPL + : LDA #$0000 : +
  PHA
  LDA !Height : SEC : SBC #$00F0 : CMP $01,s : BCS + : STA $01,s : +
  PLA : STA $1C
  ; the BG: with O, the FG's position + 16 * the signed offset ($10: absolute 0); else it shows its bottom
  ; (its height - $F0) when the camera is at the level's bottom: CameraY sets layer 2's offset for that
  LDA.l !Level : TAX
  LDA.l !Ent2,x : AND #$0080 : BEQ .bottom
  LDA.l !Ent3,x : AND #$001F : CMP #$0010 : BNE +
  LDA #$0000 : STA $20 : RTS
+ CMP #$0010 : BCC + : ORA #$FFE0 : +
  ASL #4 : CLC : ADC $1C : STA $20
  RTS
.bottom
  LDA.l !Ent3,x : AND #$001F : INC : ASL #4 : SEC : SBC #$00F0
  CLC : ADC #$8000 : STA.l !Align
  RTS

; the sprite list's entry at Y (A/X/Y 8): A = its first byte (Z clear), or Z set at the end. Lunar Magic's
; markers are skipped, a subscreen marker taken; the list's first entry (X 0, Y 1) starts in subscreen 0
SprEntry:
  CPY #$01 : BNE .read
  CPX #$00 : BNE .read
  LDA #$00 : STA.l !SprSub
.read
  LDA [$CE],y : CMP #$FF : BNE .r
  LDA.l !NewSpr : BEQ .end
  INY : LDA [$CE],y
  CMP #$FE : BEQ .end
  CMP #$FF : BEQ .r                        ; a sprite whose first byte is $FF (A = $FF, Z clear)
  ASL : STA.l !SprSub
  INY : BRA .read
.end
  LDA #$00
.r
  RTL

; sprite X (A 8): A = 0 (N clear) when it is below the level, $80 otherwise (above it too)
BelowLevel:
  LDA $14D4,x : XBA : LDA $D8,x
  REP #$20
  BMI .no
  CMP.l $7E0000+!Height : BCS .yes
.no
  SEP #$20 : LDA #$80
  RTL
.yes
  SEP #$20 : LDA #$00
  RTL

; the spawned sprite's Y high byte from its subscreen, then the game's LDA $00 : STA $E4,x
SprY:
  LDA.l !SprSub : CLC : ADC $14D4,x : STA $14D4,x
  LDA $00 : STA $E4,x
  RTL
ShooterY:
  AND #$01 : CLC : ADC.l !SprSub : STA $1793,x
  RTL
GroupY:
  AND #$01 : CLC : ADC.l !SprSub : STA $0FB8,y
  RTL
ClusterY:
  AND #$01 : CLC : ADC.l !SprSub : STA $1E2A,x
  RTL
GenY:
  AND #$01 : CLC : ADC.l !SprSub : STA $09
  RTL

; A 16, X 8: the camera's lowest Y for the game's vertical scroll ($00F7F4, which ends with RTS)
CameraY:
  LDA.l !Align : BEQ .limit
  ; the first time after the level load (the game has set layer 2's offset $1417, A796): layer 2's position
  ; at the level's bottom with no offset, by the code that moves it each frame (the game's, or l2scroll.ts's
  ; for its rates), gives the offset that puts the BG's bottom there
  PHP
  SEP #$10                                     ; X/Y 8, as the layer 2 code wants
  LDA $1C : PHA
  LDA $1462 : PHA : LDA $1464 : PHA : LDA $1466 : PHA : LDA $1468 : PHA
  LDA $9D : PHA
  SEP #$20 : LDA #$01 : STA $9D : REP #$20     ; paused: an auto-scroll doesn't move on
  LDA.l $7E0000+!Height : SEC : SBC #$00F0 : STA $1C
  STZ $1417
  PHK : PEA.w .moved-1 : PHB
  JML $00F79D                                  ; to its PLB : RTL at $00F7F2
.moved
  REP #$20
  LDA.l !Align : SEC : SBC #$8000 : SEC : SBC $20 : STA $1417
  LDA #$0000 : STA.l !Align
  PLA : STA $9D
  PLA : STA $1468 : PLA : STA $1466 : PLA : STA $1464 : PLA : STA $1462
  PLA : STA $1C
  PLP
.limit
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
  return applyPatch(rom, { name: LEVEL_HEIGHT_PATCH_NAME, main: 'levelheight.asm', files: new Map([['levelheight.asm', LEVEL_HEIGHT_ASM]]), kind: 'levelheight', ram: [LEVEL_HEIGHT_RAM, EXIT_FLAGS_RAM, [0x7e0000 | LEVEL_HEIGHT, 2], [0x7e0000 | SCREEN_PTRS[0], SCREEN_PTRS[1]]] });
}
