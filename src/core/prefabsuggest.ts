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
// run's bytes and levels takes part in keeps its suggestions (SuggestRuns.held), also one that brings back its
// state (an undo) or opens another level without edits (#212).

import type { Rom } from './rom.ts';
import { loadLevel, serializeLayer1, serializeLayer2, serializeObjects, hasObjects, isL1Vertical, isSized, type Level, type LevelObject } from './level.ts';
import type { LevelEmulator } from './levelemu.ts';
import { isDm16, dm16Tiles } from './cdm16.ts';
import type { Prefab } from './prefabs.ts';
import { prefabCost } from './prefabcost.ts';
import { dm16Prefab, arrangementKey } from './pastehint.ts';
import { findPrefabPlaces, tileKey, type Layer, type LevelPlaces, type PrefabPlace } from './prefabplaces.ts';
import { runJob } from './jobrunner.ts';
import { KeptResults } from './keptresults.ts';
import { inputHash } from './inputs.ts';
import { RomReads, record, byFingerprint, always, type RomDeps, type RomFingerprint } from './romdeps.ts';

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

// the levels of a run and the open level as edited (what decides whether the latest run holds)
export type SuggestLevels = Pick<SuggestSource, 'levels' | 'open'>;

// a finished run: what it read, its levels, the one it took as edited, each level's content it took
// (inputs) and its suggestions
export interface SuggestRun { deps: RomDeps; levels: string; edited: number | null; inputs: Map<number, string>; list: PrefabSuggestion[] }

// a level's arrangements (arrangementKey and prefab of each group, in dm16Groups' order) and the Direct Map16
// tiles it has (tileKey)
interface Arrangements { list: [string, Prefab][]; tiles: Set<string> }

const PLACES = 4096; // place searches kept (a level and an arrangement each, with its latest used contents), the latest used; a run keeps all it used, also more
const CONTENTS = 0x200; // levels whose contents as saved are kept (every level's)

// The latest finished run and whether it holds (the editor's, SuggestionList): a level's content as saved is kept
// while the ROM bytes its load read are unchanged (object 2D's length among them, obj2d.ts), so
// another level opened loads the one edited before only once.
export class SuggestRuns {
  protected fp: RomFingerprint;
  protected contents: KeptResults<RomDeps>; // a level's content as saved
  protected last: SuggestRun | null = null; // the latest finished run's

  constructor(fp: RomFingerprint) {
    this.fp = fp;
    this.contents = new KeptResults({ validity: byFingerprint(fp), limit: CONTENTS });
  }

  // the latest finished run; one finished elsewhere (in the probe worker, on the same ROM: its bytes read are checked
  // here) becomes the latest
  get latest(): SuggestRun | null { return this.last; }
  adopt(run: SuggestRun): void { this.last = run; }

  // the latest finished run's suggestions (not to be changed) if a run on src now has them, else null: the same
  // levels with the same contents, and no ROM byte it read changed (a pixel of a graphics file keeps them, a level
  // saved doesn't, an undo back brings them back). The open level counts only if it is among the levels. Another
  // level opened: the one the run took as edited is compared as saved, and from then on it is the latest run's.
  held(rom: Rom, src: SuggestLevels): PrefabSuggestion[] | null {
    const l = this.last;
    if (!l || l.levels !== src.levels.join() || !this.fp.valid(l.deps)) return null;
    const edited = editedOf(src);
    if (edited !== null && l.inputs.get(edited) !== levelContent(rom, src.open!)) return null;
    if (l.edited !== null && l.edited !== edited) {
      let e = this.savedEntry(l.edited);
      if (!e) {
        const s = loadSaved(rom, l.edited);
        if (!s) return null;
        e = { data: s.input, deps: this.fp.deps(s.reads) };
        this.contents.set(`${l.edited}`, e.data, e.deps);
      }
      if (e.data !== l.inputs.get(l.edited)) return null;
      const read = new RomReads(rom);
      read.addDeps(l.deps);
      read.addDeps(e.deps);
      l.deps = this.fp.deps(read);
    }
    l.edited = edited;
    return l.list;
  }

