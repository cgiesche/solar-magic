// What a prefab costs and saves (#112): its one-time ROM cost (its block with RATS tag in the free space), the
// bytes of one placement (extended object $04 with its number) against the same tiles as Direct Map16 objects
// (rectangles of one tile, up to 16×16), and from which placement the prefab is smaller. Measured from what
// writing the prefab (encodePrefab, the free space's 16-byte steps) and the level data take, not estimated.

import { Rom } from './rom.ts';
import { newUid, serializeObjects, type LevelObject } from './level.ts';
import { DM16_EXT } from './patches.ts';
import { encodePrefab, PREFAB_EXT, TRANSPARENT, type Prefab } from './prefabs.ts';

export interface PrefabCost {
  once: number; // bytes in the ROM's free space
  perPlacement: number; // level data bytes of one prefab object
  dm16Bytes: number; // level data bytes of the tiles as Direct Map16 objects (placed at a screen's start: no jumps)
  dm16Objects: number; // how many Direct Map16 objects that is
  breakEven: number | null; // the first number of placements at which the prefab takes less; null: never
}

// the prefab's tiles as Direct Map16 objects at x, y: each tile (with its condition) in rectangles as large as
// they go, none overlapping, ordered by screen (so the level data needs no screen jumps between them)
export function prefabDm16Objects(s: Prefab, x: number, y: number, vertical = false): LevelObject[] {
  const key = (i: number) => (s.tiles[i] === TRANSPARENT ? '' : `${s.tiles[i]} ${JSON.stringify(s.conds?.[i] ?? null)}`);
  const done = new Uint8Array(s.w * s.h);
  const out: LevelObject[] = [];
  for (let i = 0; i < s.w * s.h; i++) {
    const k = key(i);
    if (!k || done[i]) continue;
    const c0 = i % s.w, r0 = Math.floor(i / s.w);
    const free = (c: number, r: number) => !done[r * s.w + c] && key(r * s.w + c) === k;
    let w = 1, h = 1;
    while (w < 16 && c0 + w < s.w && free(c0 + w, r0)) w++;
    while (h < 16 && r0 + h < s.h && Array.from({ length: w }, (_, c) => free(c0 + c, r0 + h)).every(Boolean)) h++;
    for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) done[(r0 + r) * s.w + c0 + c] = 1;
    const cond = s.conds?.[i];
    out.push({ uid: newUid(), num: 0, ext: DM16_EXT, x: x + c0, y: y + r0, size: ((h - 1) << 4) | (w - 1), tile: s.tiles[i], ...(cond ? { cond: { ...cond } } : {}) });
  }
  const screen = (o: LevelObject) => (vertical ? o.y : o.x) >> 4;
  return out.sort((a, b) => screen(a) - screen(b));
}

// level data bytes of objects (without the end byte)
const bytesOf = (objs: LevelObject[]) => serializeObjects(objs, [], false).length - 1;

export function prefabCost(s: Prefab): PrefabCost {
  const once = Rom.ratsFootprint(encodePrefab(s).length);
  const perPlacement = bytesOf([{ uid: 0, num: 0, ext: PREFAB_EXT, x: 0, y: 0, size: 0, prefab: 0 }]);
  const objs = prefabDm16Objects(s, 0, 0);
  const dm16Bytes = bytesOf(objs);
  // k placements: once + k * perPlacement < k * dm16Bytes
  const breakEven = dm16Bytes > perPlacement ? Math.floor(once / (dm16Bytes - perPlacement)) + 1 : null;
  return { once, perPlacement, dm16Bytes, dm16Objects: objs.length, breakEven };
}
