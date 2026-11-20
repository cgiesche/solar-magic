// Results found out by emulation (block/sprite probes, captured sprite images) depend on the ROM
// bytes the emulated code read. The emulator marks the 256-byte ROM pages it reads; a result keeps
// the list of pages and a fingerprint of their contents, and stays valid while they are unchanged.
// So a change to the ROM (a saved level, a patch, an edited palette) only drops the results that
// read the changed pages, and results can be stored across sessions (and ROMs: the key only says
// what was computed, the fingerprint whether it still holds).
// The level tables (pointers, secondary headers: $05E000-$05FFFF) hold a few bytes of every level
// in each page, the ROM header page ($00FF00) the checksum next to the vectors; there single bytes
// are recorded, so saving a level (another one, or fixing the checksum) doesn't drop anything.
// The same for the editor patch's tables (per-level GFX and sprite bank; the GFX file pointers aren't
// recorded at all, see gfxSkipMask): another level's GFX setting only drops what read that entry, and
// for the levels' own palettes' pointers and the banks of their stored BG tilemaps: giving a level its
// own palette or BG tilemap only drops what loaded that level. The same for the pages holding
// ExAnimation data and the overworld's data (painting the overworld only drops what read the tiles
// painted, a level's initial flags what read them). The same for the pages holding level data (layer
// 1, layer 2 objects, sprites, stored BG tilemaps): the boot loads the title screen's level, which every
// result counts, and its data shares pages with other levels' – saving one of those only drops what
// read its bytes. The same for the two pages the shared palettes ($00:B0A0–$00:B881) share with code: every result runs
// the code from $00:B888 on (the boot), the goal tape and the goal sphere the end of the palette fade at $00:B000.
// Results that are no pictures leave the colors out (gfxDisplaySkipMask), so changing a color there keeps them (#190).
// Which reads a result leaves out follows from what it shows (bootsnapshot.ts): a recording is given its mask there.
// The same for the per-sprite tables (tweakers, INIT/MAIN pointers, PIXI's sprite table), which hold a few bytes of
// every sprite in each page: found by emulation (spritetables.ts, learnBytePages), so a change of one sprite's entry
// only drops what loaded that sprite.
// The title screen picture (its stripe image and the entry pointing to it) is drawn by the boot and written anew by
// every level's load: the boot snapshot keeps its bytes apart from the boot's other reads (bootsnapshot.ts), and only a
// result that shows the title screen counts them – painting it keeps what a level's load learned.

import type { Rom } from './rom.ts';
import type { Snes } from './snes.ts';
import { snesToPc, type RomRange } from './rom.ts';
import { editorPatch, customPalettePatch, bgPatch, GFX_FILES, GFX_BYPASS_ENTRIES } from './patches.ts';
import { exanimDataRanges } from './exanim.ts';
import { overworldDataRanges } from './overworld.ts';
import { levelDataRanges } from './level.ts';
import { KeptResults, type Validity } from './keptresults.ts';
import { SHARED_PALETTES, SHARED_PAL_SIZE } from './sharedpal.ts';
import { TITLE_STRIPE_PTR } from './titlepicture.ts';

export const PAGE_SHIFT = 8;

export interface RomDeps {
  pages: Uint16Array; // indices of the pages read
  bytes: Uint32Array; // single bytes read (in byte pages)
  h1: number; // fingerprint of their contents
  h2: number;
}

// pages whose reads are recorded by byte in every ROM state: the level tables, the ROM header page, the shared
// palettes' first and last page and the page of the title screen picture's entry in the stripe image table (code all
// around it that every result runs: painting the picture moves it)
const FIXED_BYTE_PAGES = new Uint8Array(0x10000);
FIXED_BYTE_PAGES.fill(1, 0x2e000 >> PAGE_SHIFT, 0x30000 >> PAGE_SHIFT);
FIXED_BYTE_PAGES[0x7f00 >> PAGE_SHIFT] = 1;
const SHARED_PAL_PC = snesToPc(SHARED_PALETTES);
FIXED_BYTE_PAGES[SHARED_PAL_PC >> PAGE_SHIFT] = 1;
FIXED_BYTE_PAGES[(SHARED_PAL_PC + SHARED_PAL_SIZE - 1) >> PAGE_SHIFT] = 1;
FIXED_BYTE_PAGES[snesToPc(TITLE_STRIPE_PTR) >> PAGE_SHIFT] = 1;

