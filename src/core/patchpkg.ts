// Patch packages: a single .asm file or a .zip (as on SMWCentral) with includes, binaries and an
// optional manifest "patch.json" (see docs/patches.md). Settings are Asar defines: those assigned at
// the top level of the main file (`!name = value`) are rewritten in place, so configuration defines of
// ordinary patches can be changed too; others are passed to Asar as additional defines.

import { unzipSync } from 'fflate';
import type { PatchSource } from './patchapply.ts';

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
}
export interface PatchPackage {
  name: string;
  files: Map<string, Uint8Array>;
  asmFiles: string[]; // candidates for the main file, shallowest first
  main: string | null; // null: several candidates, the user has to choose
  manifest: PatchManifest | null;
}
export interface DefineLine { name: string; value: string; comment: string; line: number }

const MAX_FILES = 2000;
const MAX_TOTAL = 32 << 20;

function isZip(d: Uint8Array): boolean {
  return d.length > 4 && d[0] === 0x50 && d[1] === 0x4b && d[2] === 0x03 && d[3] === 0x04;
}

// the files of a .zip (or the single file), paths relative to the archive root; one common top-level
// folder is stripped
export function packageFiles(fileName: string, data: Uint8Array): Map<string, Uint8Array> {
  let files = new Map<string, Uint8Array>();
  if (isZip(data)) {
    const all = unzipSync(data);
    let total = 0;
    for (const [path, content] of Object.entries(all)) {
      if (path.endsWith('/') || path.startsWith('__MACOSX/') || /(^|\/)\.[^/]*$/.test(path)) continue;
      total += content.length;
      if (files.size >= MAX_FILES || total > MAX_TOTAL) throw new Error('Das Archiv ist zu groß');
      files.set(path.replace(/\\/g, '/'), content);
    }
    // strip one common top-level folder
    const tops = new Set([...files.keys()].map((p) => (p.includes('/') ? p.split('/')[0] : '')));
    if (tops.size === 1 && !tops.has('')) {
      const cut = [...tops][0].length + 1;
      files = new Map([...files].map(([p, c]) => [p.slice(cut), c]));
    }
  } else {
    files.set(fileName.split(/[\\/]/).pop()!, data);
  }
  return files;
}

export function readPackage(fileName: string, data: Uint8Array): PatchPackage {
  return packageFromFiles(fileName, packageFiles(fileName, data));
}

// package from already extracted files (paths relative to the package root)
export function packageFromFiles(fileName: string, files: Map<string, Uint8Array>): PatchPackage {
  const base = fileName.replace(/\.[^.]*$/, '');
  if (!files.size) throw new Error('Das Archiv ist leer');

  let manifest: PatchManifest | null = null;
  const mf = files.get('patch.json');
  if (mf) {
    manifest = JSON.parse(new TextDecoder().decode(mf)) as PatchManifest;
    if (!manifest.name || !manifest.main) throw new Error('patch.json: "name" und "main" sind Pflichtfelder');
    if (!files.has(manifest.main)) throw new Error(`patch.json: Hauptdatei „${manifest.main}“ fehlt im Archiv`);
  }
  const depth = (p: string) => p.split('/').length;
  const asmFiles = [...files.keys()].filter((p) => /\.(asm|asar)$/i.test(p)).sort((a, b) => depth(a) - depth(b) || a.localeCompare(b));
  if (!asmFiles.length) throw new Error('Keine .asm-Datei gefunden');
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
  text.split(/\r?\n/).forEach((l, i) => {
    const t = l.trim().toLowerCase();
    if (/^(macro|if|while|for)\b/.test(t)) depth++;
    else if (/^(endmacro|endif|endwhile|endfor)\b/.test(t)) depth = Math.max(0, depth - 1);
    if (depth) return;
    const m = DEF_RE.exec(l);
    if (m && !out.some((d) => d.name === m[2])) out.push({ name: m[2], value: m[6], comment: (m[7] ?? '').replace(/^\s*;\s*/, ''), line: i });
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
export function effectiveDefines(pkg: PatchPackage, values: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const o of pkg.manifest?.options ?? []) out[o.define] = optionDefault(o);
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

// the Asar input for a package: defines of the main file are rewritten, the rest are passed on
export function packageSource(pkg: PatchPackage, main: string, defines: Record<string, string>): PatchSource {
  const files = new Map<string, Uint8Array | string>(pkg.files);
  const { text, rest } = rewriteDefines(new TextDecoder().decode(pkg.files.get(main)!), defines);
  files.set(main, text);
  return { name: pkg.name, version: pkg.manifest?.version, main, files, defines: rest, settings: defines };
}

// What a package is: an ordinary patch, an UberASM resource, a GPS block or a PIXI sprite. Many
// SMWCentral downloads are resources for other tools, which cannot be applied as a patch by themselves.
export type PackageKind = 'patch' | 'uberasm' | 'block' | 'blockpack' | 'pixi';
export interface PackageInfo { kind: PackageKind; file: string; acts?: number }

function statements(text: string): string[] {
  return text.split(/\r?\n/).map((l) => l.replace(/;.*$/, '').trim()).filter(Boolean);
}

export function detectKind(pkg: PatchPackage, main = pkg.main ?? pkg.asmFiles[0]): PackageInfo {
  if (pkg.manifest) return { kind: 'patch', file: main };
  const text = (f: string) => new TextDecoder().decode(pkg.files.get(f)!);
  // PIXI sprites: "print "INIT ",pc" / "print "MAIN ",pc", usually with a .json/.cfg next to them
  for (const f of pkg.asmFiles) if (/print\s+"(INIT|MAIN) ?"\s*,\s*pc/i.test(text(f))) return { kind: 'pixi', file: f };
  const isBlock = (f: string) => {
    const first = statements(text(f)).find((l) => !/^(print|!|incsrc|incbin|if|endif|else|macro|endmacro|%)/i.test(l) && !/^[A-Za-z_.][A-Za-z0-9_.]*:$/.test(l));
    return !!first && /^db\s+\$(42|37)\b/i.test(first);
  };
  // block package: a GPS list.txt with the blocks (often with a .map16 file and ExGFX)
  const list = [...pkg.files.keys()].find((f) => /(^|\/)list\.txt$/i.test(f));
  if (list && pkg.asmFiles.some(isBlock) && /^[0-9a-f]{3,4}(:[0-9a-f]{3})?\s+\S+\.asm/im.test(new TextDecoder().decode(pkg.files.get(list)!))) return { kind: 'blockpack', file: list };
  const src = text(main);
  const st = statements(src);
  // GPS block: first real statement is db $42 / db $37
  if (isBlock(main)) {
    const al = /act(?:s)?\s*like[:\s]*\$?([0-9a-f]{1,3})\b/i.exec(src);
    return { kind: 'block', file: main, acts: al ? parseInt(al[1], 16) : undefined };
  }
  // UberASM resource: entry labels and no hijack/free space of its own
  const hasLabel = st.some((l) => /^(init|main|load|end|nmi)\s*:/i.test(l));
  const hijacks = st.some((l) => /^(org|freecode|freedata|autoclean|pushpc|lorom|sa1rom|hirom)\b/i.test(l));
  if (hasLabel && !hijacks) return { kind: 'uberasm', file: main };
  return { kind: 'patch', file: main };
}
