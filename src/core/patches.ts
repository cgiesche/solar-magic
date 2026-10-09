// The editor's ROM patch ("SMWE"), assembled on install:
//  - sprite data of each level may live in any bank (bank table, 512 entries)
//  - the current level number is kept in $7E010B (as Lunar Magic does)
//  - GFX pointer table with 256 entries (GFX 00-31 vanilla, 32-FF = ExGFX)
//  - per-file format flag: 0 = LZ2 3bpp (vanilla), 1 = raw uncompressed 4bpp (DMA'd directly)
//  - per-level GFX bypass: 8 slots (SP4..SP1, FG3, BG1, FG2, FG1), $FF = tileset default
//  - extended object $02 "Direct Map16": 6 bytes, places any Map16 tile as a rectangle
//  - "edited" mark at $0FF0A0 where Lunar Magic keeps its version string (see markEdited)

import { Rom, pcToSnes, snesToPc } from './rom.ts';
import { Asm } from './asm.ts';
import { ownerNote } from './patchreg.ts';

export const SPR_BANK_HOOK = 0x05d8f5;
const HOOK_GFXPTR = 0x00ba2c;
const HOOK_UPLOAD = 0x00aa6b;
const HOOK_SPRGFX = 0x00a9e1;
const HOOK_FGGFX = 0x00aa22;
const EXT_OBJ_TABLE = 0x0da10f;
export const DM16_EXT = 0x02;
const DM16_SLOT = EXT_OBJ_TABLE + DM16_EXT * 3; // empty in the original game
// Lunar Magic writes "Lunar Magic Version x.yy …" to $0FF0A0 when it first saves a level, together with its
// level hacks (current level in $7E010B and others). Patches test $0FF0A0 != $FF for "a level editor's
// hacks are in" (Retry System) and read $0FF0B4, the version's first digit, for LM 3 features (with
// vanilla code otherwise). The editor patch brings the hack such patches need ($7E010B) and marks the ROM
// the same way, with its own name and $0FF0B4 = 0: no LM version, so LM-3-only paths are not taken.
const EDITED_MARK = 0x0ff0a0;
const EDITED_LEN = 0x15; // up to and including $0FF0B4
const EDITED_TEXT = 'Solar Magic';
// the bytes the editor patch changes in the game (SNES address, length), protected from other patches (patchapply.ts)
export const EDITOR_HOOKS: [number, number][] = [[SPR_BANK_HOOK, 4], [HOOK_GFXPTR, 15], [HOOK_UPLOAD, 4], [HOOK_SPRGFX, 15], [HOOK_FGGFX, 15], [DM16_SLOT, 3], [EDITED_MARK, EDITED_LEN]];
const MAGIC = [0x53, 0x4d, 0x57, 0x45]; // "SMWE"
const HEADER = 32;

export interface PatchInfo {
  base: number;
  version: number;
  sprBank: number;
  gfxLo: number;
  gfxHi: number;
  gfxBank: number;
  gfxFlags: number;
  levelGfx: number;
}

export function editorPatch(rom: Rom): PatchInfo | null {
  if (rom.r8(SPR_BANK_HOOK) !== 0x22) return null;
  const routine = rom.r24(SPR_BANK_HOOK + 1);
  const base = routine - HEADER;
  for (let i = 0; i < 4; i++) if (rom.r8(base + i) !== MAGIC[i]) return null;
  return {
    base,
    version: rom.r8(base + 4),
    sprBank: rom.r24(base + 5),
    gfxLo: rom.r24(base + 8),
    gfxHi: rom.r24(base + 11),
    gfxBank: rom.r24(base + 14),
    gfxFlags: rom.r24(base + 17),
    levelGfx: rom.r24(base + 20),
  };
}

export function hasEditorPatch(rom: Rom): boolean {
  return editorPatch(rom) !== null;
}

