// Standard shared routines of GPS (Gopher Popcorn Stew, the block tool by p4plus2, later TheBiob, GHB,
// Arinsu and others), called from blocks as %name(). Same names, inputs and outputs as GPS 1.4.5; written
// for the editor after the original game's routines, which are called where the game has them. The project's
// own routines/ come first. ChangeMap16/GetMap16/PixiMap16Pos are the custom sprite routines (pixiroutines.ts).

import { ROUTINES } from './pixiroutines.ts';

const r = (s: string) => '?main:\n' + s.replace(/^\n/, '');

// the game's subroutine at addr (ends with RTS) called through an RTL of its bank (bank 0: $00804D, 2: $02B889)
const call = (addr: number, label: string) => {
  const rtl = (addr >> 16) === 0 ? '$804C' : '$B888';
  return `  PHK : PEA.w ?.${label}-1\n  PEA.w ${rtl}\n  JML $${addr.toString(16).toUpperCase().padStart(6, '0')}\n?.${label}:`;
};

// smoke-type effect at the block ($98/$9A), on layer 2 relative to it
const blockEffect = (num: string, timer: string) => r(`
  PHY
  LDY #$03
?.loop:
  LDA $17C0,y : BEQ ?.found
  DEY : BPL ?.loop
  PLY
  RTL
?.found:
  LDA #${num} : STA $17C0,y
  LDA $9A : AND #$F0 : STA $17C8,y
  LDA $98 : AND #$F0 : STA $17C4,y
  LDA $1933 : BEQ ?.l1
  LDA $9A : SEC : SBC $26 : AND #$F0 : STA $17C8,y
  LDA $98 : SEC : SBC $28 : AND #$F0 : STA $17C4,y
?.l1:
  LDA #${timer} : STA $17CC,y
  PLY
  RTL
`);

// the sprite in slot A to a position next to the block
const moveSpawn = (y: string, x: string) => r(`
  PHX
  TAX
${y}
${x}
  PLX
  RTL
`);
const blockX = `  LDA $9A : AND #$F0 : STA !E4,x
  LDA $9B : STA !14E0,x`;

// shatters the block (now air): the game's $028663 with A = 0 (brown pieces) or 2 (rainbow)
const shatter = (kind: number) => r(`
  PHY
  LDA $98 : PHA : LDA $99 : PHA : LDA $9A : PHA : LDA $9B : PHA
  LDA #$02 : STA $9C
  JSL $00BEB0 ; air
  REP #$20
  PLA : XBA : STA $9A ; (pulled high, low)
  PLA : XBA : STA $98
  LDA $1933 : AND #$00FF : BEQ ?.l1
  LDA $9A : SEC : SBC $26 : STA $9A
  LDA $98 : SEC : SBC $28 : STA $98
?.l1:
  SEP #$20
  PHB : LDA #$02 : PHA : PLB
  LDA #$${kind.toString(16).padStart(2, '0')}
  JSL $028663
  PLB
  PLY
  RTL
`);

// spawn a normal or custom sprite (carry set): A = number; carry clear and A = slot, or carry set (no free slot)
const spawnSprite = (block: boolean) => r(`
  ${block ? 'PHX\n  ' : ''}XBA
  LDX #$0B
?.loop:
  LDA !14C8,x : BEQ ?.found
  DEX : BPL ?.loop
${block ? `  DEC $1861 : BPL ?.alt ; no free slot: one of the last two
  LDA #$01 : STA $1861
?.alt:
  LDA $1861 : PHP : CLC : ADC #$0A : PLP : TAX
?.found:
  STX $185E` : `  SEC
  TXA
  RTL
?.found:`}
  XBA : STA !9E,x
  JSL $07F7D2 ; keeps the carry
  BCC ?.vanilla
  LDA !9E,x : STA !new_sprite_num,x
  JSL $0187A7
  LDA #$08 : STA !extra_bits,x
?.vanilla:
  LDA #$01 : STA !14C8,x
  CLC
  TXA
  ${block ? 'PLX\n  ' : ''}RTL
`);

