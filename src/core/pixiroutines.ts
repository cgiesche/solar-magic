// Shared routines for custom sprites (PIXI format), called as %Name() (see docs/pixi.md). Same names,
// inputs and outputs as PIXI's; written for the editor after the original game's routines, whose
// tables are read from the ROM. Each routine is entered with JSL and ends with RTL; only macro-local
// (?) labels, as the file is included inside a macro. DB is the caller's unless stated.

const r = (s: string) => '?main:\n' + s.replace(/^\n/, '');

export const ROUTINES: Record<string, string> = {
  // off-screen flags and the sprite's position on screen ($00/$01), Y = OAM index ($15EA).
  // A sprite too far off screen: returns from the caller's graphics routine (its JSR becomes an RTL).
  // After the bank 3 routine at $03B760.
  GetDrawInfo: r(`
  STZ !186C,x
  STZ !15A0,x
  LDA !E4,x : CMP $1A
  LDA !14E0,x : SBC $1B
  BEQ ?.xon
  INC !15A0,x
?.xon:
  LDA !14E0,x : XBA : LDA !E4,x
  REP #$20
  SEC : SBC $1A
  CLC : ADC.w #$0040
  CMP.w #$0180
  SEP #$20
  ROL : AND #$01 : STA !15C4,x
  BNE ?.invalid
  LDY #$00
  LDA !1662,x : AND #$20 : BEQ ?.yloop
  INY
?.yloop:
  LDA.b #read1($03B75C)
  CPY #$00 : BEQ ?.y0
  LDA.b #read1($03B75D)
?.y0:
  CLC : ADC !D8,x
  PHP
  CMP $1C
  ROL $00
  PLP
  LDA !14D4,x : ADC #$00
  LSR $00
  SBC $1D
  BEQ ?.yon
  LDA.b #read1($03B75E)
  CPY #$00 : BEQ ?.b0
  LDA.b #read1($03B75F)
?.b0:
  ORA !186C,x : STA !186C,x
?.yon:
  DEY : BPL ?.yloop
  LDY !15EA,x
  LDA !E4,x : SEC : SBC $1A : STA $00
  LDA !D8,x : SEC : SBC $1C : STA $01
  RTL
?.invalid:
  PLA : PLA : PLA ; drop the JSL
  PLA : PLY ; the caller's JSR return address ...
  PHB : PHY : PHA ; ... becomes an RTL in the data bank
  RTL
`),

  // Y = 0 when Mario is right of the sprite, 1 left; $0E-$0F = Mario x - sprite x (16 bit)
  SubHorzPos: r(`
  LDY #$00
  LDA $94 : SEC : SBC !E4,x : STA $0E
  LDA $95 : SBC !14E0,x : STA $0F
  BPL ?.r
  INY
?.r:
  RTL
`),

  // Y = 0 when Mario is below the sprite, 1 above; $0F = high byte of Mario y - sprite y (as the original)
  SubVertPos: r(`
  LDY #$00
  LDA $96 : SEC : SBC !D8,x : STA $0F
  LDA $97 : SBC !14D4,x
  BPL ?.r
  INY
?.r:
  RTL
`),

  // erases the sprite once it is too far off screen; A = range (0-3 as bank 1's variants, 4-7 as bank 3's)
  SubOffScreen: r(`
  AND #$07 : ASL : STA $03
  LDA !15A0,x : ORA !186C,x
  BNE ?.check
  RTL
?.check:
  PHB : PHK : PLB
  LDA $5B : AND #$01 : BNE ?.vert
  LDA !D8,x : CLC : ADC #$50
  LDA !14D4,x : ADC #$00
  CMP #$02 : BPL ?.erase ; below the level
  LDA !167A,x : AND #$04 : BNE ?.ret ; processed off screen
  LDA $13 : AND #$01 : ORA $03 : STA $01 : TAY
  LDA $1A : CLC : ADC ?.xlo,y
  ROL $00
  CMP !E4,x
  PHP
  LDA $1B : LSR $00 : ADC ?.xhi,y
  PLP
  SBC !14E0,x : STA $00
  LSR $01 : BCC ?.h
  EOR #$80 : STA $00
?.h:
  LDA $00 : BPL ?.ret
?.erase:
  LDA !14C8,x : CMP #$08 : BCC ?.kill
  LDY !161A,x : CPY #$FF : BEQ ?.kill
  LDA #$00 : STA !1938,y ; may be loaded again
?.kill:
  STZ !14C8,x
?.ret:
  PLB
  RTL
?.vert:
  LDA !167A,x : AND #$04 : BNE ?.ret
  LDA $13 : LSR : BCS ?.ret
  LDA !E4,x : CMP #$00
  LDA !14E0,x : SBC #$00
  CMP #$02 : BCS ?.erase ; beside the level
  LDA $13 : LSR : AND #$01 : STA $01 : TAY
  LDA $1C : CLC : ADC ?.ylo,y
  ROL $00
  CMP !D8,x
  PHP
  LDA $1D : LSR $00 : ADC ?.yhi,y
  PLP
  SBC !14D4,x : STA $00
  LDY $01 : BEQ ?.v
  EOR #$80 : STA $00
?.v:
  LDA $00 : BPL ?.ret
  BMI ?.erase
?.ylo: db read1($01AC0D),read1($01AC0E)
?.yhi: db read1($01AC0F),read1($01AC10)
?.xlo:
  db read1($01AC11),read1($01AC12),read1($01AC13),read1($01AC14),read1($01AC15),read1($01AC16),read1($01AC17),read1($01AC18)
  db read1($03B83F),read1($03B840),read1($03B841),read1($03B842),read1($03B843),read1($03B844),read1($03B845),read1($03B846)
?.xhi:
  db read1($01AC19),read1($01AC1A),read1($01AC1B),read1($01AC1C),read1($01AC1D),read1($01AC1E),read1($01AC1F),read1($01AC20)
  db read1($03B847),read1($03B848),read1($03B849),read1($03B84A),read1($03B84B),read1($03B84C),read1($03B84D),read1($03B84E)
`),
};
