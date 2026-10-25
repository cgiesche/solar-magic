// The sections of a package record (pkgreg.ts), one adapter each: patches, UberASM, blocks, sprites,
// ExGFX files, songs, FG and BG Map16 tiles, shared palette colors – the fields of PackageParts, as stored in the ROM (the tool
// projects under their part kind: uberasm, block, sprite). An adapter knows what of the ROM its section
// observes (read), what came in between two reads (added), how that goes into a record (merge), when
// there is nothing (empty), how to take it out of the ROM again (remove) and how to say so (summary,
// removal). pkgreg.ts loops over them instead of naming each section; the order of SECTIONS is the
// order of removing (songs first: AddmusicK runs again; patches applied later first). The part adapters
// of installing are in pkgparts.ts.

import type { Rom } from './rom.ts';
import { listPatches, hashBytes } from './patchreg.ts';
import { uninstallPatch } from './patchapply.ts';
import { loadProject, saveProject, emptyProject, type UberProject } from './uberproject.ts';
import { loadBlockProject, saveBlockProject, type BlockProject } from './blocks.ts';
import { loadPixiProject, savePixiProject, type PixiProject } from './pixi.ts';
import { hex } from './names.ts';
import { removeGfx } from './gfxfiles.ts';
import { gfxEntry, gfxHex, GFX_FILES, VANILLA_GFX, levelMusic, setLevelMusic } from './patches.ts';
import { loadMusicProject, saveMusicProject, removeSong } from './music.ts';
import { EXT_FIRST, EXT_TILES, DEFAULT_ACTS, extTileWords, actsLike, setExtTileWords, setActsLike } from './map16ext.ts';
import { BG_EXT_FIRST, BG_EXT_TILES, bgExtTileWords, setBgExtTileWords, vanillaBgWords } from './bgmap16.ts';
import type { UberContext } from './uberasm.ts';
import type { SpriteFolder } from './pixirt.ts';
import type { PackageParts } from './pkgreg.ts';
import { sharedColors, setSharedColor, sharedColorNames } from './sharedpal.ts';

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
  // takes the package's section (mine, not empty) out of the ROM; what other packages brought as well
  // (others: their sections) stays. Returns warnings, throws when it fails.
  remove(rom: Rom, mine: P, others: P[], blank: number[]): string[] | Promise<string[]>;
  summary(p: P): string | null; // in a few words ("2 blocks"), null when empty
  removal(p: P): string | null; // what removing takes out ("block(s) at 200, 201"), null when empty
}

const count = (n: number, one: string, many: string) => (!n ? null : n > 1 ? `${n} ${many}` : one);

// sections of tool projects also tell which entries of the project are the package's (the Packages
// dialog shows them; removing takes them out)
interface Owns { owned(mine: never, project: never): unknown[] }

const check = (r: { ok: boolean; errors: string[]; warnings: string[] }, what: string): string[] => {
  if (!r.ok) throw new Error(`${what}: ${r.errors.join(' ')}`);
  return r.warnings;
};

// list.txt is written from the assignments, which are compared on their own
const hashes = (files: Map<string, Uint8Array> | undefined) => new Map([...(files ?? [])].filter(([f]) => f !== 'list.txt').map(([f, c]) => [f, hashBytes([c])]));
const changedFiles = (a: Map<string, number>, b: Map<string, number>) => [...b].filter(([f, h]) => a.get(f) !== h).map(([f]) => f);
const tryLoad = <T>(load: () => T | null): T | null => { try { return load(); } catch { return null; } };
const union = <T>(a: T[], b: T[], key: (x: T) => string = String) => {
  const seen = new Set(a.map(key));
  return [...a, ...b.filter((x) => !seen.has(key(x)))];
};

