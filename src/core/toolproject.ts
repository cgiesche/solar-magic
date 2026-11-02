// A tool project stored as a patch (UberASM Tool, GPS, PIXI, BOWSIE): the project's files in the tool's
// layout with its list.txt, kept as the sources of its registry entry (a zip). Loading reads them back,
// saving builds the patch and applies it (or reapplies it in place of the installed one); a project
// without entries and files removes the patch. Each tool gives its format: its list.txt, which files of a
// folder belong to the project, when it has entries and how its patch is built.

import { unzipSync, zipSync } from 'fflate';
import type { Rom } from './rom.ts';
import { applyPatch, reapplyPatch, uninstallPatch, type ApplyResult, type PatchSource } from './patchapply.ts';
import { listPatches, patchArchive, missingSources, type PatchEntry } from './patchreg.ts';
import type { ToolKind } from './parts.ts';

export interface ToolProject<L> { files: Map<string, Uint8Array>; list: L }

export interface ToolFormat<L> {
  kind: ToolKind; // of the registry entry
  what: string; // in messages ("custom sprite": "The custom sprite sources are not in this ROM")
  parseList(text: string): L; // list.txt (empty text: no entries); throws on a bad one
  writeList(list: L): string;
  keeps(rel: string): boolean; // a file of a folder (relative to its list.txt) that belongs to the project
  hasEntries(list: L): boolean;
  build(rom: Rom, p: ToolProject<L>): { source: PatchSource; warnings?: string[] };
  // run before a save, reading what the save changes; the function it returns runs once the patch went in
  // (removed: taken out, the project being empty) and gives the save's result
  around?(rom: Rom, p: ToolProject<L>): (r: ApplyResult, removed: boolean) => ApplyResult;
}

export interface ToolStore<L> {
  entry(rom: Rom): PatchEntry | null;
  load(rom: Rom): ToolProject<L> | null; // null: not installed; throws when its sources are missing
  save(rom: Rom, p: ToolProject<L>): ApplyResult;
  remove(rom: Rom): string[]; // saves the empty project; warnings, throws when it fails
  toZip(p: ToolProject<L>): Uint8Array;
  fromZip(data: Uint8Array): ToolProject<L>;
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const fail = (err: unknown): ApplyResult => ({ ok: false, errors: [err instanceof Error ? err.message : String(err)], warnings: [], prints: [] });

// the files of a zip by their paths ('/' separated), without folders and macOS's metadata
export function unzipFiles(data: Uint8Array): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  for (const [k, v] of Object.entries(unzipSync(data))) if (!k.endsWith('/') && !k.startsWith('__MACOSX/')) files.set(k.replace(/\\/g, '/'), v);
  return files;
}

// the folder of a tool's list.txt: the root or one folder down ('' or 'name/'), null without one
export function listRoot(paths: Iterable<string>): string | null {
  const all = [...paths];
  if (all.includes('list.txt')) return '';
  const l = all.find((p) => /^[^/]+\/list\.txt$/i.test(p));
  return l ? l.slice(0, l.indexOf('/') + 1) : null;
}

// a tool folder's project: the files it keeps (relative to its list.txt) and its list
export function folderProject<L>(f: ToolFormat<L>, files: Map<string, Uint8Array>, root = listRoot(files.keys()) ?? ''): ToolProject<L> {
  const out = new Map<string, Uint8Array>();
  for (const [p, c] of files) if (p.startsWith(root) && f.keeps(p.slice(root.length))) out.set(p.slice(root.length), c);
  const list = files.get(root + 'list.txt');
  return { files: out, list: f.parseList(list ? dec.decode(list) : '') };
}

export function toolStore<L>(f: ToolFormat<L>): ToolStore<L> {
  const entry = (rom: Rom) => listPatches(rom).find((p) => p.kind === f.kind) ?? null;
  const toZip = (p: ToolProject<L>) => {
    const all: Record<string, Uint8Array> = Object.fromEntries(p.files);
    all['list.txt'] = enc.encode(f.writeList(p.list));
    return zipSync(all, { level: 9 });
  };
  const fromZip = (data: Uint8Array) => folderProject(f, unzipFiles(data));
  const load = (rom: Rom) => {
    const e = entry(rom);
    if (!e) return null;
    const a = patchArchive(rom, e);
    if (!a) throw missingSources(f.what);
    return fromZip(a);
  };
  const save = (rom: Rom, p: ToolProject<L>): ApplyResult => {
    const e = entry(rom);
    try {
      const after = f.around?.(rom, p) ?? ((r) => r);
      // without entries it keeps its files (to assign them again); without files too it is removed
      if (!f.hasEntries(p.list) && ![...p.files.keys()].some((k) => k !== 'list.txt')) {
        return e ? after({ ok: true, errors: [], warnings: uninstallPatch(rom, e.id), prints: [] }, true) : { ok: true, errors: [], warnings: [], prints: [] };
      }
      const b = f.build(rom, p);
      const r = e ? reapplyPatch(rom, e.id, b.source) : applyPatch(rom, b.source);
      r.warnings.unshift(...(b.warnings ?? []));
      return r.ok ? after(r, false) : r;
    } catch (err) { return fail(err); }
  };
  const remove = (rom: Rom) => {
    const r = save(rom, { files: new Map(), list: f.parseList('') });
    if (!r.ok) throw new Error(r.errors.join(' '));
    return r.warnings;
  };
  return { entry, load, save, remove, toZip, fromZip };
}
