// Prefab suggestions (#116): connected groups of Direct Map16 objects (touching, also at a corner, or
// overlapping, in one layer) whose arrangement – the tiles they leave, however split into rectangles
// (pastehint.ts) – occurs more than once across the levels. Each candidate's places are then found as
// "replace all" finds them (prefabplaces.ts), so a suggestion offers exactly what saving it replaces; listed
// when the places' level data against one prefab object each saves more than the prefab's ROM cost
// (prefabcost.ts), the largest saving first. A generator, one level or one candidate in one level per step,
// so it runs in the background.
// Each level's arrangements and places can be kept between runs (KeptSuggestions), with the level (as saved, or
// as edited) as their input and the places with the ROM bytes their search read: a run takes apart only the
// levels that changed, and loads only those whose load read a changed byte (#201). A change none of the latest
// run's bytes and levels takes part in keeps its suggestions (KeptSuggestions.holds).

import type { Rom } from './rom.ts';
import { loadLevel, serializeLayer1, serializeLayer2, serializeObjects, hasObjects, isL1Vertical, isSized, type Level, type LevelObject } from './level.ts';
import type { LevelEmulator } from './levelemu.ts';
import { isDm16, dm16Tiles } from './cdm16.ts';
import type { Prefab } from './prefabs.ts';
import { prefabCost } from './prefabcost.ts';
import { dm16Prefab, arrangementKey } from './pastehint.ts';
import { findPrefabPlaces, tileKey, type Layer, type LevelPlaces, type PrefabPlace } from './prefabplaces.ts';
import { MemoryResults } from './learner.ts';
import { inputHash } from './inputs.ts';
import { INPUTS_PER_KEY, RomReads, updateBytePages, type RomDeps, type RomFingerprint } from './romdeps.ts';
import { objectLength2D } from './obj2d.ts';

export interface PrefabSuggestion {
  key: string; // the arrangement (arrangementKey)
  prefab: Prefab; // its tiles, without a name
  places: LevelPlaces[]; // where it is (findPrefabPlaces in each level)
  count: number; // how many places
  levels: number[]; // the levels of the places, ascending
  saved: number; // level data bytes saved by replacing all places, the prefab's ROM cost taken off
}

export interface SuggestSource {
  levels: number[];
  open?: Level; // the open level as edited, taken instead of its saved data (the others as saved)
  emu: () => LevelEmulator; // the emulator to load a level on (what a place search read is tracked there)
  kept?: KeptSuggestions; // the levels' results of earlier runs
}

// a level's arrangements (arrangementKey and prefab of each group, in dm16Groups' order) and the Direct Map16
// tiles it has (tileKey)
interface Arrangements { list: [string, Prefab][]; tiles: Set<string> }

const PLACES = 4096; // place searches kept (a level and an arrangement each), the latest used; a run keeps all it used, also more
const CONTENTS = 0x200; // levels' contents as saved kept (every level's)

// The results of single levels kept between runs. A level's arrangements are kept by the level's content (they
// read no ROM byte), an arrangement's places in a level by the level's content and while the ROM bytes their
// search read are unchanged (the tables, the emulated load where objects lie between those of a place). Both keep
// a level's latest used INPUTS_PER_KEY contents, so undoing an edit finds them. A level's content as saved is kept
// while the ROM bytes its load read are unchanged (and object 2D's length, which the load takes from emulation): a
// run loads only the levels a ROM change touched.
export class KeptSuggestions {
  private fp: RomFingerprint;
  private arrangements = new Map<number, { input: string; a: Arrangements }[]>(); // a level's latest used inputs first
  private places: MemoryResults;
  private contents: MemoryResults; // a level's content as saved, by object 2D's length
  private run: { read: RomReads; levels: string; open: string; len2d: number } | null = null; // the running run's (what it read: its levels' loads, its places' searches)
  private last: { deps: RomDeps; levels: string; open: string; len2d: number } | null = null; // the latest finished run's

  constructor(fp: RomFingerprint, limit = PLACES) {
    this.fp = fp;
    this.places = new MemoryResults(fp, limit);
    this.contents = new MemoryResults(fp, CONTENTS);
  }