// runs fn without recording the ROM bytes the editor code reads (Rom.reads): what it reads isn't part of the
// computation running around it (a level's data read as a load's input, a mask kept per ROM state)
export function unrecorded<T>(rom: Rom, fn: () => T): T {
  const reads = rom.reads;
  rom.reads = null;
  try { return fn(); } finally { rom.reads = reads; }
}

// make(rom), computed once per ROM state (a Rom and its generation: several ROMs may be in one process, also at the
// same generation number) and kept for it; what make reads isn't recorded (unrecorded): the next asker gets the kept
// value without its reads (skip masks, byte pages). A make that throws keeps nothing.
export function perRomState<T>(make: (rom: Rom) => T): (rom: Rom) => T {
  const kept = new WeakMap<Rom, { gen: number; value: T }>();
  return (rom) => {
    const k = kept.get(rom);
    if (k && k.gen === rom.gen) return k.value;
    const gen = rom.gen, value = unrecorded(rom, () => make(rom));
    kept.set(rom, { gen, value });
    return value;
  };
}

// The pages of this ROM state whose reads are recorded by byte (1): the fixed ones, the pages of its editor patch
// tables, its level palettes' pointers, its free space blocks' edges, ExAnimation data, overworld data and level data.
// A recorder (RomReads) looks them up for the ROM it records for. The GFX file pointers and the ExAnimation data
// aren't recorded at all (see gfxSkipMask), byte pages keep the rest of their pages from counting them (an animation
// list next to code that is run).
const baseBytePages = perRomState((rom: Rom): Uint8Array => {
  const pages = FIXED_BYTE_PAGES.slice();
  const markPc = (o: number, end: number) => pages.fill(1, o >> PAGE_SHIFT, ((end - 1) >> PAGE_SHIFT) + 1);
  for (const [a, b] of exanimDataRanges(rom)) markPc(a, b);
  for (const [a, b] of overworldDataRanges(rom)) markPc(a, b);
  // the pages a block in free space shares with the free space around it, which a save fills (code and tables
  // every level reads next to a level's data)
  for (const b of rom.scanRats()) { markPc(b.start, b.start + 1); markPc(b.start + 7 + b.size, b.start + 8 + b.size); }
  const p = editorPatch(rom);
  if (!p) return pages;
  // (after the patch's check: where a level's sprite data lies needs its sprite bank table)
  for (const [a, b] of levelDataRanges(rom)) markPc(a, b);
  const mark = (snes: number, len: number) => { const o = snesToPc(snes); markPc(o, o + len); };
  mark(p.gfxLo, GFX_FILES); mark(p.gfxHi, GFX_FILES); mark(p.gfxBank, GFX_FILES); mark(p.gfxFlags, GFX_FILES);
  mark(p.levelGfx, GFX_BYPASS_ENTRIES * 8); mark(p.levelGfxHi, GFX_BYPASS_ENTRIES * 8);
  mark(p.sprBank, 0x200);
  const pal = customPalettePatch(rom);
  if (pal) mark(pal.table, 0x200 * 3);
  const bg = bgPatch(rom);
  if (bg) mark(bg.table, 0x200);
  return pages;
});

// pages learned by emulation to be recorded by byte for a Rom (learnBytePages), with the byte pages of the ROM state
// they were last combined with
const learned = new WeakMap<Rom, { pages: number[]; base: Uint8Array | null; combined: Uint8Array | null }>();

// From now on the reads of these pages of rom are recorded by byte (with those of bytePages), in every ROM state: the
// per-sprite tables, found by emulation (spritetables.ts). Recorders made before keep the pages they had (a page read
// whole stays read whole: drops more results, never fewer).
export function learnBytePages(rom: Rom, pages: number[]): void {
  learned.set(rom, { pages, base: null, combined: null });
}

// The pages of this ROM state whose reads are recorded by byte (1): baseBytePages and those learned (learnBytePages).
export function bytePages(rom: Rom): Uint8Array {
  const base = baseBytePages(rom), l = learned.get(rom);
  if (!l?.pages.length) return base;
  if (l.base !== base || !l.combined) {
    l.combined = base.slice();
    for (const p of l.pages) if (p < l.combined.length) l.combined[p] = 1;
    l.base = base;
  }
  return l.combined;
}

