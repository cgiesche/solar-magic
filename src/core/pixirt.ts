// Runtime of custom sprites in PIXI format (see docs/pixi.md), written for the editor: the hijacks and
// dispatch code, the defines resources see (those of PIXI's sa1def.asm for a LoROM without SA-1) and
// the macros of the per-type _header.asm files. The shared routines are in pixiroutines.ts.
//
// Sprite data loader (bank 2): entries are 3 bytes plus extra bytes, their size comes from the size
// table at $0EF30C. The loop indexes the data with 8-bit Y, so once Y passes $80 the pointer $CE moves
// forward (and is put back when the loop ends). Custom sprites (extra bits value 2/3) keep their
// extra bits in !extra_bits, their number in !new_sprite_num and get acts like, tweakers and extra
// property bytes from the sprite table; INIT/MAIN and the custom status pointers are called like PIXI
// does (DB = $01, A = status, return through the RTS at $0185C2).

export type SpriteFolder = 'sprites' | 'shooters' | 'generators' | 'cluster' | 'extended' | 'minorextended' | 'bounce' | 'smoke' | 'spinningcoin' | 'score';

// numbers of the custom sprites of a misc type start after the original ones
export const MISC_OFFSET: Partial<Record<SpriteFolder, number>> = {
  cluster: 0x09, extended: 0x13, minorextended: 0x0c, smoke: 0x06, spinningcoin: 0x02, bounce: 0x08, score: 0x16,
};

const h = (n: number, w = 2) => '$' + n.toString(16).toUpperCase().padStart(w, '0');

// ---------------------------------------------------------------- defines (sa1def.asm, LoROM)

const SPRITE_TABLES: [string, number][] = [
  ['sprite_num', 0x9e], ['sprite_speed_y', 0xaa], ['sprite_speed_x', 0xb6], ['sprite_misc_c2', 0xc2], ['sprite_y_low', 0xd8], ['sprite_x_low', 0xe4],
  ['sprite_status', 0x14c8], ['sprite_y_high', 0x14d4], ['sprite_x_high', 0x14e0], ['sprite_speed_y_frac', 0x14ec], ['sprite_speed_x_frac', 0x14f8],
  ['sprite_misc_1504', 0x1504], ['sprite_misc_1510', 0x1510], ['sprite_misc_151c', 0x151c], ['sprite_misc_1528', 0x1528], ['sprite_misc_1534', 0x1534],
  ['sprite_misc_1540', 0x1540], ['sprite_misc_154c', 0x154c], ['sprite_misc_1558', 0x1558], ['sprite_misc_1564', 0x1564], ['sprite_misc_1570', 0x1570],
  ['sprite_misc_157c', 0x157c], ['sprite_blocked_status', 0x1588], ['sprite_misc_1594', 0x1594], ['sprite_off_screen_horz', 0x15a0], ['sprite_misc_15ac', 0x15ac],
  ['sprite_slope', 0x15b8], ['sprite_off_screen', 0x15c4], ['sprite_being_eaten', 0x15d0], ['sprite_obj_interact', 0x15dc], ['sprite_oam_index', 0x15ea],
  ['sprite_oam_properties', 0x15f6], ['sprite_misc_1602', 0x1602], ['sprite_misc_160e', 0x160e], ['sprite_index_in_level', 0x161a], ['sprite_misc_1626', 0x1626],
  ['sprite_behind_scenery', 0x1632], ['sprite_misc_163e', 0x163e], ['sprite_in_water', 0x164a], ['sprite_tweaker_1656', 0x1656], ['sprite_tweaker_1662', 0x1662],
  ['sprite_tweaker_166e', 0x166e], ['sprite_tweaker_167a', 0x167a], ['sprite_tweaker_1686', 0x1686], ['sprite_off_screen_vert', 0x186c], ['sprite_misc_187b', 0x187b],
  ['sprite_tweaker_190f', 0x190f], ['sprite_misc_1fd6', 0x1fd6], ['sprite_cape_disable_time', 0x1fe2], ['sprite_load_table', 0x1938],
];
const PIXI_TABLES: [string, number][] = [
  ['extra_bits', 0x7fab10], ['new_code_flag', 0x7fab1c], ['extra_prop_1', 0x7fab28], ['extra_prop_2', 0x7fab34], ['new_sprite_num', 0x7fab9e],
  ['extra_byte_1', 0x7fab40], ['extra_byte_2', 0x7fab4c], ['extra_byte_3', 0x7fab58], ['extra_byte_4', 0x7fab64],
  ['shooter_extra_byte_1', 0x7fac00], ['shooter_extra_byte_2', 0x7fac08], ['shooter_extra_byte_3', 0x7fac10],
];
const RAW = ['9E', 'AA', 'B6', 'C2', 'D8', 'E4', '14C8', '14D4', '14E0', '14EC', '14F8', '1504', '1510', '151C', '1528', '1534', '1540', '154C', '1558',
  '1564', '1570', '157C', '1588', '1594', '15A0', '15AC', '15B8', '15C4', '15D0', '15DC', '15EA', '15F6', '1602', '160E', '161A', '1626', '1632', '163E', '164A',
  '1656', '1662', '166E', '167A', '1686', '186C', '187B', '190F', '1938', '1FD6', '1FE2',
  '7FAB10', '7FAB1C', '7FAB28', '7FAB34', '7FAB9E', '7FAB40', '7FAB4C', '7FAB58', '7FAB64', '7FAC00', '7FAC08', '7FAC10'];