  // a run starts or is finished: the places a finished run used are all kept for the next one
  startRun(rom: Rom, src: SuggestSource, len2d: number): void {
    this.places.startRound();
    this.contents.startRound();
    this.run = { read: new RomReads(rom.data.length), levels: src.levels.join(), open: openKey(rom, src.open), len2d };
  }
  endRun(): void {
    this.places.endRound();
    this.contents.endRound();
    const { read, ...run } = this.run!;
    this.last = { deps: this.fp.deps(read), ...run };
    this.run = null;
  }

  // the latest finished run's suggestions are those of a run on src now: the same levels and open level, and no
  // ROM byte it read changed (a pixel of a graphics file keeps them; a level saved, a prefab's places, doesn't)
  holds(rom: Rom, src: SuggestSource): boolean {
    const l = this.last;
    return !!l && l.levels === src.levels.join() && l.len2d === objectLength2D(rom) && l.open === openKey(rom, src.open) && this.fp.valid(l.deps);
  }

  savedContent(n: number, len2d: number): string | undefined {
    return this.used(this.contents.entry<string>(`${n}`, `${len2d}`));
  }
  setSavedContent(n: number, len2d: number, input: string, reads: RomReads): void {
    this.contents.set(`${n}`, input, this.fp.deps(reads), `${len2d}`);
    this.run?.read.add(reads);
  }

  arrangementsOf(n: number, input: string): Arrangements | undefined {
    const l = this.arrangements.get(n), i = l?.findIndex((e) => e.input === input) ?? -1;
    if (i < 0) return undefined;
    const [e] = l!.splice(i, 1);
    l!.unshift(e);
    return e.a;
  }
  setArrangements(n: number, input: string, a: Arrangements): void {
    const l = [{ input, a }, ...(this.arrangements.get(n) ?? []).filter((e) => e.input !== input)];
    this.arrangements.set(n, l.slice(0, INPUTS_PER_KEY));
  }

  placesOf(n: number, key: string, input: string): PrefabPlace[] | undefined {
    return this.used(this.places.entry<PrefabPlace[]>(`${n}:${key}`, input));
  }
  setPlaces(n: number, key: string, input: string, places: PrefabPlace[], reads: RomReads): void {
    this.places.set(`${n}:${key}`, places, this.fp.deps(reads), input);
    this.run?.read.add(reads);
  }
  // a kept result the running run uses: what it read counts for the run
  private used<T>(e: { data: T; deps: RomDeps } | undefined): T | undefined {
    if (e) this.run?.read.addDeps(e.deps);
    return e?.data;
  }
}

// what a level's arrangements and places depend on besides the ROM: its objects as the emulated load gets them
// (levelOverride's, the header and screen exits in them) and its secondary header; in a mode without layer 1 objects
// the level data leaves them out, the arrangements and places don't (the open level as edited may have them)
const levelContent = (rom: Rom, lv: Level) => inputHash({
  layer1: serializeLayer1(rom, lv), layer2: serializeLayer2(rom, lv), layer2Pointer: lv.layer2Pointer, secondary: lv.secondary,
  objects: hasObjects(lv.header.mode) ? null : serializeObjects(lv.objects, [], isL1Vertical(rom, lv.header.mode), undefined, isSized(lv.secondary)),
});
const openKey = (rom: Rom, open: Level | undefined) => (open ? `${open.number}:${levelContent(rom, open)}` : '');

// level n as saved with its content and the ROM bytes loading it read; null: unreadable
function loadSaved(rom: Rom, n: number): { lv: Level; input: string; reads: RomReads } | null {
  const outer = rom.reads, reads = new RomReads(rom.data.length);
  rom.reads = reads;
  try {
    const lv = loadLevel(rom, n);
    return { lv, input: levelContent(rom, lv), reads };
  } catch { return null; } finally {
    rom.reads = outer;
    outer?.add(reads);
  }
}

