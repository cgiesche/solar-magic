// Shared routines for custom sprites (PIXI format), called as %Name() (see docs/pixi.md). Same names,
// inputs and outputs as PIXI's; written for the editor after the original game's routines, whose
// tables are read from the ROM. Each routine is entered with JSL and ends with RTL; only macro-local
// (?) labels, as the file is included inside a macro. DB is the caller's unless stated.

import { LEVEL_MAX_Y, LEVEL_ROW_MASK } from './ram.ts';

const r = (s: string) => '?main:\n' + s.replace(/^\n/, '');
const hx = (v: number) => v.toString(16).toUpperCase();

// a signed 8-bit offset added to a 16-bit position: lo/hi = where to store, off = offset, base = position (lo, hi)
const addOff = (off: string, baseLo: string, baseHi: string, lo: string, hi: string) => `
  LDA ${off} : CLC : ADC ${baseLo} : STA ${lo}
  LDA #$00 : BIT ${off} : BPL ?.p${off.slice(1)}${lo.replace(/\W/g, '')}
  DEC
?.p${off.slice(1)}${lo.replace(/\W/g, '')}:
  ADC ${baseHi} : STA ${hi}`;

// spawn routines of the other sprite types: A = number, $00/$01 = x/y offset from the origin $04-$05/$06-$07
// (16 bit); a free slot from the top, Y = slot and carry clear, or carry set when all are taken;
// overwrite: the oldest slot ($counter) is reused instead of failing
function genericSpawn(p: string, size: string, extra: string, overwrite?: string): string {
  return r(`
  XBA
  LDY.b #${size}-1
?.loop:
  LDA !${p}_num,y : BEQ ?.found
  DEY : BPL ?.loop
${overwrite ? `  DEC ${overwrite} : BPL ?.old
  LDA.b #${size}-1 : STA ${overwrite}
?.old:
  LDY ${overwrite}` : `  SEC
  RTL`}
?.found:
  XBA : STA !${p}_num,y
${addOff('$00', '$04', '$05', `!${p}_x_low,y`, `!${p}_x_high,y`)}
${addOff('$01', '$06', '$07', `!${p}_y_low,y`, `!${p}_y_high,y`)}
${extra}
  CLC
  RTL
`);
}

// rest of SpawnSprite(Safe): slot search from X down, number in B, carry = custom
const spawnSprite = `?.loop:
  LDA !14C8,x : BEQ ?.found
  DEX : BPL ?.loop
  TXY : PLX
  SEC
  RTL
?.found:
  XBA : STA !9E,x
  JSL $87F7D2 ; keeps the carry
  BCC ?.vanilla
  LDA !9E,x : STA !new_sprite_num,x
  LDA $02 : PHA : REP #$20 : LDA $00 : PHA : SEP #$20
  JSL $8187A7
  REP #$20 : PLA : STA $00 : SEP #$20 : PLA : STA $02
  LDA #$08 : STA !extra_bits,x
?.vanilla:
  LDA #$01 : STA !14C8,x
  TXY : PLX
  LDA $00 : CLC : ADC !E4,x : STA.w !E4,y
  LDA #$00 : BIT $00 : BPL ?.xp
  DEC
?.xp:
  ADC !14E0,x : STA !14E0,y
  LDA $01 : CLC : ADC !D8,x : STA.w !D8,y
  LDA #$00 : BIT $01 : BPL ?.yp
  DEC
?.yp:
  ADC !14D4,x : STA !14D4,y
  LDA $02 : STA.w !B6,y
  LDA $03 : STA.w !AA,y
  CLC
  RTL
`;

// position += speed / 16 with the low nibble in a fraction byte (the game's way); label: unique suffix
const subpixel = (speed: string, frac: string, lo: string, hi: string, label: string) => `
  LDA ${speed} : ASL #4 : CLC : ADC ${frac} : STA ${frac}
  PHP
  LDY #$00
  LDA ${speed} : LSR #4 : CMP #$08 : BCC ?.${label}
  ORA #$F0 : DEY
?.${label}:
  PLP
  ADC ${lo} : STA ${lo}
  TYA : ADC ${hi} : STA ${hi}`;

// position += speed (whole pixels)
const fullpixel = (speed: string, lo: string, hi: string, label: string) => `
  LDY #$00
  LDA ${speed} : BPL ?.${label}
  DEY
?.${label}:
  CLC : ADC ${lo} : STA ${lo}
  TYA : ADC ${hi} : STA ${hi}`;

// cluster and minor extended sprites: on-screen position, killed far off screen; Y = OAM index from the game's table
const miscDrawInfo = (p: string, oam: number, adc: string) => r(`
  LDA !${p}_y_low,x : SEC : SBC $1C : STA $01
  CMP #$E0 : BCC ?.x
  ${adc} : BPL ?.x
?.kill:
  STZ !${p}_num,x
  CLC
  RTL
?.x:
  STZ $02
  LDA !${p}_x_low,x : SEC : SBC $1A : STA $00
  LDA !${p}_x_high,x : SBC $1B : BEQ ?.on
  LDA $00 : CLC : ADC #$38 : CMP #$70 : BCS ?.kill
  INC $02
?.on:
  LDA.l $${oam.toString(16).toUpperCase()},x : TAY
  SEC
  RTL
`);

