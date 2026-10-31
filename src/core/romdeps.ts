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
// read its bytes.

import type { Rom } from './rom.ts';
import { snesToPc, type RomRange } from './rom.ts';
import { editorPatch, customPalettePatch, bgPatch, GFX_FILES } from './patches.ts';
import { exanimDataRanges } from './exanim.ts';
import { overworldDataRanges } from './overworld.ts';
import { levelDataRanges } from './level.ts';

export const PAGE_SHIFT = 8;

export interface RomDeps {
  pages: Uint16Array; // indices of the pages read
  bytes: Uint32Array; // single bytes read (in byte pages)
  h1: number; // fingerprint of their contents
  h2: number;
}

// pages whose reads are recorded by byte
export const BYTE_PAGES = new Uint8Array(0x10000);
BYTE_PAGES.fill(1, 0x2e000 >> PAGE_SHIFT, 0x30000 >> PAGE_SHIFT);
BYTE_PAGES[0x7f00 >> PAGE_SHIFT] = 1;
const FIXED_BYTE_PAGES = BYTE_PAGES.slice();

// adds the byte pages of this ROM's editor patch tables, its level palettes' pointers, its free space blocks' edges,
// ExAnimation data, overworld data and level data (call when the ROM may have changed); the GFX file pointers and the
// ExAnimation data aren't recorded at all (see gfxSkipMask), byte pages keep the rest of their pages from counting
// them (an animation list next to code that is run)
export function updateBytePages(rom: Rom): void {
  BYTE_PAGES.set(FIXED_BYTE_PAGES);
  const reads = rom.reads;
  rom.reads = null;
  try {
    const markPc = (o: number, end: number) => BYTE_PAGES.fill(1, o >> PAGE_SHIFT, ((end - 1) >> PAGE_SHIFT) + 1);
    for (const [a, b] of exanimDataRanges(rom)) markPc(a, b);
    for (const [a, b] of overworldDataRanges(rom)) markPc(a, b);
    // the pages a block in free space shares with the free space around it, which a save fills (code and tables
    // every level reads next to a level's data)
    for (const b of rom.scanRats()) { markPc(b.start, b.start + 1); markPc(b.start + 7 + b.size, b.start + 8 + b.size); }
    const p = editorPatch(rom);
    if (!p) return;
    // (after the patch's check: where a level's sprite data lies needs its sprite bank table)
    for (const [a, b] of levelDataRanges(rom)) markPc(a, b);
    const mark = (snes: number, len: number) => { const o = snesToPc(snes); markPc(o, o + len); };
    mark(p.gfxLo, GFX_FILES); mark(p.gfxHi, GFX_FILES); mark(p.gfxBank, GFX_FILES); mark(p.gfxFlags, GFX_FILES);
    mark(p.levelGfx, 0x200 * 8); mark(p.levelGfxHi, 0x200 * 8);
    mark(p.sprBank, 0x200);
    const pal = customPalettePatch(rom);
    if (pal) mark(pal.table, 0x200 * 3);
    const bg = bgPatch(rom);
    if (bg) mark(bg.table, 0x200);
  } finally { rom.reads = reads; }
}

// what a computation read (the emulated CPU and editor code, see Snes.romReads, Rom.reads)
export class RomReads {
  pages: Uint8Array; // 1 = read
  bytes = new Set<number>();

  constructor(romSize: number, base?: RomReads | null) {
    this.pages = new Uint8Array(romSize >> PAGE_SHIFT);
    if (base) this.add(base);
  }

