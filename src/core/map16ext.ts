// Extended Map16 ("SMWX"): FG tiles $200-$FFF (pages 2-F) and a per-tile "acts like" table.
//
// Tile numbers are the level map bytes $7EC800 (low) / $7FC800 (high = page). Vanilla only knows
// pages 0 and 1: graphics come from the pointer table $0FBE (built at level load), behaviour is
// hard-wired to the tile number. The patch changes:
//  - $00F545 (called by Mario, sprite and fireball block interaction with A = page, $1693 = low
//    byte): tile → acts-like tile from a table, then the vanilla code runs with that tile.
//  - $029328 (blocks hit from below / cape, tests the page itself): same mapping.
//  - the four tilemap renderers ($058A66, $058B46, $058C34, $058D2B: LDA $0FBE,y : STA $0A):
//    tiles >= $200 take their 8 bytes of tile words from the extended graphics table.
//  - $00C096 / $00C0E7 (change-tile routine sets the page with AND #$FE / ORA #$01): the page is set
//    to 0 / 1 outright, so replacing a tile on page >= 2 works.
// Version 2 adds custom blocks (GPS format, see blocks.ts): a table with 4 bytes per tile (address of
// the block's JMP table, flags bit 0 = "db $37" with wall offsets). Before the acts-like mapping the
// caller of $00F545 is identified from its return address (Mario $00F4E0 with the interaction point
// in X, sprites $019536 with the point in $0F, cape $02961D, fireball $02A6EE) and the block code is
// called with the GPS offset: Y:$1693 = acts like (the block may change it), X = the caller's X.
// Version 3 takes the caller's bank without bit 7: AddmusicK returns to the main loop at $80806B, so
// with it the game runs in the FastROM mirrors $80-$82 and version 2 found no caller.
// Version 4 hooks the change-tile routine's own drawing ($00C176: LDA #$0D : STA $06 : REP #$20 :
// LDA $0FBE,y : STA $04, the tile written to VRAM as a stripe), which blocks reach through $00C0FB
// (GPS change_map16): a tile >= $200 showed whatever its index past $0FBE pointed at.
// Version 5 puts Lunar Magic's pointers to its acts-like tables where LM has them ($06F624 for pages 00-3F,
// $06F63A for 40-7F; 2 bytes per tile from the page's first tile), both at the acts-like table: community code
// reads acts-like through them, e.g. the Line-Guide "Acts Like" Fix (imamelia, worldpeace) in the Romhack Races
// baserom, whose line-guided platforms fell without them. Pages 10-3F (and 50-7F) don't exist in the editor.
// Version 6 runs a custom block with the data bank set to the block's bank (the caller's restored after), as
// GPS does: blocks read their own tables by absolute addresses, e.g. the screen scrolling pipes' turn blocks
// in the Romhack Races baserom, which never turned Mario without it.
// Version 7 looks the tile up in the block table before it identifies the caller: nearly no tile has a block, and
// working out the caller from the stack for every block check of Mario, the sprites, the cape and the fireballs cost
// ~230 cycles a call (~16 calls and ~21 scanlines a game frame in level 106). The block table is two halves (the
// addresses' low words, then bank and flags) indexed like the acts-like table; the hook runs at the JML's target
// without a JSL and skips the table while blocks are off (a BRA, patched to +0 when they are enabled). A tile without
// a block costs about as much as the acts-like mapping alone.
// Version 8 takes the overworld's bank from the game's operand at $058B22, which Lunar Magic's overworld Map16 expansion
// (overworld.ts) changes, instead of $05.

import { Rom } from './rom.ts';
import { Asm } from './asm.ts';
import { ownerNote } from './patchreg.ts';
import { missingPatch } from './patches.ts';

export const EXT_FIRST = 0x200;
export const EXT_TILES = 0x1000; // tiles $000-$FFF
export const DEFAULT_ACTS = 0x025; // new tiles act like air
const MAGIC = [0x53, 0x4d, 0x57, 0x58]; // "SMWX"
const HEADER = 16; // +4 acts table, +7 graphics table, +10 block table, +13 blocks enabled
const BLK_HI = EXT_TILES * 2; // the block table: the addresses' low words, then bank and flags, 2 bytes per tile each

