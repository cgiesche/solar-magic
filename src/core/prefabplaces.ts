// Where a prefab's arrangement already is (#114): Direct Map16 objects with the prefab's tiles at the same
// relative places with the same conditions, however they are split into rectangles, in both layers; replaced
// by the prefab object at the place of the last of them in the object list (drawing order), so the level
// looks as before. Standard objects are never matched (they are cheaper and resizable).
// A place is its objects S: each lies wholly on prefab tiles of its own tile and condition, together they
// cover every one. It is none when another Direct Map16 object reaches into the prefab's rectangle (an extra
// or a different tile) other than where a later object of S draws over it, and when another object between
// the first and the last of S writes a prefab tile that no later object of S draws over (which tiles it
// writes is the emulated level load's, every conditional flag on). Places sharing objects: the first counts.

import type { Rom } from './rom.ts';
import { loadLevel, levelRows, newUid, type Level, type LevelObject } from './level.ts';
import { saveLevel } from './save.ts';
import { layerGeom, type LayerGeom } from './render.ts';
import { MAP_BASE, type LevelEmulator, type LevelOverride, type LevelRender } from './levelemu.ts';
import { levelOverride } from './levelusage.ts';
import { isDm16, dm16Tiles, flagBytes, COND_FLAGS, type Dm16Cond } from './cdm16.ts';
import { PREFAB_EXT, TRANSPARENT, writePrefab, type Prefab } from './prefabs.ts';
import { objectBytes } from './prefabcost.ts';
import { setPrefabSources } from './prefabsources.ts';
import { hex } from './names.ts';
import type { EditSession } from './editsession.ts';
import { objectKey } from './objboxes.ts';

export type Layer = 1 | 2;
// objects (indices in the layer's list) to become one prefab object at x, y
export interface PrefabGroup { layer: Layer; x: number; y: number; objects: number[] }
export interface PrefabPlace extends PrefabGroup {
  bytes: number; // level data bytes saved: the objects found against one prefab object
}
export interface LevelPlaces { level: number; places: PrefabPlace[] }
export interface LevelGroups { level: number; places: PrefabGroup[] }

const ALL_FLAGS = flagBytes(Array.from({ length: COND_FLAGS }, (_, f) => f));
// a Direct Map16 tile with its condition
export const tileKey = (tile: number, cond: Dm16Cond | null | undefined) => `${tile} ${cond ? `${cond.flag} ${cond.always}` : ''}`;