function build(): Asm {
  const a = new Asm();
  a.b(...MAGIC, 2);
  // data pointers (patched after link, see install)
  a.fill(HEADER - 5);

  // ---- sprite bank + level number (M=8, X=16, Y=level*2) ----
  a.label('SprBank');
  a.b(0x08, 0xc2, 0x30, 0x48, 0xda, 0x98, 0x4a); // PHP REP#$30 PHA PHX TYA LSR
  a.b(0x8f, 0x0b, 0x01, 0x7e); // STA.l $7E010B
  a.b(0xaa, 0xe2, 0x20); // TAX SEP #$20
  a.long(0xbf, 'SprBankTbl'); // LDA.l tbl,x
  a.b(0x85, 0xd0, 0xc2, 0x20, 0xfa, 0x68, 0x28, 0x6b); // STA $D0 REP#$20 PLX PLA PLP RTL

  // ---- GFX pointer lookup (Y = file) ----
  a.label('GfxPtr');
  a.b(0xda, 0xbb); // PHX TYX
  a.long(0xbf, 'GfxLo'); a.b(0x85, 0x8a);
  a.long(0xbf, 'GfxHi'); a.b(0x85, 0x8b);
  a.long(0xbf, 'GfxBk'); a.b(0x85, 0x8c);
  a.b(0xfa, 0x6b); // PLX RTL

  // ---- GFX upload: raw 4bpp files are DMA'd straight from ROM ----
  a.label('GfxUpload');
  a.b(0xda, 0xbb); // PHX TYX
  a.long(0xbf, 'GfxFlags');
  a.br(0xd0, 'raw');
  a.b(0xfa); // PLX
  a.b(0x5c, 0x28, 0xba, 0x00); // JML $00BA28
  a.label('raw');
  a.long(0xbf, 'GfxLo'); a.b(0x8f, 0x02, 0x43, 0x00);
  a.long(0xbf, 'GfxHi'); a.b(0x8f, 0x03, 0x43, 0x00);
  a.long(0xbf, 'GfxBk'); a.b(0x8f, 0x04, 0x43, 0x00);
  a.b(0xa9, 0x01, 0x8f, 0x00, 0x43, 0x00); // DMA mode 1
  a.b(0xa9, 0x18, 0x8f, 0x01, 0x43, 0x00); // → $2118
  a.b(0xa9, 0x00, 0x8f, 0x05, 0x43, 0x00);
  a.b(0xa9, 0x10, 0x8f, 0x06, 0x43, 0x00); // $1000 bytes
  a.b(0xa9, 0x01, 0x8f, 0x0b, 0x42, 0x00); // start
  a.b(0xfa, 0x68, 0x68, 0x68); // PLX, drop JSL return
  a.b(0x5c, 0xd1, 0xa9, 0x00); // JML $00A9D1 (an RTS in bank 0)

  // ---- GFX slot selection with per-level bypass ----
  a.label('SprGfxSel');
  a.b(0xad, 0x2b, 0x19, 0x0a, 0x0a, 0xa8); // LDA $192B ASL ASL TAY
  a.label('lp1');
  a.b(0xb9, 0xc3, 0xa8, 0x95, 0x04, 0xc8, 0xca); // LDA $A8C3,y STA $04,x INY DEX (DB = $00 here)
  a.br(0x10, 'lp1');
  a.b(0xa9, 0x00);
  a.abs(0x20, 'ApplyOvr');
  a.b(0x6b);

  a.label('FgGfxSel');
  a.b(0xad, 0x31, 0x19, 0x0a, 0x0a, 0xa8); // LDA $1931 ASL ASL TAY
  a.label('lp2');
  a.b(0xb9, 0x2b, 0xa9, 0x95, 0x04, 0xc8, 0xca); // LDA $A92B,y STA $04,x INY DEX
  a.br(0x10, 'lp2');
  a.b(0xa9, 0x04);
  a.abs(0x20, 'ApplyOvr');
  a.b(0x6b);

  a.label('ApplyOvr');
  a.b(0x48); // PHA (slot base offset)
  a.b(0xa5, 0x08, 0x48, 0xa5, 0x09, 0x48, 0xa5, 0x0a, 0x48, 0xa5, 0x0b, 0x48); // save scratch $08-$0B
  a.b(0xa3, 0x05, 0x85, 0x0b); // LDA 5,S STA $0B
  a.b(0xaf, 0x00, 0x01, 0x7e, 0xc9, 0x0b); // LDA.l $7E0100 CMP #$0B
  a.br(0x90, 'ovok');
  a.b(0xc9, 0x0f);
  a.br(0x90, 'ovout');
  a.label('ovok');
  a.b(0xc2, 0x20); // REP #$20
  a.b(0xaf, 0x0b, 0x01, 0x7e, 0x29, 0xff, 0x01, 0x0a, 0x0a, 0x0a, 0x18); // LDA.l $7E010B AND #$01FF ASL*3 CLC
  a.abs(0x69, 'LevelGfx'); // ADC #LevelGfx
  a.b(0x85, 0x08, 0xe2, 0x20); // STA $08 SEP #$20
  a.bankImm(0xa9, 'LevelGfx'); a.b(0x85, 0x0a); // LDA #bank STA $0A
  a.b(0xa4, 0x0b, 0xa2, 0x00); // LDY $0B LDX #$00
  a.label('lp3');
  a.b(0xb7, 0x08, 0xc9, 0xff); // LDA [$08],y CMP #$FF
  a.br(0xf0, 'ovnx');
  a.b(0x95, 0x04); // STA $04,x
  a.label('ovnx');
  a.b(0xc8, 0xe8, 0xe0, 0x04); // INY INX CPX #$04
  a.br(0xd0, 'lp3');
  a.label('ovout');
  a.b(0x68, 0x85, 0x0b, 0x68, 0x85, 0x0a, 0x68, 0x85, 0x09, 0x68, 0x85, 0x08, 0x68); // restore scratch, drop base
  a.b(0x60);

  // ---- extended object $02: Direct Map16 (M=8, X=8) ----
  a.label('DM16');
  a.b(0xa0, 0x00, 0xb7, 0x65, 0x85, 0x0c); // LDY #0 LDA [$65],y STA $0C
  a.b(0xc8, 0xb7, 0x65, 0x85, 0x0d); // INY LDA [$65],y STA $0D
  a.b(0xc8, 0xb7, 0x65, 0x85, 0x0e); // INY LDA [$65],y STA $0E
  a.b(0xa5, 0x65, 0x18, 0x69, 0x03, 0x85, 0x65, 0xa5, 0x66, 0x69, 0x00, 0x85, 0x66); // $65 += 3
  a.b(0xa5, 0x5b, 0xac, 0x33, 0x19); // LDA $5B LDY $1933
  a.br(0xf0, 'dmv1');
  a.b(0x4a); // LSR
  a.label('dmv1');
  a.b(0x29, 0x01, 0x85, 0x0f); // AND #1 STA $0F (vertical layer)
  a.b(0xa5, 0x0e, 0x4a, 0x4a, 0x4a, 0x4a, 0x85, 0x01); // rows-1
  a.label('dmrow');
  a.b(0xa5, 0x6b, 0x85, 0x04, 0xa5, 0x6c, 0x85, 0x05); // save row start
  a.b(0xa5, 0x0e, 0x29, 0x0f, 0x85, 0x00); // cols-1
  a.b(0xa4, 0x57); // LDY $57
  a.label('dmcol');
  a.b(0xa5, 0x0c, 0x97, 0x6b, 0xa5, 0x0d, 0x97, 0x6e); // store low/high byte
  a.b(0xc6, 0x00); // DEC $00
  a.br(0x30, 'dmcoldone');
  a.b(0xc8, 0x98, 0x29, 0x0f); // INY TYA AND #$0F
  a.br(0xd0, 'dmcol');
  a.b(0xa5, 0x0f);
  a.br(0xd0, 'dmvcross');
  a.b(0xa5, 0x6b, 0x18, 0x69, 0xb0, 0x85, 0x6b, 0x85, 0x6e, 0xa5, 0x6c, 0x69, 0x01, 0x85, 0x6c, 0x85, 0x6f); // += $1B0
  a.br(0x80, 'dmcrossed');
  a.label('dmvcross');
  a.b(0xe6, 0x6c, 0xe6, 0x6f); // += $100
  a.label('dmcrossed');
  a.b(0xa5, 0x57, 0x29, 0xf0, 0xa8); // LDA $57 AND #$F0 TAY
  a.br(0x80, 'dmcol');
  a.label('dmcoldone');
  a.b(0xa5, 0x04, 0x85, 0x6b, 0x85, 0x6e, 0xa5, 0x05, 0x85, 0x6c, 0x85, 0x6f); // restore row start
  a.b(0xa5, 0x57, 0x18, 0x69, 0x10, 0x85, 0x57); // $57 += $10
  a.br(0x90, 'dmnorow');
  a.b(0xa5, 0x0f);
  a.br(0xd0, 'dmvrow');
  a.b(0xe6, 0x6c, 0xe6, 0x6f);
  a.br(0x80, 'dmnorow');
  a.label('dmvrow');
  a.b(0xa5, 0x6c, 0x18, 0x69, 0x02, 0x85, 0x6c, 0x85, 0x6f);
  a.label('dmnorow');
  a.b(0xc6, 0x01); // DEC $01
  a.br(0x10, 'dmrow');
  a.b(0x68, 0x68, 0x6b); // drop JSR return, RTL

  // ---- tables ----
  a.label('SprBankTbl'); a.fill(512, 0x07);
  a.label('GfxLo'); a.fill(256);
  a.label('GfxHi'); a.fill(256);
  a.label('GfxBk'); a.fill(256);
  a.label('GfxFlags'); a.fill(256);
  a.label('LevelGfx'); a.fill(512 * 8, 0xff);
  return a;
}