  protected savedEntry(n: number) { return this.contents.entry<string>(`${n}`); }
}

// The results of single levels kept between runs (the probe worker's, where the runs are): a level's arrangements are
// kept by the level's content (they read no ROM byte), an arrangement's places in a level by the level's content and
// while the ROM bytes their search read are unchanged (the tables, the emulated load where objects lie between those
// of a place). Both keep a level's latest used INPUTS_PER_KEY contents, so undoing an edit finds them. With the
// levels' contents as saved (SuggestRuns) a run loads only the levels a ROM change touched.
export class KeptSuggestions extends SuggestRuns {
  private arrangements = new KeptResults({ validity: always }); // by level and content
  private places: KeptResults<RomDeps>;
  private run: { read: RomReads; levels: string; edited: number | null } | null = null; // the running run's (what it read: its levels' loads, its places' searches)

  constructor(fp: RomFingerprint, limit = PLACES) {
    super(fp);
    this.places = new KeptResults({ validity: byFingerprint(fp), limit });
  }

  // a run starts or is finished: the places a finished run used are all kept for the next one
  startRun(rom: Rom, src: SuggestLevels): void {
    this.places.startRound();
    this.contents.startRound();
    this.run = { read: new RomReads(rom), levels: src.levels.join(), edited: editedOf(src) };
  }
  endRun(inputs: Map<number, string>, list: PrefabSuggestion[]): void {
    this.places.endRound();
    this.contents.endRound();
    const { read, ...run } = this.run!;
    this.last = { deps: this.fp.deps(read), ...run, inputs, list };
    this.run = null;
  }

  savedContent(n: number): string | undefined {
    return this.used(this.savedEntry(n));
  }
  setSavedContent(n: number, input: string, reads: RomReads): void {
    this.contents.set(`${n}`, input, this.fp.deps(reads));
    this.run?.read.add(reads);
  }

  arrangementsOf(n: number, input: string): Arrangements | undefined { return this.arrangements.get<Arrangements>(`${n}`, input); }
  setArrangements(n: number, input: string, a: Arrangements): void { this.arrangements.set(`${n}`, a, null, input); }

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

// The suggestions the editor shows and whether they are current (of the levels and the ROM as they are now: their
// places can be taken). check() after every change: the latest run's list held (SuggestRuns.held) is current at
// once, else the list stays shown, not current, and a run is started (start; stop cancels one). While an edit is
// under way (editing: a ROM edit with its follow-ups, the open level not yet loaded again) nothing is checked and the
// list is not current: the edit session's settled checks once it is done, whatever the order of its follow-ups (#220).
export interface SuggestionHooks {
  rom(): Rom;
  source(): SuggestLevels;
  editing(): boolean; // a ROM edit is under way (its follow-ups too)
  start(): void; // a run a while after the last change (finished: done with its result)
  stop(): void; // the run started, if any, is stopped (its result won't come)
  changed(): void; // the list changed, or became current
}

export class SuggestionList {
  private shown: PrefabSuggestion[] | null = null;
  private held = false; // current as of the latest check
  private kept: SuggestRuns;
  private hooks: SuggestionHooks;

  constructor(kept: SuggestRuns, hooks: SuggestionHooks) {
    this.kept = kept;
    this.hooks = hooks;
  }

  // (never while an edit is under way: read then, the list may be of the ROM before it)
  get current(): boolean { return this.held && !this.hooks.editing(); }
  // the list shown (null: not known yet)
  get list(): PrefabSuggestion[] | null { return this.shown; }

  check(): void {
    if (this.hooks.editing()) return;
    const held = this.kept.held(this.hooks.rom(), this.hooks.source());
    if (held) {
      if (this.held && this.shown === held) return;
      this.hooks.stop();
      this.shown = held;
      this.held = true;
      this.hooks.changed();
      return;
    }
    this.hooks.stop();
    this.held = false; // (the list shown stays as it is)
    this.hooks.start();
  }

