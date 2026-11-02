// The exit graph: which screen exits lead where, which secondary entrances are used and which are free.
// An exit's target number is its own (new-style, exitIndex in level.ts), a secondary entrance's level its
// own too (bit 8 in Lunar Magic's D): exits and entrances lead from and to either bank (0xx/1xx).

import type { Rom } from './rom.ts';
import { loadLevel, readSecondaryEntrance, mainTranslevel, exitToMidway, exitIndex, oldStyleSecondary, storedExits, SEC_ENT, SEC_LEVEL_HI, EXIT_NEW, OW_EXIT, type ScreenExit } from './level.ts';
import { readTranslevels, translevelToLevel } from './overworld.ts';
import { levelName } from './levelnames.ts';
import { hex } from './names.ts';

export interface ExitRef {
  from: number; // level the exit is in
  screen: number;
  secondary: boolean;
  midway: boolean; // a standard exit to the midway entrance (exitToMidway)
  entrance: number; // secondary entrance number (secondary exits), else -1
  to: number; // destination level, -1: the overworld
  overworld: boolean; // through a secondary entrance to the overworld (Lunar Magic's, level.ts OverworldExit)
}

// where an exit of level `from` leads
export function exitTarget(rom: Rom, from: number, e: Pick<ScreenExit, 'dest' | 'secondary' | 'flags'>): { entrance: number; to: number; overworld: boolean } {
  const idx = exitIndex(from, e);
  if (!e.secondary) return { entrance: -1, to: idx, overworld: false };
  const s = readSecondaryEntrance(rom, idx);
  return s.overworld ? { entrance: idx, to: -1, overworld: true } : { entrance: idx, to: s.destLevel, overworld: false };
}
// a secondary entrance that is an exit to the overworld: of a level (its destLevel, Lunar Magic's "to Overworld
// [XXX]"), not into it
export const isOverworldExit = (rom: Rom, idx: number): boolean => (rom.r8(SEC_ENT[4] + idx) & OW_EXIT) !== 0;

export class ExitGraph {
  readonly rom: Rom;
  readonly exits: ExitRef[] = [];

  // `override`: the current state of a level being edited (its exits are not in the ROM yet)
  constructor(rom: Rom, override?: { number: number; exits: ScreenExit[] }) {
    this.rom = rom;
    for (let m = 0; m < 0x200; m++) {
      let exits: ScreenExit[];
      if (override && override.number === m) exits = override.exits;
      else try { exits = loadLevel(rom, m).exits; } catch { continue; }
      for (const e of exits) this.exits.push({ from: m, screen: e.screen, secondary: e.secondary, midway: exitToMidway(e), ...exitTarget(rom, m, e) });
    }
  }

  exitsInto(level: number): ExitRef[] {
    return this.exits.filter((e) => e.to === level);
  }

  usersOfEntrance(idx: number): ExitRef[] {
    return this.exits.filter((e) => e.entrance === idx);
  }

  // the secondary entrances leading into a level
  entrancesOf(level: number): number[] {
    const out = entrancesInto(this.rom, level);
    // a blank entry leads to level 000 or 100 too; list it only where an exit uses it
    for (const e of this.exits) if (e.entrance >= 0 && e.to === level && isBlank(this.rom, e.entrance) && !out.includes(e.entrance)) out.push(e.entrance);
    return out.sort((a, b) => a - b);
  }

  // an exit to the overworld of `level` no exit uses (to give an exit), or null
  unusedOverworldExit(level: number): number | null {
    for (let i = 0; i < 0x200; i++) if (isOverworldExit(this.rom, i) && readSecondaryEntrance(this.rom, i).destLevel === level && !this.usersOfEntrance(i).length) return i;
    return null;
  }

  // a free secondary entrance number (for any level): no exit uses it and it is blank
  freeEntrance(): number | null {
    const used = new Set(this.exits.map((e) => e.entrance));
    for (let i = 1; i < 0x200; i++) if (i !== 0x100 && !used.has(i) && isBlank(this.rom, i)) return i;
    return null;
  }

  // the levels played from `level` on: it and those its exits lead to, through theirs (not out to the overworld)
  reachedFrom(level: number): number[] {
    const seen = new Set([level]), queue = [level];
    while (queue.length) {
      const m = queue.shift()!;
      for (const e of this.exits) if (e.from === m && e.to >= 0 && !seen.has(e.to)) { seen.add(e.to); queue.push(e.to); }
    }
    return [...seen];
  }

  private parents: Map<number, number> | null = null;

