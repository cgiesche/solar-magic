// Installed packages ("SMWK"): what each added download put into the ROM – its Asar patches, files and
// list.txt entries of the UberASM, block and PIXI projects, ExGFX files – so a package can be looked at,
// configured and removed as one. Not declared by the add dialogs but observed: the ROM's projects are
// compared before and after a package (or a part of it) was added. Kept in the ROM like the patch
// registry: a RATS block holding "SMWK", a version byte and deflated JSON; the package's own files (zip)
// in RATS blocks of their own when small enough.

import { deflateSync, inflateSync } from 'fflate';
import { Rom, pcToSnes } from './rom.ts';
import { listPatches, hashBytes, writeChunks, readChunks } from './patchreg.ts';
import { uninstallPatch } from './patchapply.ts';
import { loadProject, saveProject, emptyProject } from './uberproject.ts';
import { loadBlockProject, saveBlockProject } from './blocks.ts';
import { loadPixiProject, savePixiProject } from './pixi.ts';
import { gfxEntry, setGfxEntry, VANILLA_GFX, levelMusic, setLevelMusic } from './patches.ts';
import { loadMusicProject, saveMusicProject, removeSong } from './music.ts';
import type { UberContext } from './uberasm.ts';
import type { SpriteFolder } from './pixirt.ts';

const MAGIC = [0x53, 0x4d, 0x57, 0x4b]; // "SMWK"
const VERSION = 1;
const CONTEXTS: UberContext[] = ['level', 'gamemode', 'overworld'];
const OTHER = ['global', 'statusbar', 'macrolib'] as const;
type Other = (typeof OTHER)[number];

// what a package put into the ROM
export interface PkgParts {
  patches: string[]; // ids of its Asar patches in the patch registry
  uber: { files: string[]; calls: [UberContext, number, string][]; other: Partial<Record<Other, string>> };
  blocks: { files: string[]; tiles: number[] };
  pixi: { files: string[]; list: [SpriteFolder, number][] };
  gfx: number[]; // ExGFX numbers it created
  music?: string[]; // songs it added to the music project (their .txt)
}

export interface PkgRecord extends PkgParts {
  id: string;
  name: string;
  fileName: string;
  added: string; // ISO date
  src?: number[]; // SNES addresses of the RATS blocks holding its files (zip), if kept in the ROM
  srcSize?: number;
}

export const emptyParts = (): PkgParts => ({ patches: [], uber: { files: [], calls: [], other: {} }, blocks: { files: [], tiles: [] }, pixi: { files: [], list: [] }, gfx: [], music: [] });

// ---------- the registry ----------

function find(rom: Rom): number {
  for (const b of rom.scanRats()) {
    const p = b.start + 8;
    if (b.size > 5 && MAGIC.every((m, i) => rom.data[p + i] === m)) return p;
  }
  return -1;
}

export function listPackages(rom: Rom): PkgRecord[] {
  const p = find(rom);
  if (p < 0) return [];
  if (rom.data[p + 4] > VERSION) throw new Error('Package registry in the ROM is from a newer editor version');
  const size = rom.isRatsAt(p - 8);
  return JSON.parse(new TextDecoder().decode(inflateSync(rom.data.subarray(p + 5, p + size)))) as PkgRecord[];
}

function write(rom: Rom, all: PkgRecord[]): void {
  const old = find(rom);
  if (old >= 0) rom.freeAt(pcToSnes(old));
  if (!all.length) return;
  const z = deflateSync(new TextEncoder().encode(JSON.stringify(all)), { level: 9 });
  if (z.length + 5 > 0x7f00) throw new Error('Package registry is too large');
  const buf = new Uint8Array(z.length + 5);
  buf.set(MAGIC); buf[4] = VERSION; buf.set(z, 5);
  rom.allocWrite(buf);
}

// adds or replaces the record; archive: the package's files to keep in the ROM (once)
export function savePackage(rom: Rom, rec: PkgRecord, archive?: Uint8Array): PkgRecord {
  const all = listPackages(rom);
  const full = { ...rec };
  if (archive && !full.src) { full.src = writeChunks(rom, archive); full.srcSize = archive.length; }
  const i = all.findIndex((r) => r.id === rec.id);
  if (i >= 0) all[i] = full; else all.push(full);
  write(rom, all);
  return full;
}

export function removePackageRecord(rom: Rom, id: string): void {
  const all = listPackages(rom);
  const r = all.find((x) => x.id === id);
  if (!r) return;
  for (const a of r.src ?? []) rom.freeAt(a);
  write(rom, all.filter((x) => x.id !== id));
}

// the package's files kept in the ROM, null if they are not
export function packageArchive(rom: Rom, r: PkgRecord): Uint8Array | null {
  return r.src && r.srcSize ? readChunks(rom, r.src, r.srcSize) : null;
}

// ---------- observing what a package adds ----------

