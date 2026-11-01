// The save at an event progress (CONTEXT.md "Event progress"): what a game in which events 0 … n-1 passed holds beyond
// a new file's – the level flags ($1EA2: passed, the directions open), the switch palaces pressed ($1F27) and the
// count of events triggered ($1F2E) – learned by emulation, not by a rule: a new game is played on the overworld
// emulator, and for each event in its number order the level whose exit runs it (owevents.ts eventRunners, the first
// one: the normal exit before a secret one) is left with that exit, as the game leaves a level, so that the game's own
// code sets the level's flags, runs the event and counts it. Two levels running the same event: only the one left is
// passed (the game doesn't run an event twice). An event the game doesn't run so (no level runs it, the level's exit
// runs another one) is set as the overworld view sets it (eventBits), counted by nothing. The switch palaces are
// pressed in a level (its switch tiles, $00F55E), not when it is left: they stay a new file's (issue #257).

import { OW_EVENTS, type OverworldLoads, l1XY, baseEvent } from './overworld.ts';
import { eventRunners, submapViews, submapOf, type EventRunner } from './owevents.ts';
import { GM, RAM, PAD, get16, set16 } from './ram.ts';
import type { Job } from './jobrunner.ts';

export interface ProgressSave {
  levelFlags: number[]; // per translevel ($1EA2, 0x60)
  switchPalaces: number[]; // $1F27–$1F2A (green, yellow, blue, red: 1 pressed)
  eventsTriggered: number; // $1F2E
}

const LEVEL_FLAGS = 0x60;
const PALACES = 4;
const RETURN_FRAMES = 1500; // from leaving a level until the overworld has run its event and Mario stands

const hasEvent = (w: Uint8Array, e: number) => (w[RAM.owEvents + (e >> 3)] & (0x80 >> (e & 7))) !== 0;
const setEvent = (w: Uint8Array, e: number) => { w[RAM.owEvents + (e >> 3)] |= 0x80 >> (e & 7); };
const saveOf = (w: Uint8Array): ProgressSave => ({
  levelFlags: [...w.subarray(RAM.levelFlags, RAM.levelFlags + LEVEL_FLAGS)],
  switchPalaces: [...w.subarray(RAM.switchPalaces, RAM.switchPalaces + PALACES)],
  eventsTriggered: w[RAM.eventsTriggered],
});

// The save at each event progress 0 … OW_EVENTS (index: the progress), from the kept loads: emulated again only when
// the ROM edits changed what it read
export function progressSaves(loads: OverworldLoads): ProgressSave[] {
  return loads.derive('progressSaves', () => learnSaves(loads));
}
// the save at event progress `progress` as a job of the result learner (probe worker), one step (overworld.ts
// overworldMapJob: the loads' emulator is shared)
export function* progressSaveJob(loads: OverworldLoads, progress: number): Job<ProgressSave> {
  return progressSaves(loads)[Math.max(0, Math.min(OW_EVENTS, progress))];
}

function learnSaves(loads: OverworldLoads): ProgressSave[] {
  const rom = loads.emu.rom, views = submapViews(loads), runners = eventRunners(rom);
  loads.restore(0, 0);
  const s = loads.emu.snes, w = s.wram;
  // where Mario stands on his tile (pixels), what the overworld does while he stands there
  const ox = get16(w, RAM.owPlayerX) - get16(w, RAM.owPlayerTileX) * 16, oy = get16(w, RAM.owPlayerY) - get16(w, RAM.owPlayerTileY) * 16;
  const standing = w[RAM.owProcess];
  const out: ProgressSave[] = [];
  // Mario on the runner's tile (on its submap), as he stands there when he enters its level
  const onTile = (r: EventRunner) => {
    const { x, y } = l1XY(r.tile), sub = submapOf(views, r.tile);
    for (const o of [0, RAM.owPlayerStride]) {
      set16(w, RAM.owPlayerX + o, x * 16 + ox); set16(w, RAM.owPlayerY + o, y * 16 + oy);
      set16(w, RAM.owPlayerTileX + o, x); set16(w, RAM.owPlayerTileY + o, y);
    }
    w[RAM.submap] = w[RAM.submap + 1] = sub;
  };
  // frames until the overworld has run event e and Mario stands (a save prompt answered); whether it got there
  const back = (e: number) => {
    for (let f = 0; f < RETURN_FRAMES; f++) {
      if (hasEvent(w, e) && w[RAM.gameMode] === GM.overworld && w[RAM.owProcess] === standing) return true;
      if (w[RAM.gameMode] > GM.overworld) return false; // (a level entered: the game didn't take the exit)
      s.joy1 = w[RAM.savePrompt] && f % 8 < 2 ? PAD.a : 0;
      s.runFrame();
    }
    return false;
  };
  try {
    for (let e = 0; e < OW_EVENTS; e++) {
      out.push(saveOf(w));
      if (hasEvent(w, e)) continue;
      const r = runners.get(e)?.[0];
      const before = r && s.saveState();
      if (!r || !leave(r, e)) {
        if (before) s.loadState(before);
        setEvent(w, e);
      }
    }
    out.push(saveOf(w));
  } finally { s.joy1 = 0; }
  return out;

  // the level left with the runner's exit, as the level leaves it ($13BF its translevel, $1DEA its base event as its
  // load sets them; the overworld's process 0 as from there, the exit in $0DD5, passed: $13CE and $1DE9), the overworld
  // loaded after it
  function leave(r: EventRunner, e: number): boolean {
    onTile(r);
    w[RAM.translevel] = r.tl; w[RAM.owEvent] = baseEvent(rom, r.tl); w[RAM.owProcess] = 0;
    w[RAM.levelExit] = r.exit + 1; w[RAM.midwayTouched] = 1; w[RAM.levelBeaten] = 1;
    w[RAM.gameMode] = GM.overworldReturn;
    return back(e);
  }
}
