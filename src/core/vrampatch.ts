// VRAM layout patch ("SMWV"), like Lunar Magic's: in levels, the layer 1 and layer 2 tilemaps move
// from 64x64 at VRAM $2000/$3000 to 64x32 at $3000/$3800 (BG1SC = $31, BG2SC = $39), which frees
// $2000-$2FFF for the BG2/BG3 graphics slots (tiles 200-2FF).
//
// A 64x32 tilemap holds 32 of the 54 tile rows of a horizontal level. All 54 rows of both layers are
// kept in a RAM shadow ($7F0000, filled right after the game builds a column); the tilemap holds a
// window of 32 rows around the camera and rows are copied in from the shadow as the camera moves
// vertically. Vertical levels already stream rows: there the rows built are the camera's and 14 below
// it instead of 8 above / 23 below (the tilemap holds 16 block rows) and addresses are mapped. Single
// tile changes (stripes) go to the shadow and, inside the window, to VRAM (in a vertical level: only on
// the camera's rows). The layout is switched on wherever the game loads a level ($00A59C, as Lunar Magic
// does): entering one (game mode $12), the title screen level ($04) and the ending's scene ($1D, run as $1C) –
// tiles 200-2FF are uploaded there too (a global animation's every frame, which in the game's layout lands
// in the layer 1 tilemap). Not in boss/mode 7 rooms; everything else (overworld, credits) is unchanged.
//
// A horizontal level taller than the game's 27 rows (levelheight.ts: its height in $13D7, its screens'
// Map16 addresses at $0CB6/$0CD6) doesn't fit a shadow: its layer 1 window is 16 block rows, built from
// the level data. Each frame the window follows the camera (block row Y/16 - 1) and the rows that enter
// it are built for the 32 block columns around the camera ($7F0000, two at most per frame) and uploaded
// in the NMI after the column; a column is built from the window's first row on (the game's builder
// with its screen pointers moved down, so any hook in it, like the Map16 extension's, still applies).

import { Rom } from './rom.ts';
import { applyPatch, reapplyPatch, sourceHash, type ApplyResult, type PatchSource } from './patchapply.ts';
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
!SP   = $7F3630      ; stripes: the buffer's pointer (3 bytes)
!S0   = $7F3633      ; its first byte
!SY   = $7F3634      ; the next entry (OwnUp, OwnShadow)
!SQ   = $7F3603      ; 1: the shadow pass of this NMI's stripes is due
!PS   = $7F3604      ; per layer (2 words each): the window's first tile row, its rows, the row limit, the shadow
!PL   = $7F3608
!PM   = $7F360C
!PH   = $7F3624
!SC   = $7F3628      ; a column segment starting outside the window: its first word's row in the window (SegShadow:
!SE   = $7F362A      ; the shadow offset), the rows before the limit (SegShadow: words left), the first word inside,
!SL   = $7F362C      ; the words inside
!SX   = $7F362E
!TA   = $7F3644      ; ColUp, TallCol, TallRows: temporaries
!TB   = $7F3646
!TC   = $7F3648
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

; NMI, the screen just turned on: the stripes into the shadow (LDA $0D9F : STA $420C)
org $0082B6
  JSL Tail
  NOP #2

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

; level load loop: vertical layers start 31 rows before the last one (32 rows, the last 16 stay: c-1..c+14)
org $0580B0
  JSL LoadStart1
org $0580B4
  JSL LoadStart2

