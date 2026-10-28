// VRAM layout patch ("SMWV"), like Lunar Magic's: in levels, the layer 1 and layer 2 tilemaps move
// from 64x64 at VRAM $2000/$3000 to 64x32 at $3000/$3800 (BG1SC = $31, BG2SC = $39), which frees
// $2000-$2FFF for the BG2/BG3 graphics slots (tiles 200-2FF).
//
// A 64x32 tilemap holds 32 of the 54 tile rows of a horizontal level. All 54 rows of both layers are
// kept in a RAM shadow ($7F0000, filled right after the game builds a column); the tilemap holds a
// window of 32 rows around the camera and rows are copied in from the shadow as the camera moves
// vertically. Vertical levels already stream rows: there only the look-ahead shrinks from 8 to 1 block
// (the tilemap holds 16 block rows) and addresses are mapped. Single tile changes (stripes) go to the
// shadow and, inside the window, to VRAM. Everything else (overworld, title, credits) is unchanged:
// the layout is only switched on by the level load (game mode $12), not in boss/mode 7 rooms.
//
// A horizontal level taller than the game's 27 rows (levelheight.ts: its height in $13D7, its screens'
// Map16 addresses at $0CB6/$0CD6) doesn't fit a shadow: its layer 1 window is 16 block rows, built from
// the level data. Each frame the window follows the camera (block row Y/16 - 1) and the rows that enter
// it are built for the 32 block columns around the camera ($7F0000, two at most per frame) and uploaded
// in the NMI after the column; a column is built from the window's first row on (the game's builder
// with its screen pointers moved down, so any hook in it, like the Map16 extension's, still applies).

import { Rom } from './rom.ts';
import { applyPatch, type ApplyResult } from './patchapply.ts';
import { listPatches } from './patchreg.ts';
import { setVramPatchCheck } from './patches.ts';
import { LEVEL_HEIGHT } from './ram.ts';

const hx = (v: number) => v.toString(16).toUpperCase();

export const VRAM_PATCH_NAME = 'VRAM layout (SMWV)';