// tables of the other sprite types (addresses in the low 8 KB of WRAM)
const MISC_TABLES: Record<string, [string, number][]> = {
  shoot: [['num', 0x1783], ['y_low', 0x178b], ['y_high', 0x1793], ['x_low', 0x179b], ['x_high', 0x17a3], ['timer', 0x17ab]],
  cluster: [['num', 0x1892], ['y_low', 0x1e02], ['y_high', 0x1e2a], ['x_low', 0x1e16], ['x_high', 0x1e3e], ['misc_0f4a', 0x0f4a], ['misc_0f5e', 0x0f5e],
    ['misc_0f72', 0x0f72], ['misc_0f86', 0x0f86], ['misc_0f9a', 0x0f9a], ['misc_1e52', 0x1e52], ['misc_1e66', 0x1e66], ['misc_1e7a', 0x1e7a], ['misc_1e8e', 0x1e8e]],
  extended: [['num', 0x170b], ['y_low', 0x1715], ['y_high', 0x1729], ['x_low', 0x171f], ['x_high', 0x1733], ['x_speed', 0x1747], ['y_speed', 0x173d],
    ['x_fraction', 0x175b], ['y_fraction', 0x1751], ['table', 0x1765], ['timer', 0x176f], ['behind', 0x1779], ['table_1', 0x1765], ['table_2', 0x198c],
    ['table_3', 0x1996], ['table_4', 0x19a0], ['table_5', 0x19aa]],
  minor_extended: [['num', 0x17f0], ['y_low', 0x17fc], ['y_high', 0x1814], ['x_low', 0x1808], ['x_high', 0x18ea], ['x_speed', 0x182c], ['y_speed', 0x1820],
    ['x_fraction', 0x1844], ['y_fraction', 0x1838], ['timer', 0x1850], ['table_1', 0x1938], ['table_2', 0x1944], ['table_3', 0x1950]],
  smoke: [['num', 0x17c0], ['y_low', 0x17c4], ['x_low', 0x17c8], ['timer', 0x17cc], ['table_1', 0x195c], ['table_2', 0x1960], ['table_3', 0x1964],
    ['y_high', 0x1960], ['x_high', 0x1964]],
  spinning_coin: [['num', 0x17d0], ['y_low', 0x17d4], ['y_speed', 0x17d8], ['y_bits', 0x17dc], ['x_low', 0x17e0], ['layer', 0x17e4], ['y_high', 0x17e8],
    ['x_high', 0x17ec], ['table_1', 0x1974], ['table_2', 0x1978], ['table_3', 0x197c]],
  score: [['num', 0x16e1], ['y_low', 0x16e7], ['x_low', 0x16ed], ['x_high', 0x16f3], ['y_high', 0x16f9], ['y_speed', 0x16ff], ['layer', 0x1705],
    ['table_1', 0x1980], ['table_2', 0x1986]],
  bounce: [['num', 0x1699], ['init', 0x169d], ['y_low', 0x16a1], ['x_low', 0x16a5], ['y_high', 0x16a9], ['x_high', 0x16ad], ['y_speed', 0x16b1],
    ['x_speed', 0x16b5], ['x_bits', 0x16b9], ['y_bits', 0x16bd], ['map16_tile', 0x16c1], ['timer', 0x16c5], ['table', 0x16c9], ['table_1', 0x16c9],
    ['properties', 0x1901], ['table_2', 0x1968], ['table_3', 0x196c], ['table_4', 0x1970], ['map16_low', 0x16c1], ['map16_high', 0x1968]],
};

