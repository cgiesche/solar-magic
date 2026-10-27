// The objects a prefab was made from, so "Break up" gives them back instead of its tiles as Direct Map16
// objects. Editor data, not part of the ROM image (as usernames.ts): kept with the working ROM and the project
// file, never in the playable ROM. One entry holding JSON: { v, prefabs: { number in hex: { key, objects } } },
// key: the prefab's tiles they were taken with (its name doesn't count), objects: in drawing order, relative to
// the prefab's top left. A prefab stored with other tiles drops them (writePrefab).
// Breaking up takes them only where they draw the level exactly as the prefab did (emulated: the tileset, the
// objects around it); else, and for prefabs without sources, the tiles as Direct Map16 objects (prefabcost.ts).

import type { Rom } from './rom.ts';
import { newUid, type Level, type LevelObject } from './level.ts';
import type { LevelRender } from './levelemu.ts';
import { MAP_BASE, MAP_SIZE, MAP_HI } from './ram.ts';
import { inputHash } from './inputs.ts';
import { readPrefab, type Prefab } from './prefabs.ts';
import { prefabDm16Objects } from './prefabcost.ts';

const ID = 'prefab-sources';
const VERSION = 1;

type Source = Omit<LevelObject, 'uid'>;
type Store = Record<string, { key: string; objects: Source[] }>;

function load(rom: Rom): Store {
  const b = rom.getBlob(ID);
  if (!b) return {};
  const j = JSON.parse(new TextDecoder().decode(b)) as { v: number; prefabs: Store };
  if (j.v > VERSION) throw new Error('The prefab sources are from a newer editor version');
  return j.prefabs;
}

function store(rom: Rom, prefabs: Store): void {
  rom.setBlob(ID, Object.keys(prefabs).length ? new TextEncoder().encode(JSON.stringify({ v: VERSION, prefabs })) : null);
}

const keyOf = (s: Prefab) => inputHash({ w: s.w, h: s.h, tiles: s.tiles, conds: s.conds ?? null });

// prefab n (tiles s) made from objects with its top left at x, y (null: none)
export function setPrefabSources(rom: Rom, n: number, s: Prefab, objects: LevelObject[] | null, x = 0, y = 0): void {
  const prefabs = load(rom);
  if (objects?.length) prefabs[n.toString(16)] = { key: keyOf(s), objects: objects.map(({ uid: _, ...o }) => ({ ...structuredClone(o), x: o.x - x, y: o.y - y })) };
  else delete prefabs[n.toString(16)];
  store(rom, prefabs);
}

// prefab n stored as s (null: removed): its sources kept only when they are of the same tiles
export function keepPrefabSources(rom: Rom, n: number, s: Prefab | null): void {
  const e = load(rom)[n.toString(16)];
  if (e && (!s || e.key !== keyOf(s))) setPrefabSources(rom, n, s ?? { w: 0, h: 0, tiles: [], name: '' }, null);
}

// the objects prefab n (tiles s) was made from, its top left at x, y (null: none, or of other tiles)
export function prefabSources(rom: Rom, n: number, s: Prefab, x: number, y: number): LevelObject[] | null {
  const e = load(rom)[n.toString(16)];
  if (!e || e.key !== keyOf(s)) return null;
  return e.objects.map((o) => ({ ...structuredClone(o), uid: newUid(), x: o.x + x, y: o.y + y }));
}

// what prefab object o in lv breaks up into: its sources when they draw both layers' maps as it does (load: lv
// emulated), else its tiles as Direct Map16 objects; null: the prefab doesn't exist
export function breakUpPrefab(rom: Rom, lv: Level, o: LevelObject, vertical: boolean, load: (lv: Level) => LevelRender):
  { parts: LevelObject[]; sources: boolean; differs: boolean } | null {
  const s = o.prefab !== undefined ? readPrefab(rom, o.prefab) : null;
  if (!s) return null;
  const tiles = () => prefabDm16Objects(s, o.x, o.y, vertical);
  const src = prefabSources(rom, o.prefab!, s, o.x, o.y);
  if (!src) return { parts: tiles(), sources: false, differs: false };
  const alike = (() => {
    try {
      const a = load(lv), b = load(replaced(lv, o, src));
      if (!a.ok || !b.ok) return false;
      for (let i = MAP_BASE; i < MAP_BASE + MAP_SIZE; i++) if (a.wram[i] !== b.wram[i] || a.wram[i + MAP_HI] !== b.wram[i + MAP_HI]) return false;
      return true;
    } catch { return false; } // (not serializable there)
  })();
  return alike ? { parts: src, sources: true, differs: false } : { parts: tiles(), sources: false, differs: true };
}

// lv with object o (of either layer) replaced by parts, at its place in the object list
export function replaced(lv: Level, o: LevelObject, parts: LevelObject[]): Level {
  const swap = (objs: LevelObject[]) => {
    const at = objs.indexOf(o);
    return at < 0 ? objs : [...objs.slice(0, at), ...parts, ...objs.slice(at + 1)];
  };
  return { ...lv, objects: swap(lv.objects), ...(lv.layer2Objects ? { layer2Objects: swap(lv.layer2Objects) } : {}) };
}
