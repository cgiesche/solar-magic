// FastROM (CONTEXT.md, ADR 0007): the game's code runs in the fast ROM banks ($80 and up). The header says
// so ($FFD5 = $30), the reset turns on fast ROM access ($420D = 1) and enters the game in bank $80, NMI and
// IRQ jump to their routines in bank $80 (Lunar Magic's FastROM leaves the IRQ slow), and the long jumps the
// clean game makes into banks $00–$3F go to $80–$BF: bit 7 of the bank bytes the tool found by playing the
// clean game (fastromsites.ts). The vector stubs are in free bytes of bank 0 at $00BA4E, where Lunar Magic
// has its own; the reset continues in free space, whose block is the patch's mark ("SMWR").
// The rewritten bank bytes are not hooks: a patch may overwrite them. A site whose bytes are no longer the
// clean game's (an editor patch's hook) is left to the code there.

import type { Rom } from './rom.ts';
import { Asm } from './asm.ts';
import { ownerNote } from './patchreg.ts';
import { JUMP_SITES, TABLE_SITES } from './fastromsites.ts';

const MAP_MODE = 0x00ffd5;
const VEC_NMI = 0x00ffea, VEC_IRQ = 0x00ffee, VEC_RESET = 0x00fffc;
const NMI = 0x816a, IRQ = 0x8374, RESET = 0x8000;
const STUBS = 0x00ba4e; // JML $80816A (NMI), JML Reset, JML $808374 (IRQ)
const STUB_NMI = STUBS, STUB_RESET = STUBS + 4, STUB_IRQ = STUBS + 8;
export const FASTROM_HOOKS: [number, number][] = [[MAP_MODE, 1], [VEC_NMI, 2], [VEC_IRQ, 2], [VEC_RESET, 2], [STUBS, 12]];
const MAGIC = [0x53, 0x4d, 0x57, 0x52]; // "SMWR"
const VERSION = 1;

// the bank bytes FastROM sets bit 7 of (ROM offsets, in the clean game's part of the ROM)
export const FASTROM_SITES: ReadonlySet<number> = new Set([...JUMP_SITES, ...TABLE_SITES]);

export function fastRom(rom: Rom): { base: number } | null {
  if (rom.r8(STUB_RESET) !== 0x5c || rom.r16(VEC_RESET) !== (STUB_RESET & 0xffff)) return null;
  const base = rom.r24(STUB_RESET + 1) - 5;
  for (let i = 0; i < 4; i++) if (rom.r8(base + i) !== MAGIC[i]) return null;
  return rom.r8(base + 4) === VERSION ? { base } : null;
}

const jml = (a: number) => [0x5c, a & 0xff, (a >> 8) & 0xff, a >> 16];

// clean: the clean game's image (the ROM before the editor's patches), to leave sites the patches took alone
export function installFastRom(rom: Rom, clean: Uint8Array): { base: number } {
  const ex = fastRom(rom);
  if (ex) return ex;
  const free = (a: number, n: number) => rom.bytes(a, n).every((b) => b === 0xff);
  if (rom.r8(MAP_MODE) !== 0x20 || rom.r16(VEC_NMI) !== NMI || rom.r16(VEC_IRQ) !== IRQ || rom.r16(VEC_RESET) !== RESET || !free(STUBS, 12)) {
    const note = FASTROM_HOOKS.map(([a, n]) => ownerNote(rom, a, n)).find((s) => s) ?? '';
    throw new Error(`Unexpected bytes in the ROM header or at $00BA4E${note} – FastROM not possible`);
  }
  const a = new Asm();
  a.b(...MAGIC, VERSION);
  a.label('Reset');
  a.b(0xa9, 0x01, 0x8d, 0x0d, 0x42); // LDA #$01 : STA $420D (emulation mode, A is not kept at reset)
  a.b(...jml(0x800000 | RESET));
  const addr = rom.allocWrite(new Uint8Array(a.bytes.length));
  rom.writeBytes(addr, a.link(addr));
  rom.writeBytes(STUBS, Uint8Array.from([...jml(0x800000 | NMI), ...jml(a.addrOf('Reset', addr)), ...jml(0x800000 | IRQ)]));
  rom.w16(VEC_NMI, STUB_NMI & 0xffff);
  rom.w16(VEC_IRQ, STUB_IRQ & 0xffff);
  rom.w16(VEC_RESET, STUB_RESET & 0xffff);
  rom.w8(MAP_MODE, 0x30);
  const d = rom.data.slice(0, clean.length);
  const same = (o: number, n: number) => { for (let i = o - n + 1; i <= o; i++) if (d[i] !== clean[i]) return false; return true; };
  for (const [sites, n] of [[JUMP_SITES, 4], [TABLE_SITES, 3]] as const) for (const o of sites) if (same(o, n)) d[o] |= 0x80;
  rom.writeAt(0, d);
  return fastRom(rom)!;
}
