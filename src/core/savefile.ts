// Save files (CONTEXT.md: save file, save scheme) as the game writes them: the editor makes none itself. A save file
// is the SRAM the emulated game leaves when it saves – at the overworld's save prompt (pregame.ts: the screen reached
// by walking a tile with the prompt asked for), its first choice taken – whatever the game's save routine is: the
// game's own (three files of 143 bytes and their copies), or a patch's (Retry System's own table beside them, SRAM
// and BW-RAM Plus's rewritten saving, Overworld Indicators). What the saved game holds is set in the game's RAM before
// that (ram.ts: the level flags, the events, the players' places, the switch palaces, the events triggered) – the
// editor knows the game's RAM, not what the save routine makes of it in SRAM.
// - progressSram: the save file of an event progress (eventset.ts, owprogress.ts), for a play from power-on
//   (playsession.ts powerOn): the file select shows its exit count, the file loads with its events passed. Before it
//   is handed out the game loads it from power-on: a save the game does not load as saved is refused with the reason.
// - saveScheme: the save scheme, learned – per file the SRAM bytes a save writes and those a load reads, whose code
//   wrote and read them (the game's, or a patch's by the patch registry), and whether the saved file loads again.
//   Nothing of it is taken from a patch's name or from the game's addresses.

import type { LevelEmulator } from './levelemu.ts';
import type { Rom } from './rom.ts';
import type { Snes, MemHook } from './snes.ts';
import { eventBits, passedCount, type EventProgress } from './eventset.ts';
import type { ProgressSave } from './owprogress.ts';
import { GM, RAM, PAD, SWITCH_PALACES } from './ram.ts';
import { holds, type RomReads } from './romdeps.ts';
import { ownerOf } from './patchreg.ts';
import { gameScreens, type ReachedScreen } from './pregame.ts';

export const SAVE_FILES = 3; // the file select's
const SAVE_FRAMES = 240, SAVED = 8; // a save: until the game writes SRAM, and stopped for this many frames
const BOOT_FRAMES = 2000; // from power-on to the title screen
const LEAVE_FRAMES = 120; // a button pressed until the title screen is left
const SETTLE_FRAMES = 600, SETTLED = 8; // until the game mode stays (this many frames)
const LOAD_FRAMES = 3000; // from the file chosen to its overworld (an intro's message closed)
const PRESS = 16, HELD = 4; // a button pressed anew every PRESS frames, for HELD
const LEVEL_FLAGS = RAM.levelFlagsEnd - RAM.levelFlags;

// From the machine at the save prompt (loaded by the caller, its RAM and SRAM set as wanted): the prompt's first
// choice taken, frames until the game has written SRAM and stopped. false: it wrote none.
export function saveAtPrompt(s: Snes): boolean {
  const before = s.sramWrites;
  s.joy1 = PAD.a;
  s.runFrame();
  s.joy1 = 0;
  for (let f = 0, last = before, same = 0; f < SAVE_FRAMES && (s.sramWrites === before || same < SAVED); f++) {
    s.runFrame();
    same = s.sramWrites === last ? same + 1 : 0;
    last = s.sramWrites;
  }
  return s.sramWrites !== before;
}

// The game's RAM a save holds of the overworld: the level flags … the events triggered ($1EA2–$1F2E) – and the game's
// copy of it that its own save writes out (RAM.fileLevelFlags on: the level flags copied as the save prompt comes,
// the rest when an event ended on a tile that saves). Both are set: the game's save takes the copy, a patch that
// saves the game's RAM itself (SRAM and BW-RAM Plus) the first.
const SAVED_RAM: [number, number] = [RAM.levelFlags, RAM.eventsTriggered + 1];
function setSaved(w: Uint8Array, saved: Uint8Array): void {
  w.set(saved, SAVED_RAM[0]);
  w.set(saved, RAM.fileLevelFlags);
}
// what of it the game has again when the file is loaded and its overworld shows: the level flags, the events, the
// switch palaces, the events triggered and the players' tiles (their poses and pixel positions the overworld sets)
const KEPT_RAM: [number, number][] = [[RAM.levelFlags, LEVEL_FLAGS], [RAM.owEvents, RAM.submap + 2 - RAM.owEvents], [RAM.owPlayerTileX, RAM.switchPalaces - RAM.owPlayerTileX],
  [RAM.switchPalaces, SWITCH_PALACES], [RAM.eventsTriggered, 1]];
const keptSame = (w: Uint8Array, saved: Uint8Array): boolean => KEPT_RAM.every(([at, n]) => { for (let i = 0; i < n; i++) if (w[at + i] !== saved[at + i - SAVED_RAM[0]]) return false; return true; });