// the game's subroutine at addr (bank 2, ends with RTS) called through the RTL at $02B889
const callBank2 = (addr: string, label: string) => `
  PHK : PEA.w ?.${label}-1
  PEA.w $B888
  JML ${addr}
?.${label}:`;

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
  // A = random number from 0 to A (the game's generator at $01ACF9)
  Random: r(`
  PHX : PHP
  SEP #$30
  PHA
  INC : AND $01,s : BEQ ?.mask ; A+1 a power of two
  JSL $81ACF9
  STA $4204 : LDA $148E : STA $4205 ; 16-bit random number ...
  PLA : INC : STA $4206 ; ... divided by A+1
  NOP #4 : BRA ?.wait
?.wait:
  NOP #2
  LDA $4216 ; remainder
  PLP : PLX
  RTL
?.mask:
  JSL $81ACF9
  PLA : AND $148D
  PLP : PLX
  RTL
`),

  // star kill: the sprite falls off screen, Mario gets points for consecutive kills
  Star: r(`
  PHB : PHK : PLB
  JSL $81AB6F ; contact star
  LDA #$02 : STA !14C8,x
  LDA #$D0 : STA !AA,x
  %SubHorzPos()
  LDA #$F0 : CPY #$00 : BEQ ?.dir
  LDA #$10
?.dir:
  STA !B6,x
  LDA $18D2 : INC : CMP #$08 : BCC ?.cnt
  LDA #$08
?.cnt:
  STA $18D2
  JSL $82ACE5 ; points
  LDY $18D2
  LDA ?.sfx,y : STA $1DF9
  PLB
  RTL
?.sfx: db $00,$13,$14,$15,$16,$17,$18,$19,$03
`),

  // A = tiles - 1, Y = tile size ($00 8x8, $02 16x16, $FF keep): the game's routine at $01B7B3
  FinishOAMWrite: r(`
  JML $81B7B3
`),

  // the sprite in slot X becomes sprite A (carry set: custom sprite) in its init state
  ReplaceSelf: r(`
  XBA
  JSL $87F722 ; clear the tables
  XBA
  BCS ?.custom
  STA !9E,x
  STA !new_sprite_num,x
  JSL $87F78B ; tweakers of the original sprite
  LDA #$01 : STA !14C8,x
  LDA #$00 : STA !extra_bits,x
  RTL
?.custom:
  STA !new_sprite_num,x
  LDA $02 : PHA : REP #$20 : LDA $00 : PHA : SEP #$20
  JSL $8187A7
  LDA #$01 : STA !14C8,x
  LDA #$08 : STA !extra_bits,x
  REP #$20 : PLA : STA $00 : SEP #$20 : PLA : STA $02
  RTL
`),

  // Mario riding Yoshi: Yoshi runs away as when Mario is hit; keeps A, X, Y
  LoseYoshi: r(`
  PHA
  LDA $187A : BEQ ?.r
  PHX : PHY
  LDX $18E2 ; Yoshi's slot + 1
  LDA #$10 : STA !163E-1,x
  LDA #$03 : STA $1DFA
  LDA #$13 : STA $1DFC
  LDA #$02 : STA !C2-1,x
  STZ $187A : STZ $0DC1
  LDA #$C0 : STA $7D : STZ $7B
  LDA !157C-1,x : PHX : TAX
  LDA.l $02A4B3,x ; Yoshi's running speed
  PLX : STA !B6-1,x
  STZ !1594-1,x : STZ !151C-1,x : STZ $18AE
  LDA #$30 : STA $1497
  PLY : PLX
?.r:
  PLA
  RTL
`),

  // shooters: A = timer when firing, carry set = not while Mario is next to the shooter; carry clear and
  // Y = free sprite slot when it should fire
  ShooterMain: r(`
  XBA
  LDA !shoot_timer,x : BNE ?.no
  XBA : STA !shoot_timer,x
  BCC ?.near
  LDA $94 : SBC !shoot_x_low,x : CLC : ADC #$11 : CMP #$22 : BCC ?.no
?.near:
  LDA !shoot_y_low,x : CMP $1C : LDA !shoot_y_high,x : SBC $1D : BNE ?.no
  LDA !shoot_x_low,x : CMP $1A : LDA !shoot_x_high,x : SBC $1B : BNE ?.no
  LDA !shoot_x_low,x : SEC : SBC $1A : CLC : ADC #$10 : CMP #$10 : BCC ?.no
  JSL $82A9DE ; free slot
  BMI ?.no
  CLC
  RTL
?.no:
  SEC
  RTL
`),

  // carry set when the cape (spinning) touches the sprite in slot X
  CapeContact: r(`
  LDA $13E8 : BEQ ?.no
  LDA !15D0,x : ORA !154C,x : ORA !1FE2,x : BNE ?.no
  LDA $74 : BEQ ?.net
  LDA #$01
?.net:
  EOR !1632,x : EOR $13F9 : BNE ?.no ; same side of the net
  JSL $83B69F ; clipping of the sprite
  LDA $13E9 : SEC : SBC #$02 : STA $00
  LDA $13EA : SBC #$00 : STA $08
  LDA #$14 : STA $02
  LDA $13EB : STA $01
  LDA $13EC : STA $09
  LDA #$10 : STA $03
  JML $83B72B ; contact check
?.no:
  CLC
  RTL
`),

  // carry set and Y = 0/1 (Mario's fireball in extended slot 8/9) when one touches the sprite in slot X
  FireballContact: r(`
  PHX
  LDY #$00
?.loop:
  LDA !extended_num+8,y : CMP #$05 : BNE ?.next
  LDA !extended_x_low+8,y : SEC : SBC #$02 : STA $00
  LDA !extended_x_high+8,y : SBC #$00 : STA $08
  LDA #$0C : STA $02
  LDA !extended_y_low+8,y : SEC : SBC #$04 : STA $01
  LDA !extended_y_high+8,y : SBC #$00 : STA $09
  LDA #$13 : STA $03
  PHY
  JSL $83B69F
  JSL $83B72B
  PLY
  BCS ?.hit
?.next:
  INY : CPY #$02 : BCC ?.loop
  LDY #$FF
  PLX
  CLC
  RTL
?.hit:
  PLX
  SEC
  RTL
`),

  // carry set when the 16-bit boxes $00-$07 (x, y, width, height) and $08-$0F overlap
  CheckForContactAlternate: r(`
  REP #$20
  LDA $00 : CMP $08 : BCC ?.x2
  SBC $08 : CMP $0C : BCS ?.no
  BRA ?.y
?.x2:
  LDA $08 : SEC : SBC $00 : CMP $04 : BCS ?.no
?.y:
  LDA $02 : CMP $0A : BCC ?.y2
  SBC $0A : CMP $0E : BCS ?.no
?.yes:
  SEP #$21
  RTL
?.y2:
  LDA $0A : SEC : SBC $02 : CMP $06 : BCC ?.yes
?.no:
  SEP #$20
  CLC
  RTL
`),

  // Mario's interaction box as 16-bit values in $00-$07 (the game's tables at $03B65C/$03B660)
  SetPlayerClippingAlternate: r(`
  PHX
  REP #$21
  LDA $94 : ADC #$0002 : STA $00
  LDA #$000C : STA $04
  SEP #$20
  LDX #$00
  LDA $73 : BNE ?.small
  LDA $19 : BNE ?.big
?.small:
  INX
?.big:
  LDA $187A : BEQ ?.foot
  INX #2
?.foot:
  LDA.l $03B660,x : STA $06 : STZ $07
  LDA.l $03B65C,x
  REP #$21
  AND #$00FF : ADC $96 : STA $02
  SEP #$20
  PLX
  RTL
`),

  // $08-$0F (x and y displacement, width, height) → the box of the sprite in slot X
  SetSpriteClippingAlternate: r(`
  LDA !14E0,x : XBA : LDA !E4,x
  REP #$21 : ADC $08 : STA $08 : SEP #$20
  LDA !14D4,x : XBA : LDA !D8,x
  REP #$21 : ADC $0A : STA $0A : SEP #$20
  RTL
`),

  // A = speed, $00/$02 = 16-bit shooter x/y minus target x/y → $00/$02 = x/y speed towards the target
  Aiming: r(`
  PHX : PHY : PHP
  SEP #$30
  STA $06 ; speed
  STZ $07 ; signs: bit 0 = x, bit 1 = y
  REP #$20
  LDA $00 : BPL ?.xp
  EOR #$FFFF : INC : STA $00
  BRA ?.xs
?.xp:
  SEP #$20 : LDA #$01 : TSB $07 : REP #$20 ; shooter right of the target: move left
?.xs:
  LDA $02 : BPL ?.yp
  EOR #$FFFF : INC : STA $02
  BRA ?.ys
?.yp:
  SEP #$20 : LDA #$02 : TSB $07 : REP #$20
?.ys:
?.shrink: ; both below $80
  LDA $00 : ORA $02 : AND #$FF80 : BEQ ?.small
  LSR $00 : LSR $02
  BRA ?.shrink
?.small:
  SEP #$20
  ; d^2 = x^2 + y^2 (x, y < $80)
  LDA $00 : STA $4202 : STA $4203 : NOP #4
  LDA $4216 : STA $08 : LDA $4217 : STA $09
  LDA $02 : STA $4202 : STA $4203 : NOP #4
  REP #$20
  LDA $4216 : CLC : ADC $08 : STA $08
  BNE ?.nonzero
  JMP ?.zero
?.nonzero:
  ; d = integer square root of $08 (< $8000): bit by bit, 8 bits
  SEP #$20
  STZ $0A ; result
  LDA #$80 : STA $0B ; bit
?.sq:
  LDA $0A : ORA $0B : STA $4202 : STA $4203 : NOP #4
  REP #$20 : LDA $4216 : CMP $08 : SEP #$20
  BEQ ?.take : BCS ?.skip
?.take:
  LDA $0B : TSB $0A
?.skip:
  LSR $0B : BNE ?.sq
  ; speed * x / d, speed * y / d
  LDA $06 : STA $4202 : LDA $00 : STA $4203 : NOP #4
  REP #$20 : LDA $4216 : STA $4204 : SEP #$20
  LDA $0A : STA $4206 : NOP #8
  LDA $4214 : STA $00
  LDA $06 : STA $4202 : LDA $02 : STA $4203 : NOP #4
  REP #$20 : LDA $4216 : STA $4204 : SEP #$20
  LDA $0A : STA $4206 : NOP #8
  LDA $4214 : STA $02
  LDA $07 : LSR : BCC ?.sx
  LDA $00 : EOR #$FF : INC : STA $00
?.sx:
  LDA $07 : AND #$02 : BEQ ?.sy
  LDA $02 : EOR #$FF : INC : STA $02
?.sy:
  PLP : PLY : PLX
  RTL
?.zero:
  SEP #$20
  STZ $00 : STZ $02
  PLP : PLY : PLX
  RTL
`),

  // internal: A (16 bit) = angle (9 bit, 000-1FF = 0-360°), Y = radius → A (16 bit) = radius * sin, signed;
  // the game's sine table at $07F7DB (words, $0100 at 90°); A/X/Y 16 bit, keeps X and Y
  PixiSin: r(`
  PHX : PHA
  AND #$00FF : ASL : TAX
  LDA.l $07F7DB,x : CMP #$0100 : BCC ?.mul
  TYA : AND #$00FF
  BRA ?.sign
?.mul:
  SEP #$20
  STA $4202 : TYA : STA $4203 : NOP #4
  REP #$20
  LDA $4216 : XBA : AND #$00FF ; (sin * radius) / 256
?.sign:
  TAX
  PLA : BIT #$0100 : BEQ ?.pos
  TXA : EOR #$FFFF : INC
  PLX
  RTL
?.pos:
  TXA
  PLX
  RTL
`),

  // $04 = angle (9 bit, 000-1FF = 0-360°), $06 = radius → $07 = x displacement (16 bit), radius * cos
  CircleX: r(`
  PHX : PHY : PHP
  REP #$30
  LDA $06 : AND #$00FF : TAY
  LDA $04 : CLC : ADC #$0080
  %PixiSin()
  STA $07
  PLP : PLY : PLX
  RTL
`),

  // $04 = angle (9 bit), $06 = radius → $09 = y displacement (16 bit), radius * sin
  CircleY: r(`
  PHX : PHY : PHP
  REP #$30
  LDA $06 : AND #$00FF : TAY
  LDA $04
  %PixiSin()
  STA $09
  PLP : PLY : PLX
  RTL
`),

  // A = angle low byte, carry = angle bit 8, Y = radius → $07/$09 = x/y displacement (16 bit)
  CircleXY: r(`
  PHX : PHY : PHP
  SEP #$20
  XBA : LDA #$00 : ROL : XBA ; angle (16 bit)
  REP #$30
  PHA
  TYA : AND #$00FF : TAY
  PLA : PHA
  %PixiSin()
  STA $09
  PLA : CLC : ADC #$0080
  %PixiSin()
  STA $07
  PLP : PLY : PLX
  RTL
`),
  // A = sprite number, carry set = custom sprite; $00/$01 = x/y offset, $02/$03 = x/y speed; a free slot
  // from the top: Y = slot and carry clear, or Y = $FF and carry set
  SpawnSprite: r(`
  PHX
  XBA
  LDX.b #!SprSize-1
${spawnSprite}`),
  // the same, searching the slots from $04 down
  SpawnSpriteSafe: r(`
  PHX
  XBA
  LDX $04
${spawnSprite}`),

  // A = smoke number, $00/$01 = x/y offset from the sprite in slot X, $02 = timer; Y = slot, carry set: none free
  SpawnSmoke: r(`
  LDY #$03
  XBA
?.loop:
  LDA $17C0,y : BEQ ?.found
  DEY : BPL ?.loop
  SEC
  RTL
?.found:
  XBA : STA $17C0,y
  LDA $02 : STA $17CC,y
  LDA !D8,x : CLC : ADC $01 : STA $17C4,y
  LDA !E4,x : CLC : ADC $00 : STA $17C8,y
  CLC
  RTL
`),

  // A = extended sprite number, $00/$01 = x/y offset from the sprite in slot X, $02/$03 = x/y speed;
  // nothing while the sprite is off screen or being eaten; Y = slot, carry set: not spawned
  SpawnExtended: r(`
  XBA
  LDA !15A0,x : ORA !186C,x : ORA !15D0,x : BNE ?.no
  LDY.b #!ExtendedSize-1
?.loop:
  LDA !extended_num,y : BEQ ?.found
  DEY : BPL ?.loop
?.no:
  SEC
  RTL
?.found:
  XBA : STA !extended_num,y
${addOff('$00', '!E4,x', '!14E0,x', '!extended_x_low,y', '!extended_x_high,y')}
${addOff('$01', '!D8,x', '!14D4,x', '!extended_y_low,y', '!extended_y_high,y')}
  LDA $02 : STA !extended_x_speed,y
  LDA $03 : STA !extended_y_speed,y
  CLC
  RTL
`),

  SpawnSmokeGeneric: r(`
  XBA
  LDY.b #!SmokeSize-1
?.loop:
  LDA !smoke_num,y : BEQ ?.found
  DEY : BPL ?.loop
  SEC
  RTL
?.found:
  XBA : STA !smoke_num,y
  LDA $00 : CLC : ADC $04 : STA !smoke_x_low,y
  LDA $01 : CLC : ADC $06 : STA !smoke_y_low,y
  LDA $02 : STA !smoke_timer,y
  CLC
  RTL
`),
  SpawnExtendedGeneric: genericSpawn('extended', '!ExtendedSize', '  LDA $02 : STA !extended_x_speed,y\n  LDA $03 : STA !extended_y_speed,y'),
  SpawnClusterGeneric: genericSpawn('cluster', '!ClusterSize', '  LDA #$01 : STA $18B8 ; run the cluster sprite code'),
  SpawnMinorExtendedGeneric: genericSpawn('minor_extended', '!MinorExtendedSize', '  LDA $02 : STA !minor_extended_x_speed,y\n  LDA $03 : STA !minor_extended_y_speed,y'),
  SpawnMinorExtendedOverwriteGeneric: genericSpawn('minor_extended', '!MinorExtendedSize', '  LDA $02 : STA !minor_extended_x_speed,y\n  LDA $03 : STA !minor_extended_y_speed,y', '$185D'),
  SpawnScoreGeneric: genericSpawn('score', '!ScoreSize', '  LDA #$30 : STA !score_y_speed,y', '$18F7'),
  SpawnSpinningCoinGeneric: genericSpawn('spinning_coin', '!SpinningCoinSize', '  LDA $03 : STA !spinning_coin_y_speed,y'),
  // ---- bounce sprites (slot X); tables of the game's bounce sprite code
  // $00/$01 = position on screen (layer of !bounce_table bit 7), $03 = size/x high bit, Y = OAM index; carry clear: not on screen
  BounceGetDrawInfo: r(`
  LDA #$02 : STA $03
  LDY #$00
  LDA !bounce_table,x : BPL ?.l1
  LDY #$04
?.l1:
  LDA !bounce_x_low,x : SEC : SBC.w $001A,y : STA $00
  LDA !bounce_x_high,x : SBC.w $001B,y : BEQ ?.xon
  INC $03
?.xon:
  LDA !bounce_y_low,x : SEC : SBC.w $001C,y : STA $01
  LDA !bounce_y_high,x : SBC.w $001D,y : BEQ ?.yon
  CLC
  RTL
?.yon:
  LDA.l $0291ED,x : TAY
  SEC
  RTL
`),
  // A = tile: one 16x16 tile at the bounce sprite with its properties
  BounceGenericDraw: r(`
  STA $02
  %BounceGetDrawInfo()
  BCC ?.r
  REP #$20 : LDA $00 : STA $0200,y : SEP #$20
  LDA $02 : STA $0202,y
  LDA !bounce_properties,x : ORA $64 : STA $0203,y
  TYA : LSR #2 : TAY
  LDA $03 : STA $0420,y
?.r:
  RTL
`),
  // speed change by direction (!bounce_table bits 0-1), as the original bounce sprites
  BounceSetSpeed: r(`
  TXY
  LDA !bounce_table,y : AND #$03 : TAX
  LDA !bounce_y_speed,y : CLC : ADC.l $0290CE,x : STA !bounce_y_speed,y
  LDA !bounce_x_speed,y : CLC : ADC.l $0290D2,x : STA !bounce_x_speed,y
  TYX
  RTL
`),
  // Mario's speed by the bounce direction ($80: unchanged)
  BounceSetMarioSpeed: r(`
  TXY
  LDA !bounce_table,y : AND #$03 : TAX
  LDA.l $0290D6,x : CMP #$80 : BEQ ?.y
  STA $7D
?.y:
  LDA.l $0290DA,x : CMP #$80 : BEQ ?.x
  STA $7B
?.x:
  TYX
  RTL
`),
  // the speed of the sprite in slot $0F by the bounce direction ($80: unchanged)
  BounceSetSpriteSpeed: r(`
  TXY
  LDA !bounce_table,y : AND #$03 : TAX
  LDA.l $0290D6,x : CMP #$80 : BEQ ?.y
  PHX : LDX $0F : STA !AA,x : PLX
?.y:
  LDA.l $0290DA,x : CMP #$80 : BEQ ?.x
  LDX $0F : STA !B6,x
?.x:
  TYX
  RTL
`),
  // $98-$9B and $1933: the block the bounce sprite is on (for $00BEB0 / ChangeMap16)
  BounceSetupMap16: r(`
  LDA !bounce_y_low,x : CLC : ADC #$08 : AND #$F0 : STA $98
  LDA !bounce_y_high,x : ADC #$00 : STA $99
  LDA !bounce_x_low,x : CLC : ADC #$08 : AND #$F0 : STA $9A
  LDA !bounce_x_high,x : ADC #$00 : STA $9B
  LDA !bounce_table,x : ASL : ROL : AND #$01 : STA $1933
  RTL
`),
  BounceUpdatePos: r(`
${subpixel('!bounce_y_speed,x', '!bounce_y_bits,x', '!bounce_y_low,x', '!bounce_y_high,x', 'y')}
${subpixel('!bounce_x_speed,x', '!bounce_x_bits,x', '!bounce_x_low,x', '!bounce_x_high,x', 'x')}
  RTL
`),

  // ---- cluster sprites
  ClusterGetDrawInfo: miscDrawInfo('cluster', 0x02ff50, 'CLC : ADC #$10'),
  // A = kind: 0 x+y gravity 3, 1 x+y, 2 x, 3 y, 4-7 x+y gravity 1-4 (speeds: y $1E52, x $1E66, fractions $1E7A/$1E8E)
  ClusterSpeed: r(`
  CMP #$04 : BCS ?.grav
  CMP #$00 : BEQ ?.xyg
  DEC : BEQ ?.xy
  DEC : BEQ ?.xonly
  BRA ?.y
?.grav:
  SBC #$03
  LDY !cluster_misc_1e52,x : BMI ?.add
  CPY #$40 : BPL ?.xy
?.add:
  CLC : ADC !cluster_misc_1e52,x : STA !cluster_misc_1e52,x
  BRA ?.xy
?.xyg:
  LDA !cluster_misc_1e52,x : BMI ?.g3
  CMP #$40 : BPL ?.xy
?.g3:
  CLC : ADC #$03 : STA !cluster_misc_1e52,x
?.xy:
  JSR ?.x
?.y:
${subpixel('!cluster_misc_1e52,x', '!cluster_misc_1e7a,x', '!cluster_y_low,x', '!cluster_y_high,x', 'yp')}
  RTL
?.xonly:
  JSR ?.x
  RTL
?.x: ; the x tables are the y tables + !ClusterSize
  PHX
  TXA : CLC : ADC.b #!ClusterSize : TAX
${subpixel('!cluster_misc_1e52,x', '!cluster_misc_1e7a,x', '!cluster_y_low,x', '!cluster_y_high,x', 'xp')}
  PLX
  RTS
`),

  // ---- extended sprites
  // Y = OAM index, $00 = x flip by speed, $01/$02 = position on screen; erased off screen ($02 = $F0 when hidden)
  ExtendedGetDrawInfo: r(`
  LDA.l $02A153,x : TAY
  LDA !extended_x_speed,x : AND #$80 : EOR #$80 : LSR : STA $00
  LDA !extended_x_low,x : SEC : SBC $1A : STA $01
  LDA !extended_x_high,x : SBC $1B : BNE ?.erase
  LDA !extended_y_low,x : SEC : SBC $1C : STA $02
  LDA !extended_y_high,x : SBC $1D : BNE ?.above
  LDA $02 : CMP #$F0 : BCS ?.erase
  RTL
?.above:
  CMP #$FF : BNE ?.erase
  LDA $02 : CMP #$C0 : BCC ?.erase
  CMP #$E0 : BCC ?.hide
  RTL
?.erase:
  STZ !extended_num,x
?.hide:
  LDA #$F0 : STA $02
  RTL
`),
  // A = kind as ClusterSpeed; x/y movement by the game's routines at $02B554/$02B560
  ExtendedSpeed: r(`
  CMP #$04 : BCS ?.grav
  CMP #$00 : BEQ ?.xyg
  DEC : BEQ ?.xy
  DEC : BEQ ?.x
  BRA ?.y
?.grav:
  SBC #$03
  LDY !extended_y_speed,x : BMI ?.add
  CPY #$40 : BPL ?.xy
?.add:
  CLC : ADC !extended_y_speed,x : STA !extended_y_speed,x
  BRA ?.xy
?.xyg:
  LDA !extended_y_speed,x : BMI ?.g3
  CMP #$40 : BCS ?.xy
?.g3:
  CLC : ADC #$03 : STA !extended_y_speed,x
?.xy:
${callBank2('$02B560', 'yd')}
?.x:
${callBank2('$02B554', 'xd')}
  RTL
?.y:
${callBank2('$02B560', 'yo')}
  RTL
`),
  // Mario touching the extended sprite (box 3,3 10x10) is hurt (the game's routine at $02A469)
  ExtendedHurt: r(`
  LDA !extended_x_low,x : CLC : ADC #$03 : STA $04
  LDA !extended_x_high,x : ADC #$00 : STA $0A
  LDA #$0A : STA $06 : STA $07
  LDA !extended_y_low,x : CLC : ADC #$03 : STA $05
  LDA !extended_y_high,x : ADC #$00 : STA $0B
  JSL $83B664 ; Mario's box
  JSL $83B72B
  BCC ?.r
  PHB : LDA #$02 : PHA : PLB
${callBank2('$02A469', 'h')}
  PLB
?.r:
  RTL
`),
  // $00/$02 = x/y offset, $01/$03 = width/height of the extended sprite's box: carry set when the cape touches it
  ExtendedCapeClipping: r(`
  LDA !extended_x_low,x : CLC : ADC $00 : STA $04
  LDA !extended_x_high,x : ADC #$00 : STA $0A
  LDA $01 : STA $06
  LDA !extended_y_low,x : CLC : ADC $02 : STA $05
  LDA !extended_y_high,x : ADC #$00 : STA $0B
  LDA $03 : STA $07
  LDA $13E9 : SEC : SBC #$02 : STA $00
  LDA $13EA : SBC #$00 : STA $08
  LDA #$14 : STA $02
  LDA $13EB : STA $01
  LDA $13EC : STA $09
  LDA #$10 : STA $03
  JSL $83B72B
  RTL
`),

  // ---- minor extended sprites
  MinorExtendedGetDrawInfo: miscDrawInfo('minor_extended', 0x028b78, 'ADC #$0F'),
  // A = kind: bit 0 fast (whole pixels) / slow (with fractions), bit 1 y / x
  MinorExtendedSpeed: r(`
  LSR : BCC ?.slow
  LSR : BCS ?.fy
${fullpixel('!minor_extended_x_speed,x', '!minor_extended_x_low,x', '!minor_extended_x_high,x', 'fx')}
  RTL
?.fy:
${fullpixel('!minor_extended_y_speed,x', '!minor_extended_y_low,x', '!minor_extended_y_high,x', 'fyp')}
  RTL
?.slow:
  LSR : BCS ?.sy
${subpixel('!minor_extended_x_speed,x', '!minor_extended_x_fraction,x', '!minor_extended_x_low,x', '!minor_extended_x_high,x', 'sx')}
  RTL
?.sy:
${subpixel('!minor_extended_y_speed,x', '!minor_extended_y_fraction,x', '!minor_extended_y_low,x', '!minor_extended_y_high,x', 'syp')}
  RTL
`),

  // ---- score sprites
  // $00/$01 = position on screen (layer !score_layer), Y = OAM index; carry clear: not on screen
  ScoreGetDrawInfo: r(`
  LDA !score_layer,x : ASL #2 : TAY
  REP #$20
  LDA.w $001C,y : STA $02
  LDA.w $001A,y : STA $04
  SEP #$21
  LDA !score_x_low,x : ADC #$0B
  PHP
  SEC : SBC $04
  LDA !score_x_high,x : SBC $05
  PLP
  ADC #$00 : BNE ?.no
  LDA !score_x_low,x : CMP $04
  LDA !score_x_high,x : SBC $05 : BNE ?.no
  LDA !score_y_low,x : CMP $02
  LDA !score_y_high,x : SBC $03 : BNE ?.no
  LDA !score_x_low,x : SEC : SBC $04 : STA $00
  LDA !score_y_low,x : SEC : SBC $02 : STA $01
  LDA.l $02AD9E,x : TAY
  SEC
  RTL
?.no:
  CLC
  RTL
`),
  // two 8x8 tiles $07/$08 with properties $09/$0A in front of everything; carry set when drawn
  ScoreGenericDraw: r(`
  %ScoreGetDrawInfo()
  BCC ?.r
  LDA $00 : STA $0200,y : ADC #$07 : STA $0204,y
  LDA $01 : STA $0201,y : STA $0205,y
  LDA $07 : STA $0202,y
  LDA $08 : STA $0206,y
  LDA $09 : ORA #$30 : STA $0203,y
  LDA $0A : ORA #$30 : STA $0207,y
  TYA : LSR #2 : TAY
  LDA #$00 : STA $0420,y : STA $0421,y
  SEC
?.r:
  RTL
`),
  // rises by its speed; carry set: A = highest position on screen, else the game's ($04)
  ScoreUpdateYPos: r(`
  BCS ?.set
  LDA #$04
?.set:
  STA $00
  PHX
  LDA !score_y_speed,x : LSR #4 : TAX
  LDA.l $02AD9A,x ; frames between steps by speed (the game's table)
  PLX
  AND $13
  BNE ?.r
  LDA !score_y_low,x : TAY
  SEC : SBC $1C : CMP $00 : BCC ?.r
  DEC !score_y_low,x
  TYA : BNE ?.r
  DEC !score_y_high,x
?.r:
  RTL
`),

  // ---- smoke sprites
  // $00/$01 = position on screen, Y = OAM index; carry clear: off screen
  SmokeGetDrawInfo: r(`
  LDA !smoke_x_low,x : SEC : SBC $1A : CMP #$F0 : BCS ?.no
  STA $00
  LDA !smoke_y_low,x : SEC : SBC $1C : STA $01
  LDA.l $0296B8,x : TAY
  SEC
  RTL
?.no:
  CLC
  RTL
`),
  // one tile $02 with properties $03, size/x high bit $04; carry set when drawn
  SmokeGenericDraw: r(`
  %SmokeGetDrawInfo()
  BCC ?.r
  REP #$20
  LDA $00 : STA $0200,y
  LDA $02 : STA $0202,y
  SEP #$20
  TYA : LSR #2 : TAY
  LDA $04 : STA $0420,y
  SEC
?.r:
  RTL
`),

  // ---- spinning coins
  SpinningCoinGetDrawInfo: r(`
  LDA !spinning_coin_layer,x : ASL #2 : TAY
  REP #$20
  LDA.w $001C,y : STA $02
  LDA.w $001A,y : STA $04
  SEP #$20
  LDA !spinning_coin_y_low,x : CMP $02
  LDA !spinning_coin_y_high,x : SBC $03 : BNE ?.no
  LDA !spinning_coin_x_low,x : SBC $04 : CMP #$F8 : BCS ?.kill
  STA $00
  LDA !spinning_coin_y_low,x : SEC : SBC $02 : STA $01
  LDA.l $0299E9,x : TAY
  SEC
  RTL
?.kill:
  STZ !spinning_coin_num,x
?.no:
  CLC
  RTL
`),
  SpinningCoinUpdateYPos: r(`
${subpixel('!spinning_coin_y_speed,x', '!spinning_coin_y_bits,x', '!spinning_coin_y_low,x', '!spinning_coin_y_high,x', 'y')}
  RTL
`),
  // internal: the block at $98-$9B on layer $1933 as the game's $00BEB0 sets it up: [$6B]/[$6E] = Map16
  // low/high bytes of its screen, Y = index there, $06/$07 = VRAM address, $08/$0A = camera, $0C/$0E =
  // position; carry set outside the level. Returns with A/X/Y 16 bit.
  PixiMap16Pos: r(`
  REP #$30
  LDA $9A : STA $0C
  LDA $98 : STA $0E
  LDA #$0000
  SEP #$20
  LDA $5B : STA $09
  LDA $1933 : BEQ ?.l1
  LSR $09
?.l1:
  LDY $0E
  LDA $09 : AND #$01 : BEQ ?.h
  LDA $9B : STA $00 : LDA $99 : STA $9B : LDA $00 : STA $99 ; vertical: x and y screens swapped
  LDY $0C
?.h:
  REP #$20 : TYA : CMP.l $${hx(LEVEL_MAX_Y)} : LDA #$0000 : SEP #$20 ; inside the level (taller ones too, levelheight.ts)
  BCC ?.in
  REP #$30
  SEC
  RTL
?.in:
  LDA $1933 : ASL : TAX
  LDA.l $00BEA8,x : STA $65
  LDA.l $00BEA9,x : STA $66
  STZ $67
  LDA $1925 : ASL : TAY
  LDA [$65],y : STA $04 : INY
  LDA [$65],y : STA $05
  STZ $06
  LDA $9B : STA $07 : ASL : CLC : ADC $07 : TAY
  LDA [$04],y : STA $6B : STA $6E : INY
  LDA [$04],y : STA $6C : STA $6F
  LDA #$7E : STA $6D : INC : STA $70
  ; VRAM address of the 16x16 tile
  LDA $09 : AND #$01 : BEQ ?.vh
  LDA $99 : LSR
  LDA $9B : AND #$01
  BRA ?.vr
?.vh:
  LDA $9B : LSR
  LDA $99 : AND #$01 ; the tilemap's rows modulo 64
?.vr:
  ROL : ASL #2 : ORA #$20 : STA $04
  CPX #$0000 : BEQ ?.l1v
  CLC : ADC #$10 : STA $04
?.l1v:
  LDA $98 : AND #$F0 : CLC : ASL : ROL : STA $05
  ROL : AND #$03 : ORA $04 : STA $06
  LDA $9A : AND #$F0 : LSR #3 : STA $04
  LDA $05 : AND #$C0 : ORA $04 : STA $07
  ; camera of the layer
  REP #$20
  LDA $09 : AND #$0001 : BNE ?.cv
  LDA $1A : SEC : SBC #$0080 : TAX
  LDY $1C
  LDA $1933 : BEQ ?.cs
  LDX $1E
  LDA $20 : SEC : SBC #$0080 : TAY
  BRA ?.cs
?.cv:
  LDX $1A
  LDA $1C : SEC : SBC #$0080 : TAY
  LDA $1933 : BEQ ?.cs
  LDA $1E : SEC : SBC #$0080 : TAX
  LDY $20
?.cs:
  STX $08 : STY $0A
  ; index in the screen's Map16 data
  LDA $98 : AND.l $${hx(LEVEL_ROW_MASK)} : STA $04
  LDA $9A : LSR #4 : AND #$000F : ORA $04 : TAY
  CLC
  RTL
`),

  // A (16 bit) = Map16 tile for the block at $98-$9B on layer $1933 ($1933): written to the level and shown
  // (the game's $00C0FB); carry clear when done, set outside the level
  ChangeMap16: r(`
  PHP
  REP #$30
  PHX : PHY : PHB : PHA
  %PixiMap16Pos()
  BCS ?.out
  PLA : PHA
  SEP #$20 : STA [$6B],y : XBA : STA [$6E],y : REP #$20
  PLA : ASL : TAY
  PHK : PEA.w ?.shown-1
  PEA $804C ; RTL at $00804D
  JML $80C0FB
?.shown:
  REP #$30
  PLB : PLY : PLX
  PLP
  CLC
  RTL
?.out:
  PLA : PLB : PLY : PLX
  PLP
  SEC
  RTL
`),

  // the Map16 tile of the block at $98-$9B on layer $1933: A = tile (low byte, all of it with 16-bit A),
  // Y = high byte; $FFFF outside the level
  GetMap16: r(`
  PHP
  REP #$30
  PHX : PHB
  %PixiMap16Pos()
  BCS ?.out
  SEP #$20 : LDA [$6E],y : XBA : LDA [$6B],y
  REP #$20
  PHA : XBA : AND #$00FF : TAY : PLA
  PLB : PLX
  PLP
  RTL
?.out:
  LDA #$FFFF : TAY
  PLB : PLX
  PLP
  RTL
`),
};
