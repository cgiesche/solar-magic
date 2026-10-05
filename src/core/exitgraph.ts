// The exit graph: which screen exits lead where, which secondary entrances are used and which are free.
// Convention (as levelTranslevel): the high bit of an exit's destination – the level number, or the
// secondary entrance number and that entrance's level – comes from the bank (0xx/1xx) of the level
// the exit is in.

import type { Rom } from './rom.ts';
import { loadLevel, readSecondaryEntrance, mainTranslevel, SEC_ENT, type ScreenExit } from './level.ts';
import { levelName } from './overworld.ts';
import { hex } from './names.ts';

export interface ExitRef {
  from: number; // level the exit is in
  screen: number;
  secondary: boolean;
  entrance: number; // secondary entrance number (secondary exits), else -1
  to: number; // destination level
}

// where an exit of level `from` leads
export function exitTarget(rom: Rom, from: number, e: Pick<ScreenExit, 'dest' | 'secondary'>): { entrance: number; to: number } {
  const bank = from & 0x100;
  const idx = (e.dest & 0x1ff) | bank;
  if (!e.secondary) return { entrance: -1, to: idx };
  return { entrance: idx, to: readSecondaryEntrance(rom, idx).destLevel | bank };
}

// the levels an exit of level `from` can lead to, and the entrances it can use
export function sameBank(a: number, b: number): boolean {
  return (a & 0x100) === (b & 0x100);
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
      for (const e of exits) this.exits.push({ from: m, screen: e.screen, secondary: e.secondary, ...exitTarget(rom, m, e) });
    }
  }

  exitsInto(level: number): ExitRef[] {
    return this.exits.filter((e) => e.to === level);
  }

  usersOfEntrance(idx: number): ExitRef[] {
    return this.exits.filter((e) => e.entrance === idx);
  }

  // the secondary entrances leading into a level (those of its bank, see app.findSecondaryEntrances)
  entrancesOf(level: number): number[] {
    const out: number[] = [];
    const bank = level & 0x100;
    for (let i = bank; i < bank + 0x100; i++) if (readSecondaryEntrance(this.rom, i).destLevel === (level & 0xff) && !isBlank(this.rom, i)) out.push(i);
    // a blank entry leads to level x00 too; list it only where an exit uses it
    if ((level & 0xff) === 0) for (const e of this.exits) if (e.entrance >= bank && e.entrance < bank + 0x100 && isBlank(this.rom, e.entrance) && !out.includes(e.entrance)) out.push(e.entrance);
    return out.sort((a, b) => a - b);
  }

  // a free secondary entrance number in the bank of `level`: no exit uses it and all its bytes are 0
  freeEntrance(level: number): number | null {
    const bank = level & 0x100;
    const used = new Set(this.exits.map((e) => e.entrance));
    for (let i = bank + 1; i < bank + 0x100; i++) if (!used.has(i) && isBlank(this.rom, i)) return i;
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

  // "105 Vanilla Dome 2" / "1C3 (zu 105 Vanilla Dome 2)" / "0F0 (nicht erreichbar)"
  label(level: number): string {
    return `${hex(level, 3)} ${this.name(level)}`;
  }

  name(level: number): string {
    const t = mainTranslevel(level);
    if (t) return levelName(this.rom, t) || 'Level';
    const p = this.parentOf(level);
    return p === null ? '(nicht erreichbar)' : `(zu ${hex(p, 3)} ${levelName(this.rom, mainTranslevel(p)!)})`;
  }
}

export function isBlank(rom: Rom, idx: number): boolean {
  return SEC_ENT.every((t) => rom.r8(t + idx) === 0);
}