function hook(rom: Rom, at: number, target: number, len: number, braTo?: number): void {
  const bytes = [0x22, target & 0xff, (target >> 8) & 0xff, (target >> 16) & 0xff];
  if (braTo !== undefined) bytes.push(0x80, braTo - (at + 6));
  while (bytes.length < len) bytes.push(0xea);
  rom.writeBytes(at, Uint8Array.from(bytes));
}

// marks the ROM as edited (see EDITED_MARK) unless Lunar Magic (or anything else) already wrote there
function markEdited(rom: Rom): void {
  for (let i = 0; i < EDITED_LEN; i++) if (rom.r8(EDITED_MARK + i) !== 0xff) return;
  for (let i = 0; i < EDITED_LEN; i++) rom.w8(EDITED_MARK + i, i < EDITED_TEXT.length ? EDITED_TEXT.charCodeAt(i) : 0);
}

export function installEditorPatch(rom: Rom): PatchInfo {
  const existing = editorPatch(rom);
  if (existing) { markEdited(rom); return existing; }
  if (rom.r8(SPR_BANK_HOOK) !== 0xa9 || rom.r8(SPR_BANK_HOOK + 1) !== 0x07) throw new Error(`Unexpected code at $05D8F5${ownerNote(rom, SPR_BANK_HOOK, 4)} – patch not possible (ROM already modified otherwise?)`);
  if (rom.r8(HOOK_GFXPTR) !== 0xb9 || rom.r8(HOOK_UPLOAD) !== 0x22 || rom.r8(HOOK_SPRGFX) !== 0xad || rom.r8(HOOK_FGGFX) !== 0xad) {
    const note = ownerNote(rom, HOOK_GFXPTR, 15) || ownerNote(rom, HOOK_UPLOAD, 4) || ownerNote(rom, HOOK_SPRGFX, 15) || ownerNote(rom, HOOK_FGGFX, 15);
    throw new Error(`Unexpected code in the graphics loading routine${note} – patch not possible`);
  }
  if (rom.r24(DM16_SLOT) !== 0) throw new Error(`Extended object $${DM16_EXT.toString(16).padStart(2, '0')} is already in use${ownerNote(rom, DM16_SLOT, 3)} – patch not possible`);
  const a = build();
  // allocate first to know the base address, then link
  const size = a.bytes.length;
  const addr = rom.allocWrite(new Uint8Array(size));
  const code = a.link(addr);
  rom.writeBytes(addr, code);
  const L = (n: string) => a.addrOf(n, addr);
  // header pointers
  rom.w24(addr + 5, L('SprBankTbl'));
  rom.w24(addr + 8, L('GfxLo'));
  rom.w24(addr + 11, L('GfxHi'));
  rom.w24(addr + 14, L('GfxBk'));
  rom.w24(addr + 17, L('GfxFlags'));
  rom.w24(addr + 20, L('LevelGfx'));
  // copy vanilla GFX pointers
  for (let i = 0; i < 0x32; i++) {
    rom.w8(L('GfxLo') + i, rom.r8(0x00b992 + i));
    rom.w8(L('GfxHi') + i, rom.r8(0x00b9c4 + i));
    rom.w8(L('GfxBk') + i, rom.r8(0x00b9f6 + i));
  }
  // hooks
  hook(rom, SPR_BANK_HOOK, L('SprBank'), 4);
  hook(rom, HOOK_GFXPTR, L('GfxPtr'), 15, 0x00ba3b);
  hook(rom, HOOK_UPLOAD, L('GfxUpload'), 4);
  hook(rom, HOOK_SPRGFX, L('SprGfxSel'), 15, 0x00a9f0);
  hook(rom, HOOK_FGGFX, L('FgGfxSel'), 15, 0x00aa31);
  rom.w24(DM16_SLOT, L('DM16'));
  markEdited(rom);
  return editorPatch(rom)!;
}

