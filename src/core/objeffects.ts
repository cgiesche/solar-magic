// What an object that draws no tile still does when the level loads: it changes the game's RAM besides the
// level's map – e.g. a flag that other code reads (ObjecTool's custom objects, issues #104, #109). Emulated: a
// test level with the object alone is loaded and its RAM compared with the test level without it. Both end with
// the same screen jump, so the loader's own state (the screen and the object it was at last) is the same;
// what the loader leaves behind is not compared anyway.

import type { LevelEmulator, LevelRender } from './levelemu.ts';
import { encodePrimaryHeader, serializeObjects, newUid, L2_PTRS, type Level, type LevelObject } from './level.ts';
import { OV_L1 } from './levelemu.ts';
import { MAP_BASE, MAP_SIZE, MAP_HI, RAM } from './ram.ts';
import { hex } from './names.ts';

const LAST_SCREEN = 0x1f;
const SHOWN = 3; // RAM changes named in an effect, the rest counted

// WRAM that differs without being an effect: the map (the objects draw no tile, but its high bytes), and what
// the loader leaves behind – the stack, the level data pointer, the object and screen it was at
const LOADER: number[] = [RAM.loadObjPos, RAM.loadObjSize, RAM.loadObjNum, RAM.loadScreen];
function skipped(i: number): boolean {
  return (i >= MAP_BASE && i < MAP_BASE + MAP_SIZE) || (i >= MAP_HI + MAP_BASE && i < MAP_HI + MAP_BASE + MAP_SIZE)
    || (i >= RAM.stack && i < RAM.stackEnd) || (i >= RAM.levelDataPtr && i < RAM.levelDataPtr + 3) || LOADER.includes(i);
}

// the test level with the objects (one per screen, as thumbs.ts places them) loaded; withOwners: which object
// wrote which tile (LevelRender.touched, by the objects' index)
export function effectLoad(emu: LevelEmulator, level: Level, objs: LevelObject[], withOwners = false): LevelRender {
  const placed = objs.map((o, i) => ({ ...o, uid: newUid(), x: i * 16 + 3, y: 12 }));
  const owners: number[] = [-1, -1, -1, -1, -1];
  const body = serializeObjects(placed, [], false, owners);
  const l1 = new Uint8Array(5 + body.length + 3);
  l1.set(encodePrimaryHeader({ ...level.header, screens: 32, mode: 0 }));
  l1.set(body.subarray(0, -1), 5);
  l1.set([LAST_SCREEN, 0x00, 0x01, 0xff], 5 + body.length - 1);
  let byteOwner: Int32Array | undefined;
  if (withOwners) {
    byteOwner = new Int32Array(0x10000).fill(-1);
    owners.slice(0, -1).forEach((o, i) => (byteOwner![OV_L1 + i] = o));
  }
  return emu.load(level.number, {
    layer1: l1,
    layer2Pointer: level.layer2Objects ? emu.rom.r24(L2_PTRS + 0x105 * 3) : level.layer2Pointer,
    sprites: new Uint8Array([0, 0xff]),
    byteOwner,
  });
}

// a WRAM address as the game's code names it: low RAM by its mirror, else with the bank
const addr = (i: number) => '$' + (i < 0x2000 ? hex(i, 4) : hex(0x7e0000 + i, 6));
const bits = (v: number) => [0, 1, 2, 3, 4, 5, 6, 7].filter((b) => v & (1 << b));

// what the RAM w (a load with the object) has changed from base (the load without), as a phrase ("sets $7FA402
// bit 1", "sets $1411 to 00, … and 2 more"), null for nothing
export function ramEffect(base: Uint8Array, w: Uint8Array): string | null {
  const out: string[] = [];
  let more = 0;
  for (let i = 0; i < w.length; i++) {
    const a = base[i], b = w[i];
    if (a === b || skipped(i)) continue;
    if (out.length === SHOWN) { more++; continue; }
    const set = bits(b & ~a), clr = bits(a & ~b);
    const of = (bs: number[]) => `${addr(i)} bit${bs.length > 1 ? 's' : ''} ${bs.join(', ')}`;
    out.push(!clr.length ? `sets ${of(set)}` : !set.length ? `clears ${of(clr)}` : `sets ${addr(i)} to ${hex(b, 2)}`);
  }
  return out.length ? out.join(', ') + (more ? ` and ${more} more byte${more > 1 ? 's' : ''}` : '') : null;
}

// all at once (see objectEffectsJob)
export function objectEffects(emu: LevelEmulator, level: Level, objs: LevelObject[]): (string | null)[] {
  const job = objectEffectsJob(emu, level, objs);
  for (;;) { const r = job.next(); if (r.done) return r.value; }
}

// per object (they draw no tile): what the level's load changes in RAM with it (ramEffect), null for nothing or
// a load that fails; each loaded alone (in a batch, one may change what another does), a step each
export function* objectEffectsJob(emu: LevelEmulator, level: Level, objs: LevelObject[]): Generator<void, (string | null)[]> {
  const base = effectLoad(emu, level, []);
  yield;
  const out: (string | null)[] = [];
  for (const o of objs) {
    const r = base.ok ? effectLoad(emu, level, [o]) : null;
    out.push(r?.ok ? ramEffect(base.wram, r.wram) : null);
    yield;
  }
  return out;
}