const F545 = 0x00f545;
const HIT_HOOK = 0x029328;
const RENDER_HOOKS = [0x058a66, 0x058b46, 0x058c34, 0x058d2b];
const PAGE0_FIX = 0x00c096;
const PAGE1_FIX = 0x00c0e7;
const CHANGE_HOOK = 0x00c176;
const CHANGE_CODE = [0xa9, 0x0d, 0x85, 0x06, 0xc2, 0x20, 0xb9, 0xbe, 0x0f, 0x85, 0x04];
export const LM_ACTS_PTRS = [0x06f624, 0x06f63a]; // Lunar Magic's acts-like table pointers (pages 00-3F, 40-7F)
export const MAP16X_HOOKS: [number, number][] = [[F545, 4], [HIT_HOOK, 4], ...RENDER_HOOKS.map((r): [number, number] => [r, 5]), [PAGE0_FIX, 2], [PAGE1_FIX, 2], [CHANGE_HOOK, CHANGE_CODE.length],
  ...LM_ACTS_PTRS.map((p): [number, number] => [p, 3])];

export interface Map16Ext { base: number; acts: number; gfx: number; blocks: number }

export function map16Ext(rom: Rom): Map16Ext | null {
  if (rom.r8(F545) !== 0x5c) return null;
  const base = rom.r24(F545 + 1) - HEADER;
  for (let i = 0; i < 4; i++) if (rom.r8(base + i) !== MAGIC[i]) return null;
  return { base, acts: rom.r24(base + 4), gfx: rom.r24(base + 7), blocks: rom.r8(base + 13) ? rom.r24(base + 10) : 0 };
}

