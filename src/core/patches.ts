// The editor's ROM patch ("SMWE"), assembled on install:
//  - sprite data of each level may live in any bank (bank table, 512 entries)
//  - the current level number is kept in $7E010B (as Lunar Magic does)
//  - GFX pointer table with 4096 entries (GFX 00-31 vanilla, 32-FFF = ExGFX, as Lunar Magic's ExGFX 80-FFF)
//  - per-file format flag: 0 = LZ2 3bpp (vanilla), 1 = raw uncompressed 4bpp (DMA'd directly); raw files of
//    other sizes (layer3gfx.ts): 2 = 0x800 bytes (2bpp layer 3 graphics), 3 = 0x2000 (a layer 3 tilemap).
//    One of the game's files may be raw 4bpp too (colors 8-F, as Lunar Magic's 4bpp GFX): its upload goes
//    through the game's routine as far as the choice of the file ($00AA6B-$00AA7F, which loads GFX31 for
//    GFX01 after the special world), then copies it as it is instead of the 3bpp conversion; the game's
//    other code reading a file through $00BA28 gets it as 3bpp (the 4th bitplane dropped)
//  - per-level GFX bypass: 8 slots (SP4..SP1, FG3, BG1, FG2, FG1), low bytes and a table of high bytes;
//    0FF = tileset default. The game passes a file's low byte along (in $04-$07, Y); the high bytes of the
//    slots being uploaded are kept in RAM (EXGFX_HI_RAM) and joined with it where the file is looked up
//  - extended object $05 "Direct Map16": 6 bytes, places any Map16 tile as a rectangle; 7 with a condition
//    (Lunar Magic's conditional Direct Map16, cdm16.ts): bit 7 of the tile's high byte, then the condition byte
//  - "edited" mark at $0FF0A0 where Lunar Magic keeps its version string (see markEdited)

import { Rom } from './rom.ts';
import { Asm } from './asm.ts';
import { lz2Decompress } from './lz2.ts';
import { ownerNote } from './patchreg.ts';
import { LEVEL_HEIGHT_RAM, EXGFX_HI_RAM, CDM16_FLAGS, GFX_RAW_RAM, GFX_BUFFER } from './ram.ts';

export const SPR_BANK_HOOK = 0x05d8f5;

// object code (M=8): $6B/$6E on to the next screen of a horizontal level – the game's $1B0 bytes, or the
// level's screen size while the level heights patch loads a level with a size (levelheight.ts)
export function nextScreen(): number[] {
  const [a] = LEVEL_HEIGHT_RAM;
  return [0xc2, 0x20, 0xaf, a & 0xff, (a >> 8) & 0xff, a >> 16, 0xd0, 0x03, 0xa9, 0xb0, 0x01, // REP #$20 : LDA.l size : BNE + : LDA #$01B0
    0x18, 0x65, 0x6b, 0x85, 0x6b, 0x85, 0x6e, 0xe2, 0x20]; // + CLC : ADC $6B : STA $6B : STA $6E : SEP #$20
}
const HOOK_GFXPTR = 0x00ba2c;
// the game's table of GFX00–31: low, high and bank bytes (replaced by the editor's file table)
export const GAME_GFX_TABLE = [0x00b992, 0x00b9c4, 0x00b9f6];
export const HOOK_UPLOAD = 0x00aa6b;
// the start of the upload's 3bpp conversion (REP #$20 : LDA #$0000)
const HOOK_RAWUP = 0x00aa80;
const RAWUP_ORIG = [0xc2, 0x20, 0xa9, 0x00, 0x00];
const HOOK_SPRGFX = 0x00a9e1;
const HOOK_FGGFX = 0x00aa22;
const EXT_OBJ_TABLE = 0x0da10f;
// empty in the original game and in Lunar Magic, whose $02 is a 5-byte object (#117, tools/extobjprobe.ts)
export const DM16_EXT = 0x05;
const DM16_SLOT = EXT_OBJ_TABLE + DM16_EXT * 3;
// Lunar Magic writes "Lunar Magic Version x.yy …" to $0FF0A0 when it first saves a level, together with its
// level hacks (current level in $7E010B and others). Patches test $0FF0A0 != $FF for "a level editor's
// hacks are in" (Retry System) and read $0FF0B4, the version's first digit, for LM 3 features (with
// vanilla code otherwise). The editor patch brings the hack such patches need ($7E010B) and marks the ROM
// the same way, with its own name and $0FF0B4 = 0: no LM version, so LM-3-only paths are not taken.
const EDITED_MARK = 0x0ff0a0;
const EDITED_LEN = 0x15; // up to and including $0FF0B4
const EDITED_TEXT = 'Solar Magic';
// the bytes the editor patch changes in the game (SNES address, length), protected from other patches (patchapply.ts)
export const EDITOR_HOOKS: [number, number][] = [[SPR_BANK_HOOK, 4], [HOOK_GFXPTR, 15], [HOOK_UPLOAD, 4], [HOOK_RAWUP, 5], [HOOK_SPRGFX, 15], [HOOK_FGGFX, 15], [DM16_SLOT, 3], [EDITED_MARK, EDITED_LEN]];
const MAGIC = [0x53, 0x4d, 0x57, 0x45]; // "SMWE"
const VERSION = 5; // 5: the game's files as raw 4bpp
const HEADER = 32;
// GFX file numbers: 000-FFF (Lunar Magic's range); 0FF in a slot is "none" (the default), so no file has it
export const GFX_FILES = 0x1000;
export const MAX_GFX = GFX_FILES - 1;
export const GFX_NONE = 0xff;
// the RAM of the high bytes: the 8 slots of the bypass as the game uploads them (sprite slots, then
// FG/BG; uploaded again when one changes), then the one for the next upload by BG2/BG3 (EXT_UP_RET)
const SLOT_HI = EXGFX_HI_RAM[0], UP_HI = EXGFX_HI_RAM[0] + 8;
// the RAM of a raw file's upload: 1 during an upload, then the raw file to copy (its bank 0: none)
const UP_MODE = GFX_RAW_RAM[0], RAW_PTR = GFX_RAW_RAM[0] + 1;
const BUF = 0x7e0000 | GFX_BUFFER;
// the game's calls of its upload routine $00AA6B (their return addresses): the sprite and the FG/BG
// slots' loops (X = slot); BG2/BG3 call it with this return address (the RTL at $0084CF)
const SPR_UP_RET = 0xaa0a, FG_UP_RET = 0xaa4b, EXT_UP_RET = 0x84ce;
const long = (v: number) => [v & 0xff, (v >> 8) & 0xff, v >> 16];

