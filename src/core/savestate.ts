// Test play's savestate slot: one emulator state editor-wide, for the level it was saved in (a number, or a string
// naming another place: a test from the overworld's) on the ROM as it was then. Any change of the ROM since (rom.gen: a
// level saved, a ROM edit) makes it stale, and a stale one is dropped; another level or a level with unsaved changes
// just doesn't get it.

import type { Rom } from './rom.ts';

export class SaveSlot<T = unknown> {
  private slot: { rom: Rom; gen: number; level: number | string; state: T } | null = null;

  save(rom: Rom, level: number | string, state: T): void {
    this.slot = { rom, gen: rom.gen, level, state };
  }

  // the state saved in level of rom, if still usable; dirty: the open level has unsaved changes
  get(rom: Rom, level: number | string, dirty: boolean): T | null {
    const s = this.slot;
    if (!s) return null;
    if (s.rom !== rom || s.gen !== rom.gen) { this.slot = null; return null; }
    return s.level === level && !dirty ? s.state : null;
  }
}