// the places of prefab s in lv (as given); load: lv's emulated load, called when an object between those of
// a place may write a prefab tile; skip: objects that are no place's (the selection)
export function findPrefabPlaces(rom: Rom, lv: Level, s: Prefab, load: (ov: LevelOverride) => LevelRender,
  skip: (layer: Layer, i: number) => boolean = () => false): PrefabPlace[] {
  const cells = s.tiles.map((t, i) => (t === TRANSPARENT ? '' : tileKey(t, s.conds?.[i])));
  const anchor = cells.findIndex(Boolean);
  if (anchor < 0) return [];
  const ac = anchor % s.w, ar = Math.floor(anchor / s.w);
  const perPlacement = objectBytes({ uid: 0, num: 0, ext: PREFAB_EXT, x: 0, y: 0, size: 0, prefab: 0 });
  let written: Map<number, Set<number>> | null = null;
  const writes = (layer: Layer, i: number) =>
    (written ??= load({ ...levelOverride(rom, lv), cdm16Flags: ALL_FLAGS }).touched).get(objectKey(layer === 2, i));
  const out: PrefabPlace[] = [];
  for (const layer of [1, 2] as const) {
    const objs = layer === 1 ? lv.objects : lv.layer2Objects;
    if (!objs) continue;
    let geom: LayerGeom | null = null;
    const addr = (x: number, y: number) => (geom ??= layerGeom(rom, layer - 1, lv.header.mode, lv.header.screens, levelRows(lv.secondary))).addr(x, y);
    const used = new Set<number>();
    // the place at X, Y, or null
    const placeAt = (X: number, Y: number): PrefabPlace | null => {
      const idx = (t: number) => {
        const c = (t & 0xffff) - X, r = (t >> 16) - Y;
        return c >= 0 && r >= 0 && c < s.w && r < s.h ? r * s.w + c : -1;
      };
      const S: number[] = [], others: [number, number[]][] = [];
      const lastS = new Int32Array(cells.length).fill(-1); // the last object of S drawing each tile
      objs.forEach((o, j) => {
        if (!isDm16(o)) return;
        const ts = dm16Tiles(o), inside = ts.map(idx).filter((i) => i >= 0);
        if (!inside.length) return;
        const k = tileKey(o.tile ?? 0, o.cond);
        if (inside.length === ts.length && inside.every((i) => cells[i] === k)) {
          S.push(j);
          for (const i of inside) lastS[i] = j;
        } else others.push([j, inside]);
      });
      if (!S.length || S.some((j) => skip(layer, j) || used.has(j)) || cells.some((c, i) => c && lastS[i] < 0)) return null;
      // another Direct Map16 object only below S's tiles
      if (others.some(([j, inside]) => inside.some((i) => lastS[i] < j))) return null;
      // objects in between: none writes a prefab tile that S does not draw over later
      const lo = S[0], hi = S[S.length - 1];
      for (let j = lo + 1; j < hi; j++) {
        if (isDm16(objs[j])) continue;
        const w = writes(layer, j);
        if (w && cells.some((c, i) => c && lastS[i] < j && w.has(addr(X + (i % s.w), Y + Math.floor(i / s.w)) - MAP_BASE))) return null;
      }
      return { layer, x: X, y: Y, objects: S, bytes: S.reduce((n, j) => n + objectBytes(objs[j]), 0) - perPlacement };
    };
    const tried = new Set<number>();
    for (const o of objs) {
      if (!isDm16(o) || tileKey(o.tile ?? 0, o.cond) !== cells[anchor]) continue;
      for (const t of dm16Tiles(o)) {
        const X = (t & 0xffff) - ac, Y = (t >> 16) - ar;
        if (X < 0 || Y < 0 || tried.has((Y << 16) | X)) continue;
        tried.add((Y << 16) | X);
        const p = placeAt(X, Y);
        if (p) { out.push(p); p.objects.forEach((i) => used.add(i)); }
      }
    }
  }
  return out;
}

// the places in the levels (default: as saved)
export function planPrefabPlaces(rom: Rom, s: Prefab, src: {
  levels: number[];
  level?: (n: number) => Level;
  load: (n: number, ov: LevelOverride) => LevelRender;
  skip?: (n: number, layer: Layer, i: number) => boolean;
}): LevelPlaces[] {
  const out: LevelPlaces[] = [];
  for (const n of src.levels) {
    let lv: Level;
    try { lv = src.level?.(n) ?? loadLevel(rom, n); } catch { continue; } // unreadable level
    const places = findPrefabPlaces(rom, lv, s, (ov) => src.load(n, ov), src.skip && ((layer, i) => src.skip!(n, layer, i)));
    if (places.length) out.push({ level: n, places });
  }
  return out;
}

// objects of a level's layer that are no place's (the selection), as a learn job is asked for with them
export interface PrefabSkip { level: number; layer: Layer; objects: number[] }

// The places in the levels as a job (the result learner's, no picture, CONTEXT.md), learned in the probe worker: a level
// per step, open the open level as edited (the others as saved), an object load on the job's emulator
export function* prefabPlacesJob(rom: Rom, emu: LevelEmulator, s: Prefab, levels: number[], open?: Level, skip?: PrefabSkip): Generator<void, LevelPlaces[]> {
  const sel = new Set(skip?.objects);
  const out: LevelPlaces[] = [];
  for (const n of levels) {
    out.push(...planPrefabPlaces(rom, s, {
      levels: [n],
      level: (m) => (m === open?.number ? open : loadLevel(rom, m)),
      load: (m, ov) => emu.load(m, ov),
      skip: (m, l, i) => m === skip?.level && l === skip.layer && sel.has(i),
    }));
    yield;
  }
  return out;
}