// every page by byte: a fine recorder's (RomReads fine)
const ALL_PAGES = new Uint8Array(1 << (24 - PAGE_SHIFT)).fill(1); // (pages of a 16 MB ROM)

// what a computation read (the emulated CPU and editor code, see Snes.romReads, Rom.reads)
export class RomReads {
  pages: Uint8Array; // 1 = read
  bytes = new Set<number>();
  private rom: Rom;
  private pagesGen = -1;
  private pagesOf: Uint8Array | null = null;
  private fine: boolean;

  // a recorder for rom, starting with base's reads; fine: every read recorded by byte until coarsen()
  constructor(rom: Rom, base?: RomReads | null, fine = false) {
    this.rom = rom;
    this.fine = fine;
    this.pages = new Uint8Array(rom.data.length >> PAGE_SHIFT);
    if (base) this.add(base);
  }

  // the pages recorded by byte: those of the ROM state current at each read (bytePages), also for a recorder kept
  // across ROM edits. A page read whole before it became a byte page stays read whole (drops more results, never fewer)
  get bytePages(): Uint8Array {
    if (this.fine) return ALL_PAGES;
    if (this.pagesGen !== this.rom.gen || !this.pagesOf) { this.pagesOf = bytePages(this.rom); this.pagesGen = this.rom.gen; }
    return this.pagesOf;
  }

  // a fine recorder's reads as recorded by a recorder made now: by byte in the byte pages of the current ROM state
  // (with those learned meanwhile), else by page
  coarsen(): void {
    if (!this.fine) return;
    this.fine = false;
    this.pagesOf = null;
    const byte = this.bytePages;
    for (const b of this.bytes) {
      const p = b >> PAGE_SHIFT;
      if (byte[p]) continue;
      this.bytes.delete(b);
      if (p < this.pages.length) this.pages[p] = 1;
    }
  }

  read(o: number, len = 1): void {
    const byte = this.bytePages;
    for (let i = o; i < o + len; i++) {
      const p = i >> PAGE_SHIFT;
      if (byte[p]) this.bytes.add(i);
      else if (p < this.pages.length) this.pages[p] = 1;
    }
  }

  // any byte read differs between two ROM images
  differ(then: Uint8Array, now: Uint8Array): boolean {
    for (const b of this.bytes) if (then[b] !== now[b]) return true;
    const size = 1 << PAGE_SHIFT;
    for (let p = 0; p < this.pages.length; p++) {
      if (!this.pages[p]) continue;
      for (let i = p * size, end = i + size; i < end; i++) if (then[i] !== now[i]) return true;
    }
    return false;
  }

  // any byte read lies in one of the ranges
  touches(ranges: RomRange[]): boolean {
    for (const [start, end] of ranges) {
      for (let p = start >> PAGE_SHIFT, e = Math.min(this.pages.length, ((end - 1) >> PAGE_SHIFT) + 1); p < e; p++) if (this.pages[p]) return true;
    }
    for (const b of this.bytes) for (const [start, end] of ranges) if (b >= start && b < end) return true;
    return false;
  }

  // the bytes read in these ranges are left out (recorded by byte in byte pages; a page read whole stays read)
  leaveOut(ranges: RomRange[]): void {
    for (const b of this.bytes) if (ranges.some(([start, end]) => b >= start && b < end)) this.bytes.delete(b);
  }

  add(r: RomReads): void {
    const n = Math.min(this.pages.length, r.pages.length);
    for (let p = 0; p < n; p++) this.pages[p] |= r.pages[p];
    for (const b of r.bytes) this.bytes.add(b);
  }

  // the reads a result's dependencies record (a result kept as RomDeps used as if computed again)
  addDeps(d: RomDeps): void {
    for (const p of d.pages) if (p < this.pages.length) this.pages[p] = 1;
    for (const b of d.bytes) this.bytes.add(b);
  }
}

// A computation's result with the ROM bytes it read, as of ROM generation gen (when it started).
export interface Recorded<T> { result: T; reads: RomReads; gen: number }

// the emulated CPU whose ROM reads are recorded with the editor code's (Snes)
export type RecordingCpu = Pick<Snes, 'romReads' | 'romSkipMask'>;