; vertical layers: build the camera's block row c / 14 below it instead of 8 above / 23 below. The tilemap
; holds 16 block rows and the screen shows c..c+14: the game builds an edge row only when the camera enters
; a block row (or turns), so each must be the row that comes into view there – going up row c itself, going
; down c+14 (on screen from the next pixel on). Built further out (c-1 / c+15, one slot), a camera stopped at
; a block row and then going up showed c-1 with the tiles of c+15 (12A's bottom)
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
  LDA $0100 : CMP #$12 : BEQ .lvl     ; the game modes running the level load $00A59C
  CMP #$04 : BEQ .lvl
  CMP #$1C : BNE .van
.lvl
  LDA $0D9B : BNE .van
  LDA #$31 : STA $2107
  LDA #$39 : STA $2108
  LDA #$01 : STA.l !Act
  LDA #$FF : STA.l !Win1 : STA.l !Win2
  LDA #$00 : STA.l !Tall : STA.l !SQ
  RTL
.van
  LDA #$23 : STA $2107
  LDA #$33 : STA $2108
  LDA #$00 : STA.l !Act : STA.l !Tall : STA.l !SQ
  RTL

; ---------------------------------------------------------------- vertical look-ahead
VTop:
  PHA
  LDA.l !Act : AND #$00FF : BEQ +
  PLA : RTL
+ PLA : SEC : SBC #$0008 : RTL
VBot:
  PHA
  LDA.l !Act : AND #$00FF : BEQ +
  PLA : CLC : ADC #$000E : RTL
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
; The NMI's V-blank is short: the stripes are handled entry by entry, not word by word (#406). An entry for the
; layer 1/2 tilemaps ($2000-$3FFF) is cut into segments – a +1 entry at the end of each tile row, a +32 entry at
; the end of each 32x32 screen's column – so that the words of a segment lie side by side (or one below the
; other) in the remapped layout too and are inside the window in one run at most. In the NMI (force blank) the
; run goes to VRAM by one DMA at the mapped address; once the screen is on (Tail) the segments go into the
; shadow (horizontal layers). Entries for other VRAM are uploaded as the game's routine does it. Stripes in ROM
; are uploaded by the game's routine, unchanged.
Stripe:
  LDA.l !Act : BEQ .van
  LDA $02 : CMP #$7E : BCS .own