export interface Snapshot {
  patches: Set<string>;
  uber: Map<string, number>; // file → hash
  calls: Set<string>; // ctx:num:file
  other: Partial<Record<Other, string>>;
  blocks: Map<string, number>;
  tiles: Map<number, string>; // tile → file
  pixi: Map<string, number>;
  sprites: Map<string, string>; // kind:num → file
  gfx: number[]; // ExGFX address per number, 0 = none
  music: Map<string, number>; // song file → number
}

// list.txt is written from the assignments, which are compared on their own
const hashes = (files: Map<string, Uint8Array> | undefined) => new Map([...(files ?? [])].filter(([f]) => f !== 'list.txt').map(([f, c]) => [f, hashBytes([c])]));
const tryLoad = <T>(load: () => T | null): T | null => { try { return load(); } catch { return null; } };

export function snapshot(rom: Rom): Snapshot {
  const uber = tryLoad(() => loadProject(rom));
  const blocks = tryLoad(() => loadBlockProject(rom));
  const pixi = tryLoad(() => loadPixiProject(rom));
  const music = tryLoad(() => loadMusicProject(rom));
  const calls = new Set<string>();
  for (const ctx of CONTEXTS) for (const [num, cs] of uber?.list[ctx] ?? []) for (const c of cs) calls.add(`${ctx}:${num}:${c.file}`);
  const other: Partial<Record<Other, string>> = {};
  for (const k of OTHER) { const v = uber?.list[k]; if (v) other[k] = v; }
  return {
    patches: new Set(listPatches(rom).filter((p) => !p.kind || p.kind === 'patch').map((p) => p.id)),
    uber: hashes(uber?.files), calls, other,
    blocks: hashes(blocks?.files), tiles: new Map((blocks?.list ?? []).map((b) => [b.tile, b.file])),
    pixi: hashes(pixi?.files), sprites: new Map((pixi?.list ?? []).map((e) => [`${e.kind}:${e.num}`, e.file])),
    gfx: Array.from({ length: 0x100 }, (_, i) => (i >= VANILLA_GFX ? gfxEntry(rom, i)?.addr ?? 0 : 0)),
    music: new Map((music?.songs ?? []).map((x) => [x.file, x.num])),
  };
}

const changedFiles = (a: Map<string, number>, b: Map<string, number>) => [...b].filter(([f, h]) => a.get(f) !== h).map(([f]) => f);

// what came in between two snapshots
export function partsBetween(a: Snapshot, b: Snapshot): PkgParts {
  const other: Partial<Record<Other, string>> = {};
  for (const k of OTHER) if (b.other[k] && b.other[k] !== a.other[k]) other[k] = b.other[k];
  return {
    patches: [...b.patches].filter((id) => !a.patches.has(id)),
    uber: {
      files: changedFiles(a.uber, b.uber),
      calls: [...b.calls].filter((c) => !a.calls.has(c)).map((c) => { const [ctx, num, ...f] = c.split(':'); return [ctx as UberContext, Number(num), f.join(':')]; }),
      other,
    },
    blocks: { files: changedFiles(a.blocks, b.blocks), tiles: [...b.tiles].filter(([t, f]) => a.tiles.get(t) !== f).map(([t]) => t) },
    pixi: { files: changedFiles(a.pixi, b.pixi), list: [...b.sprites].filter(([k, f]) => a.sprites.get(k) !== f).map(([k]) => { const [kind, num] = k.split(':'); return [kind as SpriteFolder, Number(num)]; }) },
    gfx: b.gfx.flatMap((addr, i) => (addr && !a.gfx[i] ? [i] : [])),
    music: [...b.music.keys()].filter((f) => !a.music.has(f)),
  };
}

export function isEmptyParts(p: PkgParts): boolean {
  return !p.patches.length && !p.uber.files.length && !p.uber.calls.length && !Object.keys(p.uber.other).length
    && !p.blocks.files.length && !p.blocks.tiles.length && !p.pixi.files.length && !p.pixi.list.length && !p.gfx.length && !p.music?.length;
}

const union = <T>(a: T[], b: T[], key: (x: T) => string = String) => {
  const seen = new Set(a.map(key));
  return [...a, ...b.filter((x) => !seen.has(key(x)))];
};

// the record with more parts; patches no longer in the ROM (applied anew under a new id) are dropped
export function mergeParts(r: PkgRecord, p: PkgParts, now: Snapshot): PkgRecord {
  return {
    ...r,
    patches: union(r.patches.filter((id) => now.patches.has(id)), p.patches),
    uber: { files: union(r.uber.files, p.uber.files), calls: union(r.uber.calls, p.uber.calls, (c) => c.join(':')), other: { ...r.uber.other, ...p.uber.other } },
    blocks: { files: union(r.blocks.files, p.blocks.files), tiles: union(r.blocks.tiles, p.blocks.tiles) },
    pixi: { files: union(r.pixi.files, p.pixi.files), list: union(r.pixi.list, p.pixi.list, (e) => e.join(':')) },
    gfx: union(r.gfx, p.gfx),
    music: union(r.music ?? [], p.music ?? []),
  };
}