function build(): Asm {
  const a = new Asm();
  a.b(...MAGIC); a.fill(HEADER - 4);
  // $00F545 replacement (entered by JML, M=8 X=8; A = page, $1693 = low byte, X = the caller's): the tile's custom
  // block (if any) for the calling context, the acts-like tile, then the vanilla routine. The tile is looked up
  // first: only a tile with a block identifies its caller (Ctx). The block table operands (BlkTbl+n) and the skip
  // are patched when blocks are enabled.
  a.label('F545');
  a.b(0xda); // PHX (stack: 1 X, 2-4 the caller's return address)
  a.b(0xeb, 0xad, 0x93, 0x16, 0xc2, 0x30, 0x29, 0xff, 0x0f, 0x0a, 0xaa); // XBA : LDA $1693 : REP #$30 : AND #$0FFF : ASL : TAX (tile * 2)
  a.label('opSkip'); a.br(0x80, 'acts'); // BRA acts (BRA +0 with blocks)
  a.label('opBank'); a.b(0xbf, 0, 0, 0); // LDA.l BlkTbl+BLK_HI,x (bank and flags: 0 = no block)
  a.br(0xd0, 'custom');
  a.label('acts');
  a.long(0xbf, 'ActsTbl'); // LDA.l ActsTbl,x
  a.b(0xe2, 0x30, 0x8d, 0x93, 0x16, 0xa8, 0xfa, 0xeb); // SEP #$30 : STA $1693 : TAY : PLX : XBA (its page)
  a.br(0xd0, 'f545p1');
  a.b(0x5c, 0x4b, 0xf5, 0x80); // JML $80F54B (page 0, Y = $1693; the JML at $00F545 covers $00F548)
  a.label('f545p1');
  a.b(0x5c, 0x77, 0xf5, 0x80); // JML $80F577 (page 1)
  a.label('custom');
  a.b(0x8a, 0x4a, 0xeb, 0xe2, 0x20, 0x48); // TXA : LSR : XBA : SEP #$20 : PHA (the page; stack: 1 page, 2 X)
  a.abs(0x20, 'Ctx'); // JSR Ctx → A = GPS offset * 3, $FF = none
  a.b(0xc9, 0xff);
  a.br(0xf0, 'noctx');
  a.b(0x48); // PHA (offset; stack: 1 offset, 2 page, 3 X)
  a.b(0xc9, 30); // CMP #30 (wall offsets need "db $37")
  a.br(0x90, 'ok');
  a.label('opFlags'); a.b(0xbf, 0, 0, 0); // LDA.l BlkTbl+BLK_HI+1,x
  a.b(0x4a); // LSR
  a.br(0xb0, 'ok');
  a.b(0x68); // PLA
  a.label('noctx');
  a.b(0x68, 0xc2, 0x30); // PLA : REP #$30
  a.br(0x80, 'acts');
  a.label('ok');
  a.b(0x8b, 0x4b); // PHB (the caller's data bank) : PHK
  a.abs(0xf4, 'back', -1); // PEA.w back-1
  a.label('opBank2'); a.b(0xbf, 0, 0, 0); // LDA.l BlkTbl+BLK_HI,x
  a.b(0x48, 0xc2, 0x20, 0xa3, 0x06, 0x29, 0xff, 0x00, 0x18); // PHA : REP #$20 : LDA $06,S : AND #$00FF : CLC
  a.label('opLo'); a.b(0x7f, 0, 0, 0); // ADC.l BlkTbl,x
  a.b(0x3a, 0x48, 0xe2, 0x30, 0xa3, 0x09); // DEC : PHA : SEP #$30 : LDA $09,S (page)
  a.long(0x22, 'Acts'); // JSL Acts
  a.b(0xa8, 0xa3, 0x03, 0x48, 0xab); // TAY : LDA $03,S : PHA : PLB (the data bank: the block's, as GPS sets it)
  a.b(0xa3, 0x0a, 0xaa, 0x6b); // LDA $0A,S : TAX : RTL (→ block code)
  a.label('back');
  a.b(0xe2, 0x30, 0xab, 0x68, 0x68, 0xfa, 0x98); // SEP #$30 : PLB : PLA : PLA : PLX : TYA (the acts-like page, the block may change it)
  a.br(0xd0, 'f545p1');
  a.b(0xac, 0x93, 0x16, 0x5c, 0x4b, 0xf5, 0x80); // LDY $1693 : JML $80F54B

  // Acts: A (8 bit) = page, $1693 = low byte → acts-like tile; A = its page, Z set accordingly.
  // Keeps X, Y, D, DB and the register widths.
  a.label('Acts');
  a.b(0x08, 0xc2, 0x30, 0xda); // PHP REP #$30 PHX
  a.b(0x29, 0x0f, 0x00, 0xeb); // AND #$000F XBA
  a.b(0xe2, 0x20, 0xad, 0x93, 0x16); // SEP #$20 LDA $1693
  a.b(0xc2, 0x20, 0x0a, 0xaa); // REP #$20 ASL TAX
  a.long(0xbf, 'ActsTbl'); // LDA.l ActsTbl,x
  a.b(0xe2, 0x20, 0x8d, 0x93, 0x16, 0xeb); // SEP #$20 STA $1693 XBA
  a.b(0xfa, 0x28, 0xc9, 0x00, 0x6b); // PLX PLP CMP #$00 RTL

  // $029328 (M=8): LDA [$05] : BNE $9355 → page 1 code returns to $029355
  a.label('Hit');
  a.b(0xa7, 0x05); // LDA [$05]
  a.long(0x22, 'Acts');
  a.br(0xf0, 'hit0');
  a.b(0x48, 0xa9, 0x54, 0x83, 0x02, 0xa9, 0x93, 0x83, 0x03, 0x68); // PHA  return address := $029354 (+1)  PLA
  a.label('hit0');
  a.b(0x6b); // RTL

  // Ctx (JSR from F545, M=8 X=16; stack: 3 page, 4 X, 5-7 the return address of the $00F545 caller)
  const ret = (v: number) => a.b(0xa9, v, 0x60); // LDA #v : RTS
  a.label('Ctx');
  a.b(0xa3, 0x07, 0x29, 0x7f); a.br(0xd0, 'cNotMario'); // LDA $07,S (bank) : AND #$7F : BNE
  a.b(0xa3, 0x06, 0xc9, 0xf4); a.br(0xd0, 'cNone'); // $00F4E0: Mario
  a.b(0xa3, 0x04, 0xc9, 0x62); a.br(0xb0, 'cWall'); // LDA $04,S (X) : CMP #$62 : BCS wall running
  a.b(0x38, 0xe9, 0x02); // SEC : SBC #$02
  a.label('cMod'); a.b(0xc9, 0x0c); a.br(0x90, 'cPt'); a.b(0xe9, 0x0c); a.br(0x80, 'cMod'); // point = (X-2) mod 12
  a.label('cPt'); a.b(0xc9, 0x00); a.br(0xf0, 'cBody');
  a.b(0xc9, 0x06); a.br(0xf0, 'cHead'); a.br(0x90, 'cSide');
  a.b(0xa5, 0x7d); a.br(0x30, 'cCorner'); ret(1 * 3); // feet: MarioAbove, rising: TopCorner
  a.label('cCorner'); ret(7 * 3);
  a.label('cBody'); ret(8 * 3); // BodyInside
  a.label('cSide'); ret(2 * 3); // MarioSide
  a.label('cHead'); a.b(0xa5, 0x7d); a.br(0x30, 'cBelow'); ret(9 * 3); // HeadInside
  a.label('cBelow'); ret(0); // MarioBelow
  a.label('cWall'); a.b(0xc9, 0x66); a.br(0xf0, 'cWBody'); a.b(0xc9, 0x6c); a.br(0xf0, 'cWBody'); ret(10 * 3); // WallFeet
  a.label('cWBody'); ret(11 * 3); // WallBody
  a.label('cNotMario'); a.b(0xc9, 0x01); a.br(0xd0, 'cB2');
  a.b(0xa3, 0x06, 0xc9, 0x95); a.br(0xd0, 'cNone'); // $019536: sprites
  a.b(0xa5, 0x0f, 0xc9, 0x02); a.br(0x90, 'cSprH'); ret(3 * 3); // SpriteV (floor/ceiling)
  a.label('cSprH'); ret(4 * 3); // SpriteH (walls)
  a.label('cB2'); a.b(0xc9, 0x02); a.br(0xd0, 'cNone');
  a.b(0xa3, 0x06, 0xc9, 0x96); a.br(0xf0, 'cCape'); a.b(0xc9, 0xa6); a.br(0xf0, 'cFire');
  a.label('cNone'); ret(0xff);
  a.label('cCape'); ret(5 * 3); // MarioCape
  a.label('cFire'); ret(6 * 3); // MarioFireball

  // renderers (M=16 X=16, Y = tile * 2): pointer to the tile's 8 bytes in $0A, bank in $0C
  a.label('Render');
  a.b(0xc0, 0x00, 0x04); // CPY #$0400
  a.br(0xb0, 'rext');
  a.b(0xb9, 0xbe, 0x0f, 0x85, 0x0a); // LDA $0FBE,y STA $0A
  // vanilla bank, chosen like the caller: $0D, or the overworld's if $1931 >= $10 (signed): its layer 1 Map16's bank,
  // the operand of the game's LDY #$05 at $058B22 (overworld.ts, Lunar Magic's expansion to 0x200 tiles moves it)
  a.b(0xe2, 0x20, 0xad, 0x31, 0x19, 0xc9, 0x10); // SEP #$20 LDA $1931 CMP #$10
  a.br(0x30, 'rb0d');
  a.b(0xaf, 0x22, 0x8b, 0x05); // LDA.l $058B22
  a.br(0x80, 'rbset');
  a.label('rb0d');
  a.b(0xa9, 0x0d);
  a.label('rbset');
  a.b(0x85, 0x0c, 0xc2, 0x20, 0x6b); // STA $0C REP #$20 RTL
  a.label('rext');
  a.b(0xc0, 0x00, 0x20); // CPY #$2000 (pages >= $10: draw tile $025)
  a.br(0x90, 'rin');
  a.b(0xa0, 0x4a, 0x00); // LDY #$004A
  a.br(0x80, 'Render');
  a.label('rin');
  a.b(0x98, 0x38, 0xe9, 0x00, 0x04, 0x0a, 0x0a, 0x18); // TYA SEC SBC #$0400 ASL ASL CLC
  a.label('radc');
  a.b(0x69, 0x00, 0x00); // ADC #gfx (patched after allocation)
  a.b(0x85, 0x0a, 0xe2, 0x20); // STA $0A SEP #$20
  a.label('rbk');
  a.b(0xa9, 0x00); // LDA #bank (patched)
  a.b(0x85, 0x0c, 0xc2, 0x20, 0x6b); // STA $0C REP #$20 RTL

  // change-tile drawing (M=8 X=16, Y = tile * 2): pointer to the tile's 8 bytes in $04, bank in $06; M=16
  a.label('Change');
  a.b(0xa9, 0x0d, 0x85, 0x06, 0xc2, 0x20); // LDA #$0D STA $06 REP #$20 (vanilla)
  a.label('cgv');
  a.b(0xc0, 0x00, 0x04); // CPY #$0400
  a.br(0xb0, 'cgext');
  a.b(0xb9, 0xbe, 0x0f, 0x85, 0x04, 0x6b); // LDA $0FBE,y STA $04 RTL
  a.label('cgext');
  a.b(0xc0, 0x00, 0x20); // CPY #$2000 (pages >= $10: draw tile $025)
  a.br(0x90, 'cgin');
  a.b(0xa0, 0x4a, 0x00); // LDY #$004A
  a.br(0x80, 'cgv');
  a.label('cgin');
  a.b(0x98, 0x38, 0xe9, 0x00, 0x04, 0x0a, 0x0a, 0x18); // TYA SEC SBC #$0400 ASL ASL CLC
  a.label('cadc');
  a.b(0x69, 0x00, 0x00); // ADC #gfx (patched after allocation)
  a.b(0x85, 0x04, 0xe2, 0x20); // STA $04 SEP #$20
  a.label('cbk');
  a.b(0xa9, 0x00); // LDA #bank (patched)
  a.b(0x85, 0x06, 0xc2, 0x20, 0x6b); // STA $06 REP #$20 RTL
  a.label('ActsTbl');
  a.fill(EXT_TILES * 2);
  return a;
}

