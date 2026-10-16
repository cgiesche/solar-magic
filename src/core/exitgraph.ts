// The exit graph: which screen exits lead where, which secondary entrances are used and which are free.
// An exit's target number is its own (new-style, exitIndex in level.ts), a secondary entrance's level its
// own too (bit 8 in Lunar Magic's D): exits and entrances lead from and to either bank (0xx/1xx).

import type { Rom } from './rom.ts';
import { loadLevel, readSecondaryEntrance, mainTranslevel, exitToMidway, exitIndex, SEC_ENT, SEC_LEVEL_HI, type ScreenExit } from './level.ts';
import { levelName } from './overworld.ts';
import { hex } from './names.ts';

export interface ExitRef {
  from: number; // level the exit is in
  screen: number;
  secondary: boolean;
  midway: boolean; // a standard exit to the midway entrance (exitToMidway)
  entrance: number; // secondary entrance number (secondary exits), else -1
  to: number; // destination level
}

// where an exit of level `from` leads
export function exitTarget(rom: Rom, from: number, e: Pick<ScreenExit, 'dest' | 'secondary' | 'flags'>): { entrance: number; to: number } {
  const idx = exitIndex(from, e);
  if (!e.secondary) return { entrance: -1, to: idx };
  return { entrance: idx, to: readSecondaryEntrance(rom, idx).destLevel };
}

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

  // the secondary entrances leading into a level (see app.findSecondaryEntrances)
  entrancesOf(level: number): number[] {
    const out: number[] = [];
    for (let i = 0; i < 0x200; i++) if (readSecondaryEntrance(this.rom, i).destLevel === level && !isBlank(this.rom, i)) out.push(i);
    // a blank entry leads to level 000 or 100 too; list it only where an exit uses it
    for (const e of this.exits) if (e.entrance >= 0 && e.to === level && isBlank(this.rom, e.entrance) && !out.includes(e.entrance)) out.push(e.entrance);
    return out.sort((a, b) => a - b);
  }

  // a free secondary entrance number (for any level): no exit uses it and it is blank
  freeEntrance(): number | null {
    const used = new Set(this.exits.map((e) => e.entrance));
    for (let i = 1; i < 0x200; i++) if (i !== 0x100 && !used.has(i) && isBlank(this.rom, i)) return i;
    return null;
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
          if (parent.has(e.to)) continue;
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
    if (t) return levelName(this.rom, t) || 'Level';
    const p = this.parentOf(level);
    return p === null ? '(unreachable)' : `(from ${hex(p, 3)} ${levelName(this.rom, mainTranslevel(p)!)})`;
  }
}

// all its bytes 0, but for the level's bit 8 (D: an unused entrance 100-1FF of the game leads into level 100)
export function isBlank(rom: Rom, idx: number): boolean {
  return SEC_ENT.every((t, k) => (rom.r8(t + idx) & (k === 3 ? ~SEC_LEVEL_HI : 0xff)) === 0);
}
