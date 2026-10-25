// What the editor knows of the clean game once it has changed the ROM: a CRC32 of each 256-byte block of
// it ("SMWF"), kept when it opens the clean game. A byte of this ROM is still the clean game's while its
// block's CRC is the clean one's. Lunar Magic data exported as BPS from the clean game (Callisto's global
// ExAnimation, its overworld) takes some of its bytes from the clean game; those are read from this ROM
// where it still has them.

import { Rom, pcToSnes, snesToPc } from './rom.ts';
import { crc32, bpsReader } from './bps.ts';
import type { RomRead } from './exanim.ts';

export const SMW_CLEAN_CRC = 0xb19ed489; // Super Mario World (U), headerless
export const CLEAN_SIZE = 0x80000;
const BLOCK = 0x100;
const BLOCKS = CLEAN_SIZE / BLOCK;

const MAGIC = [0x53, 0x4d, 0x57, 0x46]; // "SMWF"
const VERSION = 1;
const SIZE = 5 + BLOCKS * 4;

function find(rom: Rom): number {
  for (const b of rom.scanRats()) {
    const p = b.start + 8;
    if (b.size === SIZE && MAGIC.every((m, i) => rom.data[p + i] === m)) return p;
  }
  return -1;
}

export function isCleanRom(rom: Rom): boolean {
  return rom.size === CLEAN_SIZE && crc32(rom.data) === SMW_CLEAN_CRC;
}

const blockCrc = (d: Uint8Array, k: number) => crc32(d.subarray(k * BLOCK, (k + 1) * BLOCK));

// keeps the clean game's fingerprint (run when the clean game is opened, before anything changes it)
export function keepCleanGame(rom: Rom): void {
  const old = find(rom);
  if (old >= 0) rom.freeAt(pcToSnes(old));
  const buf = new Uint8Array(SIZE);
  buf.set(MAGIC); buf[4] = VERSION;
  const v = new DataView(buf.buffer);
  for (let k = 0; k < BLOCKS; k++) v.setUint32(5 + k * 4, blockCrc(rom.data, k), true);
  rom.allocWrite(buf);
}

// the clean game's byte at a ROM offset (below 512 KB) where this ROM still has it, else null; null
// when the ROM has no fingerprint and is not the clean game itself (blocks are compared once: for one
// read of the ROM as it is)
export function cleanGameBytes(rom: Rom): ((o: number) => number | null) | null {
  const p = find(rom);
  if (p < 0) return isCleanRom(rom) ? (o) => (o >= 0 && o < CLEAN_SIZE ? rom.data[o] : null) : null;
  if (rom.data[p + 4] > VERSION) throw new Error('The clean game\'s fingerprint in the ROM is from a newer editor version');
  const v = new DataView(rom.data.buffer, rom.data.byteOffset + p + 5, BLOCKS * 4);
  const same = new Map<number, boolean>();
  return (o) => {
    if (o < 0 || o >= CLEAN_SIZE) return null;
    const k = Math.floor(o / BLOCK);
    let s = same.get(k);
    if (s === undefined) same.set(k, s = blockCrc(rom.data, k) === v.getUint32(k * 4, true));
    return s ? rom.data[o] : null;
  };
}

// a byte of a patch's target depends on a byte of the clean game this ROM does not have
export class NotKnown extends Error {}

// the ROM a BPS from the clean game makes (Lunar Magic data Callisto exports), read through it without
// applying it: `byte` is null and r8 throws NotKnown where it needs a byte `clean` does not have (see
// cleanGameBytes); null when it is no BPS from the clean game
export interface BpsRom extends RomRead { byte(pc: number): number | null }
export function cleanGameBps(data: Uint8Array, clean: (o: number) => number | null): BpsRom | null {
  const r = bpsReader(data);
  if (!r || r.sourceSize !== CLEAN_SIZE || r.sourceCrc !== SMW_CLEAN_CRC) return null;
  const byte = (pc: number) => r.byte(pc, clean);
  const r8 = (a: number) => {
    const v = byte(snesToPc(a));
    if (v === null) throw new NotKnown();
    return v;
  };
  return { byte, r8, r16: (a) => r8(a) | (r8(a + 1) << 8), r24: (a) => r8(a) | (r8(a + 1) << 8) | (r8(a + 2) << 16) };
}

// runs `read`; 'not known' when it needs a byte that is not known
export function known<T>(read: () => T): T | 'not known' {
  try { return read(); } catch (e) {
    if (e instanceof NotKnown) return 'not known';
    throw e;
  }
}
