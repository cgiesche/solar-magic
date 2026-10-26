// Structures ("SMWS"): user-made blocks of Map16 tiles, placed as one level object.
// Extended object $04 takes one extra byte, the structure number (00-FF). The only change to the
// original game is the pointer for extended object $04 in the extended object table (empty in the
// original game), so no code of the game or of other patches is hooked. $04 is free in the clean game and
// in Lunar Magic, whose $03 is its swapped screen jump, a 3-byte object (#117, tools/extobjprobe.ts).
// Code block: "SMWS", version, pointer to the structure table, code. The table holds a 24-bit
// pointer per structure (0 = none, the object then places nothing). Each structure is its own
// RATS block: width, height, width*height tile words row by row ($FFFF = transparent, the tile
// below stays; with the top bit, COND_MARK, its condition byte follows: Lunar Magic's conditional Direct
// Map16, cdm16.ts), then its name (UTF-8, zero-terminated).

import { Rom } from './rom.ts';
import { Asm } from './asm.ts';
import { ownerNote } from './patchreg.ts';
import { missingPatch, nextScreen } from './patches.ts';
import { CDM16_FLAGS } from './ram.ts';
import { COND_MARK, condByte, condOf, type Dm16Cond } from './cdm16.ts';

export const EXT_OBJ_TABLE = 0x0da10f;
export const STRUCT_EXT = 0x04;
export const STRUCT_SLOT = EXT_OBJ_TABLE + STRUCT_EXT * 3;
export const STRUCT_HOOKS: [number, number][] = [[STRUCT_SLOT, 3]];
export const STRUCT_COUNT = 256;
export const STRUCT_MAX = 64; // width/height limit (the row/column counters are signed bytes)
export const TRANSPARENT = -1;
const MAGIC = [0x53, 0x4d, 0x57, 0x53]; // "SMWS"
const HEADER = 8;

export interface Structure {
  w: number;
  h: number;
  tiles: number[]; // row-major, TRANSPARENT = keep the tile below
  conds?: (Dm16Cond | null)[]; // per tile: its flag (missing: none)
  name: string;
}

export function structPatch(rom: Rom): { base: number; table: number } | null {
  const code = rom.r24(STRUCT_SLOT);
  if (!code) return null;
  const base = code - HEADER;
  if ((base & 0xffff) < 0x8000 || !MAGIC.every((m, i) => rom.r8(base + i) === m)) return null;
  return { base, table: rom.r24(base + 5) };
}

const structTable = (rom: Rom) => (structPatch(rom) ?? missingPatch('Structures (SMWS)')).table;