// a list of numbers or names: what is new in b
function listSection<T>(read: (rom: Rom) => T[], remove: PartSection<T[], T[]>['remove'], summary: PartSection<T[], T[]>['summary'], removal: PartSection<T[], T[]>['removal'], key: (x: T) => string = String): PartSection<T[], T[]> {
  return {
    summary,
    removal,
    none: () => [],
    read,
    remove,
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
function tileSection(label: string, read: (rom: Rom) => string[], first: number, remove: PartSection<string[], number[]>['remove']): PartSection<string[], number[]> {
  return {
    summary: (p) => (p.length ? 'Map16 tiles' : null),
    removal: (p) => (p.length ? `${p.length} ${label} tile(s)` : null),
    none: () => [],
    read,
    remove,
    added: (a, b) => changedTiles(a, b, first),
    merge: (r, p) => union(r, p),
    empty: (p) => !p.length,
  };
}

// its Asar patches (ids in the patch registry); a patch applied anew gets a new id: ids no longer in
// the ROM are dropped
const patches: PartSection<string[], string[]> = {
  ...listSection((rom) => listPatches(rom).filter((p) => !p.kind || p.kind === 'patch').map((p) => p.id), (rom, mine) => {
    const order = listPatches(rom).map((p) => p.id);
    return mine.filter((x) => order.includes(x)).sort((a, b) => order.indexOf(b) - order.indexOf(a)).flatMap((id) => uninstallPatch(rom, id));
  }, (p) => count(p.length, 'Patch', 'patches'), (p) => (!p.length ? null : p.length > 1 ? `${p.length} patches` : 'the patch')),
  merge: (r, p, now) => union(r.filter((id) => now.includes(id)), p),
};

type UberPart = PackageParts['uberasm'];
interface UberRead { files: Map<string, number>; calls: Set<string>; other: Partial<Record<Other, string>> }
// UberASM files (with their content), calls (ctx:num:file) and the other list.txt entries
export const uberasm = {
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
  summary: (p) => (p.files.length || p.calls.length ? 'UberASM' : null),
  removal: (p) => (p.files.length ? `${p.files.length} UberASM file(s) with their assignments` : null),
  // its calls still in the project
  owned: (mine: UberPart, p: UberProject) => mine.calls.filter(([ctx, num, file]) => p.list[ctx].get(num)?.some((c) => c.file === file)),
  remove(rom, mine, others) {
    const p = loadProject(rom) ?? emptyProject();
    for (const [ctx, num, file] of mine.calls) {
      const cs = p.list[ctx].get(num)?.filter((c) => c.file !== file);
      if (cs?.length) p.list[ctx].set(num, cs); else p.list[ctx].delete(num);
    }
    for (const k of OTHER) if (mine.other[k] && p.list[k] === mine.other[k]) p.list[k] = null;
    for (const f of mine.files) if (!others.some((o) => o.files.includes(f))) p.files.delete(f);
    // calls to its files made by hand (another level, all levels) go with the files
    for (const ctx of CONTEXTS) for (const [num, cs] of p.list[ctx]) {
      const kept = cs.filter((c) => p.files.has(c.file) || !mine.files.includes(c.file));
      if (kept.length) p.list[ctx].set(num, kept); else p.list[ctx].delete(num);
    }
    return check(saveProject(rom, p), 'UberASM');
  },
} satisfies PartSection<UberRead, UberPart> & Owns;

type BlocksPart = PackageParts['block'];
// block files and the Map16 tiles they are on (tile → file)
export const block = {
  none: () => ({ files: [], tiles: [] }),
  read(rom) {
    const p = tryLoad(() => loadBlockProject(rom));
    return { files: hashes(p?.files), tiles: new Map((p?.list ?? []).map((b) => [b.tile, b.file])) };
  },
  added: (a, b) => ({ files: changedFiles(a.files, b.files), tiles: [...b.tiles].filter(([t, f]) => a.tiles.get(t) !== f).map(([t]) => t) }),
  merge: (r, p) => ({ files: union(r.files, p.files), tiles: union(r.tiles, p.tiles) }),
  empty: (p) => !p.files.length && !p.tiles.length,
  summary: (p) => count(p.tiles.length, 'Block', 'blocks'),
  removal: (p) => (p.tiles.length ? `block(s) at ${p.tiles.map((t) => hex(t, 3)).join(', ')}` : null),
  // its blocks in the project: on one of its tiles with one of its files
  owned: (mine: BlocksPart, p: BlockProject) => p.list.filter((b) => mine.tiles.includes(b.tile) && mine.files.includes(b.file)),
  remove(rom, mine, others, blank) {
    const p = loadBlockProject(rom);
    if (!p) return [];
    const own = new Set(block.owned(mine, p));
    p.list = p.list.filter((b) => !own.has(b));
    for (const f of mine.files) if (!others.some((o) => o.files.includes(f))) p.files.delete(f);
    return check(saveBlockProject(rom, p), 'Custom Blocks');
  },
} satisfies PartSection<{ files: Map<string, number>; tiles: Map<number, string> }, BlocksPart> & Owns;

type SpritePart = PackageParts['sprite'];
// sprite files and the list entries (kind:num → file)
export const sprite = {
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
  summary: (p) => count(p.list.length, 'Sprite', 'sprites'),
  removal: (p) => (p.list.length ? `sprite(s) ${p.list.map(([, n]) => hex(n, 2)).join(', ')}` : null),
  // its sprites in the project: one of its kind/number entries with one of its files
  owned(mine: SpritePart, p: PixiProject) {
    const keys = new Set(mine.list.map((e) => e.join(':')));
    return p.list.filter((e) => keys.has(`${e.kind}:${e.num}`) && mine.files.includes(e.file));
  },
  remove(rom, mine, others) {
    const p = loadPixiProject(rom);
    if (!p) return [];
    const own = new Set(sprite.owned(mine, p));
    p.list = p.list.filter((e) => !own.has(e));
    for (const f of mine.files) if (!others.some((o) => o.files.includes(f))) p.files.delete(f);
    return check(savePixiProject(rom, p), 'Custom Sprites');
  },
} satisfies PartSection<{ files: Map<string, number>; sprites: Map<string, string> }, SpritePart> & Owns;

// ExGFX files it created (read: the file's address per number, 0 = none)
const gfx: PartSection<number[], number[]> = {
  none: () => [],
  read: (rom) => Array.from({ length: GFX_FILES }, (_, i) => (i >= VANILLA_GFX ? gfxEntry(rom, i)?.addr ?? 0 : 0)),
  added: (a, b) => b.flatMap((addr, i) => (addr && !a[i] ? [i] : [])),
  merge: (r, p) => union(r, p),
  empty: (p) => !p.length,
  summary: (p) => (p.length ? 'ExGFX' : null),
  removal: (p) => (p.length ? p.map((n) => `ExGFX${gfxHex(n)}`).join(', ') : null),
  remove(rom, mine) {
    for (const n of mine) if (n >= VANILLA_GFX) removeGfx(rom, n);
    return [];
  },
};

// songs it added to the music project (their .txt)
// (AddmusicK inserts the rest again; levels set to a removed song get their header music back)
const music = listSection((rom) => (tryLoad(() => loadMusicProject(rom))?.songs ?? []).map((s) => s.file), async (rom, mine) => {
  const p = loadMusicProject(rom);
  if (!p) return [];
  const nums = p.songs.filter((s) => mine.includes(s.file)).map((s) => s.num);
  for (const n of nums) removeSong(p, n);
  const r = await saveMusicProject(rom, p);
  if (!r.ok) throw new Error(`Music: ${r.errors.join(' ')}`);
  for (let l = 0; l < 0x200; l++) if (nums.includes(levelMusic(rom, l)) && !p.songs.some((s) => s.num === levelMusic(rom, l))) setLevelMusic(rom, l, 0);
  return r.warnings;
}, (p) => count(p.length, 'Song', 'songs'), (p) => (!p.length ? null : `${p.length > 1 ? 'songs' : 'the song'} (AddmusicK inserts the music again)`));

// emptied again, unless another package filled them too
const map16 = tileSection('FG Map16', (rom) => Array.from({ length: EXT_TILES - EXT_FIRST }, (_, i) => `${extTileWords(rom, EXT_FIRST + i)!.join()}:${actsLike(rom, EXT_FIRST + i)}`), EXT_FIRST,
  (rom, mine, others, blank) => {
    for (const t of mine) if (!others.some((o) => o.includes(t))) { setExtTileWords(rom, t, blank); setActsLike(rom, t, DEFAULT_ACTS); }
    return [];
  });
const bgMap16 = tileSection('BG Map16', (rom) => Array.from({ length: BG_EXT_TILES - BG_EXT_FIRST }, (_, i) => bgExtTileWords(rom, BG_EXT_FIRST + i)!.join()), BG_EXT_FIRST,
  (rom, mine, others) => {
    const fill = vanillaBgWords(rom, 0x025);
    for (const t of mine) if (!others.some((o) => o.includes(t))) setBgExtTileWords(rom, t, fill);
    return [];
  });

// shared palette colors it changed, with the color each had before: set back to it (two packages never
// change the same color, see pkgplan.ts applyGraphics)
const sharedPal: PartSection<number[], [number, number][]> = {
  none: () => [],
  read: sharedColors,
  added: (a, b) => b.flatMap((c, i): [number, number][] => (c !== a[i] ? [[i, a[i]]] : [])),
  merge: (r, p) => union(r, p, ([i]) => String(i)),
  empty: (p) => !p.length,
  summary: (p) => (p.length ? 'Shared palettes' : null),
  removal: (p) => (p.length ? `shared palette colors (${sharedColorNames(p.map(([i]) => i)).join('; ')}), set back` : null),
  remove(rom, mine) {
    for (const [i, c] of mine) setSharedColor(rom, i, c);
    return [];
  },
};

// every field of PackageParts has its adapter (the compiler checks it)
type Sections = { [K in keyof PackageParts]-?: PartSection<any, NonNullable<PackageParts[K]>> };
export const SECTIONS = { music, sprite, block, uberasm, patches, map16, bgMap16, gfx, sharedPal } satisfies Sections;
export type SectionKey = keyof typeof SECTIONS;
export const SECTION_KEYS = Object.keys(SECTIONS) as SectionKey[];