  // the run started finished with r (during an edit: of the ROM before it, shown if it still holds once it is done)
  done(r: SuggestRun): void {
    this.kept.adopt(r);
    if (this.hooks.editing()) return;
    this.shown = r.list;
    this.held = true;
    this.hooks.changed();
  }

  // a suggestion saved as prefab with its places replaced: not offered any more (the next run doesn't find it either);
  // the list without it is no run's, never current
  drop(key: string): void {
    if (!this.shown?.some((q) => q.key === key)) return;
    this.shown = this.shown.filter((q) => q.key !== key);
    this.held = false;
    this.hooks.changed();
  }
}

// what a level's arrangements and places depend on besides the ROM: its objects as the emulated load gets them
// (levelOverride's, the header and screen exits in them) and its secondary header; in a mode without layer 1 objects
// the level data leaves them out, the arrangements and places don't (the open level as edited may have them)
const levelContent = (rom: Rom, lv: Level) => inputHash({
  layer1: serializeLayer1(rom, lv), layer2: serializeLayer2(rom, lv), layer2Pointer: lv.layer2Pointer, secondary: lv.secondary,
  objects: hasObjects(lv.header.mode) ? null : serializeObjects(lv.objects, [], isL1Vertical(rom, lv.header.mode), undefined, isSized(lv.secondary)),
});
// the level a run on src takes as edited: the open level, if it is among the levels
const editedOf = (src: SuggestLevels) => (src.open && src.levels.includes(src.open.number) ? src.open.number : null);
// what a run on src depends on besides the ROM (its job's input): its levels, the one it takes as edited and its content
export function suggestInput(rom: Rom, src: SuggestLevels): string {
  const edited = editedOf(src);
  return inputHash({ levels: src.levels.join(), edited, content: edited === null ? null : levelContent(rom, src.open!) });
}

// level n as saved with its content and the ROM bytes loading it read; null: unreadable
function loadSaved(rom: Rom, n: number): { lv: Level; input: string; reads: RomReads } | null {
  try {
    const { result, reads } = record(rom, () => { const lv = loadLevel(rom, n); return { lv, input: levelContent(rom, lv) }; });
    return { ...result, reads };
  } catch { return null; }
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
  const kept = src.kept;
  kept?.startRun(rom, src);
  // the arrangements of the groups, with how often they occur
  const levels = new Map<number, { lv: Level | null; input: string; a: Arrangements }>(); // (lv: loaded when needed)
  const found = new Map<string, { prefab: Prefab; count: number }>();
  for (const n of src.levels) {
    // the open level as edited; another as saved, loaded only when the bytes its kept content's load read changed
    let lv = n === src.open?.number ? src.open : null, input = lv || !kept ? undefined : kept.savedContent(n);
    if (lv) input = kept ? levelContent(rom, lv) : '';
    else if (input === undefined) {
      if (kept) {
        const s = loadSaved(rom, n);
        if (!s) continue; // unreadable level
        ({ lv, input } = s);
        kept.setSavedContent(n, input, s.reads);
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
    }
    const k = places.reduce((m, p) => m + p.places.length, 0);
    const saved = places.reduce((m, p) => m + p.places.reduce((b, q) => b + q.bytes, 0), 0) - cost.once;
    if (k > 1 && saved > 0) out.push({ key, prefab, places, count: k, levels: places.map((p) => p.level).sort((x, y) => x - y), saved });
  }
  out.sort((x, y) => y.saved - x.saved);
  kept?.endRun(new Map([...levels].map(([n, l]) => [n, l.input])), out);
  return out;
}

// A run as a job (the result learner's, in the probe worker; no picture): the levels' places searched on emu, the
// results of single levels kept in kept between runs; the run finished
export function* prefabSuggestionsJob(rom: Rom, emu: LevelEmulator, kept: KeptSuggestions, levels: number[], open?: Level): Generator<void, SuggestRun> {
  yield* prefabSuggestions(rom, { levels, open, emu: () => emu, kept });
  return kept.latest!;
}

// all at once
export function suggestPrefabs(rom: Rom, src: SuggestSource): PrefabSuggestion[] {
  return runJob(prefabSuggestions(rom, src));
}
