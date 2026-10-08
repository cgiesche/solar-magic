// The sections of a package record (pkgreg.ts), one adapter each: patches, UberASM, blocks, sprites
// (PIXI), ExGFX files, songs, FG and BG Map16 tiles – the fields of PackageParts, as stored in the ROM.
// An adapter knows what of the ROM its section observes (read), what came in between two reads
// (added), how that goes into a record (merge) and when there is nothing (empty). pkgreg.ts loops over
// them instead of naming each section.

import type { Rom } from './rom.ts';
import { listPatches, hashBytes } from './patchreg.ts';
import { loadProject } from './uberproject.ts';
import { loadBlockProject } from './blocks.ts';
import { loadPixiProject } from './pixi.ts';
import { gfxEntry, VANILLA_GFX } from './patches.ts';
import { loadMusicProject } from './music.ts';
import { EXT_FIRST, EXT_TILES, map16Ext, extTileWords, actsLike } from './map16ext.ts';
import { BG_EXT_FIRST, BG_EXT_TILES, bgMap16Ext, bgExtTileWords } from './bgmap16.ts';
import type { UberContext } from './uberasm.ts';
import type { SpriteFolder } from './pixirt.ts';
import type { PackageParts } from './pkgreg.ts';

const CONTEXTS: UberContext[] = ['level', 'gamemode', 'overworld'];
export const OTHER = ['global', 'statusbar', 'macrolib'] as const;
export type Other = (typeof OTHER)[number];

// S: what the section observes of the ROM, P: its field in the record
export interface PartSection<S, P> {
  none(): P; // nothing (also for records from before the section existed)
  read(rom: Rom): S;
  added(a: S, b: S): P; // what came in from a to b
  merge(rec: P, p: P, now: S): P; // the record's section with more
  empty(p: P): boolean;
}

// list.txt is written from the assignments, which are compared on their own
const hashes = (files: Map<string, Uint8Array> | undefined) => new Map([...(files ?? [])].filter(([f]) => f !== 'list.txt').map(([f, c]) => [f, hashBytes([c])]));
const changedFiles = (a: Map<string, number>, b: Map<string, number>) => [...b].filter(([f, h]) => a.get(f) !== h).map(([f]) => f);
const tryLoad = <T>(load: () => T | null): T | null => { try { return load(); } catch { return null; } };
const union = <T>(a: T[], b: T[], key: (x: T) => string = String) => {
  const seen = new Set(a.map(key));
  return [...a, ...b.filter((x) => !seen.has(key(x)))];
};

// a list of numbers or names: what is new in b
function listSection<T>(read: (rom: Rom) => T[], key: (x: T) => string = String): PartSection<T[], T[]> {
  return {
    none: () => [],
    read,
    added: (a, b) => { const had = new Set(a.map(key)); return b.filter((x) => !had.has(key(x))); },
    merge: (r, p) => union(r, p, key),
    empty: (p) => !p.length,
  };
}

// tiles that differ between two reads; when the table came in, the ones not holding its fill (the
// tile most of them hold)
function changedTiles(a: string[], b: string[], first: number): number[] {
  let base = a;
  if (!a.length && b.length) {
    const n = new Map<string, number>();
    for (const v of b) n.set(v, (n.get(v) ?? 0) + 1);
    const fill = [...n].reduce((m, e) => (e[1] > m[1] ? e : m))[0];
    base = b.map(() => fill);
  }
  return b.flatMap((v, i) => (v !== base[i] ? [first + i] : []));
}

// extended Map16 tiles it filled (read: each tile's content, [] while the table is not installed)
function tileSection(read: (rom: Rom) => string[], first: number): PartSection<string[], number[]> {
  return {
    none: () => [],
    read,
    added: (a, b) => changedTiles(a, b, first),
    merge: (r, p) => union(r, p),
    empty: (p) => !p.length,
  };
}

// its Asar patches (ids in the patch registry); a patch applied anew gets a new id: ids no longer in
// the ROM are dropped
const patches: PartSection<string[], string[]> = {
  ...listSection((rom) => listPatches(rom).filter((p) => !p.kind || p.kind === 'patch').map((p) => p.id)),
  merge: (r, p, now) => union(r.filter((id) => now.includes(id)), p),
};

