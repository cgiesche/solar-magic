// The save at an event progress (CONTEXT.md "Event progress"): what a game in which events 0 … n-1 passed holds beyond
// a new file's – the level flags ($1EA2: passed, the directions open), the switch palaces pressed ($1F27) and the
// count of events triggered ($1F2E) – learned by emulation, not by a rule: a new game is played on the overworld
// emulator, and for each event in its number order the level whose exit runs it (owevents.ts eventRunners, the first
// one: the normal exit before a secret one) is left with that exit, as the game leaves a level, so that the game's own
// code sets the level's flags, runs the event and counts it. Two levels running the same event: only the one left is
// passed (the game doesn't run an event twice). An event the game doesn't run so (no level runs it, the level's exit
// runs another one) is set as the overworld view sets it (eventBits), counted by nothing.
// The switch palaces are pressed in a level, not when it is left: Mario landing on a switch tile ($00F55E sets $1423
// by the tile, $00EEAE presses its switch). Which tiles press which switch is learned by the block probe (each tile
// once, in the tileset of a level placing it: BlockProber.probePress), which levels place them by loading the levels
// (levelusage.ts LevelUses). A save has the switches pressed whose tiles are in a level played from a translevel passed
// at its progress (and not at a new file's): its level and those its exits lead to (ExitGraph.reachedFrom). No table
// of palace levels or switch tiles; a switch tile placed where no exit leads counts as not pressed (#257).

import { OW_EVENTS, FLAG, type OverworldLoads, l1XY, baseEvent, translevelToLevel, readTranslevels } from './overworld.ts';
import { layer1AtEveryProgress } from './owcellhistory.ts';
import { eventRunners, submapViews, submapOf, type EventRunner } from './owevents.ts';
import { ExitGraph } from './exitgraph.ts';
import { levelTeleports } from './owlinks.ts';
import { readStart } from './owsprites.ts';
import { reach, reachInput, type ReachInput } from './owreach.ts';
import type { PathKind, PathShapes } from './owpaths.ts';
import type { OwTile } from './owteleport.ts';
import type { CheckedAt } from './worldcheck.ts';
import type { LevelUses } from './levelusage.ts';
import type { LevelEmulator } from './levelemu.ts';
import type { BlockProber } from './blockprobe.ts';
import { GM, RAM, PAD, SWITCH_PALACES, get16, set16 } from './ram.ts';
import type { Rom } from './rom.ts';
import type { Job } from './jobrunner.ts';

export interface ProgressSave {
  levelFlags: number[]; // per translevel ($1EA2, 0x60)
  switchPalaces: number[]; // $1F27–$1F2A (green, yellow, blue, red: 1 pressed)
  eventsTriggered: number; // $1F2E
}

const LEVEL_FLAGS = 0x60;
const RETURN_FRAMES = 1500; // from leaving a level until the overworld has run its event and Mario stands

const hasEvent = (w: Uint8Array, e: number) => (w[RAM.owEvents + (e >> 3)] & (0x80 >> (e & 7))) !== 0;
const setEvent = (w: Uint8Array, e: number) => { w[RAM.owEvents + (e >> 3)] |= 0x80 >> (e & 7); };
const saveOf = (w: Uint8Array): ProgressSave => ({
  levelFlags: [...w.subarray(RAM.levelFlags, RAM.levelFlags + LEVEL_FLAGS)],
  switchPalaces: [...w.subarray(RAM.switchPalaces, RAM.switchPalaces + SWITCH_PALACES)],
  eventsTriggered: w[RAM.eventsTriggered],
});

// The save at each event progress 0 … OW_EVENTS (index: the progress), from the kept loads: emulated again only when
// the ROM edits changed what it read. The switch palaces are a new file's (progressSaveJob adds those pressed)
export function progressSaves(loads: OverworldLoads): ProgressSave[] {
  return loads.derive('progressSaves', () => learnSaves(loads));
}

// the level flags of the save at each event progress 0 … OW_EVENTS (progressSaves) as a job of the result learner
// (probe worker), one step: what the maps at every progress need of the saves (progressMapsFromEvents)
export function* progressFlagsJob(loads: OverworldLoads): Job<number[][]> {
  return progressSaves(loads).map((s) => s.levelFlags);
}

// layer 1 and the translevels (l1Index order) of the map at an event progress, the level flags of the save there
export interface ProgressMap { l1: Uint16Array; tls: Uint8Array; flags: number[] }

// The maps at every event progress 0 … OW_EVENTS (index: the progress) without emulating them: layer 1 as the events
// leave it (owcellhistory.ts layer1AtEveryProgress: their layer 1 changes, reveals and destroys in number order, as
// the game loads a save – the model testowcellhistory checks against the game's at every progress), the translevels
// of the ROM's table (Lunar Magic's, decompressed by the overworld's load: the same at every progress), the level
// flags of the saves (`flags`, progressFlagsJob). What the World check and the exits' arrows search at every progress;
// the same as the maps the game loads there where its code is the clean game's (testowlook, testworldcheck)
export function progressMapsFromEvents(rom: Rom, flags: readonly number[][]): ProgressMap[] {
  const tls = readTranslevels(rom);
  return layer1AtEveryProgress(rom).map((l1, p) => ({ l1, tls, flags: flags[p] }));
}