export interface PatchInfo {
  base: number;
  version: number;
  sprBank: number;
  gfxLo: number;
  gfxHi: number;
  gfxBank: number;
  gfxFlags: number;
  levelGfx: number;
  levelGfxHi: number;
  decomp: number; // JSL (M=8, X=16): decompresses file X (16 bit) to $7EAD00 as the game's $00BA28 does
}

export function editorPatch(rom: Rom): PatchInfo | null {
  if (rom.r8(SPR_BANK_HOOK) !== 0x22) return null;
  const routine = rom.r24(SPR_BANK_HOOK + 1);
  const base = routine - HEADER;
  for (let i = 0; i < 4; i++) if (rom.r8(base + i) !== MAGIC[i]) return null;
  if (rom.r8(base + 4) !== VERSION) return null; // an older editor's ROM (no migrations: not opened)
  return {
    base,
    version: rom.r8(base + 4),
    sprBank: rom.r24(base + 5),
    gfxLo: rom.r24(base + 8),
    gfxHi: rom.r24(base + 11),
    gfxBank: rom.r24(base + 14),
    gfxFlags: rom.r24(base + 17),
    levelGfx: rom.r24(base + 20),
    levelGfxHi: rom.r24(base + 23),
    decomp: rom.r24(base + 26),
  };
}

// for the editor's patches that every opened ROM has (see editorpatches.ts)
export function missingPatch(what: string): never {
  throw new Error(`${what} is not installed in this ROM`);
}
const editor = (rom: Rom) => editorPatch(rom) ?? missingPatch('Editor patch (SMWE)');

