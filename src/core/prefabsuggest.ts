// Prefab suggestions (#116): connected groups of Direct Map16 objects (touching, also at a corner, or
// overlapping, in one layer) whose arrangement – the tiles they leave, however split into rectangles
// (pastehint.ts) – occurs more than once across the levels. Each candidate's places are then found as
// "replace all" finds them (prefabplaces.ts), so a suggestion offers exactly what saving it replaces; listed
// when the places' level data against one prefab object each saves more than the prefab's ROM cost
// (prefabcost.ts), the largest saving first. A generator, one level or one candidate in one level per step,
// so it runs in the background.

import type { Rom } from './rom.ts';
import { loadLevel, type Level, type LevelObject } from './level.ts';
import type { LevelOverride, LevelRender } from './levelemu.ts';
import { isDm16, dm16Tiles, type Dm16Cond } from './cdm16.ts';
import type { Prefab } from './prefabs.ts';
import { prefabCost } from './prefabcost.ts';
import { dm16Prefab, arrangementKey } from './pastehint.ts';
import { findPrefabPlaces, type Layer, type LevelPlaces } from './prefabplaces.ts';

export interface PrefabSuggestion {
  key: string; // the arrangement (arrangementKey)
  prefab: Prefab; // its tiles, without a name
  places: LevelPlaces[]; // where it is (planPrefabPlaces)
  count: number; // how many places
  levels: number[]; // the levels of the places, ascending
  saved: number; // level data bytes saved by replacing all places, the prefab's ROM cost taken off
}

export interface SuggestSource {
  levels: number[];
  level?: (n: number) => Level; // default: as saved
  load: (n: number, ov: LevelOverride) => LevelRender;
}

// the Direct Map16 objects of lv in connected groups (indices in their layer's list, ascending)
export function dm16Groups(lv: Level): { layer: Layer; objects: number[] }[] {
  const out: { layer: Layer; objects: number[] }[] = [];
  for (const layer of [1, 2] as const) {
    const objs = layer === 1 ? lv.objects : lv.layer2Objects;
    if (!objs) continue;
    const parent = objs.map((_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    const at = new Map<number, number>(); // tile -> an object covering it
    objs.forEach((o, i) => {
      if (!isDm16(o)) return;
      for (const t of dm16Tiles(o)) {
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const j = at.get(t + (dy << 16) + dx);
          if (j !== undefined) parent[find(j)] = find(i);
        }
        at.set(t, i);
      }
    });
    const groups = new Map<number, number[]>();
    objs.forEach((o, i) => { if (isDm16(o)) { const r = find(i); groups.set(r, [...groups.get(r) ?? [], i]); } });
    for (const g of groups.values()) out.push({ layer, objects: g });
  }
  return out;
}

export function* prefabSuggestions(rom: Rom, src: SuggestSource): Generator<void, PrefabSuggestion[]> {
  // the arrangements of the groups, with how often they occur
  const levels = new Map<number, Level>();
  const found = new Map<string, { prefab: Prefab; count: number }>();
  for (const n of src.levels) {
    let lv: Level;
    try { lv = src.level?.(n) ?? loadLevel(rom, n); } catch { continue; } // unreadable level
    levels.set(n, lv);
    for (const g of dm16Groups(lv)) {
      const objs = (g.layer === 1 ? lv.objects : lv.layer2Objects!) as LevelObject[];
      const s = dm16Prefab(g.objects.map((i) => objs[i]));
      if (!s) continue;
      const key = arrangementKey(s);
      const f = found.get(key);
      if (f) f.count++; else found.set(key, { prefab: s, count: 1 });
    }
    yield;
  }
  // the places of those occurring more than once, in the levels that have their first tile
  const tileKey = (tile: number, c: Dm16Cond | null | undefined) => `${tile} ${c ? `${c.flag} ${c.always}` : ''}`;
  const has = new Map([...levels].map(([n, lv]) => [n, new Set([...lv.objects, ...(lv.layer2Objects ?? [])].filter(isDm16).map((o) => tileKey(o.tile ?? 0, o.cond)))]));
  const out: PrefabSuggestion[] = [];
  for (const [key, { prefab, count }] of found) {
    if (count < 2) continue;
    const cost = prefabCost(prefab);
    const a = prefab.tiles.findIndex((t) => t >= 0);
    const first = tileKey(prefab.tiles[a], prefab.conds?.[a]);
    const places: LevelPlaces[] = [];
    for (const [n, lv] of levels) {
      if (!has.get(n)!.has(first)) continue;
      const ps = findPrefabPlaces(rom, lv, prefab, (ov) => src.load(n, ov));
      if (ps.length) places.push({ level: n, places: ps });
      yield;
    }
    const k = places.reduce((m, p) => m + p.places.length, 0);
    const saved = places.reduce((m, p) => m + p.places.reduce((b, q) => b + q.bytes, 0), 0) - cost.once;
    if (k > 1 && saved > 0) out.push({ key, prefab, places, count: k, levels: places.map((p) => p.level).sort((x, y) => x - y), saved });
  }
  return out.sort((x, y) => y.saved - x.saved);
}

// all at once
export function suggestPrefabs(rom: Rom, src: SuggestSource): PrefabSuggestion[] {
  const g = prefabSuggestions(rom, src);
  for (;;) { const r = g.next(); if (r.done) return r.value; }
}
