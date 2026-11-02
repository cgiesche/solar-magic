// Uploads: what the user hands in for one package (see CONTEXT.md) – a single .asm file or a .zip
// (as on SMWCentral) with includes, binaries and an optional manifest "patch.json" (see
// docs/patches.md). Settings are Asar defines: those assigned at the top level of the main file
// (`!name = value`) are rewritten in place, so configuration defines of ordinary patches can be changed
// too; others are passed to Asar as additional defines.

import { unzipSync, zipSync } from 'fflate';
import type { PatchSource } from './patchapply.ts';
import type { RamClaim } from './patchreg.ts';

export type OptionType = 'bool' | 'number' | 'hex' | 'enum' | 'text';
export interface PatchOption {
  define: string; // without "!"
  label: string;
  type: OptionType;
  default?: string | number | boolean;
  values?: { value: string; label: string }[]; // enum
  min?: number;
  max?: number;
  hint?: string;
}
export interface PatchManifest {
  name: string;
  author?: string;
  version?: string;
  description?: string;
  main: string;
  options?: PatchOption[];
  requires?: string[]; // built-in editor patches: "smwe", "smwx"
  smwc?: string; // link to the SMWCentral page
  ram?: PatchRam[]; // free RAM the patch uses
}
// a free RAM range: at a define's value (its setting, or its assignment in the main file) or a fixed address
export interface PatchRam { define?: string; addr?: string | number; size: number; shared?: boolean }
export interface Upload {
  name: string;
  files: Map<string, Uint8Array>;
  asmFiles: string[]; // candidates for the main file, shallowest first
  main: string | null; // null: several candidates, the user has to choose
  manifest: PatchManifest | null;
}
// a setting: the define, its value, the comment behind it, the comment lines above it (doc) and the
// heading of its section (a comment line like ";=== Title ===")
export interface DefineLine { name: string; value: string; comment: string; line: number; doc: string; section: string }

const MAX_FILES = 2000;
const MAX_TOTAL = 32 << 20;

function isZip(d: Uint8Array): boolean {
  return d.length > 4 && d[0] === 0x50 && d[1] === 0x4b && d[2] === 0x03 && d[3] === 0x04;
}

// the files of a .zip (or the single file), paths relative to the archive root; one common top-level
// folder is stripped
export function uploadFiles(fileName: string, data: Uint8Array): Map<string, Uint8Array> {
  let files = new Map<string, Uint8Array>();
  if (isZip(data)) {
    const all = unzipSync(data);
    let total = 0;
    for (const [path, content] of Object.entries(all)) {
      if (path.endsWith('/') || path.startsWith('__MACOSX/') || /(^|\/)\.[^/]*$/.test(path)) continue;
      total += content.length;
      if (files.size >= MAX_FILES || total > MAX_TOTAL) throw new Error('The archive is too large');
      files.set(path.replace(/\\/g, '/'), content);
    }
    // strip one common top-level folder (not a bank of AddmusicK's sound effects: it says what they are)
    const tops = new Set([...files.keys()].map((p) => (p.includes('/') ? p.split('/')[0] : '')));
    if (tops.size === 1 && !tops.has('') && !/^1DF[9C]$/i.test([...tops][0])) {
      const cut = [...tops][0].length + 1;
      files = new Map([...files].map(([p, c]) => [p.slice(cut), c]));
    }
  } else {
    files.set(fileName.split(/[\\/]/).pop()!, data);
  }
  return files;
}

export function readUpload(fileName: string, data: Uint8Array): Upload {
  return uploadFromFiles(fileName, uploadFiles(fileName, data));
}

// upload from already extracted files (paths relative to the package root)
export function uploadFromFiles(fileName: string, files: Map<string, Uint8Array>): Upload {
  const base = fileName.replace(/\.[^.]*$/, '');
  if (!files.size) throw new Error('The archive is empty');

  let manifest: PatchManifest | null = null;
  const mf = files.get('patch.json');
  if (mf) {
    manifest = JSON.parse(new TextDecoder().decode(mf)) as PatchManifest;
    if (!manifest.name || !manifest.main) throw new Error('patch.json: "name" and "main" are required');
    if (!files.has(manifest.main)) throw new Error(`patch.json: main file “${manifest.main}” is missing from the archive`);
  }
  const depth = (p: string) => p.split('/').length;
  const asmFiles = [...files.keys()].filter((p) => /\.(asm|asar)$/i.test(p)).sort((a, b) => depth(a) - depth(b) || a.localeCompare(b));
  if (!asmFiles.length) throw new Error('No .asm file found');
  let main = manifest?.main ?? null;
  if (!main) {
    const top = asmFiles.filter((p) => depth(p) === depth(asmFiles[0]));
    main = top.length === 1 ? top[0] : top.find((p) => p.replace(/\.[^.]*$/, '').toLowerCase() === base.toLowerCase()) ?? null;
  }
  return { name: manifest?.name ?? base, files, asmFiles, main, manifest };
}

const DEF_RE = /^(\s*)!([A-Za-z0-9_]+)(\s*)(\?=|=)(\s*)(.*?)(\s*;.*)?$/;