export const VRAM_ASM = `asar 1.90
lorom
!Act  = $7F3602      ; 1: remapped layout active (set by the level load)
!Win1 = $7F3600      ; first row of the layer 1 window (0-63, rows modulo 64 like the game's tilemap), $FF = not set
!Win2 = $7F3601
!Sh1  = $7F0000      ; 54 rows x 64 columns x 2 bytes
!Sh2  = $7F1B00
!DA   = $7F3610      ; DMA arguments: VRAM address, source, bank, length, VMAIN
!DS   = $7F3612
!DB   = $7F3614      ; (bank and VMAIN are written together as one word)
!DM   = $7F3615
!DL   = $7F3616
!CB   = $7F361A      ; column upload: VRAM base, buffer, window
!CS   = $7F361C
!CW   = $7F361E
!RB   = $7F3620      ; row upload: VRAM base of the layer, shadow base
!RS   = $7F3622
!SP   = $7F3630      ; stripes: pointer (3 bytes), then 2-byte values
!SY   = $7F3634
!SA   = $7F3636
!SF   = $7F3638
!SN   = $7F363A
!SW   = $7F363C
!SK   = $7F363E
!SV   = $7F3640
!TW   = $7F3642      ; PutWord: tile word, relative address, tilemap base, window, row, offset
!TA   = $7F3644
!TB   = $7F3646
!TC   = $7F3648
!TD   = $7F364A
!TE   = $7F364C
!TT   = $7F364E      ; Stream: target row, map row
!TM   = $7F3650
!TW0  = $7F3652      ; ColUp: window
!Tall = $7F3654      ; 1: layer 1 is a horizontal level taller than 27 rows (window built from the level)
!TB0  = $7F0200      ; tall: the window's first block row (16-bit; the shadow of layer 1 is free)
!CB0  = $7F0202      ; the first block row of the column built this frame
!RQ   = $7F0204      ; rows built for the NMI (0-2)
!RR   = $7F0206      ; their block rows (2 words)
!RB0  = $7F020A      ; row build: block row, column, columns left, buffer offset, address
!RC   = $7F020C
!RN   = $7F020E
!RX   = $7F0210
!RA   = $7F0212
!Row  = $7F0000      ; built rows: $100 bytes each, 64 tiles of the upper then the lower tile row
!Height = $${hx(LEVEL_HEIGHT)}   ; the level's height in pixels (Lunar Magic's, set by the level heights patch)

; tilemap registers: set by the common PPU setup, switch on in the level load only
org $008A7F
  JSL SetSC
  NOP #6

; NMI tilemap upload (also called by the level load loop)
org $0087AD
  JML Nmi
  NOP

; stripe upload (single tile changes)
org $0085E3
  JSL Stripe
  NOP

; column builders: copy the built column into the shadow
org $058730
  JSL Build1Frame
org $058770
  JSL Build2Frame
org $0580BF
  JSL Build1Load
org $0580C3
  JSL Build2Load

; tall level: the window follows the camera each frame (before the game builds a column)
org $0586F7   ; SEP #$20 : LDA $5B
  JSL TallFrame

; tall level: a layer 1 column from the window's first row on (A 8, after the screen pointers $6B/$6E)
org $058A3A   ; SEP #$10 : LDY #$0D
  JSL TallColumn

; level load loop: vertical layers start 31 rows before the last one
org $0580B0
  JSL LoadStart1
org $0580B4
  JSL LoadStart2

; vertical layers: build 1 block above / 15 below the camera instead of 8 / 23. The tilemap holds 16
; block rows: the two edge rows share a slot, but only one of them can be on screen (rows c..c+14)
org $0587D4
  JSL VTop
org $0587DB
  JSL VBot
org $05880B
  JSL VTop
org $058812
  JSL VBot

freecode cleaned
db "SMWV"

; boss/mode 7 rooms ($0D9B != 0, already set here) build their own VRAM layout: left alone
SetSC:
  LDA $0100 : CMP #$12 : BNE .van
  LDA $0D9B : BNE .van
  LDA #$31 : STA $2107
  LDA #$39 : STA $2108
  LDA #$01 : STA.l !Act
  LDA #$FF : STA.l !Win1 : STA.l !Win2
  LDA #$00 : STA.l !Tall
  RTL
.van
  LDA #$23 : STA $2107
  LDA #$33 : STA $2108
  LDA #$00 : STA.l !Act : STA.l !Tall
  RTL

; ---------------------------------------------------------------- vertical look-ahead
VTop:
  PHA
  LDA.l !Act : AND #$00FF : BEQ +
  PLA : SEC : SBC #$0001 : RTL
+ PLA : SEC : SBC #$0008 : RTL
VBot:
  PHA
  LDA.l !Act : AND #$00FF : BEQ +
  PLA : CLC : ADC #$000F : RTL
+ PLA : CLC : ADC #$0017 : RTL

LoadStart1:
  PHP : SEP #$20
  LDA.l !Act : BEQ .v
  LDA $5B : AND #$01 : BEQ .v
  REP #$20 : LDA $47 : SEC : SBC #$001F : STA $47 : PLP : RTL
.v
  REP #$20 : LDA $45 : STA $47 : PLP : RTL
LoadStart2:
  PHP : SEP #$20
  LDA.l !Act : BEQ .v
  LDA $5B : AND #$02 : BEQ .v
  REP #$20 : LDA $4B : SEC : SBC #$001F : STA $4B : PLP : RTL
.v
  REP #$20 : LDA $49 : STA $4B : PLP : RTL

; ---------------------------------------------------------------- shadow copy after a column build
Build1Frame:
  JSL $85881A
  BRA Copy1
Build1Load:
  JSL $8588EC
Copy1:
  PHP : SEP #$30
  LDA.l !Act : BEQ .no
  LDA.l !Tall : BNE .no
  LDA $5B : AND #$01 : BNE .no
  LDA $1BE4 : BNE .go
.no
  JMP .done
.go
  REP #$30
  LDA $1BE4 : XBA : PHA
  AND #$001F : ASL : STA $00
  PLA : AND #$0400 : LSR #4 : ORA $00 : TAX     ; X = column * 2 (0-126)
  !i = 0
  while !i < 54                                 ; unrolled: 2 words per row
    LDA $1BE6+(!i*2) : STA.l !Sh1+(!i*128),x
    LDA $1C66+(!i*2) : STA.l !Sh1+2+(!i*128),x
    !i #= !i+1
  endwhile
.done
  PLP : RTL

Build2Frame:
  JSL $858883
  BRA Copy2
Build2Load:
  JSL $858955
Copy2:
  PHP : SEP #$30
  LDA.l !Act : BEQ .no
  LDA $5B : AND #$02 : BNE .no
  LDA $1CE6 : BNE .go
.no
  JMP .done
.go
  REP #$30
  LDA $1CE6 : XBA : PHA
  AND #$001F : ASL : STA $00
  PLA : AND #$0400 : LSR #4 : ORA $00 : TAX
  !i = 0
  while !i < 54                                 ; unrolled: 2 words per row
    LDA $1CE8+(!i*2) : STA.l !Sh2+(!i*128),x
    LDA $1D68+(!i*2) : STA.l !Sh2+2+(!i*128),x
    !i #= !i+1
  endwhile
.done
  PLP : RTL

; ---------------------------------------------------------------- DMA helper (channel 1, like the game)
VDMA:
  PHP : SEP #$20
  LDA.l !DM : STA $2115
  LDA.l !DA : STA $2116 : LDA.l !DA+1 : STA $2117
  LDA #$01 : STA $4310 : LDA #$18 : STA $4311
  LDA.l !DS : STA $4312 : LDA.l !DS+1 : STA $4313 : LDA.l !DB : STA $4314
  LDA.l !DL : STA $4315 : LDA.l !DL+1 : STA $4316
  LDA #$02 : STA $420B
  PLP : RTS

; ---------------------------------------------------------------- NMI upload
Nmi:
  SEP #$30
  LDA.l !Act : BNE .act
  LDA $1BE4 : JML $8087B2
.act
  JSR Stream1
  JSR Stream2
  LDA $1BE4 : BEQ .l2
  LDA $5B : AND #$01 : BNE .v1
  REP #$30
  LDA $1BE4 : XBA : AND #$041F : ORA #$3000 : STA.l !CB
  LDA #$1BE6 : STA.l !CS
  SEP #$20 : LDA.l !Tall : BEQ +
  REP #$20 : JSR TallCol
  BRA .l2
+ LDA.l !Win1 : STA.l !CW : REP #$20
  JSR ColPair
  BRA .l2
.v1
  REP #$30
  LDA $1BE4 : XBA : AND #$07FF : ORA #$3000 : STA.l !CB
  LDA #$1BE6 : STA.l !CS
  JSR RowPair
.l2
  SEP #$30
  STZ $1BE4
  LDA.l !Tall : BEQ +
  JSR TallRows
  SEP #$30
+ LDA $1CE6 : BEQ .end
  LDA $5B : AND #$02 : BNE .v2
  REP #$30
  LDA $1CE6 : XBA : AND #$041F : ORA #$3800 : STA.l !CB
  LDA #$1CE8 : STA.l !CS
  SEP #$20 : LDA.l !Win2 : STA.l !CW : REP #$20
  JSR ColPair
  BRA .end
.v2
  REP #$30
  LDA $1CE6 : XBA : AND #$07FF : ORA #$3800 : STA.l !CB
  LDA #$1CE8 : STA.l !CS
  JSR RowPair
.end
  SEP #$30
  STZ $1CE6
  RTL

; a 16px column (2 tile columns of 54 rows at !CS and !CS+$80) into the window !CW (A/X/Y 16 bit)
ColPair:
  JSR ColUp
  LDA.l !CB : INC : STA.l !CB
  LDA.l !CS : CLC : ADC #$0080 : STA.l !CS
  JSR ColUp
  RTS
ColUp:
  ; rows 0-31 (buffer +0, map rows = rows): W < 32 → rows W-31, else rows 0..W-33
  LDA.l !CW : AND #$00FF : STA.l !TW0
  CMP #$0020 : BCS +
  STA.l !TA : LDA #$0020 : STA.l !TB : BRA ++
+ LDA #$0000 : STA.l !TA : LDA.l !TW0 : SEC : SBC #$0020 : STA.l !TB
++
  LDA #$0000 : STA.l !TC : JSR ColPiece
  ; rows 32-53 (buffer +64, map rows = rows - 32): W < 32 → rows 32..min(W+31, 53), else rows W..53
  LDA.l !TW0 : CMP #$0020 : BCS +
  LDA #$0020 : STA.l !TA : LDA.l !TW0 : CLC : ADC #$0020 : CMP #$0036 : BCC ++ : LDA #$0036 : ++ : STA.l !TB : BRA +++
+ STA.l !TA : LDA #$0036 : STA.l !TB
+++
  LDA #$0020 : STA.l !TC : JSR ColPiece
  RTS
; rows !TA..!TB-1 of the column at !CS (half starting at row !TC) → VRAM !CB (A/X/Y 16 bit)
ColPiece:
  LDA.l !TB : SEC : SBC.l !TA : BEQ .r : BMI .r
  ASL : STA.l !DL
  LDA.l !TA : ASL : CLC : ADC.l !CS : STA.l !DS
  LDA.l !TA : SEC : SBC.l !TC : ASL #5 : CLC : ADC.l !CB : STA.l !DA
  LDA #$8100 : STA.l !DB                      ; bank $00, VMAIN $81
  JSR VDMA
.r
  RTS

; a block row of a vertical layer (2 tile rows x 64 tiles at !CS) to its mapped address !CB (16 bit)
RowPair:
  LDA #$8000 : STA.l !DB                      ; bank $00, VMAIN $80
  LDA #$0040 : STA.l !DL
  LDA.l !CB : STA.l !DA
  LDA.l !CS : STA.l !DS : JSR VDMA
  LDA.l !CB : CLC : ADC #$0400 : STA.l !DA
  LDA.l !CS : CLC : ADC #$0040 : STA.l !DS : JSR VDMA
  LDA.l !CB : CLC : ADC #$0020 : STA.l !DA
  LDA.l !CS : CLC : ADC #$0080 : STA.l !DS : JSR VDMA
  LDA.l !CB : CLC : ADC #$0420 : STA.l !DA
  LDA.l !CS : CLC : ADC #$00C0 : STA.l !DS : JSR VDMA
  RTS

; ---------------------------------------------------------------- window follows the camera
; T = clamp(camera Y / 8 - 1, 0, 22); up to 8 rows per call are copied in from the shadow
Stream1:
  LDA $5B : AND #$01 : BEQ +
  RTS
+ LDA.l !Tall : BEQ +
  RTS
+
  REP #$30
  LDA $1C : JSR Target
  STA.l !TT
  LDA #$3000 : STA.l !RB
  LDA #!Sh1 : STA.l !RS
  SEP #$20
  LDA.l !Win1 : CMP #$FF : BNE +
  LDA.l !TT : STA.l !Win1 : BRA .r
+ LDX #$0008
.lp
  LDA.l !TT : SEC : SBC.l !Win1 : AND #$3F : BEQ .r
  CMP #$20 : BCS .up
  ; down: row W+32 enters at map row W, W+1
  REP #$20 : LDA.l !Win1 : AND #$003F : STA.l !TM : CLC : ADC #$0020 : AND #$003F : JSR RowUp : SEP #$20
  LDA.l !Win1 : INC : AND #$3F : STA.l !Win1
  DEX : BNE .lp
  BRA .r
.up
  ; up: W-1, row W-1 enters at map row W-1
  LDA.l !Win1 : DEC : AND #$3F : STA.l !Win1
  REP #$20 : AND #$003F : STA.l !TM : JSR RowUp : SEP #$20
  DEX : BNE .lp
.r
  SEP #$30
  RTS

Stream2:
  LDA $5B : AND #$02 : BEQ +
  RTS
+
  REP #$30
  LDA $20 : JSR Target
  STA.l !TT
  LDA #$3800 : STA.l !RB
  LDA #!Sh2 : STA.l !RS
  SEP #$20
  LDA.l !Win2 : CMP #$FF : BNE +
  LDA.l !TT : STA.l !Win2 : BRA .r
+ LDX #$0008
.lp
  LDA.l !TT : SEC : SBC.l !Win2 : AND #$3F : BEQ .r
  CMP #$20 : BCS .up
  ; down: row W+32 enters at map row W, W+1
  REP #$20 : LDA.l !Win2 : AND #$003F : STA.l !TM : CLC : ADC #$0020 : AND #$003F : JSR RowUp : SEP #$20
  LDA.l !Win2 : INC : AND #$3F : STA.l !Win2
  DEX : BNE .lp
  BRA .r
.up
  ; up: W-1, row W-1 enters at map row W-1
  LDA.l !Win2 : DEC : AND #$3F : STA.l !Win2
  REP #$20 : AND #$003F : STA.l !TM : JSR RowUp : SEP #$20
  DEX : BNE .lp
.r
  SEP #$30
  RTS

; A (16 bit) = camera Y → first window row: (Y / 8 - 1) mod 64
Target:
  CMP #$8000 : ROR : CMP #$8000 : ROR : CMP #$8000 : ROR     ; arithmetic shift right by 3
  DEC : AND #$003F
  RTS

; level row A of the shadow !RS → map row !TM of the tilemap at !RB (A 16 bit)
RowUp:
  CMP #$0036 : BCC +
  RTS
+ PHX
  XBA : LSR : AND #$FF80 : CLC : ADC.l !RS : STA.l !DS   ; row * 128
  LDA #$807F : STA.l !DB                               ; bank $7F, VMAIN $80
  LDA #$0040 : STA.l !DL
  LDA.l !TM : AND #$001F : ASL #5 : CLC : ADC.l !RB : STA.l !DA
  JSR VDMA
  LDA.l !DS : CLC : ADC #$0040 : STA.l !DS
  LDA.l !DA : CLC : ADC #$0400 : STA.l !DA
  JSR VDMA
  PLX
  RTS

; ---------------------------------------------------------------- tall horizontal levels
; A (16 bit) = the window's first block row for the camera: Y/16 - 1, inside the level (A/X/Y 16)
TallTarget:
  LDA $1C : BPL + : LDA #$0000
+ LSR #4 : DEC : BPL + : LDA #$0000
+ PHA
  LDA !Height : LSR #4 : SEC : SBC #$0010 : BPL + : LDA #$0000
+ CMP $01,s : BCS +
  STA $01,s
+ PLA
  RTS

; per frame, before the game's column check: rows that enter the window are built (at most two until
; the NMI took them); replaces SEP #$20 : LDA $5B
TallFrame:
  PHP
  SEP #$20
  LDA.l !Tall : BEQ .done
  LDA.l !RQ : CMP #$02 : BCS .done
  PHB : PEA $0000 : PLB : PLB                   ; data bank 0: RAM and the game's tile pointers
  REP #$30
  JSR .step
  SEP #$20 : LDA.l !RQ : CMP #$02 : BCS +
  REP #$30 : JSR .step
+ PLB
.done
  PLP
  SEP #$20 : LDA $5B
  RTL
.step
  JSR TallTarget
  CMP.l !TB0 : BEQ .r
  BCC .up
  LDA.l !TB0 : INC : STA.l !TB0
  CLC : ADC #$000F : JSR BuildRow                ; the row entering at the bottom
  BRA .win
.up
  LDA.l !TB0 : DEC : STA.l !TB0
  JSR BuildRow                                   ; the row entering at the top
.win
  LDA.l !TB0 : ASL : AND #$003F
  SEP #$20 : STA.l !Win1 : REP #$20
.r
  RTS

; block row A into the next row slot for the NMI (A/X/Y 16, data bank 0): the 32 block columns from 8
; left of the camera on, each block's tile words from the game's renderer ($058A66, or the hook there)
BuildRow:
  STA.l !RB0
  LDA.l !RQ : AND #$00FF : ASL : TAX
  LDA.l !RB0 : STA.l !RR,x
  TXA : XBA : LSR : STA.l !RX                    ; slot * $100
  LDA $1A : BPL + : LDA #$0000
+ LSR #4 : SEC : SBC #$0008 : BPL + : LDA #$0000
+ STA.l !RC
  LDA #$0020 : STA.l !RN
  SEP #$20                                       ; the tiles' bank as the game's builder chooses it
  LDA $1931 : CMP #$10 : BMI +
  LDA #$05 : BRA ++
+ LDA #$0D
++ STA $0C
  REP #$20
.col
  LDA.l !RC : LSR #4 : TAX                       ; screen
  SEP #$20 : LDA $0CD6,x : XBA : LDA $0CB6,x : REP #$20
  STA.l !RA
  LDA.l !RB0 : ASL #4 : CLC : ADC.l !RA : STA.l !RA
  LDA.l !RC : AND #$000F : CLC : ADC.l !RA : TAX
  SEP #$20 : LDA.l $7F0000,x : XBA : LDA.l $7E0000,x : REP #$20
  ASL : TAY
  JSR TilePtr
  ; buffer: upper row at +2*m, lower at +$80+2*m, m = 2 * column mod 64
  LDA.l !RC : ASL : AND #$003F : ASL : CLC : ADC.l !RX : TAX
  LDY #$0000 : LDA [$0A],y : STA.l !Row,x
  LDY #$0002 : LDA [$0A],y : STA.l !Row+$80,x
  LDY #$0004 : LDA [$0A],y : STA.l !Row+2,x
  LDY #$0006 : LDA [$0A],y : STA.l !Row+$82,x
  LDA.l !RC : INC : STA.l !RC
  LDA.l !RN : DEC : STA.l !RN : BEQ +
  JMP .col
+
  SEP #$20 : LDA.l !RQ : INC : STA.l !RQ : REP #$20
  RTS

; Y = tile * 2 (A/X/Y 16, data bank 0) → [$0A] = the tile's four words, as the game's renderer finds them:
; LDA $0FBE,y : STA $0A at $058A66, or the code a patch called there instead
TilePtr:
  LDA.l $058A66 : AND #$00FF : CMP #$0022 : BEQ .hook
  LDA $0FBE,y : STA $0A
  RTS
.hook
  PHK : PEA.w .back-1
  SEP #$20 : LDA.l $058A69 : PHA : REP #$20
  LDA.l $058A67 : DEC : PHA
  RTL
.back
  REP #$30
  RTS

; the game's column builder, screen pointers loaded (A 8, X 16): a tall level's column starts at the
; window's first row; the first column after the level load sets the window. Replaces SEP #$10 : LDY #$0D
TallColumn:
  LDA.l !Act : BEQ .done
  LDA.l !Win1 : CMP #$FF : BNE +
  LDA #$00 : STA.l !Tall
  REP #$20
  LDA !Height : CMP #$01B1 : BCC .first
  SEP #$20 : LDA #$01 : STA.l !Tall
  REP #$30 : PHX : PHY : JSR TallTarget : PLY : PLX
  STA.l !TB0 : ASL : AND #$003F
  SEP #$20 : STA.l !Win1
  LDA #$00 : STA.l !RQ
.first
  SEP #$20
+ LDA.l !Tall : BEQ .done
  REP #$20
  LDA.l !TB0 : STA.l !CB0
  ASL #4 : PHA : CLC : ADC $6B : STA $6B
  PLA : CLC : ADC $6E : STA $6E
  SEP #$20
.done
  SEP #$10 : LDY #$0D
  RTL

; NMI: the built column (2 tile columns at !CS, !CS+$80 → VRAM !CB) into the window's 32 rows: buffer row i
; is tile row 2 * !CB0 + i, at map row (2 * !CB0 + i) mod 32 (A/X/Y 16)
TallCol:
  JSR .one
  LDA.l !CB : INC : STA.l !CB
  LDA.l !CS : CLC : ADC #$0080 : STA.l !CS
.one
  LDA #$8100 : STA.l !DB                         ; bank $00, VMAIN $81
  LDA.l !CB0 : ASL : AND #$001F : STA.l !TA      ; map row of buffer row 0
  LDA #$0020 : SEC : SBC.l !TA : ASL : STA.l !DL
  LDA.l !CS : STA.l !DS
  LDA.l !TA : ASL #5 : CLC : ADC.l !CB : STA.l !DA
  JSR VDMA
  LDA.l !TA : BEQ +
  ASL : STA.l !DL
  LDA #$0020 : SEC : SBC.l !TA : ASL : CLC : ADC.l !CS : STA.l !DS
  LDA.l !CB : STA.l !DA
  JSR VDMA
+ RTS

; NMI: the rows built this frame, each 2 tile rows x 64 tiles (A/X/Y 8 on entry)
TallRows:
  LDA.l !RQ : BNE +
  RTS
+
  REP #$30
  LDA #$807F : STA.l !DB                         ; bank $7F, VMAIN $80
  LDA #$0040 : STA.l !DL
  LDX #$0000
.row
  LDA.l !RR,x : ASL : AND #$001F : ASL #5 : STA.l !TA   ; map row of the upper tile row * 32
  TXA : XBA : LSR : STA.l !TB                    ; slot * $100
  LDA #$3000 : CLC : ADC.l !TA : STA.l !DA
  LDA.w #!Row&$FFFF : CLC : ADC.l !TB : STA.l !DS : JSR VDMA
  LDA #$3400 : CLC : ADC.l !TA : STA.l !DA
  LDA.w #(!Row+$40)&$FFFF : CLC : ADC.l !TB : STA.l !DS : JSR VDMA
  LDA.l !TA : CLC : ADC #$0020 : AND #$03FF : STA.l !TA
  LDA #$3000 : CLC : ADC.l !TA : STA.l !DA
  LDA.w #(!Row+$80)&$FFFF : CLC : ADC.l !TB : STA.l !DS : JSR VDMA
  LDA #$3400 : CLC : ADC.l !TA : STA.l !DA
  LDA.w #(!Row+$C0)&$FFFF : CLC : ADC.l !TB : STA.l !DS : JSR VDMA
  INX #2
  TXA : LSR : SEP #$20 : CMP.l !RQ : REP #$20 : BCS +
  JMP .row
+ SEP #$30
  LDA #$00 : STA.l !RQ
  RTS

; ---------------------------------------------------------------- stripes
; Entries for the layer 1/2 tilemaps ($2000-$3FFF) are written word by word: always to the shadow
; (horizontal layers), and to VRAM at the mapped address if inside the window. Other entries are
; uploaded by the game's routine, with a temporary end mark after each (RAM stripes only).
Stripe:
  PHA
  LDA.l !Act : BEQ .van
  LDA $02 : CMP #$7E : BCS .own                ; stripes in ROM: unchanged
.van
  PLA
  PHK : PEA.w .ret-1 : PEA.w $84CF-1
  JML $80871E
.ret
  SEP #$30 : LDA $12 : RTL
.own
  PLA
  REP #$30
  LDA $00 : STA.l !SP : SEP #$20 : LDA $02 : STA.l !SP+2 : REP #$20
  LDA #$0000 : STA.l !SY
.entry
  REP #$30
  LDA.l !SP : STA $00 : SEP #$20 : LDA.l !SP+2 : STA $02 : REP #$20
  LDA.l !SY : TAY
  SEP #$20
  LDA [$00],y : BMI .done
  CMP #$20 : BCC .other
  CMP #$40 : BCS .other
  JSR OwnEntry
  BRA .entry
.other
  JSR EntrySize                                 ; → !SN = size (16 bit)
  REP #$20
  LDA.l !SY : CLC : ADC $00 : STA $00           ; pointer to this entry
  LDA.l !SN : TAY
  SEP #$20
  LDA [$00],y : STA.l !SV                       ; temporary end mark
  LDA #$FF : STA [$00],y
  PHK : PEA.w .back-1 : PEA.w $84CF-1
  LDA $02
  JML $80871E
.back
  REP #$30
  LDA.l !SP : STA $00 : SEP #$20 : LDA.l !SP+2 : STA $02 : REP #$20
  LDA.l !SY : CLC : ADC.l !SN : STA.l !SY : TAY
  SEP #$20
  LDA.l !SV : STA [$00],y
  BRA .entry
.done
  SEP #$30 : LDA $12 : RTL

; entry at [$00]+!SY → !SN = 4 + data bytes (M=8, X=16)
EntrySize:
  REP #$20
  LDA.l !SY : TAY : INY #2
  LDA [$00],y : XBA : AND #$3FFF : INC : STA.l !SN   ; length
  SEP #$20
  LDA [$00],y : AND #$40 : BEQ +
  REP #$20 : LDA #$0002 : STA.l !SN : SEP #$20
+ REP #$20
  LDA.l !SN : CLC : ADC #$0004 : STA.l !SN
  SEP #$20
  RTS

OwnEntry:
  JSR EntrySize
  REP #$30
  LDA.l !SY : TAY
  LDA [$00],y : XBA : STA.l !SA                 ; VRAM address (big endian in the stripe)
  INY #2
  LDA [$00],y : STA.l !SF                       ; flags: bit 7 = +32, bit 6 = RLE
  XBA : AND #$3FFF : INC : INC : LSR : STA.l !SW  ; words
  LDA #$0000 : STA.l !SK
.w
  LDA.l !SY : CLC : ADC #$0004 : TAY
  LDA.l !SF : AND #$0040 : BNE +                ; RLE: always the first word
  TYA : CLC : ADC.l !SK : ADC.l !SK : TAY
+ LDA [$00],y : STA.l !TW                       ; tile word
  JSR PutWord
  LDA.l !SF : AND #$0080 : BEQ +
  LDA.l !SA : CLC : ADC #$001F : STA.l !SA
+ LDA.l !SA : INC : STA.l !SA
  LDA.l !SK : INC : STA.l !SK
  CMP.l !SW : BCC .w
  LDA.l !SY : CLC : ADC.l !SN : STA.l !SY
  SEP #$20
  RTS

; tile word !TW for the game's (64x64) VRAM address !SA (A/X/Y 16 bit)
PutWord:
  LDA.l !SA : CMP #$3000 : BCS .l2
  AND #$0FFF : STA.l !TA                         ; address relative to the tilemap
  SEP #$20 : LDA $5B : AND #$01 : REP #$20 : BNE .v1
  LDA #$3000 : STA.l !TB
  LDA.l !Win1 : AND #$00FF : STA.l !TC
  LDX #$0000                                     ; shadow of layer 1
  BRA .horz
.v1
  LDA #$3000 : BRA .vert
.l2
  AND #$0FFF : STA.l !TA
  SEP #$20 : LDA $5B : AND #$02 : REP #$20 : BNE .v2
  LDA #$3800 : STA.l !TB
  LDA.l !Win2 : AND #$00FF : STA.l !TC
  LDX #$1B00                                     ; shadow of layer 2
  BRA .horz
.v2
  LDA #$3800
.vert                                            ; vertical layer: rows modulo 32
  STA.l !TB
  LDA.l !TA : AND #$07FF : ORA.l !TB
  JMP .vram
.horz
  ; row y = (a >> 5 & 31) + (a & $800 ? 32 : 0), column byte offset = (a & 31) * 2 + (a & $400 ? 64 : 0)
  LDA.l !TA : LSR #5 : AND #$001F : STA.l !TD
  LDA.l !TA : AND #$0800 : BEQ +
  LDA.l !TD : ORA #$0020 : STA.l !TD
+ CPX #$0000 : BNE +                             ; layer 1 of a tall level: no shadow, rows modulo 64
  LDA.l !Tall : AND #$00FF : BNE .win
+ LDA.l !TD : CMP #$0036 : BCC +                  ; beyond row 53
  JMP .r
+
  XBA : LSR : STA.l !TE                           ; y * 128
  LDA.l !TA : AND #$001F : ASL : ORA.l !TE : STA.l !TE
  LDA.l !TA : AND #$0400 : LSR #4 : ORA.l !TE : STA.l !TE
  TXA : CLC : ADC.l !TE : TAX
  LDA.l !TW : STA.l !Sh1,x
.win
  LDA.l !TC : CMP #$00FF : BNE +                  ; no window yet
  JMP .r
+ LDA.l !TD : SEC : SBC.l !TC : AND #$003F : CMP #$0020 : BCC +   ; outside the window
  JMP .r
+
  LDA.l !TD : AND #$001F : ASL #5 : STA.l !TE
  LDA.l !TA : AND #$041F : ORA.l !TE : ORA.l !TB
.vram
  STA $2116
  SEP #$20 : LDA #$80 : STA $2115 : REP #$20
  LDA.l !TW : STA $2118
.r
  RTS
`;

export function vramPatchEntry(rom: Rom) {
  return listPatches(rom).find((p) => p.kind === 'vram') ?? null;
}

// needs Asar (loadAsar) to be loaded
export function installVramPatch(rom: Rom): ApplyResult {
  const e = vramPatchEntry(rom);
  if (e) return { ok: true, errors: [], warnings: [], prints: [], entry: e };
  return applyPatch(rom, { name: VRAM_PATCH_NAME, main: 'vram.asm', files: new Map([['vram.asm', VRAM_ASM]]), kind: 'vram', ram: [[0x7f0000, 0x3655]] });
}

setVramPatchCheck((rom) => vramPatchEntry(rom) !== null);