export function spriteBankOf(rom: Rom, n: number): number {
  const p = editorPatch(rom);
  return p ? rom.r8(p.sprBank + n) : 0x07;
}
export function setSpriteBank(rom: Rom, n: number, bank: number): void {
  const p = installEditorPatch(rom);
  rom.w8(p.sprBank + n, bank);
}

// ---- GFX files ----
export const VANILLA_GFX = 0x32;
export interface GfxEntry { addr: number; raw: boolean }
export function gfxEntry(rom: Rom, i: number): GfxEntry | null {
  const p = editorPatch(rom);
  if (!p) {
    if (i >= VANILLA_GFX) return null;
    return { addr: rom.r8(0x00b992 + i) | (rom.r8(0x00b9c4 + i) << 8) | (rom.r8(0x00b9f6 + i) << 16), raw: false };
  }
  const addr = rom.r8(p.gfxLo + i) | (rom.r8(p.gfxHi + i) << 8) | (rom.r8(p.gfxBank + i) << 16);
  if (addr === 0) return null;
  return { addr, raw: rom.r8(p.gfxFlags + i) !== 0 };
}
export function setGfxEntry(rom: Rom, i: number, addr: number, raw: boolean): void {
  const p = i >= VANILLA_GFX || raw ? installEditorPatch(rom) : editorPatch(rom);
  if (i < VANILLA_GFX) {
    rom.w8(0x00b992 + i, addr & 0xff);
    rom.w8(0x00b9c4 + i, (addr >> 8) & 0xff);
    rom.w8(0x00b9f6 + i, (addr >> 16) & 0xff);
  }
  if (p) {
    rom.w8(p.gfxLo + i, addr & 0xff);
    rom.w8(p.gfxHi + i, (addr >> 8) & 0xff);
    rom.w8(p.gfxBank + i, (addr >> 16) & 0xff);
    rom.w8(p.gfxFlags + i, raw ? 1 : 0);
  }
}

// ---- per-level GFX bypass ----
export const GFX_SLOT_NAMES = ['SP4', 'SP3', 'SP2', 'SP1', 'FG3', 'BG1', 'FG2', 'FG1'];
export function levelGfx(rom: Rom, n: number): number[] {
  const p = editorPatch(rom);
  if (!p) return new Array(8).fill(0xff);
  return Array.from({ length: 8 }, (_, k) => rom.r8(p.levelGfx + n * 8 + k));
}
export function setLevelGfx(rom: Rom, n: number, slots: number[]): void {
  const p = installEditorPatch(rom);
  slots.forEach((v, k) => rom.w8(p.levelGfx + n * 8 + k, v));
}
// defaults from the tileset / sprite set tables, in slot order
export function defaultGfx(rom: Rom, tileset: number, spriteSet: number): number[] {
  const out: number[] = [];
  for (let x = 0; x < 4; x++) out.push(rom.r8(0x00a8c3 + spriteSet * 4 + (3 - x)));
  for (let x = 0; x < 4; x++) out.push(rom.r8(0x00a92b + tileset * 4 + (3 - x)));
  return out;
}

// ---------------------------------------------------------------------------
// Custom palettes per level ("SMWP"): hook at $00922F (palette upload during level
// load, GM $12). If the level has a palette pointer, colors 1-255 are copied to the
// palette buffer $0703 and color 0 becomes the back area color ($0701).
const PAL_HOOK = 0x00922f;
export const PAL_HOOKS: [number, number][] = [[PAL_HOOK, 6]];
const PAL_MAGIC = [0x53, 0x4d, 0x57, 0x50]; // "SMWP"

export function customPalettePatch(rom: Rom): { base: number; table: number } | null {
  if (rom.r8(PAL_HOOK) !== 0x22) return null;
  const base = rom.r24(PAL_HOOK + 1) - 8;
  for (let i = 0; i < 4; i++) if (rom.r8(base + i) !== PAL_MAGIC[i]) return null;
  return { base, table: rom.r24(base + 4) };
}

export function installCustomPalettePatch(rom: Rom): { base: number; table: number } {
  const ex = customPalettePatch(rom);
  if (ex) return ex;
  installEditorPatch(rom); // needs the level number in $010B
  if (rom.r8(PAL_HOOK) !== 0x9c || rom.r16(PAL_HOOK + 1) !== 0x0703) throw new Error(`Unexpected code at $00922F${ownerNote(rom, PAL_HOOK, 6)} – palette patch not possible`);
  const a = new Asm();
  a.b(...PAL_MAGIC); a.fill(4); // +4: table pointer
  a.label('Pal');
  a.b(0x08, 0xc2, 0x30, 0x48, 0xda, 0x5a); // PHP REP#$30 PHA PHX PHY
  a.b(0xaf, 0x00, 0x01, 0x7e, 0x29, 0xff, 0x00, 0xc9, 0x12, 0x00); // LDA.l $7E0100 AND #$FF CMP #$12
  a.br(0xd0, 'out');
  a.b(0xaf, 0x0b, 0x01, 0x7e, 0x0a, 0x18, 0x6f, 0x0b, 0x01, 0x7e, 0xaa); // LDA.l $7E010B ASL CLC ADC.l $7E010B TAX (X = level*3)
  a.b(0xe2, 0x20); // SEP #$20
  a.long(0xbf, 'PalTblBank'); // LDA.l bank,x
  a.br(0xf0, 'out');
  a.b(0x48); // PHA (bank)
  a.b(0xc2, 0x20, 0xa4, 0x00, 0x5a, 0xa4, 0x02, 0x5a); // REP#$20 LDY $00 PHY LDY $02 PHY
  a.long(0xbf, 'PalTbl'); a.b(0x85, 0x00); // LDA.l tbl,x STA $00
  a.b(0xe2, 0x20, 0xa3, 0x05, 0x85, 0x02, 0xc2, 0x20); // SEP#$20 LDA 5,S STA $02 REP#$20
  a.b(0xa0, 0x02, 0x00); // LDY #$0002
  a.label('lp');
  a.b(0xb7, 0x00, 0xbb, 0x9f, 0x03, 0x07, 0x7e); // LDA [$00],y TYX STA.l $7E0703,x
  a.b(0xc8, 0xc8, 0xc0, 0x00, 0x02); // INY INY CPY #$0200
  a.br(0xd0, 'lp');
  a.b(0xa7, 0x00, 0x8f, 0x01, 0x07, 0x7e); // LDA [$00] STA.l $7E0701
  a.b(0x7a, 0x84, 0x02, 0x7a, 0x84, 0x00); // PLY STY $02 PLY STY $00
  a.b(0xe2, 0x20, 0x68); // SEP#$20 PLA
  a.label('out');
  a.b(0xc2, 0x30, 0xa9, 0x00, 0x00, 0x8f, 0x03, 0x07, 0x7e); // REP#$30 LDA #0 STA.l $7E0703 (original STZ $0703/$0704)
  a.b(0x7a, 0xfa, 0x68, 0x28, 0x6b); // PLY PLX PLA PLP RTL
  a.label('PalTbl');
  a.fill(2);
  a.label('PalTblBank');
  a.fill(512 * 3 - 2);
  const addr = rom.allocWrite(new Uint8Array(a.bytes.length));
  // PalTblBank is PalTbl+2 so that LDA.l PalTblBank,x reads the bank byte of entry x/3
  const code = a.link(addr);
  rom.writeBytes(addr, code);
  rom.w24(addr + 4, a.addrOf('PalTbl', addr));
  rom.writeBytes(PAL_HOOK, Uint8Array.from([0x22, ...[0, 8, 16].map((s) => ((a.addrOf('Pal', addr)) >> s) & 0xff), 0xea, 0xea]));
  return customPalettePatch(rom)!;
}

