// The ROM's UberASM project: loaded from the sources stored with its registry entry, saved by
// rebuilding and reapplying the generated patch.

import { unzipSync, zipSync } from 'fflate';
import { Rom } from './rom.ts';
import { applyPatch, reapplyPatch, uninstallPatch, type ApplyResult } from './patchapply.ts';
import { listPatches, patchArchive, type PatchEntry } from './patchreg.ts';
import { installEditorPatch } from './patches.ts';
import { buildUberPatch, parseList, emptyList, writeList, type UberList } from './uberasm.ts';

export interface UberProject { files: Map<string, Uint8Array>; list: UberList }

export function uberEntry(rom: Rom): PatchEntry | null {
  return listPatches(rom).find((p) => p.kind === 'uberasm') ?? null;
}

export function emptyProject(): UberProject {
  return { files: new Map(), list: emptyList() };
}

// project from a zip/folder in UberASM Tool's layout (list.txt at the root or one folder down)
export function projectFromFiles(files: Map<string, Uint8Array>): UberProject {
  let root = '';
  if (!files.has('list.txt')) {
    const l = [...files.keys()].find((p) => /^[^/]+\/list\.txt$/i.test(p));
    if (!l) throw new Error('No list.txt found – is this an UberASM Tool folder?');
    root = l.slice(0, l.indexOf('/') + 1);
  }
  const out = new Map<string, Uint8Array>();
  for (const [p, c] of files) {
    if (!p.startsWith(root)) continue;
    const rel = p.slice(root.length);
    // the tool's own files are not needed (the editor generates the main patch)
    if (/^(asm\/|UberASMTool|asar\.|.*\.(exe|dll|config|html|txt)$)/i.test(rel) && rel !== 'list.txt') continue;
    out.set(rel, c);
  }
  const list = parseList(new TextDecoder().decode(out.get('list.txt') ?? new Uint8Array()));
  return { files: out, list };
}

export function projectFromZip(data: Uint8Array): UberProject {
  const files = new Map<string, Uint8Array>();
  for (const [p, c] of Object.entries(unzipSync(data))) if (!p.endsWith('/') && !p.startsWith('__MACOSX/')) files.set(p.replace(/\\/g, '/'), c);
  return projectFromFiles(files);
}

export function projectToZip(p: UberProject): Uint8Array {
  const files = new Map(p.files);
  files.set('list.txt', new TextEncoder().encode(writeList(p.list)));
  return zipSync(Object.fromEntries(files), { level: 9 });
}

export function loadProject(rom: Rom): UberProject | null {
  const e = uberEntry(rom);
  if (!e) return null;
  const a = patchArchive(rom, e);
  if (!a) throw new Error('The UberASM sources are not stored in the ROM');
  return projectFromZip(a);
}

function isEmpty(p: UberProject): boolean {
  const l = p.list;
  return !l.level.size && !l.gamemode.size && !l.overworld.size && !l.global && !l.statusbar;
}

// assembles and (re)applies the project; an empty project removes the UberASM patch
export function saveProject(rom: Rom, p: UberProject): ApplyResult {
  const e = uberEntry(rom);
  if (isEmpty(p) && ![...p.files.keys()].some((f) => f !== 'list.txt')) {
    const warnings = e ? uninstallPatch(rom, e.id) : [];
    return { ok: true, errors: [], warnings, prints: [] };
  }
  installEditorPatch(rom); // level resources use the level number in $7E010B
  const b = buildUberPatch(p.files, p.list);
  const r = e ? reapplyPatch(rom, e.id, b.source) : applyPatch(rom, b.source);
  r.warnings.unshift(...b.warnings);
  return r;
}