interface Made { sram: Uint8Array; saved: Uint8Array } // the SRAM after the save, the RAM that was to be saved
// The game at event progress `progress` (with the learned save's flags) saved as file `file` at the save prompt,
// `hook` watching the save. null: the game wrote no SRAM.
function makeSave(emu: LevelEmulator, prompt: ReachedScreen, progress: EventProgress, save: ProgressSave | undefined, file: number, hook: MemHook | null = null): Made | null {
  const s = emu.snes, w = s.wram;
  const events = passedCount(progress) > 0 ? eventBits(progress) : undefined;
  emu.startGameAt(-1, events);
  if (save) {
    w.set(save.levelFlags, RAM.levelFlags);
    w.set(save.switchPalaces, RAM.switchPalaces);
    w[RAM.eventsTriggered] = save.eventsTriggered;
  }
  const saved = w.slice(SAVED_RAM[0], SAVED_RAM[1]);
  s.loadState(prompt.state);
  s.sram.fill(0);
  setSaved(w, saved);
  w[RAM.saveFile] = file;
  s.hook = hook;
  try { return saveAtPrompt(s) ? { sram: s.sram.slice(), saved } : null; } finally { s.hook = null; }
}

// what the game did with a save file chosen at power-on
export interface LoadedSave {
  reached: boolean; // it got to the overworld
  chosen: boolean; // the file select came, and the file was chosen there
  intro: boolean; // a level was loaded on the way: the file counted as new
}
// The game from power-on with `sram` as its save files, played as a player loads file `file`: a button on the title
// screen, the cursor moved down to the file, the first choice of what follows – until its overworld. `hook` watches
// from the choice on. The machine is left where the run ended.
export function loadSave(emu: LevelEmulator, sram: Uint8Array, file: number, hook: MemHook | null = null): LoadedSave {
  const s = emu.snes, w = s.wram, outer = s.hook, out: LoadedSave = { reached: false, chosen: false, intro: false };
  const mode = () => w[RAM.gameMode];
  const frame = (joy = 0) => { s.joy1 = joy; s.runFrame(); s.joy1 = 0; };
  emu.ensureBoot(); // (the emulator caught up with the ROM)
  s.hook = null;
  s.powerOn();
  s.sram.set(sram.subarray(0, s.sram.length));
  try {
    for (let f = 0; f < BOOT_FRAMES && mode() !== GM.title; f++) frame();
    for (let f = 0; f < LEAVE_FRAMES && mode() === GM.title; f++) frame(f % PRESS < HELD ? PAD.start : 0);
    for (let f = 0, same = 0, last = -1; f < SETTLE_FRAMES && same < SETTLED; f++) { frame(); same = mode() === last ? same + 1 : 0; last = mode(); }
    if (mode() === GM.fileSelect) {
      for (let i = 0; i < file; i++) { frame(PAD.down); frame(); frame(); }
      out.chosen = true;
    }
    s.hook = hook;
    for (let f = 0; f < LOAD_FRAMES && mode() !== GM.overworld; f++) {
      if (mode() === GM.level) out.intro = true;
      frame(f % PRESS < HELD ? PAD.a : 0);
    }
    out.reached = mode() === GM.overworld;
    out.chosen &&= w[RAM.saveFile] === file;
    if (out.reached) for (let i = 0; i < 3; i++) frame();
  } catch { /* the emulated game crashed: not reached */ } finally {
    s.hook = outer;
    s.joy1 = 0;
  }
  return out;
}

// why the game did not load a save as it was saved ('': it did); the machine as loadSave left it
function loadProblem(emu: LevelEmulator, made: Made, file: number, hook: MemHook | null = null): string {
  const l = loadSave(emu, made.sram, file, hook), name = `file ${'ABC'[file] ?? file + 1}`;
  if (!l.reached) return `the game does not get to the overworld with ${name} chosen at power-on`;
  if (!l.chosen) return `the game does not choose ${name} in a file select`;
  if (l.intro) return `the game takes ${name} for a new file: it does not find what its save wrote`;
  if (!keptSame(emu.snes.wram, made.saved)) return `${name} loads with other level flags, events or places than were saved`;
  return '';
}

