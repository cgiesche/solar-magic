// Which entrances make a level slippery ($86). The game's own way is an entrance action (in the clean game 5,
// sliding in); Lunar Magic's is the entrance's slippery bit (main, midway and secondary entrances, played by
// the level heights patch). The actions are learned by loading a level with each of them in the emulator,
// not from a table.

import type { Rom } from './rom.ts';
import type { RomReads } from './romdeps.ts';
import type { LevelEmulator } from './levelemu.ts';
import { readSecondaryHeader, encodeSecondaryHeader, readSecondaryEntrance, mainEntrance, midwayEntrance, type SecondaryEntrance, type SecondaryHeader } from './level.ts';
import { RAM } from './ram.ts';

const ACTIONS = 8; // the entrance action's 3 bits
const PROBE_LEVEL = 0x105; // the level loaded with each action

// the entrance actions after which the level is slippery
function slipperyOnes(emu: LevelEmulator): number[] {
  const sec = { ...readSecondaryHeader(emu.rom, PROBE_LEVEL), slippery: 0, midwayOwn: 0 };
  return Array.from({ length: ACTIONS }, (_, a) => a).filter((a) => {
    const r = emu.load(PROBE_LEVEL, { secondaryHeader: encodeSecondaryHeader({ ...sec, entranceAction: a }) });
    return r.wram[RAM.slippery] !== 0;
  });
}

// the same with what the loads read
export function slipperyActions(emu: LevelEmulator): { result: number[]; reads: RomReads } {
  return emu.tracked(() => slipperyOnes(emu));
}

// the same as a job (the result learner's, no picture, CONTEXT.md) learned in the probe worker under slipperyKey: a
// single step
export const slipperyKey = 'slip1';
export function* slipperyJob(emu: LevelEmulator): Generator<never, number[]> {
  return slipperyOnes(emu);
}

// whether Mario arrives in a slippery level through an entrance: by its own bit or its action (actions:
// slipperyActions)
export const arrivesSlippery = (e: Pick<SecondaryEntrance, 'slippery' | 'action'>, actions: number[]): boolean => !!e.slippery || actions.includes(e.action);

// the entrances of a level (s: its secondary header, secs: its secondary entrances) through which Mario arrives
// in a slippery level: the main entrance (also the midway point's unless it has its own), the midway entrance
// with its own settings, secondary entrances
export type SlipperyEntrance = { kind: 'main' | 'midway' } | { kind: 'sec'; index: number };
export function slipperyEntrances(rom: Rom, s: SecondaryHeader, secs: number[], actions: number[]): SlipperyEntrance[] {
  return [
    ...(arrivesSlippery(mainEntrance(s), actions) ? [{ kind: 'main' as const }] : []),
    ...(s.midwayOwn && arrivesSlippery(midwayEntrance(s), actions) ? [{ kind: 'midway' as const }] : []),
    ...secs.filter((i) => arrivesSlippery(readSecondaryEntrance(rom, i), actions)).map((index) => ({ kind: 'sec' as const, index })),
  ];
}