// blank: the 4 tile words new tiles start with (an empty tile of the current tileset)
export function installMap16Ext(rom: Rom, blank: number[]): Map16Ext {
  const ex = map16Ext(rom);
  if (ex) return ex;
  const expect = (at: number, bytes: number[], what: string) => {
    for (let i = 0; i < bytes.length; i++) if (rom.r8(at + i) !== bytes[i]) throw new Error(`Unexpected code at $${at.toString(16).toUpperCase()} (${what})${ownerNote(rom, at, bytes.length)} – extended Map16 not possible`);
  };
  expect(F545, [0xa8, 0xd0, 0x2f, 0xac], 'block interaction');
  expect(HIT_HOOK, [0xa7, 0x05, 0xd0, 0x29], 'block from below');
  for (const r of RENDER_HOOKS) expect(r, [0xb9, 0xbe, 0x0f, 0x85, 0x0a], 'tilemap building');
  expect(PAGE0_FIX, [0x29, 0xfe], 'tile replacement');
  expect(PAGE1_FIX, [0x09, 0x01], 'tile replacement');
  expect(CHANGE_HOOK, CHANGE_CODE, 'tile replacement drawing');
  for (const p of LM_ACTS_PTRS) expect(p, [0xff, 0xff, 0xff], 'acts-like table pointer');

  const gfxData = new Uint8Array((EXT_TILES - EXT_FIRST) * 8);
  for (let t = 0; t < EXT_TILES - EXT_FIRST; t++) for (let k = 0; k < 4; k++) { gfxData[t * 8 + k * 2] = blank[k] & 0xff; gfxData[t * 8 + k * 2 + 1] = blank[k] >> 8; }
  const gfx = rom.allocWrite(gfxData);
  if ((gfx & 0xffff) + gfxData.length > 0x10000) throw new Error('Map16 graphics table crosses a bank boundary');
  // acts like: identity for pages 0/1, air for the new pages
  const acts = new Uint8Array(EXT_TILES * 2);
  for (let t = 0; t < EXT_TILES; t++) { const v = t < EXT_FIRST ? t : DEFAULT_ACTS; acts[t * 2] = v & 0xff; acts[t * 2 + 1] = v >> 8; }
  writeCode(rom, gfx, acts);
  rom.writeBytes(PAGE0_FIX, Uint8Array.from([0xa9, 0x00]));
  rom.writeBytes(PAGE1_FIX, Uint8Array.from([0xa9, 0x01]));
  return map16Ext(rom)!;
}

