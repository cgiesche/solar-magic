// The overworld's animated 8x8 tiles and colors (issue #238), the overworld's counterpart of a level's (levelemu.ts
// animatedJob): what the game keeps rewriting on a submap – its water and waves, the ExAnimation lists' slots (#244) –,
// so the Map16 tab marks them as it marks a level's. Found by emulation: the overworld loaded on the submap (at an event
// progress), then FRAMES frames run on, the 8x8 tiles from BG1's character base (layer 1's tile numbers) and the
// colors that differ from the load at any of them; plus the tiles the submap's list and the overworld's global one
// overwrite (a slot whose trigger doesn't fire in those frames, an event's second set).

import type { Animated } from './levelemu.ts';
import type { Job } from './jobrunner.ts';
import { loadKey, type OverworldLoads } from './overworld.ts';
import { owExanimTiles } from './exanim.ts';

const FRAMES = 64; // (the game's water cycles in fewer)
const STEP = 4; // compared every STEP frames

// the tiles and colors animated on submap `map` at event progress `progress`, from `loads` (the learner's own), kept
// there while what it read is unchanged
export function owAnimated(loads: OverworldLoads, map: number, progress: number): Animated {
  return loads.derive('owAnimated', () => {
    // (the console right after the load, which is kept: get runs nothing)
    loads.restore(map, progress);
    const r = loads.get(map, progress), s = loads.emu.snes, base = (r.ppuRegs[0x0b] & 0x0f) << 13;
    const tiles = new Set<number>(), colors = new Set<number>();
    try {
      for (let f = 1; f <= FRAMES; f++) {
        s.runFrame();
        if (f % STEP) continue;
        for (let t = 0; t < 0x400; t++) {
          const o = (base + t * 32) & 0xffff;
          for (let b = 0; b < 32; b++) if (s.vram[o + b] !== r.vram[o + b]) { tiles.add(t); break; }
        }
        for (let c = 0; c < 256; c++) if (s.cgram[c * 2] !== r.cgram[c * 2] || s.cgram[c * 2 + 1] !== r.cgram[c * 2 + 1]) colors.add(c);
      }
    } catch (e) { console.error(e); }
    for (const t of owExanimTiles(loads.emu.rom, map, base >> 1).keys()) tiles.add(t);
    return { tiles, colors };
  }, loadKey(map, progress));
}
// owAnimated as a job of the result learner (probe worker), one step: the loads' emulator is shared
export function* owAnimatedJob(loads: OverworldLoads, map: number, progress: number): Job<Animated> {
  return owAnimated(loads, map, progress);
}