type UberPart = PackageParts['uber'];
interface UberRead { files: Map<string, number>; calls: Set<string>; other: Partial<Record<Other, string>> }
// UberASM files (with their content), calls (ctx:num:file) and the other list.txt entries
const uber: PartSection<UberRead, UberPart> = {
  none: () => ({ files: [], calls: [], other: {} }),
  read(rom) {
    const p = tryLoad(() => loadProject(rom));
    const calls = new Set<string>();
    for (const ctx of CONTEXTS) for (const [num, cs] of p?.list[ctx] ?? []) for (const c of cs) calls.add(`${ctx}:${num}:${c.file}`);
    const other: Partial<Record<Other, string>> = {};
    for (const k of OTHER) { const v = p?.list[k]; if (v) other[k] = v; }
    return { files: hashes(p?.files), calls, other };
  },
  added(a, b) {
    const other: Partial<Record<Other, string>> = {};
    for (const k of OTHER) if (b.other[k] && b.other[k] !== a.other[k]) other[k] = b.other[k];
    return {
      files: changedFiles(a.files, b.files),
      calls: [...b.calls].filter((c) => !a.calls.has(c)).map((c) => { const [ctx, num, ...f] = c.split(':'); return [ctx as UberContext, Number(num), f.join(':')]; }),
      other,
    };
  },
  merge: (r, p) => ({ files: union(r.files, p.files), calls: union(r.calls, p.calls, (c) => c.join(':')), other: { ...r.other, ...p.other } }),
  empty: (p) => !p.files.length && !p.calls.length && !Object.keys(p.other).length,
};

type BlocksPart = PackageParts['blocks'];
// block files and the Map16 tiles they are on (tile → file)
const blocks: PartSection<{ files: Map<string, number>; tiles: Map<number, string> }, BlocksPart> = {
  none: () => ({ files: [], tiles: [] }),
  read(rom) {
    const p = tryLoad(() => loadBlockProject(rom));
    return { files: hashes(p?.files), tiles: new Map((p?.list ?? []).map((b) => [b.tile, b.file])) };
  },
  added: (a, b) => ({ files: changedFiles(a.files, b.files), tiles: [...b.tiles].filter(([t, f]) => a.tiles.get(t) !== f).map(([t]) => t) }),
  merge: (r, p) => ({ files: union(r.files, p.files), tiles: union(r.tiles, p.tiles) }),
  empty: (p) => !p.files.length && !p.tiles.length,
};

type PixiPart = PackageParts['pixi'];
// sprite files and the list entries (kind:num → file)
const pixi: PartSection<{ files: Map<string, number>; sprites: Map<string, string> }, PixiPart> = {
  none: () => ({ files: [], list: [] }),
  read(rom) {
    const p = tryLoad(() => loadPixiProject(rom));
    return { files: hashes(p?.files), sprites: new Map((p?.list ?? []).map((e) => [`${e.kind}:${e.num}`, e.file])) };
  },
  added: (a, b) => ({
    files: changedFiles(a.files, b.files),
    list: [...b.sprites].filter(([k, f]) => a.sprites.get(k) !== f).map(([k]) => { const [kind, num] = k.split(':'); return [kind as SpriteFolder, Number(num)]; }),
  }),
  merge: (r, p) => ({ files: union(r.files, p.files), list: union(r.list, p.list, (e) => e.join(':')) }),
  empty: (p) => !p.files.length && !p.list.length,
};

// ExGFX files it created (read: the file's address per number, 0 = none)
const gfx: PartSection<number[], number[]> = {
  none: () => [],
  read: (rom) => Array.from({ length: 0x100 }, (_, i) => (i >= VANILLA_GFX ? gfxEntry(rom, i)?.addr ?? 0 : 0)),
  added: (a, b) => b.flatMap((addr, i) => (addr && !a[i] ? [i] : [])),
  merge: (r, p) => union(r, p),
  empty: (p) => !p.length,
};

// songs it added to the music project (their .txt)
const music = listSection((rom) => (tryLoad(() => loadMusicProject(rom))?.songs ?? []).map((s) => s.file));

const map16 = tileSection((rom) => (map16Ext(rom) ? Array.from({ length: EXT_TILES - EXT_FIRST }, (_, i) => `${extTileWords(rom, EXT_FIRST + i)!.join()}:${actsLike(rom, EXT_FIRST + i)}`) : []), EXT_FIRST);
const bgMap16 = tileSection((rom) => (bgMap16Ext(rom) ? Array.from({ length: BG_EXT_TILES - BG_EXT_FIRST }, (_, i) => bgExtTileWords(rom, BG_EXT_FIRST + i)!.join()) : []), BG_EXT_FIRST);

// every field of PackageParts has its adapter (the compiler checks it)
type Sections = { [K in keyof PackageParts]-?: PartSection<any, NonNullable<PackageParts[K]>> };
export const SECTIONS = { music, pixi, blocks, uber, patches, map16, bgMap16, gfx } satisfies Sections;
export type SectionKey = keyof typeof SECTIONS;
export const SECTION_KEYS = Object.keys(SECTIONS) as SectionKey[];
