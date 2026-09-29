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

import { Rom } from './rom.ts';
import { Asm } from './asm.ts';
import { ownerNote } from './patchreg.ts';

export const EXT_FIRST = 0x200;
export const EXT_TILES = 0x1000; // tiles $000-$FFF
export const DEFAULT_ACTS = 0x025; // new tiles act like air
const MAGIC = [0x53, 0x4d, 0x57, 0x58]; // "SMWX"
const HEADER = 16; // +4 acts table, +7 graphics table, +10 block table, +13 blocks enabled, +14 version
const VERSION = 2;

const F545 = 0x00f545;
const HIT_HOOK = 0x029328;
const RENDER_HOOKS = [0x058a66, 0x058b46, 0x058c34, 0x058d2b];
const PAGE0_FIX = 0x00c096;
const PAGE1_FIX = 0x00c0e7;

export interface Map16Ext { base: number; acts: number; gfx: number; blocks: number; version: number }

export function map16Ext(rom: Rom): Map16Ext | null {
  if (rom.r8(F545) !== 0x5c) return null;
  const base = rom.r24(F545 + 1) - HEADER;
  for (let i = 0; i < 4; i++) if (rom.r8(base + i) !== MAGIC[i]) return null;
  const version = rom.r8(base + 14) || 1;
  return { base, acts: rom.r24(base + 4), gfx: rom.r24(base + 7), blocks: version >= 2 && rom.r8(base + 13) ? rom.r24(base + 10) : 0, version };
}

function build(): Asm {
  const a = new Asm();
  a.b(...MAGIC); a.fill(HEADER - 4);
  a.labels.set('Flag', 13);
  a.bytes[14] = VERSION;
  // $00F545 replacement (entered by JML, M=8 X=8): custom block, map the tile, continue in the vanilla routine
  a.label('F545');
  a.long(0x22, 'Blk'); // JSL Blk
  a.b(0xa8); // TAY
  a.br(0xd0, 'f545p1');
  a.b(0xac, 0x93, 0x16, 0x5c, 0x4b, 0xf5, 0x00); // LDY $1693 JML $00F54B (page 0; the JML at $00F545 covers $00F548)
  a.label('f545p1');
  a.b(0x5c, 0x77, 0xf5, 0x00); // JML $00F577 (page 1)

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

  // Blk: like Acts, but first runs the custom block of the tile (if any) for the calling context.
  // The table operands (BlkTbl+n) are patched when blocks are enabled.
  a.label('Blk');
  a.b(0x48); // PHA
  a.long(0xaf, 'Flag'); // LDA.l Flag
  a.b(0xd0, 0x04, 0x68); // BNE +4 : PLA
  a.abs(0x4c, 'Acts'); // JMP Acts
  a.b(0x68, 0xda, 0x48); // PLA : PHX : PHA
  a.abs(0x20, 'Ctx'); // JSR Ctx → A = GPS offset * 3, $FF = none
  a.b(0xc9, 0xff);
  a.br(0xf0, 'plain');
  a.b(0x48); // PHA (offset)
  a.b(0xc2, 0x30, 0xa3, 0x02, 0x29, 0x0f, 0x00, 0xeb); // REP #$30 : LDA $02,S : AND #$000F : XBA
  a.b(0xe2, 0x20, 0xad, 0x93, 0x16, 0xc2, 0x20); // SEP #$20 : LDA $1693 : REP #$20 (A = tile)
  a.b(0x0a, 0x0a, 0xaa, 0xe2, 0x20); // ASL : ASL : TAX : SEP #$20
  a.label('opBank'); a.b(0xbf, 0, 0, 0); // LDA.l BlkTbl+2,x
  a.br(0xf0, 'noptr');
  a.b(0xa3, 0x01, 0xc9, 30); // LDA $01,S : CMP #30 (wall offsets need "db $37")
  a.br(0x90, 'ok');
  a.label('opFlags'); a.b(0xbf, 0, 0, 0); // LDA.l BlkTbl+3,x
  a.b(0x4a); // LSR
  a.br(0x90, 'noptr');
  a.label('ok');
  a.b(0x4b); // PHK
  a.abs(0xf4, 'back', -1); // PEA.w back-1
  a.label('opBank2'); a.b(0xbf, 0, 0, 0); // LDA.l BlkTbl+2,x
  a.b(0x48, 0xc2, 0x20, 0xa3, 0x05, 0x29, 0xff, 0x00, 0x18); // PHA : REP #$20 : LDA $05,S : AND #$00FF : CLC
  a.label('opLo'); a.b(0x7f, 0, 0, 0); // ADC.l BlkTbl,x
  a.b(0x3a, 0x48, 0xe2, 0x30, 0xa3, 0x08); // DEC : PHA : SEP #$30 : LDA $08,S (page)
  a.long(0x22, 'Acts'); // JSL Acts
  a.b(0xa8, 0xa3, 0x09, 0xaa, 0x6b); // TAY : LDA $09,S : TAX : RTL (→ block code)
  a.label('back');
  a.b(0xe2, 0x30, 0x68, 0x68, 0xfa, 0x98, 0x6b); // SEP #$30 : PLA : PLA : PLX : TYA : RTL
  a.label('noptr');
  a.b(0xe2, 0x30, 0x68); // SEP #$30 : PLA
  a.label('plain');
  a.b(0x68, 0xfa); // PLA : PLX
  a.abs(0x4c, 'Acts'); // JMP Acts

  // Ctx (JSR from Blk; stack: 3 page, 4 X, 5-7 Blk return, 8-10 return address of the $00F545 caller)
  const ret = (v: number) => a.b(0xa9, v, 0x60); // LDA #v : RTS
  a.label('Ctx');
  a.b(0xa3, 0x0a); a.br(0xd0, 'cNotMario'); // LDA $0A,S (bank) : BNE
  a.b(0xa3, 0x09, 0xc9, 0xf4); a.br(0xd0, 'cNone'); // $00F4E0: Mario
  a.b(0x8a, 0xc9, 0x62); a.br(0xb0, 'cWall'); // TXA : CMP #$62 : BCS wall running
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
  a.b(0xa3, 0x09, 0xc9, 0x95); a.br(0xd0, 'cNone'); // $019536: sprites
  a.b(0xa5, 0x0f, 0xc9, 0x02); a.br(0x90, 'cSprH'); ret(3 * 3); // SpriteV (floor/ceiling)
  a.label('cSprH'); ret(4 * 3); // SpriteH (walls)
  a.label('cB2'); a.b(0xc9, 0x02); a.br(0xd0, 'cNone');
  a.b(0xa3, 0x09, 0xc9, 0x96); a.br(0xf0, 'cCape'); a.b(0xc9, 0xa6); a.br(0xf0, 'cFire');
  a.label('cNone'); ret(0xff);
  a.label('cCape'); ret(5 * 3); // MarioCape
  a.label('cFire'); ret(6 * 3); // MarioFireball

  // renderers (M=16 X=16, Y = tile * 2): pointer to the tile's 8 bytes in $0A, bank in $0C
  a.label('Render');
  a.b(0xc0, 0x00, 0x04); // CPY #$0400
  a.br(0xb0, 'rext');
  a.b(0xb9, 0xbe, 0x0f, 0x85, 0x0a); // LDA $0FBE,y STA $0A
  // vanilla bank, chosen like the caller: $0D, or $05 if $1931 >= $10 (signed)
  a.b(0xe2, 0x20, 0xad, 0x31, 0x19, 0xc9, 0x10); // SEP #$20 LDA $1931 CMP #$10
  a.br(0x30, 'rb0d');
  a.b(0xa9, 0x05);
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
  a.label('ActsTbl');
  a.fill(EXT_TILES * 2);
  return a;
}

