// Which entrances make a level slippery ($86). The game's own way is an entrance action (in the clean game 5,
// sliding in); Lunar Magic's is the entrance's slippery bit (main, midway and secondary entrances, played by
// the level heights patch). The actions are learned by loading a level with each of them in the emulator,
// not from a table.

import type { RomReads } from './romdeps.ts';
import type { LevelEmulator } from './levelemu.ts';
import { readSecondaryHeader, encodeSecondaryHeader, type SecondaryEntrance } from './level.ts';
import { RAM } from './ram.ts';

const ACTIONS = 8; // the entrance action's 3 bits
const PROBE_LEVEL = 0x105; // the level loaded with each action

// the entrance actions after which the level is slippery, and what the loads read
export function slipperyActions(emu: LevelEmulator): { result: number[]; reads: RomReads } {
  const sec = { ...readSecondaryHeader(emu.rom, PROBE_LEVEL), slippery: 0, midwayOwn: 0 };
  return emu.tracked(() => Array.from({ length: ACTIONS }, (_, a) => a).filter((a) => {
    const r = emu.load(PROBE_LEVEL, { secondaryHeader: encodeSecondaryHeader({ ...sec, entranceAction: a }) });
    return r.wram[RAM.slippery] !== 0;
  }));
}

// whether Mario arrives in a slippery level through an entrance: by its own bit or its action (actions:
// slipperyActions)
export const arrivesSlippery = (e: Pick<SecondaryEntrance, 'slippery' | 'action'>, actions: number[]): boolean => !!e.slippery || actions.includes(e.action);