// top-level define assignments of a file (outside macros/conditionals), as settings for the user
export function scanDefines(text: string): DefineLine[] {
  const out: DefineLine[] = [];
  let depth = 0;
  let section = '';
  let above: string[] = []; // comment lines right above
  let doc = ''; // shared by defines following each other without a blank line
  text.split(/\r?\n/).forEach((l, i) => {
    const t = l.trim().toLowerCase();
    if (/^(macro|if|while|for)\b/.test(t)) depth++;
    else if (/^(endmacro|endif|endwhile|endfor)\b/.test(t)) depth = Math.max(0, depth - 1);
    if (depth) { above = []; doc = ''; return; }
    if (t.startsWith(';')) {
      const head = /^;\s*[=\-*#]{3,}\s*(.*?)\s*[=\-*#]*\s*$/.exec(l.trim());
      if (head) { if (head[1]) section = head[1]; above = []; doc = ''; } else above.push(l.trim().replace(/^;+\s?/, ''));
      return;
    }
    const m = DEF_RE.exec(l);
    if (!m) { above = []; doc = ''; return; }
    if (above.length) { doc = above.join('\n'); above = []; }
    if (!out.some((d) => d.name === m[2])) out.push({ name: m[2], value: m[6], comment: (m[7] ?? '').replace(/^\s*;\s*/, ''), line: i, doc, section });
  });
  return out;
}

export function optionDefault(o: PatchOption): string {
  const d = o.default;
  if (o.type === 'bool') return d === true || d === 1 || d === '1' ? '1' : '0';
  if (d === undefined) return o.type === 'enum' ? o.values?.[0]?.value ?? '0' : o.type === 'text' ? '' : '0';
  if (o.type === 'hex' && typeof d === 'number') return '$' + d.toString(16).toUpperCase();
  return String(d);
}

// defines for the chosen settings: manifest defaults, overridden by `values`
export function effectiveDefines(upload: Upload, values: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const o of upload.manifest?.options ?? []) out[o.define] = optionDefault(o);
  return { ...out, ...values };
}

// sets top-level define assignments of a file to new values; returns the defines not found there
export function rewriteDefines(text: string, defines: Record<string, string>): { text: string; rest: Record<string, string> } {
  const rest: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  const found = new Map(scanDefines(text).map((d) => [d.name, d]));
  for (const [name, value] of Object.entries(defines)) {
    const d = found.get(name);
    if (!d) { rest[name] = value; continue; }
    lines[d.line] = lines[d.line].replace(DEF_RE, (_all, ind, n, s1, op, s2, _v, cm) => `${ind}!${n}${s1}${op}${s2}${value}${cm ?? ''}`);
  }
  return { text: lines.join('\n'), rest };
}

// defines to set, per file: a part's number another part's code names (a sprite's, a sound effect's)
export type FileDefines = Map<string, Record<string, string>>;

// the files with their defines set (the same map when there are none to set)
export function withDefines(files: Map<string, Uint8Array>, defines: FileDefines): Map<string, Uint8Array> {
  if (!defines.size) return files;
  const out = new Map(files);
  for (const [f, d] of defines) if (files.has(f)) out.set(f, new TextEncoder().encode(rewriteDefines(new TextDecoder().decode(files.get(f)!), d).text));
  return out;
}

// the Asar input for a package: defines of the main file are rewritten, the rest are passed on
export function uploadSource(upload: Upload, main: string, defines: Record<string, string>): PatchSource {
  const files = new Map<string, Uint8Array | string>(upload.files);
  const { text, rest } = rewriteDefines(new TextDecoder().decode(upload.files.get(main)!), defines);
  files.set(main, text);
  const ram = manifestRam(upload, text, defines);
  return { name: upload.name, version: upload.manifest?.version, main, files, defines: rest, settings: defines, ...(ram.length ? { ram } : {}) };
}

// the manifest's RAM ranges as claims; an address that isn't a plain number ($7FB000, 0x7FB000, decimal) is an error
export function manifestRam(upload: Upload, mainText: string, defines: Record<string, string>): RamClaim[] {
  const out: RamClaim[] = [];
  const own = new Map(scanDefines(mainText).map((d) => [d.name, d.value]));
  for (const r of upload.manifest?.ram ?? []) {
    const v = r.define !== undefined ? defines[r.define] ?? own.get(r.define) : r.addr;
    const a = typeof v === 'number' ? v : parseNum(String(v ?? '').trim());
    if (a === null || !(r.size > 0)) throw new Error(`patch.json: RAM entry ${JSON.stringify(r)} is invalid`);
    out.push(r.shared ? [a, r.size, 1] : [a, r.size]);
  }
  return out;
}

export function parseNum(s: string): number | null {
  const m = /^(?:\$|0x)([0-9a-f]+)$/i.exec(s);
  if (m) return parseInt(m[1], 16);
  return /^\d+$/.test(s) ? parseInt(s, 10) : null;
}

// What the ASM of an upload is: an ordinary patch, an UberASM resource, a GPS block (`pack`: a block
// package, its list.txt in `file`) or a PIXI sprite. Many SMWCentral downloads are resources for other
// tools, which cannot be applied as a patch by themselves.
// an upload as kept with a patch it applied (its archive in the editor data), to reapply it later
export interface StoredUpload { fileName: string; files: [string, Uint8Array][]; main: string }
const STORED_META = '.smwe-package.json';

export function packUpload(s: StoredUpload): Uint8Array {
  const files: Record<string, Uint8Array> = Object.fromEntries(s.files);
  files[STORED_META] = new TextEncoder().encode(JSON.stringify({ fileName: s.fileName, main: s.main }));
  return zipSync(files, { level: 9 });
}

export function unpackUpload(a: Uint8Array): StoredUpload {
  const all = unzipSync(a);
  const meta = JSON.parse(new TextDecoder().decode(all[STORED_META])) as { fileName: string; main: string };
  delete all[STORED_META];
  return { ...meta, files: Object.entries(all) };
}