export interface RecordOptions {
  cpu?: RecordingCpu | null; // its reads are recorded too
  base?: RomReads | null; // reads the result counts as its own (a boot's: the state it starts from)
  mask?: (() => Uint8Array | null) | null; // the CPU's reads it leaves out (a skip mask; inside another recording the outer one's mask applies)
  counted?: boolean; // the reads count for the recording around it (default; else only as given to countReads)
  fine?: boolean; // every read recorded by byte (RomReads fine: coarsened by the caller, before it counts)
}

// Runs fn, returning its result with what it read: the editor code's reads (Rom.reads) and the CPU's, recorded
// against the byte pages of the ROM state it starts in. The recorders running around it are restored after it, also
// when it throws, and get its reads (counted).
export function record<T>(rom: Rom, fn: () => T, o: RecordOptions = {}): Recorded<T> {
  const cpu = o.cpu ?? null, outer = cpu?.romReads ?? null, outerRom = rom.reads, outerMask = cpu?.romSkipMask ?? null;
  const gen = rom.gen, reads = new RomReads(rom, o.base, o.fine);
  rom.reads = reads;
  if (cpu) {
    cpu.romReads = reads;
    if (!outer) cpu.romSkipMask = o.mask?.() ?? null;
  }
  try {
    return { result: fn(), reads, gen };
  } finally {
    rom.reads = outerRom;
    if (cpu) { cpu.romReads = outer; cpu.romSkipMask = outerMask; }
    if (o.counted !== false) countReads(rom, cpu, reads);
  }
}

// reads (of a recording not counted, of a kept result) count for the recorders running as if read now
export function countReads(rom: Rom, cpu: RecordingCpu | null, reads: RomReads): void {
  const outer = cpu?.romReads ?? null, outerRom = rom.reads;
  outer?.add(reads);
  if (outerRom && outerRom !== outer) outerRom.add(reads);
}

// a recorded result still holds: the ROM edits since its generation changed no byte it read (one the ROM's change log
// no longer reaches counts as changed); then it is as of the current generation
export function holds(rom: Rom, r: { gen: number; reads: RomReads }): boolean {
  const changes = rom.changesSince(r.gen);
  if (!changes || (changes.length > 0 && r.reads.touches(changes))) return false;
  r.gen = rom.gen;
  return true;
}

// A value kept for one ROM state and key (the latest asked), its reads counted: a later ask of the same state and key
// gets the kept value and counts what making it read for the recorders running (a view's watch, romwatch.ts), as if
// read again. (perRomState keeps values whose reads don't count.)
export class StateMemo<T> {
  private kept: { rom: Rom; gen: number; key: unknown; r: Recorded<T> } | null = null;

  get(rom: Rom, key: unknown, make: () => T): T {
    const k = this.kept;
    if (k && k.rom === rom && k.gen === rom.gen && k.key === key) { countReads(rom, null, k.r.reads); return k.r.result; }
    const gen = rom.gen, r = record(rom, make);
    this.kept = { rom, gen, key, r };
    return r.result;
  }
}

// hashes of all pages of the current ROM, rehashed where the ROM changed (Rom.changesSince) when its generation does
export class RomFingerprint {
  gen = 0; // counts recomputations that changed a page; cached validity checks are redone when it changes
  rehashed = 0; // pages hashed by the last recomputation
  private rom: Rom;
  private romGen = -1;
  private hashes = new Uint32Array(0);

  constructor(rom: Rom) {
    this.rom = rom;
  }

  sync(): void {
    if (this.romGen === this.rom.gen) return;
    const d = this.rom.data, n = d.length >> PAGE_SHIFT;
    const changes = this.hashes.length === n * 2 ? this.rom.changesSince(this.romGen) : null;
    this.romGen = this.rom.gen;
    if (changes?.length === 0) return;
    const words = d.byteOffset & 3 ? new Uint32Array(d.slice().buffer, 0, d.length >> 2) : new Uint32Array(d.buffer, d.byteOffset, d.length >> 2);
    const h = changes ? this.hashes : new Uint32Array(n * 2);
    const per = 1 << (PAGE_SHIFT - 2);
    const hash = (p: number) => {
      let a = 0x811c9dc5, b = 0x2545f491;
      for (let i = p * per, e = i + per; i < e; i++) {
        const v = words[i];
        a = Math.imul(a ^ v, 0x01000193);
        b = Math.imul(b ^ v, 0x5bd1e995) ^ (b >>> 15);
      }
      h[p * 2] = a; h[p * 2 + 1] = b;
    };
    let count = 0, next = 0; // (ranges are sorted: a page shared by two is hashed once)
    if (!changes) for (; count < n; count++) hash(count);
    else for (const [start, end] of changes) {
      for (let p = Math.max(next, start >> PAGE_SHIFT), e = Math.min(n, ((end - 1) >> PAGE_SHIFT) + 1); p < e; p++, count++) hash(p);
      next = Math.max(next, ((end - 1) >> PAGE_SHIFT) + 1);
    }
    this.hashes = h;
    this.rehashed = count;
    this.gen++;
  }