// ---------- removing a package ----------

// removes everything the package put into the ROM and its record; files another package also brought
// stay. All or nothing: throws, the ROM unchanged. Returns warnings.
export function uninstallPackage(rom: Rom, id: string, blank: number[]): string[] {
  const all = listPackages(rom);
  const rec = all.find((r) => r.id === id);
  if (!rec) throw new Error('Package is not installed');
  const others = all.filter((r) => r !== rec);
  const shared = (tool: 'uber' | 'blocks' | 'pixi', f: string) => others.some((r) => r[tool].files.includes(f));
  const before = rom.data.slice();
  const warnings: string[] = [];
  const check = (r: { ok: boolean; errors: string[]; warnings: string[] }, what: string) => {
    if (!r.ok) throw new Error(`${what}: ${r.errors.join(' ')}`);
    warnings.push(...r.warnings);
  };
  try {
    if (rec.pixi.files.length || rec.pixi.list.length) {
      const p = loadPixiProject(rom);
      if (p) {
        const mine = new Set(rec.pixi.list.map((e) => e.join(':')));
        p.list = p.list.filter((e) => !mine.has(`${e.kind}:${e.num}`) || !rec.pixi.files.includes(e.file));
        for (const f of rec.pixi.files) if (!shared('pixi', f)) p.files.delete(f);
        check(savePixiProject(rom, p), 'Custom Sprites');
      }
    }
    if (rec.blocks.files.length || rec.blocks.tiles.length) {
      const p = loadBlockProject(rom);
      if (p) {
        p.list = p.list.filter((b) => !rec.blocks.tiles.includes(b.tile) || !rec.blocks.files.includes(b.file));
        for (const f of rec.blocks.files) if (!shared('blocks', f)) p.files.delete(f);
        check(saveBlockProject(rom, p, blank), 'Custom Blocks');
      }
    }
    if (rec.uber.files.length || rec.uber.calls.length || Object.keys(rec.uber.other).length) {
      const p = loadProject(rom) ?? emptyProject();
      for (const [ctx, num, file] of rec.uber.calls) {
        const cs = p.list[ctx].get(num)?.filter((c) => c.file !== file);
        if (cs?.length) p.list[ctx].set(num, cs); else p.list[ctx].delete(num);
      }
      for (const k of OTHER) if (rec.uber.other[k] && p.list[k] === rec.uber.other[k]) p.list[k] = null;
      for (const f of rec.uber.files) if (!shared('uber', f)) p.files.delete(f);
      check(saveProject(rom, p), 'UberASM');
    }
    // patches applied later first
    const order = listPatches(rom).map((p) => p.id);
    for (const pid of [...rec.patches].filter((x) => order.includes(x)).sort((a, b) => order.indexOf(b) - order.indexOf(a))) warnings.push(...uninstallPatch(rom, pid));
    for (const n of rec.gfx) {
      const e = n >= VANILLA_GFX ? gfxEntry(rom, n) : null;
      if (!e) continue;
      rom.freeAt(e.addr);
      setGfxEntry(rom, n, 0, false);
    }
    removePackageRecord(rom, id);
  } catch (e) {
    rom.data = before;
    throw e;
  }
  return warnings;
}

// uninstallPackage for packages with songs too: the songs are removed first (AddmusicK runs again;
// levels set to a removed song get their header music back), all or nothing like uninstallPackage
export async function uninstallPackageWithMusic(rom: Rom, id: string, blank: number[]): Promise<string[]> {
  const rec = listPackages(rom).find((r) => r.id === id);
  if (!rec) throw new Error('Package is not installed');
  const before = rom.data.slice();
  const warnings: string[] = [];
  try {
    const p = rec.music?.length ? loadMusicProject(rom) : null;
    if (p) {
      const nums = p.songs.filter((s) => rec.music!.includes(s.file)).map((s) => s.num);
      for (const n of nums) removeSong(p, n);
      const r = await saveMusicProject(rom, p);
      if (!r.ok) throw new Error(`Music: ${r.errors.join(' ')}`);
      warnings.push(...r.warnings);
      for (let l = 0; l < 0x200; l++) if (nums.includes(levelMusic(rom, l)) && !p.songs.some((s) => s.num === levelMusic(rom, l))) setLevelMusic(rom, l, 0);
    }
    warnings.push(...uninstallPackage(rom, id, blank));
  } catch (e) {
    rom.data = before;
    throw e;
  }
  return warnings;
}

// the package that brought a patch (by registry id)
export function packageOfPatch(rom: Rom, patchId: string): PkgRecord | null {
  return listPackages(rom).find((r) => r.patches.includes(patchId)) ?? null;
}
