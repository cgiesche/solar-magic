// Which objects that draw no tile still do something when the level loads: they change the game's RAM besides
// the level's map – e.g. a flag that other code reads (ObjecTool's custom objects, issue #104). Emulated: the
// level with the objects is loaded and its RAM compared with the level without them; a batch that differs is
// split until single objects remain. Both end with the same screen jump, so the loader's own state (the screen
// of the last object) is the same.

import type { LevelEmulator } from './levelemu.ts';
import { encodePrimaryHeader, serializeObjects, newUid, L2_PTRS, type Level, type LevelObject } from './level.ts';
import { MAP_BASE, MAP_SIZE, MAP_HI, RAM } from './ram.ts';

const PER = 32; // objects per load, one per screen
const LAST_SCREEN = 0x1f;

// WRAM that differs without being an effect: the map (the objects draw no tile, but its high bytes) and what
// the loader leaves behind – the stack and the level data pointer
function skipped(i: number): boolean {
  return (i >= MAP_BASE && i < MAP_BASE + MAP_SIZE) || (i >= MAP_HI + MAP_BASE && i < MAP_HI + MAP_BASE + MAP_SIZE)
    || (i >= RAM.stack && i < RAM.stackEnd) || (i >= RAM.levelDataPtr && i < RAM.levelDataPtr + 3);
}

// all at once (see objectEffectsJob)
export function objectEffects(emu: LevelEmulator, level: Level, objs: LevelObject[]): boolean[] {
  const job = objectEffectsJob(emu, level, objs);
  for (;;) { const r = job.next(); if (r.done) return r.value; }
}

// per object (they draw no tile): whether the level's load changes RAM with it; a load per step
export function* objectEffectsJob(emu: LevelEmulator, level: Level, objs: LevelObject[]): Generator<void, boolean[]> {
  const out = objs.map(() => false);
  const load = (batch: LevelObject[]): Uint8Array | null => {
    const placed = batch.map((o, i) => ({ ...o, uid: newUid(), x: i * 16 + 3, y: 12 }));
    const body = serializeObjects(placed, [], false);
    const l1 = new Uint8Array(5 + body.length + 3);
    l1.set(encodePrimaryHeader({ ...level.header, screens: 32, mode: 0 }));
    l1.set(body.subarray(0, -1), 5);
    l1.set([LAST_SCREEN, 0x00, 0x01, 0xff], 5 + body.length - 1);
    const r = emu.load(level.number, {
      layer1: l1,
      layer2Pointer: level.layer2Objects ? emu.rom.r24(L2_PTRS + 0x105 * 3) : level.layer2Pointer,
      sprites: new Uint8Array([0, 0xff]),
    });
    return r.ok ? r.wram : null;
  };
  const base = load([]);
  yield;
  if (!base) return out;
  const differs = (w: Uint8Array) => { for (let i = 0; i < w.length; i++) if (w[i] !== base[i] && !skipped(i)) return true; return false; };
  const todo: number[][] = [];
  for (let i = 0; i < objs.length; i += PER) todo.push(objs.slice(i, i + PER).map((_, k) => i + k));
  for (let batch = todo.shift(); batch; batch = todo.shift()) {
    const w = load(batch.map((i) => objs[i]));
    yield;
    // a load that fails is an effect too: of one object, or of some of a batch
    if (w && !differs(w)) continue;
    if (batch.length === 1) out[batch[0]] = true;
    else todo.unshift(batch.slice(0, batch.length >> 1), batch.slice(batch.length >> 1));
  }
  return out;
}