function build(): Asm {
  const a = new Asm();
  a.b(...MAGIC, VERSION);
  // data pointers (patched after link, see install)
  a.fill(HEADER - 5);

  // ---- sprite bank + level number (M=8, X=16, Y=level*2) ----
  a.label('SprBank');
  a.b(0x08, 0xc2, 0x30, 0x48, 0xda, 0x98, 0x4a); // PHP REP#$30 PHA PHX TYA LSR
  a.b(0x8f, 0x0b, 0x01, 0x7e); // STA.l $7E010B
  a.b(0xaa, 0xe2, 0x20); // TAX SEP #$20
  a.long(0xbf, 'SprBankTbl'); // LDA.l tbl,x
  a.b(0x85, 0xd0, 0xc2, 0x20, 0xfa, 0x68, 0x28, 0x6b); // STA $D0 REP#$20 PLX PLA PLP RTL

  // ---- GFX pointer lookup (JSL from $00BA2C, M=8, Y = file): an LZ2 file is decompressed by the game; a
  // raw one is converted to 3bpp into the game's buffer (as the game would have it, for code reading it so
  // and for GFX31 decompressed over half of it) and, during an upload, remembered (RawUp copies it) ----
  a.label('GfxPtr');
  a.b(0xda, 0xbb); // PHX TYX
  a.long(0xbf, 'GfxLo'); a.b(0x85, 0x8a);
  a.long(0xbf, 'GfxHi'); a.b(0x85, 0x8b);
  a.long(0xbf, 'GfxBk'); a.b(0x85, 0x8c);
  a.long(0xbf, 'GfxFlags'); a.br(0xd0, 'praw');
  a.b(0x8f, ...long(RAW_PTR + 2)); // STA.l RawPtr bank (A = 0: the file is in the buffer)
  a.b(0xfa, 0x6b); // PLX RTL (→ the game's decompression)
  a.label('praw');
  a.b(0xaf, ...long(UP_MODE)); a.br(0xf0, 'p3'); // LDA.l UpMode : BEQ
  a.b(0xa5, 0x8a, 0x8f, ...long(RAW_PTR), 0xa5, 0x8b, 0x8f, ...long(RAW_PTR + 1), 0xa5, 0x8c, 0x8f, ...long(RAW_PTR + 2)); // RawPtr = $8A
  a.label('p3'); // 128 tiles: the first 16 bytes as they are, then every other byte (bitplane 2)
  a.b(0x08, 0xc2, 0x30, 0xa0, 0x00, 0x00, 0xa2, 0x00, 0x00); // PHP REP #$30 LDY #0 LDX #0
  a.label('p3t');
  a.b(0xa9, 0x08, 0x00, 0x48); // LDA #8 PHA
  a.label('p3w');
  a.b(0xb7, 0x8a, 0x9f, ...long(BUF), 0xc8, 0xc8, 0xe8, 0xe8); // LDA [$8A],y STA.l buf,x INY INY INX INX
  a.b(0xa3, 0x01, 0x3a, 0x83, 0x01); a.br(0xd0, 'p3w'); // LDA 1,S DEC STA 1,S BNE
  a.b(0xa9, 0x08, 0x00, 0x83, 0x01); // LDA #8 STA 1,S
  a.label('p3b');
  a.b(0xe2, 0x20, 0xb7, 0x8a, 0x9f, ...long(BUF), 0xc2, 0x20, 0xc8, 0xc8, 0xe8); // SEP #$20 LDA [$8A],y STA.l buf,x REP #$20 INY INY INX
  a.b(0xa3, 0x01, 0x3a, 0x83, 0x01); a.br(0xd0, 'p3b');
  a.b(0x68, 0xe0, 0x00, 0x0c); a.br(0xd0, 'p3t'); // PLA CPX #$0C00 BNE
  a.b(0x28); // PLP
  a.b(0xa9, BUF & 0xff, 0x85, 0x00, 0xa9, (BUF >> 8) & 0xff, 0x85, 0x01, 0xa9, BUF >> 16, 0x85, 0x02); // $00 = buf, as the game's
  a.b(0xfa, 0x68, 0x68, 0x68); // PLX, drop the JSL return
  a.b(0x5c, 0x4a, 0xba, 0x80); // JML $80BA4A (PLY PLB RTL)

  // ---- GFX upload (JSL from $00AA6B, M=8 X=8, Y = the file's low byte): its high byte by the caller;
  // files up to FF through the game's $00BA28 (GfxPtr), those above FF here; they go on as file 80 (the game
  // treats some of its own files, by number, differently: 01, 08, 1E); a raw file is copied by RawUp ----
  a.label('GfxUpload');
  a.b(0xda, 0x08, 0xc2, 0x20, 0xa3, 0x06); // PHX PHP REP #$20 LDA 6,S (the caller's JSR return)
  a.b(0xc9, ...long(SPR_UP_RET).slice(0, 2)); a.br(0xf0, 'uspr'); // CMP : BEQ
  a.b(0xc9, ...long(FG_UP_RET).slice(0, 2)); a.br(0xf0, 'ufg');
  a.b(0xc9, ...long(EXT_UP_RET).slice(0, 2)); a.br(0xf0, 'uext');
  a.b(0xe2, 0x20, 0xa9, 0x00); a.br(0x80, 'uhi'); // SEP #$20 LDA #$00 BRA
  a.label('uspr');
  a.b(0xe2, 0x20, 0xbf, ...long(SLOT_HI)); a.br(0x80, 'uhi'); // SEP #$20 LDA.l SlotHi,x
  a.label('ufg');
  a.b(0xe2, 0x20, 0xbf, ...long(SLOT_HI + 4)); a.br(0x80, 'uhi');
  a.label('uext');
  a.b(0xe2, 0x20, 0xaf, ...long(UP_HI)); // SEP #$20 LDA.l UpHi
  a.label('uhi');
  a.b(0xeb, 0x98, 0xc2, 0x10, 0xaa); // XBA TYA REP #$10 TAX (X = file, 16 bit)
  a.b(0xa9, 0x01, 0x8f, ...long(UP_MODE), 0xa9, 0x00, 0x8f, ...long(RAW_PTR + 2)); // UpMode = 1, no raw file yet
  a.b(0xeb); a.br(0xd0, 'big'); // XBA : BNE (above FF)
  a.b(0x28, 0xfa); // PLP PLX
  a.b(0x5c, 0x28, 0xba, 0x80); // JML $80BA28
  a.label('big');
  a.long(0xbf, 'GfxFlags'); a.br(0xd0, 'bigraw');
  a.long(0x22, 'GfxDecomp');
  a.label('bigend');
  a.b(0x28, 0xfa, 0xa0, 0x80, 0x6b); // PLP PLX LDY #$80 RTL (→ $00AA6F)
  a.label('bigraw');
  a.long(0xbf, 'GfxLo'); a.b(0x8f, ...long(RAW_PTR));
  a.long(0xbf, 'GfxHi'); a.b(0x8f, ...long(RAW_PTR + 1));
  a.long(0xbf, 'GfxBk'); a.b(0x8f, ...long(RAW_PTR + 2));
  a.br(0x80, 'bigend');

  // ---- the upload's conversion (JSL from $00AA80, Y = file): a raw file DMA'd from ROM as it is, else
  // the game's 3bpp conversion ----
  a.label('RawUp');
  a.b(0xe2, 0x20, 0xa9, 0x00, 0x8f, ...long(UP_MODE)); // SEP #$20 : UpMode = 0
  a.b(0xaf, ...long(RAW_PTR + 2)); a.br(0xd0, 'raw'); // LDA.l RawPtr bank : BNE
  a.b(0xc2, 0x20, 0xa9, 0x00, 0x00, 0x6b); // REP #$20 LDA #$0000 RTL (the replaced code)
  a.label('raw');
  a.b(0x8f, 0x04, 0x43, 0x00);
  a.b(0xaf, ...long(RAW_PTR), 0x8f, 0x02, 0x43, 0x00);
  a.b(0xaf, ...long(RAW_PTR + 1), 0x8f, 0x03, 0x43, 0x00);
  a.b(0xa9, 0x01, 0x8f, 0x00, 0x43, 0x00); // DMA mode 1
  a.b(0xa9, 0x18, 0x8f, 0x01, 0x43, 0x00); // → $2118
  a.b(0xa9, 0x00, 0x8f, 0x05, 0x43, 0x00);
  a.b(0xa9, 0x10, 0x8f, 0x06, 0x43, 0x00); // $1000 bytes
  a.b(0xa9, 0x01, 0x8f, 0x0b, 0x42, 0x00); // start
  a.b(0x68, 0x68, 0x68); // drop the JSL return
  a.b(0x5c, 0xd1, 0xa9, 0x80); // JML $80A9D1 (an RTS in bank 0: the upload's)

  // ---- decompression of any file (JSL, M=8 X=16, X = file): through the game's $00BA28 from where
  // it has the file's pointer; X and Y's high byte are lost ----
  a.label('GfxDecomp');
  a.b(0x8b); // PHB
  a.long(0xbf, 'GfxLo'); a.b(0x85, 0x8a);
  a.long(0xbf, 'GfxHi'); a.b(0x85, 0x8b);
  a.long(0xbf, 'GfxBk'); a.b(0x85, 0x8c);
  a.b(0x08, 0xe2, 0x10, 0x4b); a.abs(0xf4, 'dret', -1); // PHP SEP #$10 PHK PEA.w dret-1 (for its RTL)
  a.b(0x8b, 0x5a, 0xa9, 0x00, 0x48, 0xab); // PHB PHY (its PLY PLB) LDA #$00 PHA PLB
  a.b(0x5c, 0x3b, 0xba, 0x80); // JML $80BA3B
  a.label('dret');
  a.b(0x28, 0xab, 0x6b); // PLP PLB RTL

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

  // A = slot base (0 sprite slots, 4 FG/BG), M=8 X=8, DB=$00: the level's files into $04-$07 (its low
  // bytes; the high bytes to SlotHi), in levels only; a slot whose high byte is or was not 0 is uploaded
  // again (the game's record of uploaded files, $0101-$0108, holds low bytes)
  a.label('ApplyOvr');
  a.b(0x08, 0xc2, 0x30, 0x29, 0xff, 0x00, 0x48); // PHP REP #$30 AND #$00FF PHA (base: 7,S)
  a.b(0xa5, 0x08, 0x48, 0xa5, 0x0a, 0x48, 0xa5, 0x0c, 0x48, 0x64, 0x0c); // save $08-$0D, STZ $0C (levels: 1)
  a.b(0xaf, 0x00, 0x01, 0x7e, 0x29, 0xff, 0x00, 0xc9, 0x0b, 0x00); // LDA.l $7E0100 AND #$FF CMP #$0B
  a.br(0x90, 'ovlv');
  a.b(0xc9, 0x0f, 0x00); a.br(0x90, 'ovow'); // CMP #$0F : BCC (overworld)
  a.label('ovlv');
  a.b(0xe6, 0x0c, 0xaf, 0x0b, 0x01, 0x7e, 0x29, 0xff, 0x01, 0x0a, 0x0a, 0x0a); // INC $0C LDA.l $7E010B AND #$01FF ASL*3
  a.br(0x80, 'ovrow');
  a.label('ovow');
  a.b(0xa9, 0x00, 0x00);
  a.label('ovrow');
  a.b(0x18, 0x63, 0x07, 0x85, 0x08, 0xa0, 0x00, 0x00); // CLC ADC 7,S STA $08 (level*8 + base) LDY #0
  a.label('ovlp');
  a.b(0x98, 0x18, 0x65, 0x08, 0xaa, 0xe2, 0x20, 0x64, 0x0a, 0xa5, 0x0c); // TYA CLC ADC $08 TAX SEP #$20 STZ $0A (hi) LDA $0C
  a.br(0xf0, 'ovhi');
  a.long(0xbf, 'LevelGfx'); a.b(0x85, 0x0b);
  a.long(0xbf, 'LevelGfxHi'); a.b(0x85, 0x0a);
  a.br(0xd0, 'ovset');
  a.b(0xa5, 0x0b, 0xc9, 0xff); a.br(0xf0, 'ovhi'); // 0FF: the default
  a.label('ovset');
  a.b(0xa5, 0x0b, 0x99, 0x04, 0x00); // LDA $0B STA $0004,y
  a.label('ovhi');
  a.b(0xc2, 0x20, 0x8a, 0x29, 0x07, 0x00, 0xaa, 0xe2, 0x20); // REP #$20 TXA AND #7 TAX SEP #$20 (X = base + slot)
  a.b(0xa5, 0x0a, 0x1f, ...long(SLOT_HI)); a.br(0xf0, 'ovsame'); // LDA $0A ORA.l SlotHi,x
  a.b(0xb9, 0x04, 0x00, 0x49, 0xff, 0x9f, 0x01, 0x01, 0x7e); // LDA $0004,y EOR #$FF STA.l $7E0101,x
  a.label('ovsame');
  a.b(0xa5, 0x0a, 0x9f, ...long(SLOT_HI)); // STA.l SlotHi,x
  a.b(0xc2, 0x20, 0xc8, 0xc0, 0x04, 0x00); a.br(0xd0, 'ovlp'); // REP #$20 INY CPY #4 BNE
  a.b(0x68, 0x85, 0x0c, 0x68, 0x85, 0x0a, 0x68, 0x85, 0x08, 0x68, 0x28, 0x60); // restore, PLA PLP RTS

  // ---- extended object $05: Direct Map16 (M=8, X=8) ----
  a.label('DM16');
  a.b(0xa0, 0x00, 0xb7, 0x65, 0x85, 0x0c); // LDY #0 LDA [$65],y STA $0C
  a.b(0xc8, 0xb7, 0x65, 0x85, 0x0d); // INY LDA [$65],y STA $0D
  a.b(0xc8, 0xb7, 0x65, 0x85, 0x0e); // INY LDA [$65],y STA $0E
  a.b(0xa5, 0x65, 0x18, 0x69, 0x03, 0x85, 0x65, 0xa5, 0x66, 0x69, 0x00, 0x85, 0x66); // $65 += 3
  // conditional (cdm16.ts): bit 7 of the tile's high byte, the condition byte ACCCCCCC follows
  a.b(0xa5, 0x0d); a.br(0x10, 'dmshow'); // LDA $0D : BPL
  a.b(0x29, 0x7f, 0x85, 0x0d); // AND #$7F : STA $0D
  a.b(0xa7, 0x65, 0x85, 0x0f, 0xe6, 0x65, 0xd0, 0x02, 0xe6, 0x66); // LDA [$65] : STA $0F : INC $65 : BNE + : INC $66
  a.b(0x29, 0x07, 0xaa); a.long(0xbf, 'DM16Bits'); a.b(0x85, 0x00); // AND #7 : TAX : LDA.l bits,x : STA $00
  a.b(0xa5, 0x0f, 0x4a, 0x4a, 0x4a, 0x29, 0x0f, 0xaa); // LDA $0F : LSR #3 : AND #$0F : TAX
  a.b(0xbf, ...long(CDM16_FLAGS[0]), 0x25, 0x00); a.br(0xf0, 'dmoff'); // LDA.l flags,x : AND $00 : BEQ
  a.b(0x24, 0x0f); a.br(0x10, 'dmshow'); // BIT $0F : BPL (flag on: shown)
  a.b(0xe6, 0x0d); a.br(0x80, 'dmshow'); // INC $0D (always show, flag on: tiles + $100)
  a.label('dmoff');
  a.b(0x24, 0x0f); a.br(0x30, 'dmshow'); // BIT $0F : BMI (always show)
  a.b(0x68, 0x68, 0x6b); // not drawn: drop JSR return, RTL
  a.label('dmshow');
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
  a.b(...nextScreen()); // += a screen
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
  a.label('DM16Bits'); a.b(0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80);
  a.label('SprBankTbl'); a.fill(512, 0x07);
  a.label('GfxLo'); a.fill(GFX_FILES);
  a.label('GfxHi'); a.fill(GFX_FILES);
  a.label('GfxBk'); a.fill(GFX_FILES);
  a.label('GfxFlags'); a.fill(GFX_FILES);
  a.label('LevelGfx'); a.fill(512 * 8, 0xff);
  a.label('LevelGfxHi'); a.fill(512 * 8);
  return a;
}

