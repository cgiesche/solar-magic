// Conditional Direct Map16 (Lunar Magic's, LM help: edit_cdm16.htm): a Direct Map16 object, or a tile of a
// structure, that depends on a flag of the table at $7FC060-F (CDM16_FLAGS, flag n: byte n / 8, bit n % 8,
// bits low to high). The game draws it only while the flag is on; with "always show" always, its tiles +
// 0x100 while the flag is on. Nothing in the game sets the flags: community code (UberASM) does.
// In the level data the condition is Lunar Magic's byte ACCCCCCC (A: always show, C: the flag), after the
// tile it applies to, which says so by its top bit: the Direct Map16 object's tile high byte (patches.ts),
// a structure's tile word (structs.ts). What the flags do in the level comes from the game's level load with
// them set (LevelOverride.cdm16Flags), test play the same.

import type { Rom } from './rom.ts';
import type { Level, LevelObject } from './level.ts';
import { DM16_EXT } from './patches.ts';
import { STRUCT_EXT, readStructure, type Structure } from './structs.ts';
import { CDM16_FLAGS } from './ram.ts';

export interface Dm16Cond { flag: number; always: boolean }

export const COND_FLAGS = CDM16_FLAGS[1] * 8; // flags 00-7F
// the top bit of a tile word: its condition byte follows
export const COND_MARK = 0x8000;
// "always show" adds this while the flag is on: the tile must stay below it
export const COND_ADD = 0x100;

export const condByte = (c: Dm16Cond): number => (c.always ? 0x80 : 0) | (c.flag & 0x7f);
export const condOf = (b: number): Dm16Cond => ({ flag: b & 0x7f, always: (b & 0x80) !== 0 });

// the flag table with `on` set
export function flagBytes(on: Iterable<number>): Uint8Array {
  const out = new Uint8Array(CDM16_FLAGS[1]);
  for (const f of on) if (f >= 0 && f < COND_FLAGS) out[f >> 3] |= 1 << (f & 7);
  return out;
}

export const isDm16 = (o: LevelObject): boolean => o.num === 0 && o.ext === DM16_EXT;

// the flags of a level's objects (both layers): flag → how many objects depend on it (a structure object
// once per flag of its tiles)
export function usedFlags(rom: Rom, lv: Pick<Level, 'objects' | 'layer2Objects'>): Map<number, number> {
  const out = new Map<number, number>();
  const structs = new Map<number, Structure | null>();
  const add = (f: number) => out.set(f, (out.get(f) ?? 0) + 1);
  for (const o of [...lv.objects, ...(lv.layer2Objects ?? [])]) {
    if (isDm16(o) && o.cond) add(o.cond.flag);
    else if (o.num === 0 && o.ext === STRUCT_EXT && o.struct !== undefined) {
      if (!structs.has(o.struct)) structs.set(o.struct, readStructure(rom, o.struct));
      for (const f of structFlags(structs.get(o.struct) ?? null)) add(f);
    }
  }
  return new Map([...out].sort((a, b) => a[0] - b[0]));
}

// the flags a structure's tiles depend on
export function structFlags(s: Structure | null): number[] {
  return [...new Set((s?.conds ?? []).flatMap((c) => (c ? [c.flag] : [])))].sort((a, b) => a - b);
}