  read(o: number, len = 1): void {
    for (let i = o; i < o + len; i++) {
      const p = i >> PAGE_SHIFT;
      if (BYTE_PAGES[p]) this.bytes.add(i);
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

  add(r: RomReads): void {
    const n = Math.min(this.pages.length, r.pages.length);
    for (let p = 0; p < n; p++) this.pages[p] |= r.pages[p];
    for (const b of r.bytes) this.bytes.add(b);
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

export const INPUTS_PER_KEY = 4; // inputs a key keeps results for (the latest used)

// where an entry is stored: its key, with the input's hash; a key's inputs in the order last used under the key
// with an empty input (the inputs' hashes, '' for none; written when they change, not the entries)
const storeKey = (key: string, input: string | undefined) => input === undefined ? key : `${key}#${input}`;
const orderKey = (key: string) => `${key}#`;
const keyOf = (stored: string, e: CacheEntry) => e.input === undefined ? stored : stored.slice(0, -e.input.length - 1);

type Slot = CacheEntry & { gen: number };

// results by key, checked against the ROM once per fingerprint generation; changed and dropped
// entries are collected for storing (see flush()). A result with an input holds for that input only; a key
// keeps the results of its latest used INPUTS_PER_KEY inputs (switching between levels whose sprite memory differs
// doesn't learn their sprite images again), the least recently used one dropped.
export class ResultCache {
  fp: RomFingerprint;
  private entries = new Map<string, Slot[]>(); // a key's results, the latest used first
  private dirty = new Map<string, string>(); // stored keys of changed results: their key
  private dropped = new Set<string>(); // stored keys of dropped results
  private reordered = new Set<string>(); // keys whose inputs' order changed
  onChange: (() => void) | null = null;

  constructor(fp: RomFingerprint) {
    this.fp = fp;
  }

  get<T>(key: string, input?: string): T | undefined {
    const slots = this.entries.get(key), i = slots?.findIndex((e) => e.input === input) ?? -1;
    if (i < 0) return undefined;
    const e = slots![i];
    this.fp.sync();
    if (e.gen !== this.fp.gen) {
      if (!this.fp.valid(e.deps)) {
        this.remove(key, slots!, i);
        this.onChange?.();
        return undefined;
      }
      e.gen = this.fp.gen;
    }
    if (i > 0) {
      slots!.splice(i, 1);
      slots!.unshift(e);
      this.reordered.add(key);
      this.onChange?.();
    }
    return e.data as T;
  }

  // the entry under key for the input, if it holds for the current ROM
  entry(key: string, input?: string): CacheEntry | undefined {
    if (this.get(key, input) === undefined) return undefined;
    const e = this.entries.get(key)![0];
    return { deps: e.deps, data: e.data, input: e.input };
  }

  set(key: string, data: unknown, deps: RomDeps, input?: string): void {
    let slots = this.entries.get(key);
    if (!slots) this.entries.set(key, (slots = []));
    const i = slots.findIndex((e) => e.input === input);
    if (i >= 0) slots.splice(i, 1);
    slots.unshift({ deps, data, input, gen: this.fp.gen });
    const k = storeKey(key, input);
    this.dropped.delete(k);
    this.dirty.set(k, key);
    if (slots.length > 1 || input !== undefined) this.reordered.add(key);
    while (slots.length > INPUTS_PER_KEY) this.remove(key, slots, slots.length - 1);
    this.onChange?.();
  }

  // entries flushed by another cache (the probe worker's), by stored key
  setAll(put: [string, CacheEntry][]): void {
    for (const [k, e] of put) this.set(keyOf(k, e), e.data, e.deps, e.input);
  }

  private remove(key: string, slots: Slot[], i: number): void {
    const input = slots[i].input, k = storeKey(key, input);
    slots.splice(i, 1);
    if (!slots.length) this.entries.delete(key);
    this.dirty.delete(k);
    this.dropped.add(k);
    if (input !== undefined || slots.length) this.reordered.add(key);
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
      let slots = this.entries.get(key);
      if (!slots) this.entries.set(key, (slots = []));
      for (const e of l.sort((a, b) => rank(a) - rank(b))) if (!slots.some((s) => s.input === e.input)) slots.push({ ...e, gen: -1 });
      while (slots.length > INPUTS_PER_KEY) this.remove(key, slots, slots.length - 1);
    }
  }

  // changed entries to store (with the changed orders of keys' inputs) and dropped ones to delete since the last call
  flush(): { put: [string, CacheEntry][]; order: [string, string[]][]; del: string[] } {
    const put: [string, CacheEntry][] = [], order: [string, string[]][] = [], del = [...this.dropped];
    for (const [k, key] of this.dirty) {
      const e = this.entries.get(key)?.find((s) => storeKey(key, s.input) === k);
      if (e) put.push([k, { deps: e.deps, data: e.data, input: e.input }]);
    }
    for (const key of this.reordered) {
      const slots = this.entries.get(key);
      if (slots?.some((s) => s.input !== undefined)) order.push([orderKey(key), slots.map((s) => s.input ?? '')]);
      else del.push(orderKey(key));
    }
    this.dirty.clear();
    this.dropped.clear();
    this.reordered.clear();
    return { put, order, del };
  }
}