// each group's objects become one prefab object n, at the place of the last of them; the new objects
export function replaceWithPrefab(lv: Level, n: number, groups: PrefabGroup[]): LevelObject[] {
  const made: LevelObject[] = [];
  for (const layer of [1, 2] as const) {
    const objs = layer === 1 ? lv.objects : lv.layer2Objects;
    const gs = groups.filter((g) => g.layer === layer);
    if (!objs || !gs.length) continue;
    const gone = new Set(gs.flatMap((g) => g.objects));
    const at = new Map(gs.map((g): [number, LevelObject] => [Math.max(...g.objects), { uid: newUid(), num: 0, ext: PREFAB_EXT, x: g.x, y: g.y, size: 0, prefab: n }]));
    const res: LevelObject[] = [];
    objs.forEach((o, i) => {
      const p = at.get(i);
      if (p) { res.push(p); made.push(p); } else if (!gone.has(i)) res.push(o);
    });
    if (layer === 1) lv.objects = res; else lv.layer2Objects = res;
  }
  return made;
}

// replaces the planned places with prefab n in the levels as saved (an open level with changes is saved
// before, by the ROM edit)
export function applyPrefabPlaces(rom: Rom, n: number, plan: LevelGroups[]): void {
  for (const p of plan) {
    const lv = loadLevel(rom, p.level);
    replaceWithPrefab(lv, n, p.places);
    saveLevel(rom, lv);
  }
}

// prefab n's objects (both layers): how many in lv
export function prefabObjectCount(lv: Level, n: number): number {
  return [...lv.objects, ...(lv.layer2Objects ?? [])].filter((o) => o.num === 0 && o.ext === PREFAB_EXT && o.prefab === n).length;
}

// deletes prefab n and its objects in the levels as saved (an open level with changes is saved before, by the
// ROM edit), so none is left placing nothing
export function deletePrefab(rom: Rom, n: number, levels: number[]): void {
  const other = (o: LevelObject) => !(o.num === 0 && o.ext === PREFAB_EXT && o.prefab === n);
  for (const i of levels) {
    let lv: Level;
    try { lv = loadLevel(rom, i); } catch { continue; } // unreadable level
    if (!prefabObjectCount(lv, n)) continue;
    lv.objects = lv.objects.filter(other);
    if (lv.layer2Objects) lv.layer2Objects = lv.layer2Objects.filter(other);
    saveLevel(rom, lv);
  }
  writePrefab(rom, n, null);
}

// prefab n as s and plan's objects replaced by it, one ROM edit labelled with the places found elsewhere;
// sources: the objects it is made from, its top left at x, y (prefabsources.ts). Throws when it failed.
export function storePrefab(edits: EditSession, n: number, s: Prefab, plan: LevelGroups[], places: LevelPlaces[], sources?: { objects: LevelObject[]; x: number; y: number }): void {
  const open = edits.level.number, found = places.reduce((k, p) => k + p.places.length, 0);
  edits.romEdit(`Prefab ${hex(n, 2)} saved${found ? `, ${found} place${found > 1 ? 's' : ''} replaced` : ''}`, () => {
    // (the plan's objects are the open level's as edited: saved before the ROM edit)
    if (plan.some((p) => p.level === open) && edits.dirty) throw new Error(`Level ${hex(open, 3)} could not be saved`);
    writePrefab(edits.rom, n, s);
    setPrefabSources(edits.rom, n, s, sources?.objects ?? null, sources?.x, sources?.y);
    applyPrefabPlaces(edits.rom, n, plan);
  });
}