export function customPalette(rom: Rom, level: number): number {
  const p = customPalettePatch(rom);
  if (!p) return 0;
  return rom.r24(p.table + level * 3);
}
export function setCustomPalette(rom: Rom, level: number, colors: Uint8Array | null): number {
  const p = installCustomPalettePatch(rom);
  const old = rom.r24(p.table + level * 3);
  if (old) rom.freeAt(old);
  if (!colors) { rom.w24(p.table + level * 3, 0); return 0; }
  const addr = rom.allocWrite(colors);
  rom.w24(p.table + level * 3, addr);
  return addr;
}

// ---------------------------------------------------------------------------
// Level BG tilemaps in any bank ("SMWB"): hook at $058060 (LDA #$0C : STA $6A, the bank of
// BG tilemap data) reads the bank from a per-level table, 0 = vanilla bank $0C.
// Edited tilemaps are stored as RLE of 0x800 bytes (low bytes $7EB900-$7EBCFF, high bytes
// $7EBD00-$7EC0FF) so each tile may use either BG Map16 page.
export const BG_HOOK = 0x058060;
export const BG_HOOKS: [number, number][] = [[BG_HOOK, 4]];
const BG_MAGIC = [0x53, 0x4d, 0x57, 0x42]; // "SMWB"

export function bgPatch(rom: Rom): { table: number } | null {
  if (rom.r8(BG_HOOK) !== 0x22) return null;
  const base = rom.r24(BG_HOOK + 1) - 8;
  for (let i = 0; i < 4; i++) if (rom.r8(base + i) !== BG_MAGIC[i]) return null;
  return { table: rom.r24(base + 4) };
}

export function installBgPatch(rom: Rom): { table: number } {
  const ex = bgPatch(rom);
  if (ex) return ex;
  installEditorPatch(rom); // needs the level number in $010B
  if (rom.r8(BG_HOOK) !== 0xa9 || rom.r8(BG_HOOK + 1) !== 0x0c || rom.r16(BG_HOOK + 2) !== 0x6a85) {
    throw new Error(`Unexpected code at $058060${ownerNote(rom, BG_HOOK, 4)} – BG patch not possible`);
  }
  const a = new Asm();
  a.b(...BG_MAGIC); a.fill(4); // +4: table pointer
  a.label('Bg');
  a.b(0xc2, 0x30); // REP #$30 (X stays 16 bit as in the caller)
  a.b(0xaf, 0x0b, 0x01, 0x7e, 0x29, 0xff, 0x01, 0xaa); // LDA.l $7E010B AND #$01FF TAX
  a.b(0xe2, 0x20); // SEP #$20
  a.long(0xbf, 'Tbl'); // LDA.l Tbl,x
  a.br(0xd0, 'set');
  a.b(0xa9, 0x0c); // LDA #$0C
  a.label('set');
  a.b(0x85, 0x6a, 0x6b); // STA $6A : RTL
  a.label('Tbl');
  a.fill(512);
  const addr = rom.allocWrite(new Uint8Array(a.bytes.length));
  rom.writeBytes(addr, a.link(addr));
  rom.w24(addr + 4, a.addrOf('Tbl', addr));
  rom.writeBytes(BG_HOOK, Uint8Array.from([0x22, ...[0, 8, 16].map((s) => (a.addrOf('Bg', addr) >> s) & 0xff)]));
  return bgPatch(rom)!;
}

// bank of the level's BG tilemap data if it was stored by the editor, else 0
export function bgBank(rom: Rom, level: number): number {
  const p = bgPatch(rom);
  return p ? rom.r8(p.table + level) : 0;
}
export function setBgBank(rom: Rom, level: number, bank: number): void {
  rom.w8(installBgPatch(rom).table + level, bank);
}

// ---------------------------------------------------------------------------
// Music per level ("SMWU", like Lunar Magic's music bypass): the level header has only 8 music
// settings, looked up in the table at $0584DB. The hook at $058551 (LDA $0584DB,x) reads a song number
// from a per-level table first; 0 = the header's setting. The value is what the game writes to $0DDA,
// so any song of the sound engine works (vanilla or AddmusicK, whose patch keeps this code).
export const MUSIC_HOOK = 0x058551;
export const MUSIC_HOOKS: [number, number][] = [[MUSIC_HOOK, 4]];
const MUSIC_MAGIC = [0x53, 0x4d, 0x57, 0x55]; // "SMWU"
export const HEADER_MUSIC_TABLE = 0x0584db;

