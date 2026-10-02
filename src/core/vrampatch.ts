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

import { Rom } from './rom.ts';
import { applyPatch, uninstallPatch, type ApplyResult } from './patchapply.ts';
import { listPatches } from './patchreg.ts';
import { setVramPatchCheck, extGfxPatch, installExtGfxPatch, disableUnsafeExtGfx } from './patches.ts';

export const VRAM_PATCH_NAME = 'VRAM-Layout (SMWV)';

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
  RTL
.van
  LDA #$23 : STA $2107
  LDA #$33 : STA $2108
  LDA #$00 : STA.l !Act
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
  JSL $05881A
  BRA Copy1
Build1Load:
  JSL $0588EC
Copy1:
  PHP : SEP #$30
  LDA.l !Act : BEQ .no
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
  JSL $058883
  BRA Copy2
Build2Load:
  JSL $058955
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
  LDA $1BE4 : JML $0087B2
.act
  JSR Stream1
  JSR Stream2
  LDA $1BE4 : BEQ .l2
  LDA $5B : AND #$01 : BNE .v1
  REP #$30
  LDA $1BE4 : XBA : AND #$041F : ORA #$3000 : STA.l !CB
  LDA #$1BE6 : STA.l !CS
  SEP #$20 : LDA.l !Win1 : STA.l !CW : REP #$20
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
  LDA $1CE6 : BEQ .end
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
  JML $00871E
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
  JML $00871E
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
+ LDA.l !TD : CMP #$0036 : BCC +                  ; beyond row 53
  JMP .r
+
  XBA : LSR : STA.l !TE                           ; y * 128
  LDA.l !TA : AND #$001F : ASL : ORA.l !TE : STA.l !TE
  LDA.l !TA : AND #$0400 : LSR #4 : ORA.l !TE : STA.l !TE
  TXA : CLC : ADC.l !TE : TAX
  LDA.l !TW : STA.l !Sh1,x
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

// needs Asar (loadAsar) to be loaded. BG2/BG3 slots switched off earlier (SMWG) become active again.
export function installVramPatch(rom: Rom): ApplyResult {
  const e = vramPatchEntry(rom);
  if (e) return { ok: true, errors: [], warnings: [], prints: [], entry: e };
  const r = applyPatch(rom, { name: VRAM_PATCH_NAME, main: 'vram.asm', files: new Map([['vram.asm', VRAM_ASM]]), kind: 'vram', ram: [[0x7f0000, 0x3654]] });
  if (r.ok && extGfxPatch(rom) && !extGfxPatch(rom)!.active) installExtGfxPatch(rom);
  return r;
}

// also switches the BG2/BG3 slots off, which would overwrite the layer 1 tilemap again
export function uninstallVramPatch(rom: Rom): string[] {
  const e = vramPatchEntry(rom);
  if (!e) return [];
  const w = uninstallPatch(rom, e.id);
  disableUnsafeExtGfx(rom);
  return w;
}

setVramPatchCheck((rom) => vramPatchEntry(rom) !== null);
