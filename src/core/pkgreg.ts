// Installed packages ("SMWK"): what each added download put into the ROM – its Asar patches, files and
// list.txt entries of the UberASM, block, sprite (PIXI) and overworld sprite (BOWSIE) projects, songs and sound effects, ExGFX files, global GFX files, shared palette colors, global animation slots – so a package can be looked at,
// configured and removed as one. Not declared by the add dialogs but observed: the ROM's projects are
// compared before and after a package (or a part of it) was added. Kept in the ROM like the patch
// registry: a RATS block holding "SMWK", a version byte and deflated JSON; the package's own files (zip)
// in RATS blocks of their own when small enough.

import { deflateSync, inflateSync } from 'fflate';
import { Rom, pcToSnes } from './rom.ts';
import type { UberContext } from './uberasm.ts';
import type { SpriteFolder } from './pixirt.ts';
import { TOOL_KINDS, type ToolKind } from './parts.ts';
import { SECTIONS, SECTION_KEYS, type SectionKey, type PartSection, type Other } from './pkgsections.ts';
import type { ObjectText } from './objtext.ts';

const MAGIC = [0x53, 0x4d, 0x57, 0x4b]; // "SMWK"
const VERSION = 1;

// what a package put into the ROM (the tool projects under their part kind)
export interface PackageParts {
  patches: string[]; // ids of its Asar patches in the patch registry
  uberasm: { files: string[]; calls: [UberContext, number, string][]; other: Partial<Record<Other, string>> };
  block: { files: string[]; tiles: number[] };
  sprite: { files: string[]; list: [SpriteFolder, number][] };
  owsprite: { files: string[]; list: number[] }; // overworld sprites (BOWSIE): files and numbers
  gfx: number[]; // ExGFX numbers it created
  music?: string[]; // songs it added to the music project (their .txt)
  sfx?: string[]; // sound effects it added to the music project ("<bank>/<file>")
  map16?: number[]; // extended FG Map16 tiles it filled (graphics packages)
  bgMap16?: number[]; // extended BG Map16 tiles it filled
  sharedPal?: [number, number][]; // shared palette colors it changed (index in the block, the color before)
  globalAnim?: GlobalAnimPart; // global animation slots it filled
  globalGfx?: [number, number][]; // global GFX files it replaced (GFX00–33, the hash of its file unpacked)
}
// slots of the global animation list; graphic: the Anim graphic its frames went into and its size before
export interface GlobalAnimPart { slots: number[]; graphic?: [number, number] }

// an installed package: the upload's name and files and what it brought
export interface Package extends PackageParts {
  id: string;
  name: string;
  fileName: string;
  added: string; // ISO date
  srcId?: string; // its files (zip) in the editor data (rom.extra)
  objectText?: ObjectText; // object names and tooltips of its Lunar Magic side files (objtext.ts)
}

export const emptyParts = (): PackageParts => Object.fromEntries(SECTION_KEYS.map((k) => [k, SECTIONS[k].none()])) as unknown as PackageParts;

// ---------- the registry ----------

function find(rom: Rom): number {
  for (const b of rom.scanRats()) {
    const p = b.start + 8;
    if (b.size > 5 && MAGIC.every((m, i) => rom.data[p + i] === m)) return p;
  }
  return -1;
}

export function listPackages(rom: Rom): Package[] {
  const p = find(rom);
  if (p < 0) return [];
  if (rom.data[p + 4] > VERSION) throw new Error('Package registry in the ROM is from a newer editor version');
  const size = rom.isRatsAt(p - 8);
  return JSON.parse(new TextDecoder().decode(inflateSync(rom.data.subarray(p + 5, p + size)))) as Package[];
}

function write(rom: Rom, all: Package[]): void {
  const old = find(rom);
  if (old >= 0) rom.freeAt(pcToSnes(old));
  if (!all.length) return;
  const z = deflateSync(new TextEncoder().encode(JSON.stringify(all)), { level: 9 });
  if (z.length + 5 > 0x7f00) throw new Error('Package registry is too large');
  const buf = new Uint8Array(z.length + 5);
  buf.set(MAGIC); buf[4] = VERSION; buf.set(z, 5);
  rom.allocWrite(buf);
}

// adds or replaces the record; archive: the package's files to keep with the editor data (once)
export function savePackage(rom: Rom, rec: Package, archive?: Uint8Array): Package {
  const all = listPackages(rom);
  const full = { ...rec };
  if (archive && !full.srcId) full.srcId = rom.putBlob(archive);
  const i = all.findIndex((r) => r.id === rec.id);
  if (i >= 0) all[i] = full; else all.push(full);
  write(rom, all);
  return full;
}

export function removePackageRecord(rom: Rom, id: string): void {
  const all = listPackages(rom);
  const r = all.find((x) => x.id === id);
  if (!r) return;
  if (r.srcId) rom.dropBlob(r.srcId);
  write(rom, all.filter((x) => x.id !== id));
}

// the package's files, null if they are not kept
export function packageArchive(rom: Rom, r: Package): Uint8Array | null {
  return r.srcId ? rom.getBlob(r.srcId) : null;
}


// ---------- observing what a package adds ----------
// (each section of the record by its adapter, see pkgsections.ts)

type Snapshot = { [K in SectionKey]: ReturnType<(typeof SECTIONS)[K]['read']> };
const section = (k: SectionKey) => SECTIONS[k] as PartSection<unknown, unknown>;
type Parts = Record<SectionKey, unknown>;