  deps(r: RomReads): RomDeps {
    this.sync();
    const pages: number[] = [];
    for (let p = 0; p < r.pages.length; p++) if (r.pages[p]) pages.push(p);
    const d = { pages: Uint16Array.from(pages), bytes: Uint32Array.from(r.bytes).sort(), h1: 0, h2: 0 };
    [d.h1, d.h2] = this.combine(d);
    return d;
  }

  valid(d: RomDeps): boolean {
    this.sync();
    const n = this.hashes.length >> 1, len = this.rom.data.length;
    for (const p of d.pages) if (p >= n) return false;
    for (const o of d.bytes) if (o >= len) return false;
    const [h1, h2] = this.combine(d);
    return h1 === d.h1 && h2 === d.h2;
  }

  private combine(d: { pages: Uint16Array; bytes: Uint32Array }): [number, number] {
    const h = this.hashes, rom = this.rom.data;
    let a = 0x9e3779b9, b = 0x85ebca6b;
    for (const p of d.pages) {
      a = Math.imul(a ^ h[p * 2], 0x01000193) ^ p;
      b = Math.imul(b ^ h[p * 2 + 1], 0xc2b2ae35) ^ (b >>> 13);
    }
    for (const o of d.bytes) {
      a = Math.imul(a ^ rom[o] ^ (o << 8), 0x01000193);
      b = Math.imul(b ^ rom[o] ^ (o << 8), 0xc2b2ae35) ^ (b >>> 13);
    }
    return [a >>> 0, b >>> 0];
  }
}

export interface CacheEntry {
  deps: RomDeps;
  data: unknown;
  input?: string; // the hash of the result's input (inputs.ts), if it has one
}

// where an entry is stored: its key, with the input's hash; a key's inputs in the order last used under the key
// with an empty input (the inputs' hashes, '' for none; written when they change, not the entries)
export const storeKey = (key: string, input: string | undefined) => input === undefined ? key : `${key}#${input}`;
const orderKey = (key: string) => `${key}#`;
const keyOf = (stored: string, e: CacheEntry) => e.input === undefined ? stored : stored.slice(0, -e.input.length - 1);

// stored keys of earlier versions of a store whose keys start with its name and version ('rc' 4: 'rc3:…', 'rc2:…',
// 'rc:…'; not a later version's, kept for the editor that wrote it)
export function oldStoreKeys(keys: string[], name: string, version: number): string[] {
  return keys.filter((k) => {
    const v = k.startsWith(name) ? /^(\d*):/.exec(k.slice(name.length)) : null;
    return v !== null && Number(v[1]) < version;
  });
}

// results checked against the ROM's fingerprint (once per fingerprint generation)
export const byFingerprint = (fp: RomFingerprint): Validity<RomDeps> => ({ stamp: () => { fp.sync(); return fp.gen; }, holds: (d) => fp.valid(d) });

// results checked against the ROM edits since they were recorded (holds; recorded on an older generation: checked
// when first used)
export type Since = { gen: number; reads: RomReads };
export const bySince = (rom: Rom): Validity<Since> => ({ stamp: () => rom.gen, holds: (d) => holds(rom, d), current: (d) => d.gen === rom.gen });

// results that read no ROM byte: they always hold
export const always: Validity<null> = { stamp: () => 0, holds: () => true };

// The result cache: results by key and input kept while the bytes they read are unchanged (KeptResults, checked
// against the fingerprint), persisted: changed and dropped entries are collected for storing (see flush()). A key keeps
// the results of its latest used INPUTS_PER_KEY inputs, the least recently used one dropped (also from storage).
// what reading results takes of a result cache (a stored result by key)
export type ResultGet = Pick<ResultCache, 'get'>;