// blank: the 4 tile words new tiles start with (an empty tile of the current tileset)
export function installMap16Ext(rom: Rom, blank: number[]): Map16Ext {
  const ex = map16Ext(rom);
  if (ex) return ex.version < VERSION ? upgrade(rom, ex) : ex;
  const expect = (at: number, bytes: number[], what: string) => {
    for (let i = 0; i < bytes.length; i++) if (rom.r8(at + i) !== bytes[i]) throw new Error(`Unerwarteter Code bei $${at.toString(16).toUpperCase()} (${what})${ownerNote(rom, at, bytes.length)} – Map16-Erweiterung nicht möglich`);
  };
  expect(F545, [0xa8, 0xd0, 0x2f, 0xac], 'Block-Interaktion');
  expect(HIT_HOOK, [0xa7, 0x05, 0xd0, 0x29], 'Block von unten');
  for (const r of RENDER_HOOKS) expect(r, [0xb9, 0xbe, 0x0f, 0x85, 0x0a], 'Tilemap-Aufbau');
  expect(PAGE0_FIX, [0x29, 0xfe], 'Tile ersetzen');
  expect(PAGE1_FIX, [0x09, 0x01], 'Tile ersetzen');

  const gfxData = new Uint8Array((EXT_TILES - EXT_FIRST) * 8);
  for (let t = 0; t < EXT_TILES - EXT_FIRST; t++) for (let k = 0; k < 4; k++) { gfxData[t * 8 + k * 2] = blank[k] & 0xff; gfxData[t * 8 + k * 2 + 1] = blank[k] >> 8; }
  const gfx = rom.allocWrite(gfxData);
  if ((gfx & 0xffff) + gfxData.length > 0x10000) throw new Error('Map16-Grafiktabelle überschreitet eine Bankgrenze');
  // acts like: identity for pages 0/1, air for the new pages
  const acts = new Uint8Array(EXT_TILES * 2);
  for (let t = 0; t < EXT_TILES; t++) { const v = t < EXT_FIRST ? t : DEFAULT_ACTS; acts[t * 2] = v & 0xff; acts[t * 2 + 1] = v >> 8; }
  writeCode(rom, gfx, acts, 0);
  rom.writeBytes(PAGE0_FIX, Uint8Array.from([0xa9, 0x00]));
  rom.writeBytes(PAGE1_FIX, Uint8Array.from([0xa9, 0x01]));
  return map16Ext(rom)!;
}

