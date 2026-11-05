// The overworld's ExAnimation as the graphics workspace's Animations tab shows a submap's (#260), by emulation of the
// overworld loaded at an event progress (OverworldLoads, run on from the load):
// - the event triggers 01–08 (Lunar Magic's "Event Manual 8–F"): which event each waits for and whether it holds, read
//   from the console after the load (the Trigger Init's events, the events passed at the progress); switched for the
//   preview (owTriggerRender): the game run on with the trigger's Manual byte pointed at an event that is passed, or at
//   none, so the engine shows the second frame set or the first – the map stays as loaded (an event bit set for that
//   in RAM after the load changes no tile drawn)
// - the colors the game itself keeps setting on the submap (owGameColors: Mario's, the level dots' 6D and 7D, the
//   lightning's 47 where it is on), which a color slot or rotation there fights with: the game run on with the
//   submap's own lists off and its colors as its palette has them; what differs from the palette then is the game's

import type { Rom } from './rom.ts';
import { RAM, EXTRIGGER_RAM, EXANIM_OW_SETTINGS } from './ram.ts';
import { OW_EVENTS } from './extrigger.ts';
import { eventManual, isEventTrigger, NO_LEVEL_LIST, NO_GLOBAL_LIST } from './exanim.ts';
import { submapPalette } from './submapgfx.ts';
import { loadKey, type OverworldLoads, type OwRender } from './overworld.ts';
import type { Job } from './jobrunner.ts';

const W = (a: number) => a - 0x7e0000; // a long WRAM address as an index of the console's WRAM
const MANUAL = W(EXTRIGGER_RAM.manual);
const eventSet = (w: Uint8Array, e: number) => !!(w[RAM.owEvents + (e >> 3)] & (0x80 >> (e & 7)));

// event trigger t (01–08) in the console `wram` (after a load): the event its Manual byte names (null: none, past the
// overworld's events, it never holds; a byte no Trigger Init names keeps what was there before the load, #311) and
// whether that event is passed, as the engine checks it each frame (kobo/exanimation.ts, ".overworld")
export function eventTriggerState(wram: Uint8Array, t: number): { event: number | null; holds: boolean } {
  const e = wram[MANUAL + eventManual(t)];
  if (!isEventTrigger(t) || e >= OW_EVENTS) return { event: null, holds: false };
  return { event: e, holds: eventSet(wram, e) };
}

// event triggers switched for the preview: [trigger 01–08, holds]
export type OwTriggerSwitches = [number, boolean][];
// frames run on after switching: every slot runs once in 8 ($14 mod 8) and uploads its frame
export const TRIGGER_FRAMES = 8;
const switchesKey = (sw: OwTriggerSwitches) => sw.map(([t, on]) => `${t}${on ? '+' : '-'}`).join('');

// Map `map` at event progress `progress` (special: after the special world) with event triggers switched: the console
// after the load, the triggers' Manual bytes set (one switched on names an event passed that no trigger left as it is
// names – passed for it when none is –, one switched off names none), then TRIGGER_FRAMES frames. Kept for the map,
// progress and switches while the ROM edits since changed no byte it read (OverworldLoads.derive).
export function owTriggerRender(loads: OverworldLoads, map: number, progress: number, special: boolean, sw: OwTriggerSwitches): OwRender {
  return loads.derive('owTriggerRender', () => {
    loads.restore(map, progress, special);
    const s = loads.emu.snes, w = s.wram;
    const switched = new Map(sw.filter(([t]) => isEventTrigger(t)));
    const kept = new Set(Array.from({ length: 8 }, (_, k) => k + 1).filter((t) => !switched.has(t)).map((t) => w[MANUAL + eventManual(t)]));
    const free = Array.from({ length: OW_EVENTS }, (_, e) => e).filter((e) => !kept.has(e));
    const on = free.find((e) => eventSet(w, e)) ?? free[0];
    if ([...switched.values()].some((v) => v) && !eventSet(w, on)) w[RAM.owEvents + (on >> 3)] |= 0x80 >> (on & 7);
    for (const [t, v] of switched) w[MANUAL + eventManual(t)] = v ? on : 0xff;
    for (let f = 0; f < TRIGGER_FRAMES; f++) s.runFrame();
    return { vram: s.vram.slice(), cgram: s.cgram.slice(), wram: s.wram.slice(), ppuRegs: s.ppuRegs.slice(), ok: true };
  }, `${loadKey(map, progress)}${special ? ':special' : ''}:${switchesKey(sw)}`);
}
export function* owTriggerJob(loads: OverworldLoads, map: number, progress: number, special: boolean, sw: OwTriggerSwitches): Job<OwRender> {
  return owTriggerRender(loads, map, progress, special, sw);
}

// frames the game's colors are watched for: the level dots' flashing goes round in 32
export const GAME_COLOR_FRAMES = 64;
// The colors (0–255) the game keeps setting on map `map` loaded at event progress `progress` (special: after the
// special world): from the console after the load, the submap's lists and the overworld's global one off (its
// settings in RAM) and its colors (CGRAM and the palette buffer $0703) as its palette has them, the game's lightning
// due in a frame (its timer, where the game's mask lets it flash), GAME_COLOR_FRAMES frames; a color whose CGRAM
// differs from the palette after any of them. Kept as owTriggerRender.
export function owGameColors(loads: OverworldLoads, map: number, progress: number, special: boolean): number[] {
  return loads.derive('owGameColors', () => {
    loads.restore(map, progress, special);
    const rom: Rom = loads.emu.rom, s = loads.emu.snes, w = s.wram, pal = submapPalette(rom, map, special);
    w[W(EXANIM_OW_SETTINGS)] |= NO_LEVEL_LIST | NO_GLOBAL_LIST;
    s.cgram.set(pal);
    w.set(pal, RAM.palettes + 2);
    w[RAM.owLightningTimer] = 1;
    const out = new Set<number>();
    for (let f = 0; f < GAME_COLOR_FRAMES; f++) {
      s.runFrame();
      for (let i = 0; i < 256; i++) if (s.cgram[i * 2] !== pal[i * 2] || s.cgram[i * 2 + 1] !== pal[i * 2 + 1]) out.add(i);
    }
    return [...out].sort((a, b) => a - b);
  }, `${loadKey(map, progress)}${special ? ':special' : ''}`);
}
export function* owGameColorsJob(loads: OverworldLoads, map: number, progress: number, special: boolean): Job<number[]> {
  return owGameColors(loads, map, progress, special);
}