function build(): Asm {
  const a = new Asm();
  a.b(...MAGIC, 2); // 2: conditional tiles
  a.fill(HEADER - 5); // +5: table pointer
  // entry (M=8, X=8) from the extended object dispatcher; [$65] points behind the 3 object bytes
  a.label('Obj');
  a.b(0xa7, 0x65); // LDA [$65] (structure number)
  a.b(0xe6, 0x65, 0xd0, 0x02, 0xe6, 0x66); // INC $65 : BNE + : INC $66
  a.b(0xc2, 0x30, 0x29, 0xff, 0x00, 0x0a, 0xaa); // REP #$30 : AND #$00FF : ASL : TAX
  a.long(0xbf, 'TblW'); a.b(0x85, 0x08); // LDA.l TblW,x : STA $08
  a.b(0x8a, 0x4a, 0xaa, 0xe2, 0x20); // TXA : LSR : TAX : SEP #$20
  a.long(0xbf, 'TblB'); a.b(0x85, 0x0a); // LDA.l TblB,x : STA $0A
  a.b(0xe2, 0x10); // SEP #$10
  a.br(0xd0, 'have'); // bank 0: no structure
  a.b(0x68, 0x68, 0x6b); // drop JSR return, RTL
  a.label('have');
  a.b(0xa7, 0x08, 0x85, 0x0c); // LDA [$08] : STA $0C (width)
  a.b(0xa0, 0x01, 0xb7, 0x08, 0x3a, 0x85, 0x01); // LDY #1 : LDA [$08],y : DEC : STA $01 (rows-1)
  a.b(0xc2, 0x20, 0xa5, 0x08, 0x18, 0x69, 0x02, 0x00, 0x85, 0x08, 0xe2, 0x20); // $08 += 2 (16 bit)
  // which layer's layout (vertical or not), as in Direct Map16
  a.b(0xa5, 0x5b, 0xac, 0x33, 0x19); // LDA $5B LDY $1933
  a.br(0xf0, 'v1');
  a.b(0x4a); // LSR
  a.label('v1');
  a.b(0x29, 0x01, 0x85, 0x0f); // AND #1 STA $0F
  a.label('row');
  a.b(0xa5, 0x6b, 0x85, 0x04, 0xa5, 0x6c, 0x85, 0x05); // save row start
  a.b(0xa5, 0x0c, 0x3a, 0x85, 0x00); // cols-1
  a.b(0xa4, 0x57); // LDY $57
  a.label('col');
  a.b(0xc2, 0x20, 0xa7, 0x08, 0xe6, 0x08, 0xe6, 0x08, 0x85, 0x06); // REP #$20 : LDA [$08] : INC $08 : INC $08 : STA $06
  a.b(0xc9, 0xff, 0xff, 0xe2, 0x20); // CMP #$FFFF : SEP #$20 (keeps Z)
  a.br(0xf0, 'skip');
  // conditional (the word's top bit): drawn or not by its condition byte
  a.b(0xa5, 0x07); a.br(0x10, 'put'); // LDA $07 : BPL
  a.abs(0x20, 'Cond'); a.br(0x90, 'skip'); // JSR Cond : BCC
  a.label('put');
  a.b(0xa5, 0x06, 0x97, 0x6b, 0xa5, 0x07, 0x97, 0x6e); // LDA $06 : STA [$6B],y : LDA $07 : STA [$6E],y
  a.label('skip');
  a.b(0xc6, 0x00); // DEC $00
  a.br(0x30, 'coldone');
  a.b(0xc8, 0x98, 0x29, 0x0f); // INY TYA AND #$0F
  a.br(0xd0, 'col');
  a.b(0xa5, 0x0f);
  a.br(0xd0, 'vcross');
  a.b(...nextScreen()); // += a screen
  a.br(0x80, 'crossed');
  a.label('vcross');
  a.b(0xe6, 0x6c, 0xe6, 0x6f); // += $100
  a.label('crossed');
  a.b(0xa5, 0x57, 0x29, 0xf0, 0xa8); // LDA $57 AND #$F0 TAY
  a.br(0x80, 'col');
  a.label('coldone');
  a.b(0xa5, 0x04, 0x85, 0x6b, 0x85, 0x6e, 0xa5, 0x05, 0x85, 0x6c, 0x85, 0x6f); // restore row start
  a.b(0xa5, 0x57, 0x18, 0x69, 0x10, 0x85, 0x57); // $57 += $10
  a.br(0x90, 'norow');
  a.b(0xa5, 0x0f);
  a.br(0xd0, 'vrow');
  a.b(0xe6, 0x6c, 0xe6, 0x6f);
  a.br(0x80, 'norow');
  a.label('vrow');
  a.b(0xa5, 0x6c, 0x18, 0x69, 0x02, 0x85, 0x6c, 0x85, 0x6f);
  a.label('norow');
  a.b(0xc6, 0x01); // DEC $01
  a.br(0x30, 'done'); a.abs(0x4c, 'row'); // BMI : JMP row (out of a branch's reach)
  a.label('done');
  a.b(0x68, 0x68, 0x6b); // drop JSR return, RTL
  // the condition byte ACCCCCCC after the tile (cdm16.ts), A = the tile's high byte: carry set when the tile
  // is drawn ($06/$07, +$100 with always show and the flag on)
  a.label('Cond');
  a.b(0x29, 0x7f, 0x85, 0x07); // AND #$7F : STA $07
  a.b(0xa7, 0x08, 0x85, 0x0b, 0xc2, 0x20, 0xe6, 0x08, 0xe2, 0x20); // LDA [$08] : STA $0B : REP #$20 : INC $08 : SEP #$20
  a.b(0x29, 0x07, 0xaa); a.long(0xbf, 'Bits'); a.b(0x85, 0x0e); // AND #7 : TAX : LDA.l bits,x : STA $0E
  a.b(0xa5, 0x0b, 0x4a, 0x4a, 0x4a, 0x29, 0x0f, 0xaa); // LDA $0B : LSR #3 : AND #$0F : TAX
  a.b(0xbf, CDM16_FLAGS[0] & 0xff, (CDM16_FLAGS[0] >> 8) & 0xff, CDM16_FLAGS[0] >> 16, 0x25, 0x0e); a.br(0xf0, 'off'); // LDA.l flags,x : AND $0E : BEQ
  a.b(0x24, 0x0b); a.br(0x10, 'on'); // BIT $0B : BPL (flag on: drawn)
  a.b(0xe6, 0x07); // INC $07 (always show, flag on: tile + $100)
  a.label('on');
  a.b(0x38, 0x60); // SEC : RTS
  a.label('off');
  a.b(0x24, 0x0b); a.br(0x30, 'on'); // BIT $0B : BMI (always show)
  a.b(0x18, 0x60); // CLC : RTS (not drawn: the tile below stays)
  a.label('Bits'); a.b(0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80);
  a.label('TblW'); a.fill(STRUCT_COUNT * 2);
  a.label('TblB'); a.fill(STRUCT_COUNT);
  return a;
}