// assembles the code block with the given tables and points the hooks at it
function writeCode(rom: Rom, gfx: number, acts: Uint8Array): number {
  const a = build();
  const addr = rom.allocWrite(new Uint8Array(a.bytes.length));
  const code = a.link(addr);
  const L = (n: string) => a.addrOf(n, addr);
  // ADC #gfx operand and LDA #bank operand
  for (const [adcAt, bankAt] of [['radc', 'rbk'], ['cadc', 'cbk']]) {
    const adc = L(adcAt) - addr;
    code[adc + 1] = gfx & 0xff; code[adc + 2] = (gfx >> 8) & 0xff;
    code[L(bankAt) - addr + 1] = gfx >> 16;
  }
  code.set(acts, L('ActsTbl') - addr);
  rom.writeBytes(addr, code);
  rom.w24(addr + 4, L('ActsTbl'));
  rom.w24(addr + 7, gfx);
  for (const p of LM_ACTS_PTRS) rom.w24(p, L('ActsTbl'));
  const jml = L('F545');
  rom.writeBytes(F545, Uint8Array.from([0x5c, jml & 0xff, (jml >> 8) & 0xff, jml >> 16]));
  const jsl = (at: number, t: number, len: number) => {
    const b = [0x22, t & 0xff, (t >> 8) & 0xff, t >> 16];
    while (b.length < len) b.push(0xea);
    rom.writeBytes(at, Uint8Array.from(b));
  };
  jsl(HIT_HOOK, L('Hit'), 4);
  for (const r of RENDER_HOOKS) jsl(r, L('Render'), 5);
  jsl(CHANGE_HOOK, L('Change'), CHANGE_CODE.length); // the change-tile drawing
  return addr;
}