.van
  LDA $02                                       ; (the game's routine takes the bank in A)
  PHK : PEA.w .ret-1 : PEA.w $84CF-1
  JML $80871E
.ret
  SEP #$30 : LDA $12 : RTL
.own
  LDA [$00] : BMI .none                         ; empty
  STA.l !S0                                     ; the game puts its end mark there after the upload
  REP #$30
  LDA $00 : STA.l !SP : SEP #$20 : LDA $02 : STA.l !SP+2 : REP #$20
  JSR Params
  JSR WalkUp
  SEP #$30
  LDA #$01 : STA.l !SQ
.none
  SEP #$30 : LDA $12 : RTL

; NMI with the screen on (replaces LDA $0D9F : STA $420C): this NMI's stripes into the shadow. The buffer is as
; it was uploaded but for its first byte (the game's end mark); the game's code waits for this NMI to end
Tail:
  LDA $0D9F : STA $420C
  LDA.l !SQ : BEQ .r
  LDA #$00 : STA.l !SQ
  REP #$30
  LDA.l !SP : STA $00 : SEP #$20 : LDA.l !SP+2 : STA $02
  LDA [$00] : PHA : LDA.l !S0 : STA [$00]
  REP #$20
  JSR WalkShadow
  SEP #$20
  PLA : STA [$00]
.r
  RTL

; per layer (X = 0: layer 1, 2: layer 2) where its words go, from the window this NMI set (A/X/Y 16):
; !PS the window's first tile row (0-63), !PL its rows from there (modulo 64; 0: no window yet), !PM the rows
; from which on a word goes nowhere, !PH the layer's shadow ($FFFF: none). Horizontal: the window's 32 rows,
; rows from 54 on nowhere (a tall layer 1: no limit, no shadow). Vertical: the camera's block rows c..c+14 (the
; slot of any other may be one on screen; it is built when it comes into view), no shadow
Params:
  LDA $5B : LSR : BCS .v1
  LDA.l !Win1 : AND #$00FF : STA.l !PS
  CMP #$00FF : LDA #$0020 : BCC +
  LDA #$0000
+ STA.l !PL
  LDA.l !Tall : LSR : LDA #$0036 : LDX #$0000 : BCC +
  LDA #$0040 : LDX #$FFFF
+ STA.l !PM : TXA : STA.l !PH
  BRA .l2
.v1
  LDA $1C : LSR #3 : AND #$003E : STA.l !PS
  LDA #$001E : STA.l !PL
  LDA #$0040 : STA.l !PM
  LDA #$FFFF : STA.l !PH
.l2
  LDA $5B : AND #$0002 : BNE .v2
  LDA.l !Win2 : AND #$00FF : STA.l !PS+2
  CMP #$00FF : LDA #$0020 : BCC +
  LDA #$0000
+ STA.l !PL+2
  LDA #$0036 : STA.l !PM+2
  LDA #$1B00 : STA.l !PH+2
  RTS
.v2
  LDA $20 : LSR #3 : AND #$003E : STA.l !PS+2
  LDA #$001E : STA.l !PL+2
  LDA #$0040 : STA.l !PM+2
  LDA #$FFFF : STA.l !PH+2
  RTS

; NMI: the entries of the stripe buffer at [$00] to VRAM (A/X/Y 16; uses $03-$0F). An entry for the layer 1/2
; tilemaps within one tile row (+1, not RLE: a changed block's row) is done here, the others by OwnUp; an entry
; for other VRAM as the game's routine ($00871E) does it
WalkUp:
  JSR Defaults
  LDY #$0000
.entry
  LDA [$00],y : BIT #$0080 : BEQ +
  RTS
+ XBA : STA $08                                 ; VRAM address (big endian in the stripe)
  AND #$E000 : CMP #$2000 : BEQ +
  JMP .other
+ INY #2
  LDA [$00],y : XBA : STA $0E
  INY #2
  BIT #$C000 : BEQ +
  BIT #$4000 : BNE .gen
  JMP .col
+ INC : STA $06                                 ; data bytes
  INC : LSR : STA $04                           ; words
  LDA $08 : ORA #$FFE0 : CLC : ADC $04 : DEC : BPL .gen   ; beyond the tile row's end
  TYA : CLC : ADC $06 : STA $0A                 ; the next entry
  LDA $08 : CMP #$3000 : LDX #$0000 : BCC +     ; (as SegUp, inline: the most frequent entry)
  LDX #$0002
+ AND #$0BE0 : ASL #3 : XBA : CMP #$0040 : BCC +
  SBC #$0020
+ CMP.l !PM,x : BCS .next
  SEC : SBC.l !PS,x : AND #$003F : CMP.l !PL,x : BCS .next
  LDA $08 : AND #$07FF : ORA.l Base,x : STA $2116
  TYA : CLC : ADC $00 : STA $4312
  LDA $04 : ASL : STA $4315
  SEP #$20 : LDA #$02 : STA $420B : REP #$20
.next
  LDY $0A
  JMP .entry
.gen
  DEY #4
  JSR OwnUp
  JMP .entry
.col                                             ; +32, not RLE, within the 32x32 screen's column: by SegUp
  AND #$3FFF : INC : STA $06
  INC : LSR : STA $04
  LDA $08 : LSR #5 : ORA #$FFE0 : CLC : ADC $04 : DEC : BPL .gen
  TYA : STA $0C : CLC : ADC $06 : STA $0A
  JSR SegUp
  LDY $0A
  JMP .entry
.other
  INY #2
  LDA [$00],y : XBA : STA $0E
  INY #2
  LDA $08 : STA $2116
  TYA : CLC : ADC $00 : STA $4312
  LDA $0E : AND #$3FFF : INC : TAX : STX $4315   ; bytes
  BIT $0E : BVS .orle
  STX $06 : TYA : CLC : ADC $06 : TAY
  SEP #$20
  LDA $0F : BMI +
  LDA #$02 : STA $420B
  REP #$20
  JMP .entry
+ LDA #$81 : STA $2115                          ; +32
  LDA #$02 : STA $420B
  LDA #$80 : STA $2115
  REP #$20
  JMP .entry
.orle                                            ; the game's RLE: the low byte to $2118/$2119 (+1/+32 after
  SEP #$20                                       ; $2118), then the high byte to $2119/$211A (after $2119)
  LDA #$09 : STA $4310
  LDA $0F : ASL : LDA #$00 : ROL : STA $03 : STA $2115
  LDA #$02 : STA $420B
  LDA #$19 : STA $4311
  REP #$21
  LDA $08 : STA $2116
  TYA : ADC $00 : INC : STA $4312
  STX $4315
  INY #2
  SEP #$20
  LDA $03 : ORA #$80 : STA $2115
  LDA #$02 : STA $420B
  REP #$20
  JSR Defaults
  JMP .entry

; the DMA settings of WalkUp: channel 1 to $2118/$2119 from the buffer's bank, +1 after the high byte
Defaults:
  LDA #$1801 : STA $4310
  SEP #$20
  LDA #$80 : STA $2115
  LDA $02 : STA $4314
  REP #$20
  RTS

; screen on: the entries for the layer 1/2 tilemaps into the shadow (A/X/Y 16; uses $03-$0F)
WalkShadow:
  LDY #$0000
.entry
  LDA [$00],y : BIT #$0080 : BNE .done
  AND #$00E0 : CMP #$0020 : BNE .other
  JSR OwnShadow
  BRA .entry
.other                                           ; the next entry: + 4 + 2 (RLE) or + 4 + length
  INY #2
  LDA [$00],y : XBA : BIT #$4000 : BEQ +
  LDA #$0001
+ AND #$3FFF : STA $06
  TYA : SEC : ADC $06 : INC #2 : TAY
  BRA .entry
.done
  RTS

; Y = an entry for the layer 1/2 tilemaps, segment by segment → Y = the next entry (A/X/Y 16), each segment by
; <seg>.
; $08: the game's (64x64) VRAM address of the segment, $0A: words left, $0C: their data (offset in the buffer),
; $0E: byte 2 << 8 | byte 3 of the entry (bit 15: +32, bit 14: RLE, length - 1), $04: the segment's words
macro own(name, seg)
<name>:
  LDA [$00],y : XBA : STA $08                   ; (big endian in the stripe)
  INY #2
  LDA [$00],y : XBA : STA $0E
  INY #2 : STY $0C
  AND #$3FFF : INC : STA $06                    ; data bytes
  INC : LSR : STA $0A                           ; words
  BIT $0E : BVC +
  LDA #$0002 : STA $06
+ TYA : CLC : ADC $06 : STA.l !SY
.seg
  ; words to the end of the tile row (+1) or of the screen's column (+32)
  LDA $08 : BIT $0E : BPL +
  LSR #5
+ AND #$001F : EOR #$001F : INC
  CMP $0A : BCC +
  LDA $0A
+ STA $04
  JSR <seg>
  LDA $04 : BIT $0E : BPL +
  ASL #5
+ CLC : ADC $08 : STA $08
  BIT $0E : BVS +
  LDA $04 : ASL : ADC $0C : STA $0C
+ LDA $0A : SEC : SBC $04 : STA $0A
  BNE .seg
  LDA.l !SY : TAY
  RTS
endmacro
%own(OwnUp, SegUp)
%own(OwnShadow, SegShadow)

; the layer's tilemap in VRAM
Base:
  dw $3000, $3800

; NMI: the segment's words inside the window to VRAM. A row segment is one tile row y (rows mod 64:
; (a >> 5 & 31) + (a & $800 ? 32 : 0)); a column segment's rows y, y+1 ... (one screen's) are inside the window
; at most in one run. Mapped: the address within the 32x32 screens side by side (a & $7FF) on the layer's tilemap
SegUp:
  LDA $08 : CMP #$3000 : LDX #$0000 : BCC +
  LDX #$0002