export function installStructPatch(rom: Rom): { base: number; table: number } {
  const ex = structPatch(rom);
  if (ex) return ex;
  if (rom.r24(STRUCT_SLOT) !== 0) throw new Error(`Extended object $${STRUCT_EXT.toString(16).padStart(2, '0')} is already in use${ownerNote(rom, STRUCT_SLOT, 3)} – structures not possible`);
  const a = build();
  const addr = rom.allocWrite(new Uint8Array(a.bytes.length));
  rom.writeBytes(addr, a.link(addr));
  rom.w24(addr + 5, a.addrOf('TblW', addr));
  rom.w24(STRUCT_SLOT, a.addrOf('Obj', addr));
  return structPatch(rom)!;
}

// the table: word part, then bank part
function ptrOf(rom: Rom, table: number, n: number): number {
  return rom.r16(table + n * 2) | (rom.r8(table + STRUCT_COUNT * 2 + n) << 16);
}
function setPtr(rom: Rom, table: number, n: number, addr: number): void {
  rom.w8(table + n * 2, addr & 0xff);
  rom.w8(table + n * 2 + 1, (addr >> 8) & 0xff);
  rom.w8(table + STRUCT_COUNT * 2 + n, (addr >> 16) & 0xff);
}

export function readStructure(rom: Rom, n: number): Structure | null {
  const a = ptrOf(rom, structTable(rom), n);
  if (!(a >> 16)) return null;
  const w = rom.r8(a), h = rom.r8(a + 1);
  const tiles: number[] = [], conds: (Dm16Cond | null)[] = [];
  let p = a + 2;
  for (let i = 0; i < w * h; i++, p += 2) {
    const t = rom.r16(p);
    const c = t !== 0xffff && (t & COND_MARK) !== 0;
    tiles.push(t === 0xffff ? TRANSPARENT : t & ~COND_MARK);
    conds.push(c ? condOf(rom.r8(p + 2)) : null);
    if (c) p++;
  }
  const nameAt = p;
  const bytes: number[] = [];
  for (let i = 0; i < 64; i++) { const c = rom.r8(nameAt + i); if (!c) break; bytes.push(c); }
  return { w, h, tiles, ...(conds.some((c) => c) ? { conds } : {}), name: new TextDecoder().decode(Uint8Array.from(bytes)) };
}

export function listStructures(rom: Rom): Map<number, Structure> {
  const out = new Map<number, Structure>();
  for (let n = 0; n < STRUCT_COUNT; n++) { const s = readStructure(rom, n); if (s) out.set(n, s); }
  return out;
}

export function freeStructureNumber(rom: Rom): number {
  const table = structTable(rom);
  for (let n = 0; n < STRUCT_COUNT; n++) if (!(ptrOf(rom, table, n) >> 16)) return n;
  return -1;
}

// stores (or with null removes) structure n
export function writeStructure(rom: Rom, n: number, s: Structure | null): void {
  const p = { table: structTable(rom) };
  const old = ptrOf(rom, p.table, n);
  if (old >> 16) rom.freeAt(old);
  if (!s) { setPtr(rom, p.table, n, 0); return; }
  if (s.w < 1 || s.h < 1 || s.w > STRUCT_MAX || s.h > STRUCT_MAX || s.tiles.length !== s.w * s.h) throw new Error(`Structure ${s.w}×${s.h} invalid (at most ${STRUCT_MAX}×${STRUCT_MAX})`);
  const name = new TextEncoder().encode(s.name).slice(0, 63);
  const data = [s.w, s.h];
  s.tiles.forEach((t, i) => {
    const c = t < 0 ? null : s.conds?.[i] ?? null;
    const v = t < 0 ? 0xffff : t | (c ? COND_MARK : 0);
    data.push(v & 0xff, v >> 8);
    if (c) data.push(condByte(c));
  });
  const buf = new Uint8Array(data.length + name.length + 1);
  buf.set(data);
  buf.set(name, data.length);
  setPtr(rom, p.table, n, rom.allocWrite(buf));
}
