// Save files (CONTEXT.md: save file) as the game writes them: the editor makes none itself. A save file is the SRAM
// the emulated game leaves when it saves – at the overworld's save prompt (pregame.ts: the screen reached by walking
// a tile with the prompt asked for), its first choice taken – whatever the game's save routine is: the game's own,
// or a patch's (Retry System, SRAM and BW-RAM Plus). What the saved game holds is set in the game's RAM before that
// (ram.ts: the level flags, the events, the players' places, the switch palaces, the events triggered) – the editor
// knows the game's RAM, not what the save routine makes of it in SRAM.
// - progressSram: the save file of an event progress (eventset.ts, owprogress.ts), for a play from power-on
//   (playsession.ts powerOn): the file select shows its exit count, the file loads with its events passed.

import type { LevelEmulator } from './levelemu.ts';
import type { Snes } from './snes.ts';
import { eventBits, passedCount, type EventProgress } from './eventset.ts';
import type { ProgressSave } from './owprogress.ts';
import { RAM, PAD } from './ram.ts';
import { gameScreens, type ReachedScreen } from './pregame.ts';

export const SAVE_FILES = 3; // the file select's
const SAVE_FRAMES = 240, SAVED = 8; // a save: until the game writes SRAM, and stopped for this many frames

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

// The SRAM with save file `file` holding the game at event progress `progress` – the events passed, with the save
// learned for it (the level flags, switch palaces and events triggered: the exit count the file select shows; none:
// a new file's), Mario and Luigi at the start position – and the other files empty. Made by the game: a new game at
// the progress as test play from the overworld starts it (levelemu.ts startGameAt), its saved RAM put into the game
// at the save prompt, the prompt's first choice taken. null: the game shows no save prompt, or saved nothing.
// The emulator's machine is left in the last state run.
export function progressSram(emu: LevelEmulator, progress: EventProgress, save?: ProgressSave, file = 0, prompt: ReachedScreen | undefined = gameScreens(emu).find((x) => x.id === 'savePrompt')): Uint8Array | null {
  if (!prompt) return null;
  const s = emu.snes, w = s.wram, hook = s.hook;
  s.hook = null;
  try {
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
    return saveAtPrompt(s) ? s.sram.slice() : null;
  } finally {
    s.hook = hook;
    s.joy1 = 0;
  }
}