// The defines and macros of PIXI's sa1def.asm (LoROM, no SA-1), included in every file
export function pixiDefines(): string {
  const out = [
    '; generated by SMW Editor: the defines of PIXI\'s sa1def.asm (LoROM, no SA-1)',
    'lorom',
    '!sa1 = 0', '!SA1 = 0', '!SA_1 = 0', '!fullsa1 = 0',
    '!Base1 = $0000', '!Base2 = $0000', '!dp = $0000', '!addr = $0000',
    '!BankA = $7E0000', '!BankB = $800000', '!bank = $800000', '!Bank8 = $80', '!bank8 = $80',
    '!SprSize = $0C', '!EXLEVEL = 0', '!PerLevel = 0', '!Disable255SpritesPerLevel = 0', '!CustomBit = $08',
    '!More_ExSprite = 0', '!ExSprSize = $07', '!FireballSprSize = $09', '!GenStart = $D0',
    ...Object.entries({ Cluster: 'cluster', Extended: 'extended', MinorExtended: 'minorextended', Smoke: 'smoke', SpinningCoin: 'spinningcoin', Bounce: 'bounce', Score: 'score' })
      .map(([n, k]) => `!${n}Offset = ${h(MISC_OFFSET[k as SpriteFolder]!)}`),
    '!ClusterSize = $14', '!ExtendedSize = $08', '!MinorExtendedSize = $0C', '!SmokeSize = $04', '!SpinningCoinSize = $04', '!BounceSize = $04', '!ScoreSize = $06',
    ...SPRITE_TABLES.map(([n, a]) => `!${n} = ${h(a, a > 0xff ? 4 : 2)}`),
    ...PIXI_TABLES.map(([n, a]) => `!${n} = ${h(a, 6)}`),
    ...RAW.map((n) => `!${n} = $${n}`),
    '!7FAF00 = $1938',
    ...Object.entries(MISC_TABLES).flatMap(([p, t]) => t.map(([n, a]) => `!${p}_${n} = ${h(a, 4)}`)),
    // names a few headers of PIXI use for shooters
    '!shooter_num = !shoot_num', '!shooter_y_low = !shoot_y_low', '!shooter_y_high = !shoot_y_high',
    '!shooter_x_low = !shoot_x_low', '!shooter_x_high = !shoot_x_high', '!shooter_timer = !shoot_timer',
    'macro define_sprite_table(name, addr, addr_sa1)', '  !<name> #= <addr>', 'endmacro',
    'macro define_base2_address(name, addr)', '  !<name> #= <addr>', 'endmacro',
    'macro define_exsprite_table(name, addr, addr_more)', '  !<name> #= <addr>', 'endmacro',
    'macro debugmsg(msg)', 'endmacro',
    'macro BES(label)', '  LDA !extra_bits,x', '  AND #$04', '  BNE <label>', 'endmacro',
    'macro BEC(label)', '  LDA !extra_bits,x', '  AND #$04', '  BEQ <label>', 'endmacro',
    'macro Between(x, label)', '  CLC : ADC <x>', '  CMP <x>*2', '  BCS <label>', 'endmacro',
    'macro invoke_snes(addr)', '  error "SA-1 is not supported"', 'endmacro',
    'macro invoke_sa1(label)', '  error "SA-1 is not supported"', 'endmacro',
  ];
  return out.join('\n') + '\n';
}

// ---------------------------------------------------------------- headers (_header.asm per type)

// spawn helpers shared by most types: position in $04-$07 from the calling sprite, then the generic routine
const spawnAlt = (x: string, y: string, xh: string, yh: string, pha = true) => `
macro SetupCoords()
  ${pha ? 'PHA' : ''}
  LDA ${x},x : STA $04
  LDA ${xh},x : STA $05
  LDA ${y},x : STA $06
  LDA ${yh},x : STA $07
  ${pha ? 'PLA' : ''}
endmacro
macro SpawnExtendedAlt()
  %SetupCoords()
  %SpawnExtendedGeneric()
endmacro
macro SpawnSmokeAlt()
  %SetupCoords()
  %SpawnSmokeGeneric()
endmacro
macro SpawnCluster()
  %SetupCoords()
  %SpawnClusterGeneric()
endmacro
macro SpawnMinorExtended()
  %SetupCoords()
  %SpawnMinorExtendedGeneric()
endmacro
macro SpawnMinorExtendedOverwrite()
  %SetupCoords()
  %SpawnMinorExtendedOverwriteGeneric()
endmacro
macro SpawnSpinningCoin()
  %SetupCoords()
  %SpawnSpinningCoinGeneric()
endmacro
macro SpawnScore()
  %SetupCoords()
  %SpawnScoreGeneric()
endmacro
`;

