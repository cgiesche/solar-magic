// The game's upload of one of its graphics files to VRAM ($00AA6B), by emulation: the 3bpp tiles become 4bpp,
// the 4th bitplane as the game sets it – for some files (and tilesets) it puts tiles in colors 8–F. Lunar
// Magic's .bin of such a file has these tiles so; it is still the 3bpp file (gfxbin.ts from4bpp).

import { type Rom } from './rom.ts';
import { Snes } from './snes.ts';
import { RAM, GFX_BUFFER } from './ram.ts';
import { hashBytes } from './patchreg.ts';

// the routine after its JSL $00BA28: the file in the game's buffer at [$00], Y = its number
const CONVERT = 0xaa6f;
const RET = 0x1f00; // where it returns to (bank 0's RAM)
const MAX_STEPS = 200_000;
const CHECK = 256; // steps between looks at what it wrote so far

// whether the game uploads `data` (3bpp, 128 tiles) as its file `num` in `tileset` as `as4bpp`; stops at the
// first byte that differs
function uploadAs(rom: Rom, num: number, data: Uint8Array, tileset: number, as4bpp: Uint8Array): boolean {
  const s = new Snes(rom.data), cpu = s.cpu, w = s.wram;
  w.set(data, GFX_BUFFER);
  w[0] = GFX_BUFFER & 0xff; w[1] = GFX_BUFFER >> 8; w[2] = 0x7e;
  w[RAM.tileset] = tileset;
  s.write(0x2115, 0x80); s.write(0x2116, 0); s.write(0x2117, 0);
  w[0x1ff] = (RET - 1) >> 8; w[0x1fe] = (RET - 1) & 0xff; // its RTS
  cpu.e = false; cpu.p = 0x34; cpu.s = 0x1fd; cpu.d = 0; cpu.dbr = 0; cpu.pbr = 0; cpu.pc = CONVERT; cpu.y = num;
  let seen = 0;
  const same = (to: number) => { for (; seen < to; seen++) if (s.vram[seen] !== as4bpp[seen]) return false; return true; };
  for (let n = 0; !(cpu.pbr === 0 && cpu.pc === RET); n++) {
    if (n === MAX_STEPS) return false;
    cpu.step();
    if (n % CHECK === 0 && !same(Math.min(s.vaddr * 2, as4bpp.length))) return false;
  }
  return same(as4bpp.length);
}

const memo = new WeakMap<Rom, Map<string, boolean>>();

// whether the game uploads `data` (3bpp, 128 tiles) as its file `num` as `as4bpp` in one of the tilesets
export function uploadsAs(rom: Rom, num: number, data: Uint8Array, as4bpp: Uint8Array): boolean {
  const m = memo.get(rom) ?? new Map<string, boolean>();
  memo.set(rom, m);
  const key = `${num}:${hashBytes([data, as4bpp])}`;
  let r = m.get(key);
  if (r === undefined) {
    r = false;
    for (let t = 0; t < 0x100 && !r; t++) r = uploadAs(rom, num, data, t, as4bpp);
    m.set(key, r);
  }
  return r;
}
