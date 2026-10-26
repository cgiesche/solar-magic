// The hint to save a prefab on repeated paste (#115): how often the session pasted each arrangement of Direct
// Map16 objects (the tiles they leave, wherever placed and however split into rectangles), and whether a
// prefab would save bytes by now – the level data of the pastes against the prefab (prefabcost.ts) and one
// prefab object per paste. From the third paste on, until the arrangement is dismissed.

import type { LevelObject } from './level.ts';
import { isDm16, dm16Tiles, type Dm16Cond } from './cdm16.ts';
import { PREFAB_MAX, TRANSPARENT, type Prefab } from './prefabs.ts';
import { prefabCost, objectBytes } from './prefabcost.ts';

const MIN_PASTES = 3;

export interface PasteHint {
  key: string; // the arrangement (PasteCounter.dismiss)
  count: number; // pasted that often
  saved: number; // level data bytes the prefab would save over the pastes, its one-time ROM cost taken off
}

// the tiles Direct Map16 objects leave (the later over the earlier, cells between transparent) as a prefab;
// null when one of them is another object or they span more than a prefab can
export function dm16Prefab(objs: LevelObject[]): Prefab | null {
  if (!objs.length || !objs.every(isDm16)) return null;
  const cells = new Map<number, { tile: number; cond?: Dm16Cond }>();
  for (const o of objs) for (const t of dm16Tiles(o)) cells.set(t, { tile: o.tile ?? 0, ...(o.cond ? { cond: o.cond } : {}) });
  const xs = [...cells.keys()].map((t) => t & 0xffff), ys = [...cells.keys()].map((t) => t >> 16);
  const x0 = Math.min(...xs), y0 = Math.min(...ys), w = Math.max(...xs) - x0 + 1, h = Math.max(...ys) - y0 + 1;
  if (w > PREFAB_MAX || h > PREFAB_MAX) return null;
  const cell = (i: number) => cells.get(((y0 + Math.floor(i / w)) << 16) | (x0 + (i % w)));
  const tiles = Array.from({ length: w * h }, (_, i) => cell(i)?.tile ?? TRANSPARENT);
  const conds = Array.from({ length: w * h }, (_, i) => (cell(i)?.cond ? { ...cell(i)!.cond! } : null));
  return { w, h, tiles, ...(conds.some((c) => c) ? { conds } : {}), name: '' };
}

// the pasted objects as they are now in objs (a level saved is loaded anew, with new uids): the last object
// not yet taken that is the same for each (pasted objects come after what they were placed over); null when
// one is gone
export function findPasted(objs: LevelObject[], pasted: LevelObject[]): number[] | null {
  const same = (a: LevelObject, b: LevelObject) => a.num === b.num && a.ext === b.ext && a.x === b.x && a.y === b.y && a.size === b.size
    && a.tile === b.tile && a.cond?.flag === b.cond?.flag && a.cond?.always === b.cond?.always;
  const taken = new Set<number>(), out: number[] = [];
  for (const p of pasted) {
    let o: LevelObject | undefined;
    for (let i = objs.length - 1; i >= 0 && !o; i--) if (!taken.has(objs[i].uid) && same(p, objs[i])) o = objs[i];
    if (!o) return null;
    taken.add(o.uid);
    out.push(o.uid);
  }
  return out;
}

export class PasteCounter {
  private pasted = new Map<string, { count: number; bytes: number }>();
  private dismissed = new Set<string>();

  // counts a paste of objs; the hint to show, or null
  paste(objs: LevelObject[]): PasteHint | null {
    const s = dm16Prefab(objs);
    if (!s) return null;
    const key = JSON.stringify([s.w, s.tiles, s.conds ?? null]);
    const p = this.pasted.get(key) ?? { count: 0, bytes: 0 };
    p.count++;
    p.bytes += objs.reduce((n, o) => n + objectBytes(o), 0);
    this.pasted.set(key, p);
    if (p.count < MIN_PASTES || this.dismissed.has(key)) return null;
    const c = prefabCost(s);
    const saved = p.bytes - c.once - p.count * c.perPlacement;
    return saved > 0 ? { key, count: p.count, saved } : null;
  }

  // no hint for this arrangement anymore
  dismiss(key: string): void {
    this.dismissed.add(key);
  }
}