+ AND #$0BE0 : ASL #3 : XBA : CMP #$0040 : BCC +
  SBC #$0020
+ STA $06                                       ; y
  CMP.l !PM,x : BCS .r
  SEC : SBC.l !PS,x : AND #$003F                ; its row in the window
  BIT $0E : BMI .col
  CMP.l !PL,x : BCS .r
  LDA $08 : AND #$07FF : ORA.l Base,x : STA $06
  LDY $0C : LDX $04
  JMP Put
.r
  RTS
.col
  CMP.l !PL,x : BCS .late
  EOR #$FFFF : SEC : ADC.l !PL,x                ; inside from the first word to the window's end
  CMP $04 : BCC +
  LDA $04
+ TAY
  LDA.l !PM,x : SEC : SBC $06 : STA $06         ; rows before the limit
  CPY $06 : BCC +
  LDY $06
+ LDA $08 : AND #$07FF : ORA.l Base,x : STA $06
  TYX
  LDY $0C
  JMP Put
.late
  STA.l !SC
  LDA.l !PM,x : SEC : SBC $06 : STA.l !SE       ; rows before the limit
  LDA #$0040 : SEC : SBC.l !SC : STA.l !SL      ; inside from the word at the window's start
  CLC : ADC.l !PL,x                             ; to the window's end
  CMP $04 : BCC +
  LDA $04
+ CMP.l !SE : BCC +
  LDA.l !SE
+ SEC : SBC.l !SL : BEQ .r : BCC .r
  STA.l !SX                                     ; words of the run
  LDA.l !SL : ASL #5 : CLC : ADC $08 : AND #$07FF : ORA.l Base,x : STA $06
  LDA.l !SL : ASL : BIT $0E : BVC +
  LDA #$0000
+ CLC : ADC $0C : TAY
  LDA.l !SX : TAX
  ; (falls through)