export const HEADERS: Record<SpriteFolder, string> = {
  sprites: `
macro LDE()
  LDA !extra_bits,x
  AND #$04
endmacro
macro SetupCoords()
  PHA
  LDA !sprite_x_low,x : STA $04
  LDA !sprite_x_high,x : STA $05
  LDA !sprite_y_low,x : STA $06
  LDA !sprite_y_high,x : STA $07
  PLA
endmacro
macro SpawnMinorExtended()
  XBA
  LDA !sprite_off_screen_horz,x
  ORA !sprite_off_screen_vert,x
  ORA !sprite_being_eaten,x
  BNE ?ret
  XBA
  %SetupCoords()
  %SpawnMinorExtendedGeneric()
?ret:
endmacro
macro SpawnCluster()
  %SetupCoords()
  %SpawnClusterGeneric()
endmacro
macro SpawnSpinningCoin()
  %SetupCoords()
  %SpawnSpinningCoinGeneric()
endmacro
macro SpawnScore()
  %SetupCoords()
  %SpawnScoreGeneric()
endmacro
`,
  shooters: `
macro LDE()
  LDA !shoot_num,x
  AND #$40
endmacro
${spawnAlt('!shoot_x_low', '!shoot_y_low', '!shoot_x_high', '!shoot_y_high').replace(/macro SpawnExtendedAlt[\s\S]*?endmacro\n/, '')}
macro SpawnExtendedAlt()
  %SetupCoords()
  %SpawnExtendedGeneric()
endmacro
`,
  generators: '',
  cluster: `
macro LDE()
  LDA !cluster_num,x
  AND #$80
endmacro
${spawnAlt('!cluster_x_low', '!cluster_y_low', '!cluster_x_high', '!cluster_y_high')}`,
  extended: `
macro Speed()
  LDA #$00
  %ExtendedSpeed()
endmacro
macro SpeedNoGrav()
  LDA #$01
  %ExtendedSpeed()
endmacro
macro SpeedX()
  LDA #$02
  %ExtendedSpeed()
endmacro
macro SpeedY()
  LDA #$03
  %ExtendedSpeed()
endmacro
${spawnAlt('!extended_x_low', '!extended_y_low', '!extended_x_high', '!extended_y_high')}`,
  minorextended: `
macro SpeedX()
  LDA #$00
  %MinorExtendedSpeed()
endmacro
macro SpeedY()
  LDA #$02
  %MinorExtendedSpeed()
endmacro
macro SpeedXFast()
  LDA #$01
  %MinorExtendedSpeed()
endmacro
macro SpeedYFast()
  LDA #$03
  %MinorExtendedSpeed()
endmacro
${spawnAlt('!minor_extended_x_low', '!minor_extended_y_low', '!minor_extended_x_high', '!minor_extended_y_high')}`,
  bounce: `
macro RevertMap16()
  LDA !bounce_map16_tile,x
  STA $9C
  %BounceSetupMap16()
  PHX
  JSL $00BEB0|!BankB
  PLX
endmacro
macro InvisibleMap16()
  LDA #$09
  STA $9C
  %BounceSetupMap16()
  PHX
  JSL $00BEB0|!BankB
  PLX
endmacro
macro SetSpeed()
  %BounceSetSpeed()
endmacro
macro SetMarioSpeed()
  %BounceSetMarioSpeed()
endmacro
macro UpdatePos()
  %BounceUpdatePos()
endmacro
; erases the coin above the bounce sprite: $029265 is a subroutine ending in RTS, called through an RTL
macro EraseCoinAbove()
  PHK
  PEA.w ?ret-1
  PEA.w $B888
  JML $029265|!BankB
?ret:
endmacro
${spawnAlt('!bounce_x_low', '!bounce_y_low', '!bounce_x_high', '!bounce_y_high')}`,
  smoke: spawnAlt('!smoke_x_low', '!smoke_y_low', '!smoke_x_high', '!smoke_y_high'),
  spinningcoin: `
macro UpdateYPos()
  %SpinningCoinUpdateYPos()
endmacro
${spawnAlt('!spinning_coin_x_low', '!spinning_coin_y_low', '!spinning_coin_x_high', '!spinning_coin_y_high')}`,
  score: `
macro UpdateYPos()
  CLC
  %ScoreUpdateYPos()
endmacro
macro UpdateYPosAlt()
  SEC
  %ScoreUpdateYPos()
endmacro
${spawnAlt('!score_x_low', '!score_y_low', '!score_x_high', '!score_y_high', false)}`,
};