// points the table operands of Blk at the block table and enables the dispatch
function linkBlocks(rom: Rom, base: number, table: number): void {
  const a = build();
  const op = (label: string, add: number) => rom.w24(a.addrOf(label, base) + 1, table + add);
  op('opBank', BLK_HI); op('opFlags', BLK_HI + 1); op('opBank2', BLK_HI); op('opLo', 0);
  rom.w8(a.addrOf('opSkip', base) + 1, 0);
  rom.w24(base + 10, table);
  rom.w8(base + 13, 1);
}

// ---- custom blocks ----
export const BLOCK_OFFSETS = ['MarioBelow', 'MarioAbove', 'MarioSide', 'SpriteV', 'SpriteH', 'MarioCape', 'MarioFireball', 'TopCorner', 'BodyInside', 'HeadInside', 'WallFeet', 'WallBody'];

// the block table (installs/upgrades SMWX and allocates the table if needed)
export function enableBlocks(rom: Rom, blank: number[]): Map16Ext {
  const ex = installMap16Ext(rom, blank);
  if (ex.blocks) return ex;
  const table = rom.allocWrite(new Uint8Array(BLK_HI * 2));
  if ((table & 0xffff) + BLK_HI * 2 > 0x10000) throw new Error('Custom block table crosses a bank boundary');
  linkBlocks(rom, ex.base, table);
  return map16Ext(rom)!;
}
// address of the block's JMP table (after "db $42/$37") and whether it has the wall offsets; 0 = none
const ext = (rom: Rom) => map16Ext(rom) ?? missingPatch('Extended Map16 (SMWX)');
export function blockOf(rom: Rom, t: number): { addr: number; wall: boolean } | null {
  const e = ext(rom).blocks + (t & 0xfff) * 2;
  const addr = rom.r16(e) | (rom.r8(e + BLK_HI) << 16);
  return addr ? { addr, wall: (rom.r8(e + BLK_HI + 1) & 1) !== 0 } : null;
}
export function setBlock(rom: Rom, t: number, addr: number, wall: boolean): void {
  const e = ext(rom).blocks + (t & 0xfff) * 2;
  rom.w16(e, addr & 0xffff);
  rom.w8(e + BLK_HI, addr >> 16);
  rom.w8(e + BLK_HI + 1, addr && wall ? 1 : 0);
}

export function actsLike(rom: Rom, t: number): number {
  return rom.r16(ext(rom).acts + (t & 0xfff) * 2);
}
export function setActsLike(rom: Rom, t: number, v: number): void {
  rom.w16(ext(rom).acts + (t & 0xfff) * 2, v & 0x1ff);
}

// tile words (TL, BL, TR, BR) of an extended tile; null for tiles outside 200-FFF
// where extended tile t's 4 words are
export const extTileAddr = (rom: Rom, t: number) => ext(rom).gfx + (t - EXT_FIRST) * 8;
export function extTileWords(rom: Rom, t: number): number[] | null {
  if (t < EXT_FIRST || t >= EXT_TILES) return null;
  const a = extTileAddr(rom, t);
  return [rom.r16(a), rom.r16(a + 2), rom.r16(a + 4), rom.r16(a + 6)];
}
export function setExtTileWords(rom: Rom, t: number, words: number[]): void {
  if (t < EXT_FIRST || t >= EXT_TILES) throw new Error(`Tile ${t.toString(16)} is not an extended Map16 tile`);
  const a = extTileAddr(rom, t);
  words.forEach((w, k) => rom.w16(a + k * 2, w));
}