function arrangements(lv: Level): Arrangements {
  const list: [string, Prefab][] = [];
  for (const g of dm16Groups(lv)) {
    const objs = (g.layer === 1 ? lv.objects : lv.layer2Objects!) as LevelObject[];
    const s = dm16Prefab(g.objects.map((i) => objs[i]));
    if (s) list.push([arrangementKey(s), s]);
  }
  return { list, tiles: new Set([...lv.objects, ...(lv.layer2Objects ?? [])].filter(isDm16).map((o) => tileKey(o.tile ?? 0, o.cond))) };
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
  const kept = src.kept, len2d = kept ? objectLength2D(rom) : 0;
  // (the loads' reads are recorded by byte where this ROM state's byte pages say, not where an emulator last left them;
  // again after each step: another ROM's may have been computed in between)
  updateBytePages(rom);
  kept?.startRun(rom, src, len2d);
  // the arrangements of the groups, with how often they occur
  const levels = new Map<number, { lv: Level | null; input: string; a: Arrangements }>(); // (lv: loaded when needed)
  const found = new Map<string, { prefab: Prefab; count: number }>();
  for (const n of src.levels) {
    // the open level as edited; another as saved, loaded only when the bytes its kept content's load read changed
    let lv = n === src.open?.number ? src.open : null, input = lv || !kept ? undefined : kept.savedContent(n, len2d);
    if (lv) input = kept ? levelContent(rom, lv) : '';
    else if (input === undefined) {
      if (kept) {
        const s = loadSaved(rom, n);
        if (!s) continue; // unreadable level
        ({ lv, input } = s);
        kept.setSavedContent(n, len2d, input, s.reads);
      } else {
        try { lv = loadLevel(rom, n); } catch { continue; }
        input = '';
      }
    }
    let a = kept?.arrangementsOf(n, input);
    if (!a) { lv ??= loadLevel(rom, n); a = arrangements(lv); kept?.setArrangements(n, input, a); }
    levels.set(n, { lv, input, a });
    for (const [key, s] of a.list) {
      const f = found.get(key);
      if (f) f.count++; else found.set(key, { prefab: s, count: 1 });
    }
    yield;
    updateBytePages(rom);
  }
  // the places of those occurring more than once, in the levels that have their first tile
  let emu: LevelEmulator | null = null; // (taken once per arrangement, when a search is needed)
  const search = (n: number, lv: Level, s: Prefab) => {
    const e = (emu ??= src.emu());
    // (a load starts from the boot's state: its reads count once a load is needed)
    return e.tracked(() => findPrefabPlaces(rom, lv, s, (ov) => { const r = e.load(n, ov); if (e.bootReads) rom.reads?.add(e.bootReads); return r; }), null);
  };
  const out: PrefabSuggestion[] = [];
  for (const [key, { prefab, count }] of found) {
    if (count < 2) continue;
    const cost = prefabCost(prefab);
    const a = prefab.tiles.findIndex((t) => t >= 0);
    const first = tileKey(prefab.tiles[a], prefab.conds?.[a]);
    const places: LevelPlaces[] = [];
    emu = null;
    for (const [n, l] of levels) {
      if (!l.a.tiles.has(first)) continue;
      let ps = kept?.placesOf(n, key, l.input);
      if (!ps) {
        const r = search(n, (l.lv ??= loadLevel(rom, n)), prefab); // (loaded outside the search: its reads don't count)
        ps = r.result;
        kept?.setPlaces(n, key, l.input, ps, r.reads);
      }
      if (ps.length) places.push({ level: n, places: ps });
      yield;
      updateBytePages(rom);
    }
    const k = places.reduce((m, p) => m + p.places.length, 0);
    const saved = places.reduce((m, p) => m + p.places.reduce((b, q) => b + q.bytes, 0), 0) - cost.once;
    if (k > 1 && saved > 0) out.push({ key, prefab, places, count: k, levels: places.map((p) => p.level).sort((x, y) => x - y), saved });
  }
  kept?.endRun();
  return out.sort((x, y) => y.saved - x.saved);
}

// all at once
export function suggestPrefabs(rom: Rom, src: SuggestSource): PrefabSuggestion[] {
  const g = prefabSuggestions(rom, src);
  for (;;) { const r = g.next(); if (r.done) return r.value; }
}