// ---------------------------------------------------------------- runtime

export interface SpriteRow {
  type: number; // 0 = tweak (acts like with other tweakers), 1 = custom code
  actlike: number;
  tweak: number[]; // $1656 $1662 $166E $167A $1686 $190F
  prop: [number, number]; // extra property bytes
  init: number; // SNES addresses (0 = none)
  main: number;
  status: number[]; // custom status pointers: CARRIABLE (09), KICKED (0A), CARRIED (0B), MOUTH (07), GOAL (0C)
}

export interface RuntimeSpec {
  sizes: Uint8Array; // $400 bytes
  sprites: (SpriteRow | null)[]; // 256 entries for numbers 00-FF (custom flag), null = not inserted
}

const STATUS_ORDER = [0x09, 0x0a, 0x0b, 0x07, 0x0c];
export const STATUS_LABELS = ['CARRIABLE', 'KICKED', 'CARRIED', 'MOUTH', 'GOAL'];

const dl = (v: number) => `$${v.toString(16).toUpperCase().padStart(6, '0')}`;
function rows(bytes: number[], per = 16): string {
  const out: string[] = [];
  for (let i = 0; i < bytes.length; i += per) out.push('  db ' + bytes.slice(i, i + per).map((b) => h(b & 0xff)).join(','));
  return out.join('\n');
}