export function musicPatch(rom: Rom): { table: number } | null {
  if (rom.r8(MUSIC_HOOK) !== 0x22) return null;
  const base = rom.r24(MUSIC_HOOK + 1) - 8;
  for (let i = 0; i < 4; i++) if (rom.r8(base + i) !== MUSIC_MAGIC[i]) return null;
  return { table: rom.r24(base + 4) };
}

export function installMusicPatch(rom: Rom): { table: number } {
  const ex = musicPatch(rom);
  if (ex) return ex;
  installEditorPatch(rom); // needs the level number in $010B
  if (rom.r8(MUSIC_HOOK) !== 0xbf || rom.r24(MUSIC_HOOK + 1) !== HEADER_MUSIC_TABLE) {
    throw new Error(`Unexpected code at $058551${ownerNote(rom, MUSIC_HOOK, 4)} – music per level not possible`);
  }
  const a = new Asm();
  a.b(...MUSIC_MAGIC); a.fill(4); // +4: table pointer
  a.label('Mus');
  // called with A and X 8 bit, X = the header's music setting
  a.b(0xda); // PHX
  a.b(0xc2, 0x30); // REP #$30
  a.b(0xaf, 0x0b, 0x01, 0x7e, 0x29, 0xff, 0x01, 0xaa); // LDA.l $7E010B AND #$01FF TAX
  a.b(0xe2, 0x20); // SEP #$20
  a.long(0xbf, 'Tbl'); // LDA.l Tbl,x
  a.b(0xe2, 0x10, 0xfa); // SEP #$10 : PLX
  a.b(0x09, 0x00); // ORA #$00
  a.br(0xd0, 'set');
  a.b(0xbf, HEADER_MUSIC_TABLE & 0xff, (HEADER_MUSIC_TABLE >> 8) & 0xff, HEADER_MUSIC_TABLE >> 16); // LDA.l $0584DB,x
  a.label('set');
  a.b(0x6b); // RTL
  a.label('Tbl');
  a.fill(512);
  const addr = rom.allocWrite(new Uint8Array(a.bytes.length));
  rom.writeBytes(addr, a.link(addr));
  rom.w24(addr + 4, a.addrOf('Tbl', addr));
  rom.writeBytes(MUSIC_HOOK, Uint8Array.from([0x22, ...[0, 8, 16].map((s) => (a.addrOf('Mus', addr) >> s) & 0xff)]));
  return musicPatch(rom)!;
}

// the song a level plays instead of its header setting, 0 = none
export function levelMusic(rom: Rom, level: number): number {
  const p = musicPatch(rom);
  return p ? rom.r8(p.table + level) : 0;
}
export function setLevelMusic(rom: Rom, level: number, song: number): void {
  if (!song && !musicPatch(rom)) return;
  rom.w8(installMusicPatch(rom).table + level, song);
}

// ---------------------------------------------------------------------------
// BG2/BG3 GFX slots per level ("SMWG"): after the FG/BG1 files are uploaded ($00AA50, end of the
// tileset GFX routine), GFX/ExGFX files are uploaded to VRAM $2000 (BG2, tiles 200-27F) and $2800
// (BG3, tiles 280-2FF) - like Lunar Magic's BG2/BG3 slots. The upload uses the game's own routine
// $00AA6B, so both LZ2 (3bpp) and raw 4bpp files work.
// In the original game the layer 1 tilemap lives at VRAM $2000-$2FFF, so the slots need the tilemaps
// moved out of the way first (VRAM patch, like LM's). Without it the hook stays off; the table is kept.
export const EXT_GFX_HOOK = 0x00aa50;
export const EXT_GFX_HOOKS: [number, number][] = [[EXT_GFX_HOOK, 5]];
const EXT_GFX_MAGIC = [0x53, 0x4d, 0x57, 0x47]; // "SMWG"
export const EXT_GFX_SLOT_NAMES = ['BG2', 'BG3'];
const EXT_GFX_ORIG = [0xa2, 0x03, 0xb5, 0x04, 0x9d, 0x05, 0x01, 0xca, 0x10, 0xf8, 0x60];

// set by the VRAM patch (vram.ts) once it exists: whether VRAM $2000-$2FFF is free for graphics
export let vramPatchInstalled: (rom: Rom) => boolean = () => false;
export function setVramPatchCheck(f: (rom: Rom) => boolean): void { vramPatchInstalled = f; }

function extGfxBlock(rom: Rom): number {
  if (rom.r8(EXT_GFX_HOOK) === 0x22) {
    const base = rom.r24(EXT_GFX_HOOK + 1) - 8;
    if (EXT_GFX_MAGIC.every((m, i) => rom.r8(base + i) === m)) return base;
  }
  for (const b of rom.scanRats()) if (EXT_GFX_MAGIC.every((m, i) => rom.data[b.start + 8 + i] === m)) return pcToSnes(b.start + 8);
  return -1;
}

// the patch with its table; active = the hook at $00AA50 is in place
export function extGfxPatch(rom: Rom): { table: number; active: boolean } | null {
  const base = extGfxBlock(rom);
  if (base < 0) return null;
  return { table: rom.r24(base + 4), active: rom.r8(EXT_GFX_HOOK) === 0x22 && rom.r24(EXT_GFX_HOOK + 1) === base + 8 };
}

// turns the BG2/BG3 upload off where it would overwrite the layer 1 tilemap; true if it was on
export function disableUnsafeExtGfx(rom: Rom): boolean {
  const p = extGfxPatch(rom);
  if (!p?.active || vramPatchInstalled(rom)) return false;
  rom.writeBytes(EXT_GFX_HOOK, Uint8Array.from(EXT_GFX_ORIG.slice(0, 5)));
  return true;
}