function snapshot(rom: Rom): Snapshot {
  const s = {} as Parts;
  for (const k of SECTION_KEYS) s[k] = section(k).read(rom);
  return s as Snapshot;
}

// what came in between two snapshots
function partsBetween(a: Snapshot, b: Snapshot): PackageParts {
  const p = {} as Parts;
  for (const k of SECTION_KEYS) p[k] = section(k).added(a[k], b[k]);
  return p as unknown as PackageParts;
}

function isEmptyParts(p: PackageParts): boolean {
  return SECTION_KEYS.every((k) => p[k] === undefined || section(k).empty(p[k]));
}

// every section filled in (records from before a section existed lack it)
function complete(r: Package): Package {
  const out: Record<string, unknown> = { ...r };
  for (const k of SECTION_KEYS) out[k] = r[k] ?? section(k).none();
  return out as unknown as Package;
}

// the record with more parts
function mergeParts(r: Package, p: PackageParts, now: Snapshot): Package {
  const out = complete(r) as unknown as Record<string, unknown>;
  for (const k of SECTION_KEYS) out[k] = section(k).merge(out[k], p[k], now[k]);
  return out as unknown as Package;
}

// what the package brought, in a few words each ("Patch", "2 blocks", "UberASM" …)
export function packageSummary(r: Package): string[] {
  const c = complete(r) as unknown as Parts;
  return [...new Set(SECTION_KEYS.flatMap((k) => section(k).summary(c[k]) ?? []))];
}

// what removing the package takes out of the ROM ("the patch", "block(s) at 200, 201" …)
export function packageRemoval(r: Package): string[] {
  const c = complete(r) as unknown as Parts;
  return SECTION_KEYS.flatMap((k) => section(k).removal(c[k]) ?? []);
}

// ---------- recording a change into a package ----------

// an installed package getting more, or a new one (its files kept with the editor data, its object names
// and tooltips with its record)
export type PackageTarget = Package | NewPackage;
export interface NewPackage { name: string; fileName: string; archive?: Uint8Array; objectText?: ObjectText }
// a project file the change placed that was there already (same content, brought by another package
// too): it belongs to the package as well, so removing the other one keeps it
export type Claim = (tool: ToolKind, file: string) => void;
// pkg: the saved record, null when nothing came in (nothing saved)
export interface Recorded<R> { result: R; pkg: Package | null }

// runs `change` and records what it put into the ROM into the package; when it fails (ok false) nothing
// is recorded, when it throws (or the record can't be saved) the error is passed on. Run it in an edit
// session (romedit.ts): that puts the ROM back after a failure.
export function recordPackageChange<R extends { ok: boolean }>(rom: Rom, target: PackageTarget, change: (claim: Claim) => R): Recorded<R> {
  const rec = startRecording(rom, target);
  return rec.finish(change(rec.claim));
}

// recordPackageChange for a change that awaits
export async function recordPackageChangeAsync<R extends { ok: boolean }>(rom: Rom, target: PackageTarget, change: (claim: Claim) => Promise<R>): Promise<Recorded<R>> {
  const rec = startRecording(rom, target);
  return rec.finish(await change(rec.claim));
}

function startRecording(rom: Rom, target: PackageTarget) {
  const was = snapshot(rom);
  const claimed: Record<ToolKind, Set<string>> = { uberasm: new Set(), block: new Set(), sprite: new Set(), owsprite: new Set() };
  return {
    claim: ((tool, file) => { claimed[tool].add(file); }) as Claim,
    finish<R extends { ok: boolean }>(result: R): Recorded<R> {
      if (!result.ok) return { result, pkg: null };
      const now = snapshot(rom);
      const parts = partsBetween(was, now);
      for (const tool of TOOL_KINDS) for (const f of claimed[tool]) if (!parts[tool].files.includes(f)) parts[tool].files.push(f);
      const old = 'id' in target ? target : null;
      // (nothing new, but the record may still change: a patch applied anew drops its old id)
      if (isEmptyParts(parts) && (!old || JSON.stringify(mergeParts(old, parts, now)) === JSON.stringify(complete(old)))) return { result, pkg: null };
      const add = old ? null : target as NewPackage;
      const base: Package = old ?? { id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`, name: target.name, fileName: target.fileName, added: new Date().toISOString(),
        ...emptyParts(), ...(add?.objectText ? { objectText: add.objectText } : {}) };
      return { result, pkg: savePackage(rom, mergeParts(base, parts, now), add?.archive) };
    },
  };
}

// ---------- removing a package ----------

// removes everything the package put into the ROM (each section by its adapter, in their order) and
// its record; what another package brought as well stays. Throws when it fails (run it in an edit session,
// romedit.ts, which puts the ROM back). Returns warnings.
export async function uninstallPackage(rom: Rom, id: string, blank: number[]): Promise<string[]> {
  const all = listPackages(rom);
  const rec = all.find((r) => r.id === id);
  if (!rec) throw new Error('Package is not installed');
  const mine = complete(rec) as unknown as Parts, others = all.filter((r) => r !== rec).map((r) => complete(r) as unknown as Parts);
  const warnings: string[] = [];
  for (const k of SECTION_KEYS) {
    if (section(k).empty(mine[k])) continue;
    warnings.push(...await section(k).remove(rom, mine[k], others.map((o) => o[k]), blank));
  }
  removePackageRecord(rom, id);
  return warnings;
}

// the package that brought a patch (by registry id)
export function packageOfPatch(rom: Rom, patchId: string): Package | null {
  return listPackages(rom).find((r) => r.patches.includes(patchId)) ?? null;
}
