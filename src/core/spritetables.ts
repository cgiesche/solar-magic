// The per-sprite tables of the ROM (the game's tweakers and INIT/MAIN pointers, PIXI's sprite table, whatever a
// patch adds): tables the sprite code reads with the sprite number as index, a few bytes of every sprite in each
// 256-byte page. Their pages are recorded by byte (romdeps.ts learnBytePages), so a change of one sprite's entry only
// drops the results that read that entry – a sprite set's test level loads (spritegfx.ts) of the other sprites stay.
// Found by emulation, not from a list of addresses: on the title screen of the boot snapshot a few sprites are
// spawned (as the game's and as custom sprites) and run for some frames; every indexed ROM read (Cpu.onIndexed) whose
// index is k * n + c (0 <= c < k, k up to MAX_STRIDE) for a spawned sprite's number n counts for the table at the
// instruction's base with entries of k bytes; a table counts once sprites of two numbers read it. Its pages are those
// of 256 entries from the base. Code that reads a constant table with an index that happens to fit only makes those
// pages byte pages: more bytes recorded, results as valid.
// Kept per Rom with the bytes finding them read; found again when the next boot sees them changed (a patch, a sprite
// tool's insert moving its table).

import type { LevelEmulator } from './levelemu.ts';
import type { Rom } from './rom.ts';
import { holds, learnBytePages, PAGE_SHIFT, type Recorded, type RomReads } from './romdeps.ts';
import { SPR, SPRITE_SLOTS } from './ram.ts';

const NUMBERS = [0x0d, 0x0f, 0x11]; // the sprites spawned (each also as a custom sprite: PIXI's table)
const MAX_STRIDE = 16; // bytes per entry at most (PIXI's sprite table: 16)
const FRAMES = 3;

const kept = new WeakMap<Rom, Recorded<number[]>>();

// the per-sprite tables found for rom still hold (the bytes finding them read are unchanged)
export function spriteTablesHold(rom: Rom): boolean {
  const k = kept.get(rom);
  return !!k && holds(rom, k);
}

// Finds the per-sprite tables from emu's boot snapshot (just booted, its reads boot: the state is put back after) and
// learns their pages as byte pages of its ROM; boot's reads (recorded fine: RomReads fine) are coarsened with them.
// Returns the pages, kept with the bytes read (the boot's among them); none when fewer than two sprites could be
// spawned. When the game crashes, the pages learned before stay (and none are returned).
export function findSpriteTables(emu: LevelEmulator, boot: RomReads): number[] {
  const s = emu.snes, cpu = s.cpu, base = emu.baseState!;
  const seen = new Map<string, { base: number; stride: number; numbers: Set<number> }>(); // by `${base}/${stride}`
  // (ROM as the emulator reads it: WRAM in banks 7E/7F, the emulator's overlay in FE/FF)
  const isRom = (a: number) => (a & 0xffff) >= 0x8000 && ((a >> 16) & 0x7e) !== 0x7e;
  let crashed = false;
  const r = emu.tracked(() => {
    s.loadState(base);
    const w = s.wram, free: number[] = [];
    for (let i = 0; i < SPRITE_SLOTS; i++) if (!w[SPR.status + i]) free.push(i);
    const ids = [...NUMBERS, ...NUMBERS.map((n) => n | 0x200)].slice(0, free.length);
    cpu.onIndexed = (addr, index) => {
      if (!isRom(addr)) return;
      const tableBase = addr - index;
      for (const n of NUMBERS) {
        if (index < n || index >= (n + 1) * MAX_STRIDE) continue;
        for (let stride = 1; stride <= MAX_STRIDE; stride++) {
          if (index < stride * n || index >= stride * n + stride) continue;
          const key = `${tableBase}/${stride}`;
          let t = seen.get(key);
          if (!t) seen.set(key, (t = { base: tableBase, stride, numbers: new Set() }));
          t.numbers.add(n);
        }
      }
    };
    try {
      ids.forEach((id, i) => emu.spawnSprite(free[i], id, 0x40 + i * 0x18, 0x80));
      for (let f = 0; f < FRAMES; f++) s.runFrame();
    } catch { crashed = true; } finally {
      cpu.onIndexed = null;
      s.loadState(base);
    }
    const pages = new Set<number>();
    if (!crashed) for (const t of seen.values()) {
      if (t.numbers.size < 2) continue;
      for (let a = t.base; a < t.base + t.stride * 256; a++) if (isRom(a)) pages.add(s.romOffset(a) >> PAGE_SHIFT);
    }
    return [...pages].sort((x, y) => x - y);
  }, null, false);
  if (!crashed) learnBytePages(emu.rom, r.result);
  boot.coarsen();
  r.reads.add(boot);
  kept.set(emu.rom, r);
  return r.result;
}
