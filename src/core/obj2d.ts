// Object 2D, Lunar Magic's "user defined" object: 3 bytes in the clean game, 5 once a hook of the standard
// objects' dispatcher ($0DA415) reads two more – ObjecTool (imamelia, 0x400) and the Retry System's custom
// midway bars (worldpeace, kkevinm) take its 4th byte as a custom number and its 5th as a settings byte
// (LM's "Extension"). Its length is found by emulation, not from a table: the dispatcher is run for a 2D
// object and how far it moves the level data pointer is taken. On the bare CPU (ROM and WRAM, no other
// hardware): level parsing needs it, which the full emulator (levelemu.ts) builds on.

import { Rom } from './rom.ts';
import { CPU } from './cpu.ts';
import { RAM } from './ram.ts';

export const OBJ_2D = 0x2d;
// the game's standard object dispatcher (JSR $0DA415 : RTL), called per object by the level load once it has
// moved the level data pointer past the object's 3 bytes
const DISPATCH = 0x0da40f;
const OBJ_NUM = 0x5a, OBJ_SIZE = 0x59; // the object being loaded: its number, its settings byte
const DATA = 0x7f8000; // where the bytes after the object are (what a hook reads as its extension)
const RETURN = 0x7f0000; // the stub's JSL and where it returns to
const MAX_EXTENSION = 8; // more is no extension but a hook gone wrong
const MAX_STEPS = 200000;

// once per ROM state
const memo = new WeakMap<Rom, { gen: number; len: number }>();

// the bytes of object 2D in the level data of this ROM (3, or more with a hook)
export function objectLength2D(rom: Rom): number {
  const had = memo.get(rom);
  if (had?.gen === rom.gen) return had.len;
  const len = 3 + emulatedExtension(rom);
  memo.set(rom, { gen: rom.gen, len });
  return len;
}

// how many bytes past the object's 3 the dispatcher moves the level data pointer ($65) for an object 2D
function emulatedExtension(rom: Rom): number {
  const data = rom.data, wram = new Uint8Array(0x20000), sram = new Uint8Array(0x8000);
  const cpu = new CPU({
    read(a) {
      const bank = a >> 16, off = a & 0xffff;
      if ((bank & 0xfe) === 0x7e) return wram[a - 0x7e0000];
      if (off >= 0x8000) return data[((((bank & 0x7f) << 15) | (off & 0x7fff)) % data.length)];
      if ((bank & 0x7f) >= 0x70) return sram[off & 0x7fff];
      return (bank & 0x7f) < 0x40 && off < 0x2000 ? wram[off] : 0;
    },
    write(a, v) {
      const bank = a >> 16, off = a & 0xffff;
      if ((bank & 0xfe) === 0x7e) wram[a - 0x7e0000] = v;
      else if ((bank & 0x7f) >= 0x70 && off < 0x8000) sram[off] = v;
      else if ((bank & 0x7f) < 0x40 && off < 0x2000) wram[off] = v;
    },
  });
  // what a hook reads as the custom number and settings: FF
  wram.fill(0xff, DATA - 0x7e0000, DATA - 0x7e0000 + 0x10);
  wram[OBJ_NUM] = OBJ_2D;
  wram[OBJ_SIZE] = 0;
  wram[RAM.levelDataPtr] = DATA & 0xff; wram[RAM.levelDataPtr + 1] = (DATA >> 8) & 0xff; wram[RAM.levelDataPtr + 2] = DATA >> 16;
  wram.set([0x22, DISPATCH & 0xff, (DISPATCH >> 8) & 0xff, DISPATCH >> 16], RETURN - 0x7e0000);
  cpu.pbr = RETURN >> 16; cpu.pc = RETURN & 0xffff;
  cpu.e = false; cpu.p |= 0x30; cpu.d = 0; cpu.s = 0x1ff;
  const end = (RETURN + 4) & 0xffff;
  try {
    for (let n = 0; n < MAX_STEPS && !(cpu.pbr === RETURN >> 16 && cpu.pc === end); n++) cpu.step();
  } catch { /* the pointer as far as it got */ }
  const moved = ((wram[RAM.levelDataPtr] | (wram[RAM.levelDataPtr + 1] << 8)) - (DATA & 0xffff)) & 0xffff;
  return moved <= MAX_EXTENSION ? moved : 0;
}