export const GPS_ROUTINES: Record<string, string> = {
  // the custom sprite routines they build on
  PixiMap16Pos: ROUTINES.PixiMap16Pos,
  ChangeMap16: ROUTINES.ChangeMap16,
  GetMap16: ROUTINES.GetMap16,

  // X (16 bit) = Map16 tile for the block at $98-$9B (layer $1933); swaps $99/$9B in vertical levels
  change_map16: r(`
  PHP
  REP #$30
  TXA
  %ChangeMap16()
  PLP
  RTL
`),
  // A = Map16 tile (low byte, all of it with 16-bit A), Y = high byte; $FFFF outside the level
  get_map16: r(`
  %GetMap16()
  RTL
`),
  // vertical levels: swaps the x and y high bytes of the block position back
  swap_XY: r(`
  PHP
  SEP #$20
  LDA $5B : LSR : BCC ?.r
  LDA $99 : XBA : LDA $9B : STA $99 : XBA : STA $9B
?.r:
  PLP
  RTL
`),
  // the block becomes air (tile 025, the game's $00BEB0 with $9C = 2); keeps Y
  erase_block: r(`
  LDA #$02 : STA $9C
  PHY
  JSL $00BEB0
  PLY
  RTL
`),
  shatter_block: shatter(0),
  rainbow_shatter_block: shatter(2),
  // puff of smoke at the block
  create_smoke: r(`
  PHP
  SEP #$30
  PHX
  LDX #$03
?.loop:
  LDA $17C0,x : BNE ?.next
  INC $17C0,x
  LDA #$1B : STA $17CC,x
  LDA $98 : AND #$F0 : STA $17C4,x
  LDA $9A : AND #$F0 : STA $17C8,x
  BRA ?.done
?.next:
  DEX : BPL ?.loop
?.done:
  PLX
  PLP
  RTL
`),
  // glitter at the block; keeps Y
  glitter: blockEffect('$05', '$10'),
  // kills sprites standing on the block, as a hit from below does (the game's $0286ED)
  kill_sprite: r(`
${call(0x0286ed, 'k')}
  RTL
`),
  // the current player gets 10 points
  give_points: r(`
  LDA $0DB3 : ASL : ADC $0DB3 : TAX
  LDA $0F34,x : CLC : ADC #$01 : STA $0F34,x
  LDA $0F35,x : ADC #$00 : STA $0F35,x
  LDA $0F36,x : ADC #$00 : STA $0F36,x
  RTL
`),
  // the block stays collected (the game's item memory, $00C00D)
  set_item_memory: r(`
  PHP
${call(0x00c00d, 'm')}
  PLP
  RTL
`),
  // A = item sprite as the game spawns it from blocks ($05, the game's $02887D)
  spawn_item_sprite: r(`
  STA $05
  LDA #$0F : TRB $98 : TRB $9A
  PHB : LDA #$02 : PHA : PLB
  JSL $02887D
  PLB
  RTL
`),
  // A = bounce sprite number, X = tile it becomes ($9C), Y = direction; $03-$04 = Map16 tile for X >= $1C
  // (custom bounce block patch); Y = slot used
  spawn_bounce_sprite: r(`
  STA $05 : STY $06 : STX $07
  LDA #$0F : TRB $9A : TRB $98
  LDY #$03
?.free:
  LDA $1699,y : BEQ ?.found
  DEY : BPL ?.free
  DEC $18CD : BPL ?.alt ; none free: the oldest
  LDA #$03 : STA $18CD
?.alt:
  LDY $18CD
  LDA $1699,y : CMP #$07 : BNE ?.taken
  ; a turn block still turning: put it back first
  LDA $02 : PHA : LDA $03 : PHA : LDA $04 : PHA : LDA $05 : PHA : LDA $06 : PHA : LDA $07 : PHA
  LDA $98 : PHA : LDA $99 : PHA : LDA $9A : PHA : LDA $9B : PHA
  LDA $16A5,y : STA $9A
  LDA $16AD,y : STA $9B
  LDA $16A1,y : CLC : ADC #$0C : AND #$F0 : STA $98
  LDA $16A9,y : ADC #$00 : STA $99
  LDA $16C1,y : STA $9C
  JSL $00BEB0
  PLA : STA $9B : PLA : STA $9A : PLA : STA $99 : PLA : STA $98
  PLA : STA $07 : PLA : STA $06 : PLA : STA $05 : PLA : STA $04 : PLA : STA $03 : PLA : STA $02
?.taken:
  LDY $18CD
?.found:
  LDA $05 : STA $1699,y
  LDA #$00 : STA $169D,y
  LDA $9A : STA $16A5,y
  LDA $9B : STA $16AD,y
  LDA $98 : STA $16A1,y
  LDA $99 : STA $16A9,y
  LDA $1933 : LSR : ROR : STA $08 ; layer in bit 7
  LDX $06
  LDA.l $02873A,x : STA $16B1,y ; speeds by direction
  LDA.l $02873E,x : STA $16B5,y
  TXA : ORA $08 : STA $16C9,y
  LDA $07 : STA $16C1,y
  LDA #$08 : STA $16C5,y
  LDA #$00 : STA $1901,y
  LDA $07 : CMP #$1C : BCC ?.std
  TYX
  LDA $03 : STA !bounce_map16_low,x
  LDA $04 : STA !bounce_map16_high,x
  LDA $07 : CMP #$FF : BNE ?.std
  LDA $02 : STA !bounce_sprite_tile,x
?.std:
  PHY
${call(0x0286ed, 'i')}
  PLY
  RTL
`),
  // Y = bounce slot: the turn block it came from is put back
  reset_turn_block: r(`
  LDA $98 : PHA : LDA $99 : PHA : LDA $9A : PHA : LDA $9B : PHA
  LDA $04 : PHA : LDA $05 : PHA : LDA $06 : PHA : LDA $07 : PHA
  LDA $16A5,y : STA $9A
  LDA $16AD,y : STA $9B
  LDA $16A1,y : CLC : ADC #$0C : AND #$F0 : STA $98
  LDA $16A9,y : ADC #$00 : STA $99
  LDA $16C1,y : STA $9C
  JSL $00BEB0
  PLA : STA $07 : PLA : STA $06 : PLA : STA $05 : PLA : STA $04
  PLA : STA $9B : PLA : STA $9A : PLA : STA $99 : PLA : STA $98
  RTL
`),
  spawn_sprite: spawnSprite(false),
  // the same, taking one of the last two slots when none is free; $185E = slot
  spawn_sprite_block: spawnSprite(true),
  move_spawn_into_block: moveSpawn(`  LDA $98 : AND #$F0 : STA !D8,x
  LDA $99 : STA !14D4,x`, blockX),
  move_spawn_above_block: moveSpawn(`  LDA $98 : AND #$F0 : SEC : SBC #$10 : STA !D8,x
  LDA $99 : SBC #$00 : STA !14D4,x`, blockX),
  move_spawn_below_block: moveSpawn(`  LDA $98 : AND #$F0 : CLC : ADC #$10 : STA !D8,x
  LDA $99 : ADC #$00 : STA !14D4,x`, blockX),
  // $00/$01 = x/y offset (signed)
  move_spawn_relative: moveSpawn(`  LDA $98 : AND #$F0 : CLC : ADC $01 : STA !D8,x
  LDA #$00 : BIT $01 : BPL ?.yp
  DEC
?.yp:
  ADC $99 : STA !14D4,x`, `  LDA $9A : AND #$F0 : CLC : ADC $00 : STA !E4,x
  LDA #$00 : BIT $00 : BPL ?.xp
  DEC
?.xp:
  ADC $9B : STA !14E0,x`),
  move_spawn_to_player: moveSpawn(`  LDA $96 : CLC : ADC #$10 : STA !D8,x
  LDA $97 : ADC #$00 : STA !14D4,x`, `  LDA $94 : STA !E4,x
  LDA $95 : STA !14E0,x`),
  // the sprite in slot A to the position of the sprite in slot X
  move_spawn_to_sprite: r(`
  PHY
  TAY
  LDA !D8,x : STA.w !D8,y
  LDA !14D4,x : STA !14D4,y
  LDA !E4,x : STA.w !E4,y
  LDA !14E0,x : STA !14E0,y
  PLY
  RTL
`),
  // in SpriteV/SpriteH: the block the sprite touches ($0A-$0D) becomes the block position, with its layer
  sprite_block_position: r(`
  LDA $0A : AND #$F0 : STA $9A
  LDA $0B : STA $9B
  LDA $0C : AND #$F0 : STA $98
  LDA $0D : STA $99
  LDA $185E : STA $1933
  RTL
`),
  // in SpriteV/SpriteH: the sprite's position (16 bit) in $00/$02, relative to layer 2 when the block is there
  layer2_sprite_position: r(`
  PHP
  REP #$20
  STZ $00 : STZ $02
  LDA $185E : LSR : BCC ?.l1
  LDA $26 : STA $00
  LDA $28 : STA $02
?.l1:
  SEP #$20
  LDA !E4,x : SEC : SBC $00 : STA $00
  LDA !14E0,x : SBC $01 : STA $01
  LDA !D8,x : SEC : SBC $02 : STA $02
  LDA !14D4,x : SBC $03 : STA $03
  PLP
  RTL
`),
  // carry set when a dropped or kicked sprite moves sideways at speed 8 or more
  check_sprite_kicked_horizontal: r(`
  LDA !14C8,x : CMP #$09 : BEQ ?.moving
  CMP #$0A : BEQ ?.moving
  CLC
  RTL
?.moving:
  LDA !B6,x : BPL ?.abs
  EOR #$FF : INC
?.abs:
  CMP #$08
  RTL
`),
  // carry set when a dropped or kicked sprite moves up into the block
  check_sprite_kicked_vertical: r(`
  LDA !AA,x : BPL ?.no
  LDA !14C8,x : CMP #$09 : BEQ ?.yes
  CMP #$0A : BEQ ?.yes
?.no:
  CLC
  RTL
?.yes:
  SEC
  RTL
`),
  // A (16 bit) = level: Mario goes there as through a pipe (the screen's exit); returns with 8-bit A/X/Y
  teleport: r(`
  PHX : PHY
  PHA
  STZ $88
  SEP #$30
  LDX $95
  LDA $5B : LSR : BCC ?.h
  LDX $97
?.h:
  PLA : STA $19B8,x
  PLA : ORA #$04 : STA $19D8,x
  LDA #$06 : STA $71
  PLY : PLX
  RTL
`),
};

// defines GPS gives blocks besides the sprite tables (defines.asm of GPS 1.4.5, LoROM)
export const GPS_DEFINES = `
!RAM_BounceMap16Low = $7FC275
!RAM_BounceMap16High = $7FC279
!RAM_BounceTileTbl = $7FC27D
!bounce_map16_low = !RAM_BounceMap16Low
!bounce_map16_high = !RAM_BounceMap16High
!bounce_sprite_tile = !RAM_BounceTileTbl
!sprite_extra_bits = $7FAB10
!sprite_new_code_flag = $7FAB1C
!sprite_extra_prop1 = $7FAB28
!sprite_extra_prop2 = $7FAB34
!sprite_custom_num = $7FAB9E
macro assert_lm_version(version, define)
  !lm_version = 0
  !<define> = 0
endmacro
`;