export class ResultCache {
  fp: RomFingerprint;
  private kept: KeptResults<RomDeps>;
  private dirty = new Map<string, [string, string | undefined]>(); // stored keys of changed results: their key and input
  private dropped = new Set<string>(); // stored keys of dropped results
  private reordered = new Set<string>(); // keys whose inputs' order changed
  onChange: (() => void) | null = null;

  constructor(fp: RomFingerprint) {
    this.fp = fp;
    const changed = () => this.onChange?.();
    this.kept = new KeptResults({
      validity: byFingerprint(fp),
      hooks: {
        put: (key, input) => { const k = storeKey(key, input); this.dropped.delete(k); this.dirty.set(k, [key, input]); changed(); },
        drop: (key, input) => { const k = storeKey(key, input); this.dirty.delete(k); this.dropped.add(k); changed(); },
        order: (key) => { this.reordered.add(key); changed(); },
      },
    });
  }

  get<T>(key: string, input?: string): T | undefined { return this.kept.get<T>(key, input); }

  // the entry under key for the input, if it holds for the current ROM
  entry(key: string, input?: string): CacheEntry | undefined {
    const e = this.kept.entry(key, input);
    return e && { deps: e.deps, data: e.data, input };
  }

  // (current: deps were hashed on the current ROM; else on an older one, and the result is checked when first used)
  set(key: string, data: unknown, deps: RomDeps, input?: string, current = true): void {
    this.kept.set(key, data, deps, input, current);
  }

  // drops the results of key, of all inputs (also from storage)
  delete(key: string): void { this.kept.delete(key); }

  // checks up to count results not checked against the current ROM yet (of any input, used or not) and drops those
  // that no longer hold, so storage loses them without them being asked for; false once all are checked. A changed
  // ROM starts again with the results not checked since.
  sweep(count: number): boolean { return this.kept.sweep(count); }

  // entries flushed by another cache (the probe worker's), by stored key; current: hashed on the current ROM (else
  // on an older one, whose bytes they read may have changed since)
  setAll(put: [string, CacheEntry][], current: boolean): void {
    for (const [k, e] of put) this.set(keyOf(k, e), e.data, e.deps, e.input, current);
  }

  // entries read from storage (checked when first used): results by stored key, and the keys' inputs' order
  load(entries: [string, CacheEntry | string[]][]): void {
    const order = new Map<string, string[]>(), loaded = new Map<string, CacheEntry[]>();
    for (const [k, e] of entries) {
      if (Array.isArray(e)) { order.set(k.slice(0, -1), e); continue; }
      const key = keyOf(k, e);
      let l = loaded.get(key);
      if (!l) loaded.set(key, (l = []));
      l.push(e);
    }
    for (const [key, l] of loaded) {
      const o = order.get(key) ?? [], rank = (e: CacheEntry) => { const r = o.indexOf(e.input ?? ''); return r < 0 ? o.length : r; };
      for (const e of l.sort((a, b) => rank(a) - rank(b))) {
        if (this.kept.setOlder(key, e.data, e.deps, e.input)) continue;
        this.dropped.add(storeKey(key, e.input)); // (beyond the inputs a key keeps)
        this.reordered.add(key);
      }
    }
  }

  // the entries of the keys starting with prefix, by stored key (also those not checked against the current ROM yet)
  under(prefix: string): [string, CacheEntry][] {
    const out: [string, CacheEntry][] = [];
    for (const [key, input, e] of this.kept.all()) if (key.startsWith(prefix)) out.push([storeKey(key, input), { deps: e.deps, data: e.data, input }]);
    return out;
  }

  // changed entries to store (with the changed orders of keys' inputs) and dropped ones to delete since the last call
  flush(): { put: [string, CacheEntry][]; order: [string, string[]][]; del: string[] } {
    const put: [string, CacheEntry][] = [], order: [string, string[]][] = [], del = [...this.dropped];
    for (const [k, [key, input]] of this.dirty) {
      const e = this.kept.peek(key, input);
      if (e) put.push([k, { deps: e.deps, data: e.data, input }]);
    }
    for (const key of this.reordered) {
      const inputs = this.kept.inputs(key);
      if (inputs.some((i) => i !== undefined)) order.push([orderKey(key), inputs.map((i) => i ?? '')]);
      else del.push(orderKey(key));
    }
    this.dirty.clear();
    this.dropped.clear();
    this.reordered.clear();
    return { put, order, del };
  }
}