// the search's input at event progress p from the maps at every progress, as the overworld view searches: with the
// levels' exits to the overworld teleporting (each level's asked once)
export function progressInput(rom: Rom, maps: readonly ProgressMap[], kinds: readonly PathKind[], shapes: PathShapes, graph: ExitGraph): (p: number) => ReachInput {
  const warps = new Map<number, OwTile[]>(), start = readStart(rom, 0);
  const levelWarps = (tl: number) => warps.get(tl) ?? warps.set(tl, levelTeleports(rom, graph, tl).map((t) => t.to)).get(tl)!;
  return (p) => reachInput(rom, maps[p].l1, maps[p].tls, maps[p].flags, kinds, shapes, start, levelWarps);
}

// the searches at every event progress 0 … OW_EVENTS from their inputs, each searched once when first asked for: what
// the World check (stuckAtEveryProgress, owlook.ts lookProblems) and the exits' edges (owexitedges.ts) share
export function progressSearches(input: (progress: number) => ReachInput): (progress: number) => CheckedAt {
  const found: CheckedAt[] = [];
  return (p) => (found[p] ??= (() => { const inp = input(p); return { inp, r: reach(inp), progress: p }; })());
}

// the maps at every event progress from the events (progressMapsFromEvents) and the searches over them
// (progressSearches): what the World check and the exits' arrows share
export interface ProgressSearch { maps: ProgressMap[]; search: (progress: number) => CheckedAt }

// ProgressSearch from the ROM as it is and the saves' level flags (progressFlagsJob), the path kinds and shapes and
// the levels' exits, the last one kept while the ROM generation and those (by identity) are the same: the World
// check and the exits' arrows asking for it after an edit search each progress once
export function progressSearchKeeper(): (rom: Rom, flags: readonly number[][], kinds: readonly PathKind[], shapes: PathShapes, graph: ExitGraph) => ProgressSearch {
  let kept: { from: unknown[]; s: ProgressSearch } | null = null;
  return (rom, flags, kinds, shapes, graph) => {
    const from = [rom, rom.gen, flags, kinds, shapes, graph];
    if (kept && kept.from.every((x, k) => x === from[k])) return kept.s;
    const maps = progressMapsFromEvents(rom, flags);
    kept = { from, s: { maps, search: progressSearches(progressInput(rom, maps, kinds, shapes, graph)) } };
    return kept.s;
  };
}

// where the switches pressed are learned: the levels' tiles (kept, else loaded on emu) and the tiles' probe
export interface PressSource { uses: LevelUses; emu: LevelEmulator; prober: BlockProber }

// the save at event progress `progress` as a job of the result learner (probe worker): the overworld's part in one
// step (overworld.ts overworldMapJob: the loads' emulator is shared), then the switches pressed, a step per level
// loaded. Without `src` the switches stay a new file's
export function* progressSaveJob(loads: OverworldLoads, progress: number, src?: PressSource): Job<ProgressSave> {
  const saves = progressSaves(loads), save = saves[Math.max(0, Math.min(OW_EVENTS, progress))];
  if (!src) return save;
  const passed: number[] = [];
  for (let tl = 0; tl < LEVEL_FLAGS; tl++) if (save.levelFlags[tl] & ~saves[0].levelFlags[tl] & FLAG.passed) passed.push(tl);
  const pressed = yield* switchesPressedJob(loads.emu.rom, src, passed);
  return { ...save, switchPalaces: save.switchPalaces.map((v, i) => (v || pressed & (1 << i) ? 1 : 0)) };
}

// the switch palaces (bits 0-3: $1F27 + index) the levels played from translevels `tls` press: a level's tiles (layer
// 1 and 2) probed in its tileset, a step per level. Known results count their reads for the job as if learned in it
export function* switchesPressedJob(rom: Rom, src: PressSource, tls: number[]): Generator<void, number> {
  const graph = new ExitGraph(rom), { uses, prober } = src;
  const levels = [...new Set(tls.flatMap((tl) => graph.reachedFrom(translevelToLevel(tl))))].sort((a, b) => a - b);
  let pressed = 0;
  for (const n of levels) {
    let tiles = uses.tiles(n);
    if (tiles) {
      const e = uses.entry(n);
      if (e) rom.reads?.addDeps(e[1].deps);
    } else tiles = uses.scan(n, src.emu);
    if (tiles.ok) {
      for (const tile of new Set(tiles.fg.map((u) => u.tile))) {
        const i = prober.pressIn(tiles.tileset, tile);
        if (i >= 0) pressed |= 1 << i;
      }
    }
    yield;
  }
  return pressed;
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