// The SRAM with save file `file` holding the game at event progress `progress` – the events passed, with the save
// learned for it (the level flags, switch palaces and events triggered: the exit count the file select shows; none:
// a new file's), Mario and Luigi at the start position – and the other files empty. Made by the game: a new game at
// the progress as test play from the overworld starts it (levelemu.ts startGameAt), its saved RAM put into the game
// at the save prompt, the prompt's first choice taken – and then loaded by the game from power-on, to know that it
// is the save asked for under the game's save scheme. sram null: none, `why` says the reason. The emulator's machine
// is left in the last state run.
export interface MadeSave { sram: Uint8Array | null; why: string }
export function progressSram(emu: LevelEmulator, progress: EventProgress, save?: ProgressSave, file = 0, prompt: ReachedScreen | undefined = gameScreens(emu).find((x) => x.id === 'savePrompt')): MadeSave {
  if (!prompt) return { sram: null, why: 'the game shows no save prompt on the overworld, where the editor has it save' };
  const s = emu.snes, hook = s.hook;
  s.hook = null;
  try {
    const made = makeSave(emu, prompt, progress, save, file);
    if (!made) return { sram: null, why: 'the game wrote no SRAM at its save prompt' };
    const why = loadProblem(emu, made, file);
    return why ? { sram: null, why } : { sram: made.sram, why: '' };
  } finally {
    s.hook = hook;
    s.joy1 = 0;
  }
}

// ---- the save scheme ----

export interface SramRange { from: number; to: number } // offsets into SRAM ($700000 + offset), `to` excluded
export interface SaveFileScheme {
  written: SramRange[]; // the SRAM bytes a save of this file writes
  read: SramRange[]; // the SRAM bytes the game reads from the file's choice at power-on to its overworld
  problem: string; // why the saved file does not load as saved ('': it does)
}
export interface SaveScheme {
  files: SaveFileScheme[]; // per save file (none: the game shows no save prompt, or saves nothing there)
  why: string; // why there are none
  // whose code writes SRAM in a save and reads it in a load: '' the game's own, else the patch's name (patchreg.ts)
  writers: string[];
  readers: string[];
}

const rangesOf = (bytes: Set<number>): SramRange[] => {
  const out: SramRange[] = [];
  for (const a of [...bytes].sort((x, y) => x - y)) {
    const last = out[out.length - 1];
    if (last && last.to === a) last.to = a + 1; else out.push({ from: a, to: a + 1 });
  }
  return out;
};
export const rangeBytes = (r: readonly SramRange[]): number => r.reduce((n, x) => n + x.to - x.from, 0);
// whose code is at the CPU's instruction: a registered patch's name, '' the game's
function codeOwner(rom: Rom, s: Snes): string {
  return ownerOf(rom, s.romOffset(s.cpu.opPc))?.name ?? '';
}

// The save scheme: each file saved by the game at its save prompt and loaded by it from power-on, the SRAM bytes
// written and read on the way and the code that did. The emulator's machine is left in the last state run.
export function learnSaveScheme(emu: LevelEmulator, prompt: ReachedScreen | undefined = gameScreens(emu).find((x) => x.id === 'savePrompt')): SaveScheme {
  const out: SaveScheme = { files: [], why: '', writers: [], readers: [] };
  if (!prompt) return { ...out, why: 'the game shows no save prompt on the overworld' };
  const s = emu.snes, rom = emu.rom, hook = s.hook, writers = new Set<string>(), readers = new Set<string>();
  // a game to tell from a new file's: some events passed, exits counted
  const progress = 3, exits = 7;
  s.hook = null;
  try {
    for (let file = 0; file < SAVE_FILES; file++) {
      const written = new Set<number>(), read = new Set<number>();
      emu.startGameAt(-1);
      const flags = [...s.wram.subarray(RAM.levelFlags, RAM.levelFlagsEnd)], switches = [...s.wram.subarray(RAM.switchPalaces, RAM.switchPalaces + SWITCH_PALACES)];
      const made = makeSave(emu, prompt, progress, { levelFlags: flags, switchPalaces: switches, eventsTriggered: exits }, file,
        { onSramWrite: (a) => { written.add(a); writers.add(codeOwner(rom, s)); } });
      if (!made) return { ...out, files: [], why: 'the game wrote no SRAM at its save prompt' };
      const problem = loadProblem(emu, made, file, { onSramRead: (a) => { read.add(a); readers.add(codeOwner(rom, s)); } });
      out.files.push({ written: rangesOf(written), read: rangesOf(read), problem });
    }
    out.writers = [...writers].sort();
    out.readers = [...readers].sort();
    return out;
  } finally {
    s.hook = hook;
    s.joy1 = 0;
  }
}

// The save scheme, kept per emulator while the save prompt is the one it was learned at and the ROM bytes the game
// read for it are as they were.
const kept = new WeakMap<LevelEmulator, { gen: number; reads: RomReads; prompt: ReachedScreen | undefined; scheme: SaveScheme }>();
export function saveScheme(emu: LevelEmulator): SaveScheme {
  const prompt = gameScreens(emu).find((x) => x.id === 'savePrompt'), had = kept.get(emu);
  if (had && had.prompt === prompt && holds(emu.rom, had)) return had.scheme;
  const r = emu.recordAll(() => learnSaveScheme(emu, prompt));
  kept.set(emu, { gen: r.gen, reads: r.reads, prompt, scheme: r.result });
  return r.result;
}