; X words from the buffer at offset Y to VRAM $06, +1 or +32 as the entry (A/X/Y 16; WalkUp's DMA settings, kept).
; RLE: the word's low bytes, then its high bytes, the run's words only (the game's RLE also writes the high byte
; after the run)
Put:
  LDA $06 : STA $2116
  TYA : CLC : ADC $00 : STA $4312
  BIT $0E : BVS .rle
  TXA : ASL : STA $4315
  SEP #$20
  BIT $0F : BMI .d
  LDA #$02 : STA $420B
  REP #$20
  RTS
.d
  LDA #$81 : STA $2115                          ; +32
  LDA #$02 : STA $420B
  LDA #$80 : STA $2115
  REP #$20
  RTS
.rle
  SEP #$20
  LDA $0F : ASL : LDA #$00 : ROL : STA $03      ; +1 or +32
  STA $2115                                     ; after the low byte
  REP #$20
  LDA #$1808 : STA $4310                        ; fixed source, $2118
  STX $4315
  SEP #$20 : LDA #$02 : STA $420B
  LDA $03 : ORA #$80 : STA $2115                ; after the high byte
  LDA #$19 : STA $4311
  REP #$20
  LDA $06 : STA $2116
  TYA : SEC : ADC $00 : STA $4312
  STX $4315
  SEP #$20 : LDA #$02 : STA $420B
  LDA #$80 : STA $2115
  REP #$20
  LDA #$1801 : STA $4310
  RTS

; screen on: the segment's words into the shadow of a horizontal layer, rows 0-53 (shadow offset
; y * 128 + (a & 31) * 2 + (a & $400 ? 64 : 0))
SegShadow:
  LDA $08 : CMP #$3000 : LDX #$0000 : BCC +
  LDX #$0002
+ LDA.l !PH,x : BMI .r
  STA.l !SC
  LDA $08 : AND #$0BE0 : ASL #3 : XBA : CMP #$0040 : BCC +
  SBC #$0020
+ STA $06                                       ; y
  CMP #$0036 : BCS .r
  XBA : LSR : ADC.l !SC : STA.l !SC
  LDA $08 : AND #$001F : ASL : ADC.l !SC : STA.l !SC
  LDA $08 : AND #$0400 : LSR #4 : ADC.l !SC : TAX
  LDY $0C
  LDA $04 : STA.l !SE
  BIT $0E : BMI .col
.row
  LDA [$00],y : STA.l !Sh1,x
  INX #2
  BIT $0E : BVS +
  INY #2
+ LDA.l !SE : DEC : STA.l !SE : BNE .row
.r
  RTS
.col
  LDA [$00],y : STA.l !Sh1,x
  TXA : CLC : ADC #$0080 : TAX
  BIT $0E : BVS +
  INY #2
+ INC $06 : LDA $06 : CMP #$0036 : BCS .r
  LDA.l !SE : DEC : STA.l !SE : BNE .col
  RTS
`;

export function vramPatchEntry(rom: Rom) {
  return listPatches(rom).find((p) => p.kind === 'vram') ?? null;
}

// the patch as it is applied (asm: another version of it, for tests)
export const vramSource = (asm = VRAM_ASM): PatchSource => ({ name: VRAM_PATCH_NAME, main: 'vram.asm', files: new Map([['vram.asm', asm]]), kind: 'vram', ram: [[0x7f0000, 0x3655]] });

// needs Asar (loadAsar) to be loaded
export function installVramPatch(rom: Rom): ApplyResult {
  const e = vramPatchEntry(rom);
  if (e) return { ok: true, errors: [], warnings: [], prints: [], entry: e };
  return applyPatch(rom, vramSource());
}

// whether the ROM's VRAM patch (if any) is from this source
export function vramPatchUpToDate(rom: Rom): boolean {
  const e = vramPatchEntry(rom);
  return !e || e.hash === sourceHash(vramSource());
}

// A ROM the editor made keeps the VRAM patch it was made with, unless its source (the registry's hash) is not this
// one's: then the patch is removed and applied anew, so that the ROM gets fixes of the patch's code (#406: stripes
// per entry). False if it is up to date; throws, with the ROM unchanged, if it can't be applied (e.g. another
// patch took a hook it has now). Needs Asar
export function updateVramPatch(rom: Rom): boolean {
  const e = vramPatchEntry(rom);
  if (!e || vramPatchUpToDate(rom)) return false;
  const before = rom.snapshot();
  let r: ApplyResult;
  try {
    r = reapplyPatch(rom, e.id, vramSource());
  } catch (err) {
    r = { ok: false, errors: [err instanceof Error ? err.message : String(err)], warnings: [], prints: [] };
  }
  if (!r.ok) {
    rom.restore(before);
    throw new Error(`The VRAM layout patch could not be updated: ${r.errors.join(' ')}`);
  }
  return true;
}

setVramPatchCheck((rom) => vramPatchEntry(rom) !== null);
