// What the editor knows of the clean game once it has changed the ROM: a CRC32 of each 256-byte block of
// it ("SMWF"), kept when it opens the clean game. A byte of this ROM is still the clean game's while its
// block's CRC is the clean one's. Lunar Magic data exported as BPS from the clean game (Callisto's global
// ExAnimation) takes some of its bytes from the clean game; those are read from this ROM where it still
// has them.

import { Rom, pcToSnes } from './rom.ts';
import { crc32 } from './bps.ts';

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
  if (p < 0) return rom.size === CLEAN_SIZE && crc32(rom.data) === SMW_CLEAN_CRC ? (o) => (o >= 0 && o < CLEAN_SIZE ? rom.data[o] : null) : null;
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