  // the main level (translevel) a sub-level is reached from, breadth first like levelTranslevel
  parentOf(level: number): number | null {
    if (mainTranslevel(level) !== null) return null;
    if (!this.parents) {
      const parent = this.parents = new Map<number, number>();
      const queue: number[] = [];
      for (let m = 1; m < 0x13c; m++) if (mainTranslevel(m)) { parent.set(m, m); queue.push(m); }
      const from = new Map<number, ExitRef[]>();
      for (const e of this.exits) (from.get(e.from) ?? from.set(e.from, []).get(e.from)!).push(e);
      while (queue.length) {
        const m = queue.shift()!;
        for (const e of from.get(m) ?? []) {
          if (e.overworld || parent.has(e.to)) continue;
          parent.set(e.to, parent.get(m)!);
          queue.push(e.to);
        }
      }
    }
    return this.parents.get(level) ?? null;
  }

  // "105 Vanilla Dome 2" / "1C3 (from 105 Vanilla Dome 2)" / "0F0 (unreachable)"
  label(level: number): string {
    return `${hex(level, 3)} ${this.name(level)}`;
  }

  name(level: number): string {
    const t = mainTranslevel(level);
    if (t) return levelName(this.rom, t);
    const p = this.parentOf(level);
    return p === null ? '(unreachable)' : `(from ${hex(p, 3)} ${levelName(this.rom, mainTranslevel(p)!)})`;
  }
}

// the set-up secondary entrances leading into a level (not blank ones, not its exits to the overworld)
export function entrancesInto(rom: Rom, level: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < 0x200; i++) if (readSecondaryEntrance(rom, i).destLevel === level && !isBlank(rom, i) && !isOverworldExit(rom, i)) out.push(i);
  return out;
}

// all its bytes 0, but for the level's bit 8 (D: an unused entrance 100-1FF of the game leads into level 100)
export function isBlank(rom: Rom, idx: number): boolean {
  return SEC_ENT.every((t, k) => (rom.r8(t + idx) & (k === 3 ? ~SEC_LEVEL_HI : 0xff)) === 0);
}

// The game's exits without u (old-style) take the target's high bit from the overworld submap Mario is on
// ($05D7CB: submap 0 → 0xx, else 1xx), which stays while he goes on through the exits of the level he entered.
// The banks each level is played from: its overworld tile's (submap 0 is the main map, the first 0x400 tiles
// of layer 1; the game's translevel table $7ED000 is readTranslevels()), then through
// exits, breadth first. In the game every level is played from its own bank only (tools/testexitbank.ts)
export function submapBanks(rom: Rom): Map<number, Set<number>> {
  const banks = new Map<number, Set<number>>();
  const queue: [number, number][] = [];
  const reach = (level: number, bank: number) => {
    const s = banks.get(level) ?? banks.set(level, new Set()).get(level)!;
    if (!s.has(bank)) { s.add(bank); queue.push([level, bank]); }
  };
  readTranslevels(rom).forEach((t, i) => { if (t) reach(translevelToLevel(t), i >= 0x400 ? 1 : 0); });
  while (queue.length) {
    const [n, bank] = queue.shift()!;
    let exits: ScreenExit[];
    try { exits = storedExits(rom, n).exits; } catch { continue; }
    const oldSecondary = oldStyleSecondary(exits);
    for (const e of exits) {
      const idx = exitIndex(n, e, bank);
      const secondary = e.flags & EXIT_NEW ? e.secondary : oldSecondary;
      if (secondary && isOverworldExit(rom, idx)) continue;
      reach(secondary ? readSecondaryEntrance(rom, idx).destLevel : idx, bank);
    }
  }
  return banks;
}

// makes the game's old-style exits new-style (u, h, s; Lunar Magic's), leading where the game leads them: the
// high bit of the bank the level is played from (submapBanks; a level not played: its own), secondary by the
// level's last exit. So no exit depends on the overworld any more. When the clean game is patched; a level
// played from both banks would keep its exits (the game has none)
export function newStyleExits(rom: Rom): void {
  const banks = submapBanks(rom);
  for (let n = 0; n < 0x200; n++) {
    const { exits, at } = storedExits(rom, n);
    const b = banks.get(n) ?? new Set([n >> 8]);
    if (b.size !== 1) continue;
    const bank = [...b][0], s = oldStyleSecondary(exits) ? 2 : 0;
    exits.forEach((e, i) => {
      if (!(e.flags & EXIT_NEW)) rom.w8(at[i] + 1, (rom.r8(at[i] + 1) & 0xf8) | EXIT_NEW | s | bank);
    });
  }
}
