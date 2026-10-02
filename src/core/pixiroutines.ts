// Shared routines for custom sprites (PIXI format), called as %Name() (see docs/pixi.md). Same names,
// inputs and outputs as PIXI's; written for the editor after the original game's routines, whose
// tables are read from the ROM. Each routine is entered with JSL and ends with RTL; only macro-local
// (?) labels, as the file is included inside a macro. DB is the caller's unless stated.

const r = (s: string) => '?main:\n' + s.replace(/^\n/, '');

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
  JSL $07F7D2 ; keeps the carry
  BCC ?.vanilla
  LDA !9E,x : STA !new_sprite_num,x
  LDA $02 : PHA : REP #$20 : LDA $00 : PHA : SEP #$20
  JSL $0187A7
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
  JSL $01ACF9
  STA $4204 : LDA $148E : STA $4205 ; 16-bit random number ...
  PLA : INC : STA $4206 ; ... divided by A+1
  NOP #4 : BRA ?.wait
?.wait:
  NOP #2
  LDA $4216 ; remainder
  PLP : PLX
  RTL
?.mask:
  JSL $01ACF9
  PLA : AND $148D
  PLP : PLX
  RTL
`),

  // star kill: the sprite falls off screen, Mario gets points for consecutive kills
  Star: r(`
  PHB : PHK : PLB
  JSL $01AB6F ; contact star
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
  JSL $02ACE5 ; points
  LDY $18D2
  LDA ?.sfx,y : STA $1DF9
  PLB
  RTL
?.sfx: db $00,$13,$14,$15,$16,$17,$18,$19,$03
`),

  // A = tiles - 1, Y = tile size ($00 8x8, $02 16x16, $FF keep): the game's routine at $01B7B3
  FinishOAMWrite: r(`
  JML $01B7B3
`),

  // the sprite in slot X becomes sprite A (carry set: custom sprite) in its init state
  ReplaceSelf: r(`
  XBA
  JSL $07F722 ; clear the tables
  XBA
  BCS ?.custom
  STA !9E,x
  STA !new_sprite_num,x
  JSL $07F78B ; tweakers of the original sprite
  LDA #$01 : STA !14C8,x
  LDA #$00 : STA !extra_bits,x
  RTL
?.custom:
  STA !new_sprite_num,x
  LDA $02 : PHA : REP #$20 : LDA $00 : PHA : SEP #$20
  JSL $0187A7
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
  JSL $02A9DE ; free slot
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
  JSL $03B69F ; clipping of the sprite
  LDA $13E9 : SEC : SBC #$02 : STA $00
  LDA $13EA : SBC #$00 : STA $08
  LDA #$14 : STA $02
  LDA $13EB : STA $01
  LDA $13EC : STA $09
  LDA #$10 : STA $03
  JML $03B72B ; contact check
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
  JSL $03B69F
  JSL $03B72B
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
};