export function installExtGfxPatch(rom: Rom): { table: number; active: boolean } {
  if (!vramPatchInstalled(rom)) throw new Error('BG2/BG3 graphics are not available yet: the layer tilemaps must first be moved in VRAM (VRAM patch).');
  const ex = extGfxPatch(rom);
  if (ex?.active) return ex;
  if (ex) {
    // switched off earlier: the code block and its table are still there, just hook it in again
    const base = extGfxBlock(rom) + 8;
    rom.writeBytes(EXT_GFX_HOOK, Uint8Array.from([0x22, base & 0xff, (base >> 8) & 0xff, base >> 16, 0x60]));
    return extGfxPatch(rom)!;
  }
  installEditorPatch(rom); // level number in $010B, ExGFX pointers
  const orig = EXT_GFX_ORIG;
  for (let i = 0; i < orig.length; i++) if (rom.r8(EXT_GFX_HOOK + i) !== orig[i]) throw new Error(`Unexpected code at $00AA50${ownerNote(rom, EXT_GFX_HOOK, 5)} – BG2/BG3 graphics not possible`);
  const a = new Asm();
  a.b(...EXT_GFX_MAGIC); a.fill(4); // +4: table pointer
  a.label('Ext');
  a.b(0xa2, 0x03); // LDX #$03 (replaced: remember the uploaded files)
  a.label('cp');
  a.b(0xb5, 0x04, 0x9d, 0x05, 0x01, 0xca); // LDA $04,x : STA $0105,x : DEX
  a.br(0x10, 'cp');
  // only in levels (like the GFX bypass): skip game modes $0B-$0E (overworld)
  a.b(0xaf, 0x00, 0x01, 0x7e, 0xc9, 0x0b); a.br(0x90, 'lv'); // LDA.l $7E0100 : CMP #$0B : BCC
  a.b(0xc9, 0x0f); a.br(0x90, 'out'); // CMP #$0F : BCC out
  a.label('lv');
  a.b(0xaf, 0x02, 0x36, 0x7f); a.br(0xf0, 'out'); // LDA.l $7F3602 (VRAM patch: layout active) : BEQ out
  a.b(0xc2, 0x30, 0xaf, 0x0b, 0x01, 0x7e, 0x29, 0xff, 0x01, 0x0a, 0xaa); // REP #$30 : LDA.l $7E010B : AND #$01FF : ASL : TAX
  a.long(0xbf, 'Tbl'); // LDA.l Tbl,x (BG2 | BG3 << 8)
  a.b(0xe2, 0x30, 0xeb, 0x48, 0xeb); // SEP #$30 : XBA : PHA (BG3) : XBA
  a.b(0xa0, 0x20); a.abs(0x20, 'Up'); // LDY #$20 : JSR Up (BG2 → VRAM $2000)
  a.b(0x68, 0xa0, 0x28); a.abs(0x20, 'Up'); // PLA : LDY #$28 : JSR Up (BG3 → VRAM $2800)
  a.label('out');
  a.b(0xe2, 0x30, 0x6b); // SEP #$30 : RTL
  // Up (M=8 X=8): A = file ($FF = none), Y = VRAM address high byte
  a.label('Up');
  a.b(0xc9, 0xff); a.br(0xf0, 'upx'); // CMP #$FF : BEQ
  a.b(0x9c, 0x16, 0x21, 0x8c, 0x17, 0x21, 0xa8); // STZ $2116 : STY $2117 : TAY (file)
  a.b(0x4b); a.abs(0xf4, 'upr', -1); a.b(0xf4, 0xce, 0x84); // PHK : PEA.w upr-1 : PEA.w $84CF-1
  a.b(0x5c, 0x6b, 0xaa, 0x00); // JML $00AA6B (ends with RTS → $0084CF RTL → upr)
  a.label('upr');
  a.b(0xe2, 0x30); // SEP #$30
  a.label('upx');
  a.b(0x60); // RTS
  a.label('Tbl');
  a.fill(512 * 2, 0xff);
  const addr = rom.allocWrite(new Uint8Array(a.bytes.length));
  rom.writeBytes(addr, a.link(addr));
  rom.w24(addr + 4, a.addrOf('Tbl', addr));
  const t = a.addrOf('Ext', addr);
  rom.writeBytes(EXT_GFX_HOOK, Uint8Array.from([0x22, t & 0xff, (t >> 8) & 0xff, t >> 16, 0x60]));
  return extGfxPatch(rom)!;
}

// BG2/BG3 files of a level ($FF = none)
export function levelExtGfx(rom: Rom, n: number): number[] {
  const p = extGfxPatch(rom);
  return p?.active ? [rom.r8(p.table + n * 2), rom.r8(p.table + n * 2 + 1)] : [0xff, 0xff];
}
export function extGfxAvailable(rom: Rom): boolean {
  return vramPatchInstalled(rom);
}
export function setLevelExtGfx(rom: Rom, n: number, slots: number[]): void {
  if (!extGfxPatch(rom) && slots.every((s) => s === 0xff)) return;
  const p = installExtGfxPatch(rom);
  rom.w8(p.table + n * 2, slots[0]);
  rom.w8(p.table + n * 2 + 1, slots[1]);
}

