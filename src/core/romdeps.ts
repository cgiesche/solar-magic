// Results found out by emulation (block/sprite probes, captured sprite images) depend on the ROM
// bytes the emulated code read. The emulator marks the 256-byte ROM pages it reads; a result keeps
// the list of pages and a fingerprint of their contents, and stays valid while they are unchanged.
// So a change to the ROM (a saved level, a patch, an edited palette) only drops the results that
// read the changed pages, and results can be stored across sessions (and ROMs: the key only says
// what was computed, the fingerprint whether it still holds).
// The level tables (pointers, secondary headers: $05E000-$05FFFF) hold a few bytes of every level
// in each page, the ROM header page ($00FF00) the checksum next to the vectors; there single bytes
// are recorded, so saving a level (another one, or fixing the checksum) doesn't drop anything.
// The same for the editor patch's tables (GFX file pointers, per-level GFX and sprite bank): a new
// ExGFX file or another level's GFX setting only drops what read that entry. The same for the
// pages holding ExAnimation data.

import type { Rom } from './rom.ts';
import { snesToPc } from './rom.ts';
import { editorPatch, an2DataRanges } from './patches.ts';
import { exanimDataRanges } from './exanim.ts';

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

// adds the byte pages of this ROM's editor patch tables and ExAnimation data (call when the ROM
// may have changed); the ExAnimation data isn't recorded at all (see gfxSkipMask), byte pages keep
// the rest of their pages from counting it (an animation list next to code that is run)
export function updateBytePages(rom: Rom): void {
  BYTE_PAGES.set(FIXED_BYTE_PAGES);
  const reads = rom.reads;
  rom.reads = null;
  try {
    const markPc = (o: number, end: number) => BYTE_PAGES.fill(1, o >> PAGE_SHIFT, ((end - 1) >> PAGE_SHIFT) + 1);
    for (const [a, b] of [...exanimDataRanges(rom), ...an2DataRanges(rom)]) markPc(a, b);
    const p = editorPatch(rom);
    if (!p) return;
    const mark = (snes: number, len: number) => { const o = snesToPc(snes); markPc(o, o + len); };
    mark(p.gfxLo, 0x100); mark(p.gfxHi, 0x100); mark(p.gfxBank, 0x100); mark(p.gfxFlags, 0x100);
    mark(p.levelGfx, 0x200 * 8);
    mark(p.sprBank, 0x200);
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

  add(r: RomReads): void {
    const n = Math.min(this.pages.length, r.pages.length);
    for (let p = 0; p < n; p++) this.pages[p] |= r.pages[p];
    for (const b of r.bytes) this.bytes.add(b);
  }
}

// hashes of all pages of the current ROM, recomputed when the ROM's generation changes
export class RomFingerprint {
  gen = 0; // counts recomputations; cached validity checks are redone when it changes
  private rom: Rom;
  private romGen = -1;
  private hashes = new Uint32Array(0);

  constructor(rom: Rom) {
    this.rom = rom;
  }

  sync(): void {
    if (this.romGen === this.rom.gen) return;
    this.romGen = this.rom.gen;
    const d = this.rom.data, n = d.length >> PAGE_SHIFT;
    const words = d.byteOffset & 3 ? new Uint32Array(d.slice().buffer, 0, d.length >> 2) : new Uint32Array(d.buffer, d.byteOffset, d.length >> 2);
    const h = new Uint32Array(n * 2);
    const per = 1 << (PAGE_SHIFT - 2);
    for (let p = 0; p < n; p++) {
      let a = 0x811c9dc5, b = 0x2545f491;
      for (let i = p * per, e = i + per; i < e; i++) {
        const v = words[i];
        a = Math.imul(a ^ v, 0x01000193);
        b = Math.imul(b ^ v, 0x5bd1e995) ^ (b >>> 15);
      }
      h[p * 2] = a; h[p * 2 + 1] = b;
    }
    this.hashes = h;
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
}

// results by key, checked against the ROM once per fingerprint generation; changed and dropped
// keys are collected for storing (see flush())
export class ResultCache {
  fp: RomFingerprint;
  private entries = new Map<string, CacheEntry & { gen: number }>();
  dirty = new Set<string>();
  dropped = new Set<string>();
  onChange: (() => void) | null = null;

  constructor(fp: RomFingerprint) {
    this.fp = fp;
  }

  get<T>(key: string): T | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    this.fp.sync();
    if (e.gen !== this.fp.gen) {
      if (!this.fp.valid(e.deps)) {
        this.entries.delete(key);
        this.dirty.delete(key);
        this.dropped.add(key);
        this.onChange?.();
        return undefined;
      }
      e.gen = this.fp.gen;
    }
    return e.data as T;
  }

  // the entry under key, if it holds for the current ROM
  entry(key: string): CacheEntry | undefined {
    if (this.get(key) === undefined) return undefined;
    const e = this.entries.get(key)!;
    return { deps: e.deps, data: e.data };
  }

  set(key: string, data: unknown, deps: RomDeps): void {
    this.entries.set(key, { deps, data, gen: this.fp.gen });
    this.dropped.delete(key);
    this.dirty.add(key);
    this.onChange?.();
  }

  // entries read from storage (checked when first used)
  load(entries: [string, CacheEntry][]): void {
    for (const [k, e] of entries) if (!this.entries.has(k)) this.entries.set(k, { ...e, gen: -1 });
  }

  // changed entries to store and dropped keys to delete since the last call
  flush(): { put: [string, CacheEntry][]; del: string[] } {
    const put: [string, CacheEntry][] = [];
    for (const k of this.dirty) { const e = this.entries.get(k); if (e) put.push([k, { deps: e.deps, data: e.data }]); }
    const del = [...this.dropped];
    this.dirty.clear();
    this.dropped.clear();
    return { put, del };
  }
}