function hook(rom: Rom, at: number, target: number, len: number, braTo?: number): void {
  const bytes = [0x22, target & 0xff, (target >> 8) & 0xff, (target >> 16) & 0xff];
  if (braTo !== undefined) bytes.push(0x80, braTo - (at + 6));
  while (bytes.length < len) bytes.push(0xea);
  rom.writeBytes(at, Uint8Array.from(bytes));
}

// marks the ROM as edited (see EDITED_MARK)
function markEdited(rom: Rom): void {
  for (let i = 0; i < EDITED_LEN; i++) rom.w8(EDITED_MARK + i, i < EDITED_TEXT.length ? EDITED_TEXT.charCodeAt(i) : 0);
}
// the editor's mark: a ROM it made
export function madeByEditor(rom: Rom): boolean {
  for (let i = 0; i < EDITED_LEN; i++) if (rom.r8(EDITED_MARK + i) !== (i < EDITED_TEXT.length ? EDITED_TEXT.charCodeAt(i) : 0)) return false;
  return true;
}

export function installEditorPatch(rom: Rom): PatchInfo {
  const existing = editorPatch(rom);
  if (existing) return existing;
  if (rom.r8(SPR_BANK_HOOK) !== 0xa9 || rom.r8(SPR_BANK_HOOK + 1) !== 0x07) throw new Error(`Unexpected code at $05D8F5${ownerNote(rom, SPR_BANK_HOOK, 4)} – patch not possible (ROM already modified otherwise?)`);
  if (rom.r8(HOOK_GFXPTR) !== 0xb9 || rom.r8(HOOK_UPLOAD) !== 0x22 || rom.r8(HOOK_SPRGFX) !== 0xad || rom.r8(HOOK_FGGFX) !== 0xad || RAWUP_ORIG.some((v, i) => rom.r8(HOOK_RAWUP + i) !== v)) {
    const note = ownerNote(rom, HOOK_GFXPTR, 15) || ownerNote(rom, HOOK_UPLOAD, 4) || ownerNote(rom, HOOK_RAWUP, 5) || ownerNote(rom, HOOK_SPRGFX, 15) || ownerNote(rom, HOOK_FGGFX, 15);
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
  rom.w24(addr + 23, L('LevelGfxHi'));
  rom.w24(addr + 26, L('GfxDecomp'));
  // copy vanilla GFX pointers
  for (let i = 0; i < 0x32; i++) {
    rom.w8(L('GfxLo') + i, rom.r8(GAME_GFX_TABLE[0] + i));
    rom.w8(L('GfxHi') + i, rom.r8(GAME_GFX_TABLE[1] + i));
    rom.w8(L('GfxBk') + i, rom.r8(GAME_GFX_TABLE[2] + i));
  }
  // hooks
  hook(rom, SPR_BANK_HOOK, L('SprBank'), 4);
  hook(rom, HOOK_GFXPTR, L('GfxPtr'), 15, 0x00ba3b);
  hook(rom, HOOK_UPLOAD, L('GfxUpload'), 4);
  hook(rom, HOOK_RAWUP, L('RawUp'), 5);
  hook(rom, HOOK_SPRGFX, L('SprGfxSel'), 15, 0x00a9f0);
  hook(rom, HOOK_FGGFX, L('FgGfxSel'), 15, 0x00aa31);
  rom.w24(DM16_SLOT, L('DM16'));
  markEdited(rom);
  return editorPatch(rom)!;
}

export function spriteBankOf(rom: Rom, n: number): number {
  return rom.r8(editor(rom).sprBank + n);
}
export function setSpriteBank(rom: Rom, n: number, bank: number): void {
  rom.w8(editor(rom).sprBank + n, bank);
}

// ---- GFX files ----
export const VANILLA_GFX = 0x32;
// raw: stored uncompressed, size bytes (0x1000 4bpp; 0x800, 0x2000 for layer 3)
export interface GfxEntry { addr: number; raw: boolean; size: number }
export const RAW_GFX_SIZES = [0x1000, 0x800, 0x2000]; // by format flag - 1
// Lunar Magic's ranges (LM help: file_insert_exgfx.htm, level_super_bypass.htm): ExGFX 80-DFF, and E00-FFF
// for files taken "as is", without its 3bpp/4bpp conversion (layer 3 graphics, layer 3 tilemaps, AN2).
// 32-7F, which the game doesn't use, are ExGFX too.
export const AS_IS_FIRST = 0xe00;
export type GfxRange = 'exgfx' | 'asIs';
export const gfxRange = (n: number): GfxRange | null => (n < VANILLA_GFX ? null : n >= AS_IS_FIRST ? 'asIs' : 'exgfx');
// layer 3's slots (layer3gfx.ts): LG1-LG4 (2bpp graphics) and LT3 (a tilemap)
export const LG_SLOT_NAMES = ['LG1', 'LG2', 'LG3', 'LG4'];
export const LT3_SLOT = 'LT3';
export const LAYER3_SLOT_NAMES = [...LG_SLOT_NAMES, LT3_SLOT];
export const GFX_3BPP = 0xc00; // a 3bpp file's size unpacked
// what is known of a file: the slot it is for, its size unpacked (gfxDataSize)
export interface GfxFileKind { slot?: string | null; size?: number }
// a GFX file's size unpacked: the LZ2 data's, else its own
export function gfxDataSize(data: Uint8Array): number {
  if (RAW_GFX_SIZES.includes(data.length) || data.length === GFX_3BPP) return data.length;
  try { return lz2Decompress(data, 0).data.length; } catch { return data.length; }
}
// the range a file belongs in: 3bpp graphics are ExGFX (the game converts them, so they can't be kept
// "as is"); files for layer 3's slots, 2bpp layer 3 graphics and layer 3 tilemaps "as is" (as Lunar
// Magic keeps them); other graphics ExGFX
export function gfxRangeFor(f: GfxFileKind): GfxRange {
  if (f.size === GFX_3BPP) return 'exgfx';
  if (f.slot && LAYER3_SLOT_NAMES.includes(f.slot)) return 'asIs';
  return f.size === 0x800 || f.size === 0x2000 ? 'asIs' : 'exgfx';
}
// why `n` can't hold the file `f`, null: it can – 000-FFF, not FF (a graphics slot's "none"), not the
// game's files 00-31 unless `game` (replacing one), no 3bpp graphics in E00-FFF
export function gfxNumberProblem(n: number, f: GfxFileKind & { game?: boolean } = {}): string | null {
  if (!Number.isInteger(n) || n < 0 || n > MAX_GFX) return `GFX numbers go up to ${gfxHex(MAX_GFX)}`;
  if (n === GFX_NONE) return `${gfxHex(GFX_NONE)} is a graphics slot's “none” and holds no file`;
  if (n < VANILLA_GFX && !f.game) return `00–${gfxHex(VANILLA_GFX - 1)} are the game's graphics files`;
  if (f.size === GFX_3BPP && gfxRange(n) === 'asIs') return `${gfxHex(n)} is in ${gfxHex(AS_IS_FIRST)}–${gfxHex(MAX_GFX)}, which hold files as they are (2bpp layer 3 graphics, layer 3 tilemaps); 3bpp graphics go in 80–${gfxHex(AS_IS_FIRST - 1)}`;
  return null;
}
// the first number of `range` that is free and not taken by `taken` (ExGFX: 80 on first, as Lunar Magic
// suggests, then 32-7F), -1: none left
export function freeGfx(rom: Rom, taken: Set<number>, range: GfxRange = 'exgfx'): number {
  const free = (i: number) => !gfxNumberProblem(i) && !taken.has(i) && !gfxEntry(rom, i);
  const order = range === 'asIs' ? [[AS_IS_FIRST, GFX_FILES]] : [[0x80, AS_IS_FIRST], [VANILLA_GFX, 0x80]];
  for (const [from, to] of order) for (let i = from; i < to; i++) if (free(i)) return i;
  return -1;
}

// a GFX file number as text: two hex digits up to FF (as the game's and Lunar Magic's 80-FF), else three
export const gfxHex = (n: number) => n.toString(16).toUpperCase().padStart(n > 0xff ? 3 : 2, '0');

// a GFX file number (000-FFF), else an error
export function gfxNum(n: number): number {
  if (!Number.isInteger(n) || n < 0 || n > MAX_GFX) throw new Error(`GFX number must be 000–${MAX_GFX.toString(16).toUpperCase()}`);
  return n;
}
export function gfxEntry(rom: Rom, i: number): GfxEntry | null {
  const p = editor(rom);
  if (i < 0 || i > MAX_GFX) return null;
  const addr = rom.r8(p.gfxLo + i) | (rom.r8(p.gfxHi + i) << 8) | (rom.r8(p.gfxBank + i) << 16);
  if (addr === 0) return null;
  const f = rom.r8(p.gfxFlags + i);
  return { addr, raw: f !== 0, size: f ? RAW_GFX_SIZES[f - 1] ?? 0x1000 : 0 };
}
export function setGfxEntry(rom: Rom, i: number, addr: number, raw: boolean, size = 0x1000): void {
  const p = editor(rom);
  gfxNum(i);
  rom.w8(p.gfxLo + i, addr & 0xff);
  rom.w8(p.gfxHi + i, (addr >> 8) & 0xff);
  rom.w8(p.gfxBank + i, (addr >> 16) & 0xff);
  if (raw && !RAW_GFX_SIZES.includes(size)) throw new Error(`No uncompressed GFX file has ${size} bytes`);
  rom.w8(p.gfxFlags + i, raw ? RAW_GFX_SIZES.indexOf(size) + 1 : 0);
}

// ---- per-level GFX bypass ----
export const GFX_SLOT_NAMES = ['SP4', 'SP3', 'SP2', 'SP1', 'FG3', 'BG1', 'FG2', 'FG1'];
export function levelGfx(rom: Rom, n: number): number[] {
  const p = editor(rom);
  return Array.from({ length: 8 }, (_, k) => rom.r8(p.levelGfx + n * 8 + k) | (rom.r8(p.levelGfxHi + n * 8 + k) << 8));
}
export function setLevelGfx(rom: Rom, n: number, slots: number[]): void {
  const p = editor(rom);
  slots.forEach((v, k) => { gfxNum(v); rom.w8(p.levelGfx + n * 8 + k, v & 0xff); rom.w8(p.levelGfxHi + n * 8 + k, v >> 8); });
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

export const PALETTE_SIZE = 0x200; // a level's own colors: 256 (color 0 the back area color)
const palettes = (rom: Rom) => customPalettePatch(rom) ?? missingPatch('Level palettes (SMWP)');
export function customPalette(rom: Rom, level: number): number {
  return rom.r24(palettes(rom).table + level * 3);
}
export function setCustomPalette(rom: Rom, level: number, colors: Uint8Array | null): number {
  const p = palettes(rom);
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
const bgBanks = (rom: Rom) => bgPatch(rom) ?? missingPatch('BG tilemaps (SMWB)');
export function bgBank(rom: Rom, level: number): number {
  return rom.r8(bgBanks(rom).table + level);
}
export function setBgBank(rom: Rom, level: number, bank: number): void {
  rom.w8(bgBanks(rom).table + level, bank);
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
const musicTable = (rom: Rom) => (musicPatch(rom) ?? missingPatch('Music per level (SMWU)')).table;
export function levelMusic(rom: Rom, level: number): number {
  return rom.r8(musicTable(rom) + level);
}
export function setLevelMusic(rom: Rom, level: number, song: number): void {
  rom.w8(musicTable(rom) + level, song);
}

// ---------------------------------------------------------------------------
// BG2/BG3 GFX slots per level ("SMWG"): after the FG/BG1 files are uploaded ($00AA50, end of the
// tileset GFX routine), GFX/ExGFX files are uploaded to VRAM $2000 (BG2, tiles 200-27F) and $2800
// (BG3, tiles 280-2FF) - like Lunar Magic's BG2/BG3 slots. The upload uses the game's own routine
// $00AA6B, so both LZ2 (3bpp) and raw 4bpp files work.
// In the original game the layer 1 tilemap lives at VRAM $2000-$2FFF, so the slots need the tilemaps
// moved out of the way first (VRAM patch, like LM's).
export const EXT_GFX_HOOK = 0x00aa50;
export const EXT_GFX_HOOKS: [number, number][] = [[EXT_GFX_HOOK, 5]];
const EXT_GFX_MAGIC = [0x53, 0x4d, 0x57, 0x47]; // "SMWG"
export const EXT_GFX_SLOT_NAMES = ['BG2', 'BG3'];
const EXT_GFX_ORIG = [0xa2, 0x03, 0xb5, 0x04, 0x9d, 0x05, 0x01, 0xca, 0x10, 0xf8, 0x60];

// set by the VRAM patch (vram.ts) once it exists: whether VRAM $2000-$2FFF is free for graphics
export let vramPatchInstalled: (rom: Rom) => boolean = () => false;
export function setVramPatchCheck(f: (rom: Rom) => boolean): void { vramPatchInstalled = f; }

export function extGfxPatch(rom: Rom): { table: number } | null {
  if (rom.r8(EXT_GFX_HOOK) !== 0x22) return null;
  const base = rom.r24(EXT_GFX_HOOK + 1) - 8;
  if (!EXT_GFX_MAGIC.every((m, i) => rom.r8(base + i) === m)) return null;
  return { table: rom.r24(base + 4) };
}

export function installExtGfxPatch(rom: Rom): { table: number } {
  if (!vramPatchInstalled(rom)) throw new Error('BG2/BG3 graphics are not available yet: the layer tilemaps must first be moved in VRAM (VRAM patch).');
  const ex = extGfxPatch(rom);
  if (ex) return ex;
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
  a.b(0xc2, 0x30, 0xaf, 0x0b, 0x01, 0x7e, 0x29, 0xff, 0x01, 0x0a, 0x0a, 0xaa, 0xda); // REP #$30 : LDA.l $7E010B : AND #$01FF : ASL #2 : TAX : PHX
  a.long(0xbf, 'Tbl'); // LDA.l Tbl,x (BG2)
  a.b(0xa0, 0x20, 0x00); a.abs(0x20, 'Up'); // LDY #$0020 : JSR Up (BG2 → VRAM $2000)
  a.b(0xfa, 0xe8, 0xe8); a.long(0xbf, 'Tbl'); // PLX : INX #2 : LDA.l Tbl,x (BG3)
  a.b(0xa0, 0x28, 0x00); a.abs(0x20, 'Up'); // LDY #$0028 : JSR Up (BG3 → VRAM $2800)
  a.label('out');
  a.b(0xe2, 0x30, 0x6b); // SEP #$30 : RTL
  // Up (M=16 X=16): A = file ($00FF = none), Y = VRAM address high byte; the file's high byte goes to the
  // editor patch's UpHi, which its upload takes for a call with this return address (EXT_UP_RET)
  a.label('Up');
  a.b(0xc9, 0xff, 0x00); a.br(0xf0, 'upx'); // CMP #$00FF : BEQ
  a.b(0xe2, 0x30, 0xeb, 0x8f, ...long(UP_HI), 0xeb); // SEP #$30 : XBA : STA.l UpHi : XBA
  a.b(0x9c, 0x16, 0x21, 0x8c, 0x17, 0x21, 0xa8); // STZ $2116 : STY $2117 : TAY (file)
  a.b(0x4b); a.abs(0xf4, 'upr', -1); a.b(0xf4, EXT_UP_RET & 0xff, EXT_UP_RET >> 8); // PHK : PEA.w upr-1 : PEA.w $84CF-1
  a.b(0x5c, 0x6b, 0xaa, 0x80); // JML $80AA6B (ends with RTS → $0084CF RTL → upr)
  a.label('upr');
  a.label('upx');
  a.b(0xc2, 0x30, 0x60); // REP #$30 : RTS
  a.label('Tbl');
  for (let i = 0; i < 512 * 2; i++) a.w(GFX_NONE);
  const addr = rom.allocWrite(new Uint8Array(a.bytes.length));
  rom.writeBytes(addr, a.link(addr));
  rom.w24(addr + 4, a.addrOf('Tbl', addr));
  const t = a.addrOf('Ext', addr);
  rom.writeBytes(EXT_GFX_HOOK, Uint8Array.from([0x22, t & 0xff, (t >> 8) & 0xff, t >> 16, 0x60]));
  return extGfxPatch(rom)!;
}

// BG2/BG3 files of a level (0FF = none), a word each
const extGfxTable = (rom: Rom) => (extGfxPatch(rom) ?? missingPatch('BG2/BG3 graphics (SMWG)')).table;
export function levelExtGfx(rom: Rom, n: number): number[] {
  const t = extGfxTable(rom);
  return [rom.r16(t + n * 4), rom.r16(t + n * 4 + 2)];
}
export function setLevelExtGfx(rom: Rom, n: number, slots: number[]): void {
  const t = extGfxTable(rom);
  rom.w16(t + n * 4, gfxNum(slots[0]));
  rom.w16(t + n * 4 + 2, gfxNum(slots[1]));
}
