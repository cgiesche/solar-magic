// The game's global graphics files GFX00–33 as a package's graphics part (see CONTEXT.md: Graphics part):
// Lunar Magic's Graphics/GFX##.bin. Only the files differing from the clean game's are the package's;
// they replace the file in the ROM, and setting one back to the clean game's points it at the game's
// own bytes again. GFX00–31 are files of the editor's file table (gfxfiles.ts); GFX32 (Mario) and GFX33
// (the animated tiles) the game loads at $00:B888 – each by its own address, both from one bank (the
// bank byte is set once for both), so a changed one goes into free space together with the other.
// The clean game's files are read from this ROM's bytes that are still the clean game's (cleangame.ts):
// the game's own files are never overwritten.

import { snesToPc, type Rom } from './rom.ts';
import { lz2Compress, lz2Decompress } from './lz2.ts';
import { cleanGameBytes, NotKnown } from './cleangame.ts';
import { gfxEntry, setGfxEntry, gfxHex, VANILLA_GFX } from './patches.ts';
import { gfxBytes, lz2Storage, storeGfxFile } from './gfxfiles.ts';
import { convertBpp, parseGfxBinName } from './gfxbin.ts';

export const GLOBAL_GFX = 0x34; // GFX00–33
export const GFX32 = 0x32, GFX33 = 0x33;

// the game's table of GFX00–31 (low, high, bank bytes)
const TABLE = [0x00b992, 0x00b9c4, 0x00b9f6];
// the operands of the game's code loading GFX33 and GFX32 ($00:B888: LDY #lo33 … LDA #bank … then
// LDA #lo32 for GFX32 from the same bank)
const LO33 = 0x00b88b, BANK = 0x00b890, LO32 = 0x00b8d8;
// where the clean game has them
const CLEAN_33 = 0x08bfc0, CLEAN_32 = 0x088000;

export const globalGfxName = (n: number) => `GFX${gfxHex(n)}`;

// a global GFX file's number from its .bin's name (GFX00–33), else null
export function globalGfxNum(path: string): number | null {
  const p = parseGfxBinName(path);
  return p?.game && p.num < GLOBAL_GFX ? p.num : null;
}

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

// ---------- the clean game's ----------

// the clean game's file unpacked; null when this ROM doesn't know it (cleanGameBytes)
export function cleanGlobalGfx(rom: Rom, n: number): Uint8Array | null {
  const at = cleanAddr(rom, n);
  return at === null ? null : cleanStream(rom, at)?.data ?? null;
}

function cleanAddr(rom: Rom, n: number): number | null {
  if (n === GFX32) return CLEAN_32;
  if (n === GFX33) return CLEAN_33;
  const clean = cleanGameBytes(rom);
  const b = TABLE.map((t) => clean?.(snesToPc(t + n)) ?? null);
  return b.some((v) => v === null) ? null : b[0]! | (b[1]! << 8) | (b[2]! << 16);
}

// the clean game's LZ2 data at `addr`: unpacked and the bytes as stored; null when not known
function cleanStream(rom: Rom, addr: number): { data: Uint8Array; stored: Uint8Array } | null {
  const clean = cleanGameBytes(rom);
  if (!clean) return null;
  const pc = snesToPc(addr);
  const src = new Proxy({}, { get: (_, k) => { const v = clean(Number(k)); if (v === null) throw new NotKnown(); return v; } });
  try {
    const r = lz2Decompress(src, pc);
    return { data: r.data, stored: rom.data.slice(pc, pc + r.size) };
  } catch (e) {
    if (e instanceof NotKnown) return null;
    throw e;
  }
}

// a .bin in the format of the clean game's file (Lunar Magic extracts 3bpp files as 4bpp: back to 3bpp,
// the 4th bitplane dropped as Lunar Magic does when it inserts one); null when it fits neither
export function fromBin(clean: Uint8Array, bin: Uint8Array): Uint8Array | null {
  if (bin.length === clean.length) return bin;
  if (bin.length * 3 === clean.length * 4) return convertBpp(bin, 4, 3);
  return null;
}

// ---------- this ROM's ----------

// the ROM's GFX32 or GFX33: its address and stored bytes
function pairFile(rom: Rom, n: number): { addr: number; data: Uint8Array; stored: Uint8Array } {
  const addr = (rom.r8(BANK) << 16) | rom.r16(n === GFX33 ? LO33 : LO32);
  const r = lz2Decompress(rom.data, snesToPc(addr));
  return { addr, data: r.data, stored: rom.bytes(addr, r.size).slice() };
}

// the file unpacked as the ROM has it (null: GFX00–31 without a file)
export function globalGfxData(rom: Rom, n: number): Uint8Array | null {
  return n < VANILLA_GFX ? gfxBytes(rom, n)?.data ?? null : pairFile(rom, n).data;
}

// puts the file (unpacked, in the clean game's format) into the ROM; the clean game's file points at the
// game's own bytes again. Throws when the clean game's file is not known.
export function setGlobalGfx(rom: Rom, n: number, data: Uint8Array): void {
  const at = cleanAddr(rom, n), clean = at === null ? null : cleanStream(rom, at);
  if (at === null || !clean) throw new Error(`${globalGfxName(n)}: the clean game's file is not known in this ROM`);
  const isClean = same(data, clean.data);
  if (n < VANILLA_GFX) {
    if (!isClean) { storeGfxFile(rom, n, lz2Storage(data, 'LZ2')); return; }
    const e = gfxEntry(rom, n);
    if (e) rom.freeAt(e.addr);
    setGfxEntry(rom, n, at, false);
    return;
  }
  // GFX32 and GFX33: both from one bank – the clean game's, else together in free space (GFX33 first)
  const other = n === GFX33 ? GFX32 : GFX33;
  const o = pairFile(rom, other), old = pairFile(rom, GFX33).addr;
  const otherClean = same(o.data, cleanGlobalGfx(rom, other) ?? new Uint8Array());
  rom.freeAt(old);
  if (isClean && otherClean) { writePair(rom, CLEAN_33, CLEAN_32); return; }
  const mine = isClean ? clean.stored : lz2Compress(data);
  const [s33, s32] = n === GFX33 ? [mine, o.stored] : [o.stored, mine];
  const block = new Uint8Array(s33.length + s32.length);
  block.set(s33); block.set(s32, s33.length);
  const addr = rom.allocWrite(block);
  writePair(rom, addr, addr + s33.length);
}

function writePair(rom: Rom, a33: number, a32: number): void {
  rom.w8(BANK, a33 >> 16);
  rom.w16(LO33, a33 & 0xffff);
  rom.w16(LO32, a32 & 0xffff);
}

// whether the ROM's file is the clean game's (null: not known)
export function isCleanGlobalGfx(rom: Rom, n: number): boolean | null {
  const clean = cleanGlobalGfx(rom, n), cur = globalGfxData(rom, n);
  return clean ? !!cur && same(cur, clean) : null;
}