// ---------------------------------------------------------------------------
// AN2 per level ("SMWN"), like Lunar Magic's AN2 slot: a 4bpp ExGFX file kept in RAM from $7EAD00 for
// ExAnimation to copy frames from (frames there are addresses in bank $7E; the game's own animation
// graphics are at $7E7D00-$7EACFF). During a level load the game uses $7EAD00-$7EC0FF only as scratch
// (graphics decompression, the BG tilemap), during play nothing touches it – found by emulation. So the
// file is copied in after all graphics are uploaded and before the animations are first run: the level
// load's JSL $05BE8A at $00A5BF (after JSR $A9DA, the graphics; before JSR $A5F9, the animations)
// becomes a JSL to the copy, which goes on to $05BE8A. Only uncompressed 4bpp files (4 KB) can be AN2.
export const AN2_HOOK = 0x00a5bf;
export const AN2_HOOKS: [number, number][] = [[AN2_HOOK, 4]];
const AN2_MAGIC = [0x53, 0x4d, 0x57, 0x4e]; // "SMWN"
const AN2_ORIG = [0x22, 0x8a, 0xbe, 0x05]; // JSL $05BE8A
export const AN2_RAM = 0x7ead00;
export const AN2_SIZE = 0x1000;

// the patch with its table of 512 files ($FF = none)
export function an2Patch(rom: Rom): { table: number } | null {
  if (rom.r8(AN2_HOOK) !== 0x22) return null;
  const base = rom.r24(AN2_HOOK + 1) - 8;
  if (!AN2_MAGIC.every((m, i) => rom.r8(base + i) === m)) return null;
  return { table: rom.r24(base + 4) };
}

export function installAn2Patch(rom: Rom): { table: number } {
  const ex = an2Patch(rom);
  if (ex) return ex;
  for (let i = 0; i < AN2_ORIG.length; i++) if (rom.r8(AN2_HOOK + i) !== AN2_ORIG[i]) throw new Error(`Unexpected code at $00A5BF${ownerNote(rom, AN2_HOOK, 4)} – AN2 not possible`);
  const p = installEditorPatch(rom); // level number in $010B, ExGFX pointers
  const a = new Asm();
  a.b(...AN2_MAGIC); a.fill(4); // +4: table pointer
  a.label('An2');
  a.b(0x08, 0xc2, 0x30, 0x48, 0xda, 0x5a); // PHP : REP #$30 : PHA : PHX : PHY
  a.b(0xa5, 0x00, 0x48, 0xa5, 0x01, 0x48); // LDA $00 : PHA : LDA $01 : PHA (scratch $00-$02)
  a.b(0xe2, 0x20); // SEP #$20
  // only in levels (like the GFX bypass): skip game modes $0B-$0E (overworld)
  a.b(0xaf, 0x00, 0x01, 0x7e, 0xc9, 0x0b); a.br(0x90, 'lv'); // LDA.l $7E0100 : CMP #$0B : BCC lv
  a.b(0xc9, 0x0f); a.br(0x90, 'out'); // CMP #$0F : BCC out
  a.label('lv');
  a.b(0xc2, 0x20, 0xaf, 0x0b, 0x01, 0x7e, 0x29, 0xff, 0x01, 0xaa, 0xe2, 0x20); // REP #$20 : LDA.l $7E010B : AND #$01FF : TAX : SEP #$20
  a.long(0xbf, 'Tbl'); // LDA.l Tbl,x
  a.b(0xc9, 0xff); a.br(0xf0, 'out'); // CMP #$FF : BEQ out
  a.b(0xc2, 0x20, 0x29, 0xff, 0x00, 0xaa, 0xe2, 0x20); // REP #$20 : AND #$00FF : TAX : SEP #$20
  a.b(0xbf).l(p.gfxFlags); a.br(0xf0, 'out'); // LDA.l GfxFlags,x : BEQ out (uncompressed only)
  a.b(0xbf).l(p.gfxLo); a.b(0x85, 0x00); // LDA.l GfxLo,x : STA $00
  a.b(0xbf).l(p.gfxHi); a.b(0x85, 0x01);
  a.b(0xbf).l(p.gfxBank); a.b(0x85, 0x02);
  a.b(0xc2, 0x30, 0xa0).w(AN2_SIZE - 2); // REP #$30 : LDY #$0FFE
  a.label('cp');
  a.b(0xb7, 0x00, 0xbb, 0x9f).l(AN2_RAM); // LDA [$00],y : TYX : STA.l $7EAD00,x
  a.b(0x88, 0x88); a.br(0x10, 'cp'); // DEY : DEY : BPL cp
  a.label('out');
  a.b(0xc2, 0x30, 0x68, 0x85, 0x01, 0x68, 0x85, 0x00); // REP #$30 : PLA : STA $01 : PLA : STA $00
  a.b(0x7a, 0xfa, 0x68, 0x28); // PLY : PLX : PLA : PLP
  a.b(0x5c).l(0x05be8a); // JML $05BE8A
  a.label('Tbl');
  a.fill(512, 0xff);
  const addr = rom.allocWrite(new Uint8Array(a.bytes.length));
  rom.writeBytes(addr, a.link(addr));
  rom.w24(addr + 4, a.addrOf('Tbl', addr));
  const t = a.addrOf('An2', addr);
  rom.writeBytes(AN2_HOOK, Uint8Array.from([0x22, t & 0xff, (t >> 8) & 0xff, t >> 16]));
  return an2Patch(rom)!;
}

// the AN2 file of a level ($FF = none)
export function levelAn2(rom: Rom, n: number): number {
  const p = an2Patch(rom);
  return p ? rom.r8(p.table + n) : 0xff;
}
export function setLevelAn2(rom: Rom, n: number, file: number): void {
  if (!an2Patch(rom) && file === 0xff) return;
  if (file !== 0xff && !gfxEntry(rom, file)?.raw) throw new Error(`ExGFX ${file.toString(16).toUpperCase().padStart(2, '0')} cannot be AN2: only uncompressed 4bpp files (4 KB) can`);
  rom.w8(installAn2Patch(rom).table + n, file);
}

// [start, end) ROM offsets of the AN2 table: it only reaches VRAM (through ExAnimation), so emulated
// results don't depend on it (see gfxpages.ts)
export function an2DataRanges(rom: Rom): [number, number][] {
  const p = an2Patch(rom);
  if (!p) return [];
  const o = snesToPc(p.table);
  return o >= 0 && o + 512 <= rom.data.length ? [[o, o + 512]] : [];
}