export function runtimeAsm(spec: RuntimeSpec): string {
  // sprite table: 16 bytes per number: type, acts like, 6 tweakers, INIT (3), MAIN (3), 2 extra property bytes;
  // numbers that were not inserted act like the original sprite of the same number
  const tbl: string[] = [];
  for (let n = 0; n < 256; n++) {
    const s = spec.sprites[n];
    if (!s) {
      tbl.push(`  db $00,${h(n)}` + [0x07f26c, 0x07f335, 0x07f3fe, 0x07f4c7, 0x07f590, 0x07f659].map((t) => `,read1(${dl(t + n)})`).join('') + ',0,0,0,0,0,0,0,0');
      continue;
    }
    const p = (v: number) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff];
    tbl.push(rows([s.type ? 1 : 0, s.actlike, ...s.tweak, ...p(s.init), ...p(s.main), ...s.prop], 16));
  }
  const status: number[] = [];
  for (let n = 0; n < 0xc0; n++) for (let k = 0; k < 5; k++) { const v = spec.sprites[n]?.status[k] ?? 0; status.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff); }

  return `; generated by SMW Editor: runtime of custom sprites (PIXI format) – see docs/pixi.md
!PixiCE = $7FAF00 ; level sprite data pointer while the loader moves $CE

; size table: Lunar Magic and PIXI keep its address here
org $0EF30C
  dl PixiSize
  db $42

; ---- sprite data loader
org $02A82A
  JML PixiLoad_head
org $02A846
  JML PixiLoad_skip
org $02A8D8
  JMP $AB78 ; the shooter loader does not return (it continues the loop itself)
org $02A936
  JML PixiLoad_noslot
org $02A94B
  JSL PixiLoad_bitsV : NOP
org $02A963
  JSL PixiLoad_bitsH : NOP
org $02A9C9
  JSL PixiLoad_spawn
org $02A9D7
  JML PixiLoad_next
org $02ABE9
  JML PixiLoad_nextShooter
org $02A866
  JML PixiLoad_number ; custom shooters and generators
org $02ABA0
  JML PixiLoad_shooter

; ---- shooters and generators
org $02B395
  JML PixiShooter
org $02AFFE
  JML PixiGenerator

; ---- status handling
org $018127
  JML PixiStatus
org $018151
  JML PixiErase2
org $018172
  JSL PixiInit : NOP
org $0185C3
  JSL PixiMain : NOP
org $0187A7
  JML PixiSetTables ; public: sets up a custom sprite (number in !new_sprite_num), $00-$02 = INIT
if read2($0182B3) == $87A7
  org $0182B3
    dw $85C2 ; init pointer of sprite 9B pointed at $0187A7 (an RTL there before)
endif
org $01D43E
  JSR $8133 ; public: runs the original code of the sprite's status (A = status)
  RTL
org $07F785
  JML PixiErase

freecode cleaned
PixiLoad:
.head
  REP #$20 : LDA $CE : STA.l !PixiCE : SEP #$20
  LDX #$00 : LDY #$01
.loop
  LDA [$CE],y : CMP #$FF : BEQ .exit
  ASL #3 : AND #$10 : STA $02
  INY : LDA [$CE],y : AND #$0F : ORA $02 : CMP $01
  BCC .skip : BNE .exit
  LDA [$CE],y : AND #$F0 : CMP $00 : BNE .skip
  JML $02A856 ; Y = entry + 1, X = index in $1938
.skip ; Y = entry + 1 (also from $02A846)
  DEY : JSR .advance : INX : BRA .loop
.next ; after a sprite was loaded, Y = entry + 2
  DEY #2 : JSR .advance : LDX $02 : INX : BRA .loop
.nextShooter ; after a shooter was loaded, $03 = entry
  LDY $03 : JSR .advance : LDX $02 : INX : BRA .loop
.noslot ; no free slot: the sprite is loaded again later, the loop ends for this frame
  LDX $02 : STZ $1938,x
.exit
  REP #$20 : LDA.l !PixiCE : STA $CE : SEP #$20
  JML $02A84B ; RTS
; Y = entry → Y = next entry; past $80 the data pointer moves forward instead
.advance
  JSR .size
  PHA : TYA : CLC : ADC $01,s : TAY : PLA
  CPY #$80 : BCC +
  REP #$20 : TYA : CLC : ADC $CE : STA $CE : SEP #$20
  LDY #$00
+ RTS
; A = size of the entry at Y (3 + extra bytes)
.size
  PHX
  LDA [$CE],y : LSR #2 : AND #$03 : XBA
  INY #2 : LDA [$CE],y : DEY #2
  REP #$10 : TAX : LDA.l PixiSize,x : SEP #$10
  PLX
  RTS
; $02A866: A = sprite number ($05), Y = entry + 1; custom C0-CF are shooters, D0-DF generators
.number
  CMP #$C0 : BCC .num
  CMP #$E0 : BCS .num
  DEY : LDA [$CE],y : INY : AND #$08 : BEQ .vnum
  LDA $05 : CMP #$D0 : BCS .gen
  JML $02A8D8 ; shooter
.gen ; $18B9 = $80 | extra bit << 6 | number - $CF
  DEY : LDA [$CE],y : INY : AND #$04 : ASL #4 : ORA #$80 : STA $18B9
  LDA $05 : SEC : SBC #$CF : ORA $18B9 : STA $18B9
  JML $02A8BB
.vnum
  LDA $05
.num
  CMP #$E7 : BCC +
  JML $02A86A ; scroll sprites
+ JML $02A88C
; $02ABA0: shooter slot X, entry at $03 (= Y), number in $04
.shooter
  LDA [$CE],y : AND #$08 : BNE +
  LDA $04 : SEC : SBC #$C8 : STA $1783,x
  JML $02ABA8
+ LDA [$CE],y : AND #$04 : ASL #4 : ORA #$80 : STA $1783,x ; $80 | extra bit << 6 | number - $BF
  LDA $04 : SEC : SBC #$BF : ORA $1783,x : STA $1783,x
  JSR .size
  SEC : SBC #$03 : BEQ ++
  CMP #$04 : BCS .sptr
  PHY : PHA
  INY #3 : LDA [$CE],y : STA.l !shooter_extra_byte_1,x
  LDA $01,s : DEC : STA $01,s : BEQ +
  INY : LDA [$CE],y : STA.l !shooter_extra_byte_2,x
  LDA $01,s : DEC : STA $01,s : BEQ +
  INY : LDA [$CE],y : STA.l !shooter_extra_byte_3,x
+ PLA : PLY
++ JML $02ABA8
.sptr ; 4 or more extra bytes: a pointer to them
  PHY : INY #3
  REP #$20 : TYA : CLC : ADC $CE : SEP #$20
  STA.l !shooter_extra_byte_1,x : XBA : STA.l !shooter_extra_byte_2,x
  LDA $D0 : STA.l !shooter_extra_byte_3,x
  PLY
  JML $02ABA8

; extra bits to !extra_bits; custom sprites keep only the position bit in the high position byte
.bitsH
  PHA : AND #$0C : STA.l !extra_bits,x
  AND #$08 : BEQ +
  PLA : AND #$01 : STA $14D4,x : RTL
+ PLA : AND #$0D : STA $14D4,x : RTL
.bitsV
  PHA : AND #$0C : STA.l !extra_bits,x
  AND #$08 : BEQ +
  PLA : AND #$01 : STA $14E0,x : RTL
+ PLA : AND #$0D : STA $14E0,x : RTL
; instead of JSL $07F7D2 when a sprite is loaded, Y = entry + 2
.spawn
  LDA.l !extra_bits,x : PHA
  JSL $07F7D2
  PLA : STA.l !extra_bits,x
  AND #$08 : BNE + : RTL
+ LDA [$CE],y : STA.l !new_sprite_num,x
  PHY : DEY #2 : JSR .size : PLY
  SEC : SBC #$03 : BEQ .tables
  CMP #$05 : BCS .ptr
  PHY : PHA
  INY : LDA [$CE],y : STA.l !extra_byte_1,x
  LDA $01,s : DEC : STA $01,s : BEQ .bytes
  INY : LDA [$CE],y : STA.l !extra_byte_2,x
  LDA $01,s : DEC : STA $01,s : BEQ .bytes
  INY : LDA [$CE],y : STA.l !extra_byte_3,x
  LDA $01,s : DEC : STA $01,s : BEQ .bytes
  INY : LDA [$CE],y : STA.l !extra_byte_4,x
.bytes
  PLA : PLY
  BRA .tables
.ptr ; 5 or more extra bytes: a pointer to them
  PHY : INY
  REP #$20 : TYA : CLC : ADC $CE : SEP #$20
  STA.l !extra_byte_1,x : XBA : STA.l !extra_byte_2,x
  LDA $D0 : STA.l !extra_byte_3,x
  PLY
.tables ; the loader still needs $00-$02
  LDA $02 : PHA : REP #$20 : LDA $00 : PHA : SEP #$20
  JSL PixiSetTables
  REP #$20 : PLA : STA $00 : SEP #$20 : PLA : STA $02
  RTL

; sets acts like, tweakers and extra property bytes of the custom sprite in slot X; a tweak sprite
; becomes an original one (extra bits cleared); $00-$02 = INIT pointer
PixiSetTables:
  PHP : PHB : PHK : PLB
  SEP #$30
  PHY
  LDA !new_sprite_num,x
  REP #$30 : AND #$00FF : ASL #4 : TAY
  SEP #$20
  LDA PixiSprites+1,y : STA $9E,x
  LDA PixiSprites+2,y : STA $1656,x
  LDA PixiSprites+3,y : STA $1662,x
  LDA PixiSprites+4,y : STA $166E,x : AND #$0F : STA $15F6,x
  LDA PixiSprites+5,y : STA $167A,x
  LDA PixiSprites+6,y : STA $1686,x
  LDA PixiSprites+7,y : STA $190F,x
  LDA PixiSprites+14,y : STA.l !extra_prop_1,x
  LDA PixiSprites+15,y : STA.l !extra_prop_2,x
  LDA PixiSprites,y : STA.l !new_code_flag
  BNE +
  LDA #$00 : STA.l !extra_bits,x
  BRA ++
+ REP #$20 : LDA PixiSprites+8,y : STA $00
  SEP #$20 : LDA PixiSprites+10,y : STA $02
++ SEP #$30
  PLY
  PLB : PLP
  RTL

; $00-$02 = MAIN of the custom sprite in slot X (PixiMainOf: of number A)
PixiGetMain:
  LDA !new_sprite_num,x
PixiMainOf:
  PHB : PHK : PLB
  PHY
  REP #$30 : AND #$00FF : ASL #4 : TAY
  LDA PixiSprites+11,y : STA $00
  SEP #$20 : LDA PixiSprites+13,y : STA $02
  SEP #$30
  PLY : PLB
  RTS

; status $01 ($018172)
PixiInit:
  LDA #$08 : STA $14C8,x
  LDA.l !extra_bits,x : AND #$08 : BEQ +
  JSL PixiSetTables
  LDA.l !extra_bits,x : AND #$08 : BEQ +
  PLA : PLA ; RTL to the RTS at $0185C2 (keeps the bank $01 of the return address)
  PEA $85C1
  LDA #$01
  JML [$0000]
+ RTL

; status $08 ($0185C3)
PixiMain:
  STZ $1491
  LDA.l !extra_bits,x : AND #$08 : BNE +
  LDA $9E,x
  RTL
+ JSR PixiGetMain
  PLA : PLA
  PEA $85C1
  LDA $14C8,x
  JML [$0000]

; all statuses ($018127)
PixiStatus:
  LDA $14C8,x : CMP #$02 : BCC .default
  CMP #$08 : BNE + : JML $0185C3
+ PHA
  LDA.l !extra_bits,x : AND #$08 : BNE .custom
  PLA
.default
  JML $018133
.custom ; stack: status
  LDA.l !extra_prop_2,x : BMI .main
  LDA $01,s : CMP #$07 : BCC .vanilla
  JSR PixiStatusPtr : BCC .vanilla
  PLA
  PHB : LDA $02 : PHA : PLB ; DB = the routine's bank
  PHK : PEA.w .ret-1
  JML [$0000]
.ret
  PLB
  JML $0185C2 ; RTS
.vanilla
  LDA $01,s : JSL $01D43E ; original code of the status
  LDA.l !extra_prop_2,x : AND #$40 : BNE .main
  LDA $01,s : CMP #$09 : BCS .main
  PLA
  JML $0185C2 ; RTS
.main ; MAIN in any status
  PLA
  JSR PixiGetMain
  LDA.b #$01 : PHA : PEA $85C1
  LDA $14C8,x
  JML [$0000]

; custom status pointer of the sprite in slot X for status A (07, 09-0C): carry set and $00-$02 = pointer
PixiStatusPtr:
  PHB : PHK : PLB
  PHY
  LDY #$04
- CMP PixiStatusOrder,y : BEQ +
  DEY : BPL -
  BRA .none
+ STY $00
  LDA !new_sprite_num,x : CMP #$C0 : BCS .none
  REP #$30
  AND #$00FF : PHA : ASL #4 : SEC : SBC $01,s : STA $01,s ; number * 15
  LDA $00 : AND #$00FF : STA $00 : ASL : CLC : ADC $00 : CLC : ADC $01,s : TAY ; + index * 3
  PLA
  LDA PixiStatusPtrs,y : STA $00
  SEP #$20 : LDA PixiStatusPtrs+2,y : STA $02
  SEP #$30
  PLY : PLB
  LDA $00 : ORA $01 : ORA $02 : BEQ +
  SEC : RTS
+ CLC : RTS
.none
  SEP #$30
  PLY : PLB
  CLC : RTS
PixiStatusOrder:
  db ${STATUS_ORDER.map((s) => h(s)).join(',')}

; $02B395: shooter in slot X, A = !shoot_num; custom ones ($80 set) count their timer down and run MAIN
PixiShooter:
  BMI .custom
  LDY $17AB,x : BEQ +
  JML $02B39A
+ JML $02B3A4
.custom
  LDY $17AB,x : BEQ +
  PHA : LDA $13 : LSR : BCC ++
  DEC $17AB,x
++ PLA
+ AND #$3F : CLC : ADC #$BF
  JSR PixiMainOf
  LDA #$02 : PHA : PEA $B3A6 ; RTL to $02B3A7 (next shooter)
  JML [$0000]

; $02AFFE: generators; custom ones ($18B9 bit 7) run MAIN
PixiGenerator:
  LDA $18B9 : BMI .custom
  BNE +
  JML $02B02A ; RTS
+ JML $02B003
.custom
  LDY $9D : BNE +
  AND #$3F : CLC : ADC #$CF
  JSR PixiMainOf
  LDA #$02 : PHA : PEA $B029 ; RTL to the RTS at $02B02A
  JML [$0000]
+ JML $02B02A

; $07F785: end of the routine clearing a slot's tables
PixiErase:
  LDA #$00 : STA.l !extra_bits,x
  LDA #$01 : STA $15A0,x
  RTL

; $018151: status 0
PixiErase2:
  LDA #$00 : STA.l !extra_bits,x
  LDA #$FF : STA $161A,x
  JML $018156 ; RTS

PixiSize:
${rows([...spec.sizes])}
PixiSprites:
${tbl.join('\n')}
PixiStatusPtrs:
${rows(status, 15)}
`;
}