// assembles the code block with the given tables and points the hooks at it
function writeCode(rom: Rom, gfx: number, acts: Uint8Array, blocks: number): number {
  const a = build();
  const addr = rom.allocWrite(new Uint8Array(a.bytes.length));
  const code = a.link(addr);
  const L = (n: string) => a.addrOf(n, addr);
  // ADC #gfx operand and LDA #bank operand
  const adc = L('radc') - addr;
  code[adc + 1] = gfx & 0xff; code[adc + 2] = (gfx >> 8) & 0xff;
  code[L('rbk') - addr + 1] = gfx >> 16;
  code.set(acts, L('ActsTbl') - addr);
  rom.writeBytes(addr, code);
  rom.w24(addr + 4, L('ActsTbl'));
  rom.w24(addr + 7, gfx);
  if (blocks) linkBlocks(rom, addr, blocks);
  const jml = L('F545');
  rom.writeBytes(F545, Uint8Array.from([0x5c, jml & 0xff, (jml >> 8) & 0xff, jml >> 16]));
  const jsl = (at: number, t: number, len: number) => {
    const b = [0x22, t & 0xff, (t >> 8) & 0xff, t >> 16];
    while (b.length < len) b.push(0xea);
    rom.writeBytes(at, Uint8Array.from(b));
  };
  jsl(HIT_HOOK, L('Hit'), 4);
  for (const r of RENDER_HOOKS) jsl(r, L('Render'), 5);
  return addr;
}

// version 1 (no custom blocks): same tables, new code
function upgrade(rom: Rom, old: Map16Ext): Map16Ext {
  const acts = rom.bytes(old.acts, EXT_TILES * 2);
  writeCode(rom, old.gfx, acts, 0);
  rom.freeAt(old.base);
  return map16Ext(rom)!;
}

// points the table operands of Blk at the block table and enables the dispatch
function linkBlocks(rom: Rom, base: number, table: number): void {
  const a = build();
  const op = (label: string, add: number) => rom.w24(a.addrOf(label, base) + 1, table + add);
  op('opBank', 2); op('opFlags', 3); op('opBank2', 2); op('opLo', 0);
  rom.w24(base + 10, table);
  rom.w8(base + 13, 1);
}

// ---- custom blocks ----
export const BLOCK_OFFSETS = ['MarioBelow', 'MarioAbove', 'MarioSide', 'SpriteV', 'SpriteH', 'MarioCape', 'MarioFireball', 'TopCorner', 'BodyInside', 'HeadInside', 'WallFeet', 'WallBody'];

// the block table (installs/upgrades SMWX and allocates the table if needed)
export function enableBlocks(rom: Rom, blank: number[]): Map16Ext {
  const ex = installMap16Ext(rom, blank);
  if (ex.blocks) return ex;
  const table = rom.allocWrite(new Uint8Array(EXT_TILES * 4));
  linkBlocks(rom, ex.base, table);
  return map16Ext(rom)!;
}
// address of the block's JMP table (after "db $42/$37") and whether it has the wall offsets; 0 = none
export function blockOf(rom: Rom, t: number): { addr: number; wall: boolean } | null {
  const p = map16Ext(rom);
  if (!p?.blocks) return null;
  const e = p.blocks + (t & 0xfff) * 4;
  const addr = rom.r24(e);
  return addr ? { addr, wall: (rom.r8(e + 3) & 1) !== 0 } : null;
}
export function setBlock(rom: Rom, t: number, addr: number, wall: boolean): void {
  const p = map16Ext(rom);
  if (!p?.blocks) throw new Error('Custom Blocks sind nicht aktiviert');
  const e = p.blocks + (t & 0xfff) * 4;
  rom.w24(e, addr);
  rom.w8(e + 3, addr && wall ? 1 : 0);
}

export function actsLike(rom: Rom, t: number): number {
  const p = map16Ext(rom);
  if (!p) return t < EXT_FIRST ? t : DEFAULT_ACTS;
  return rom.r16(p.acts + (t & 0xfff) * 2);
}
export function setActsLike(rom: Rom, t: number, v: number, blank: number[]): void {
  const p = installMap16Ext(rom, blank);
  rom.w16(p.acts + (t & 0xfff) * 2, v & 0x1ff);
}

// tile words (TL, BL, TR, BR) of an extended tile; null when the patch is not installed
export function extTileWords(rom: Rom, t: number): number[] | null {
  const p = map16Ext(rom);
  if (!p || t < EXT_FIRST || t >= EXT_TILES) return null;
  const a = p.gfx + (t - EXT_FIRST) * 8;
  return [rom.r16(a), rom.r16(a + 2), rom.r16(a + 4), rom.r16(a + 6)];
}
export function setExtTileWords(rom: Rom, t: number, words: number[], blank: number[]): void {
  if (t < EXT_FIRST || t >= EXT_TILES) throw new Error(`Tile ${t.toString(16)} ist kein erweitertes Map16-Tile`);
  const p = installMap16Ext(rom, blank);
  const a = p.gfx + (t - EXT_FIRST) * 8;
  words.forEach((w, k) => rom.w16(a + k * 2, w));
}
