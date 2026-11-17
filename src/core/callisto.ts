// Callisto projects (see CONTEXT.md: Callisto project): uploads made with Underrout's build tool Callisto
// (https://github.com/Underrout/callisto), recognised by their tools/Callisto/*.toml. What the editor
// takes from the configuration:
// - the patches of patches.toml, applied in its order;
// - the header Callisto generates (.callisto/callisto.asm, as Builder::generateCallistoAsmFile of
//   Callisto 0.6.2 writes it), given to the project's patches, UberASM files and GPS blocks as
//   "callisto.asm", with the defines Callisto passes to patches;
// - the folders and list files of its UberASM Tool, GPS and PIXI;
// - what is not part of the package: Callisto's initial patch (FastROM/SA-1) and its BPS of the overworld,
//   title screen and credits (Lunar Magic data) – of the overworld's only its layer 1 tiles' graphics (a
//   graphics part, owtilebps.ts) and the sample levels' messages (pkgsamples.ts) are taken.

import { isUberList } from './uberproject.ts';
import { isGpsListText } from './blocks.ts';

export interface CallistoProject {
  root: string; // the project root in the upload ('' or 'folder/')
  version: [number, number, number]; // the Callisto version the project pins (else the one followed here)
  patches: string[]; // patches.toml in its order (upload paths)
  missing: string[]; // listed patches the upload lacks
  header: string | null; // the project's callisto_header (upload path)
  tools: Record<CallistoTool, ToolFolder | null>;
  left: { file: string; what: string }[]; // files of the project that are not part of the package
  overworld: string | null; // its BPS of the overworld (upload path, when the upload has it): the sample levels' messages (its layer 1 tiles: a graphics part)
  graphics: string | null; // the folder of its global GFX files: Graphics/ next to the output ROM (upload path)
}
export type CallistoTool = 'uberasm' | 'gps' | 'pixi';
// a tool's folder in the upload and its list file
export interface ToolFolder { folder: string; list: string | null }

// the version followed when the project doesn't name one
const FOLLOWED: [number, number, number] = [0, 6, 2];
// the defines Callisto passes to a patch
export const PATCH_DEFINES: Record<string, string> = { CALLISTO_ASSEMBLING: '1', CALLISTO_INSERTION_TYPE: 'Patch' };
// where the project's files are kept in a tool project (UberASM, GPS), next to its callisto.asm
export const TOOL_ROOT = 'callisto/';

const dec = new TextDecoder();
const CONFIG = /(^|\/)tools\/callisto\/[^/]+\.toml$/i;

// ---------- the configuration (a subset of TOML: tables, strings, numbers, booleans, arrays) ----------

type Value = string | number | boolean | Value[] | null;

// key path ("resources.patches") → value; inline tables and dates are read as null
export function parseToml(text: string, into = new Map<string, Value>()): Map<string, Value> {
  let table = '';
  let i = 0;
  const ws = () => { for (;;) { while (i < text.length && /[ \t\r\n]/.test(text[i])) i++; if (text[i] !== '#') return; while (i < text.length && text[i] !== '\n') i++; } };
  const lineWs = () => { while (i < text.length && /[ \t]/.test(text[i])) i++; };
  const key = (): string => {
    const parts: string[] = [];
    for (;;) {
      lineWs();
      if (text[i] === '"' || text[i] === "'") parts.push(str());
      else { const m = /^[A-Za-z0-9_-]+/.exec(text.slice(i)); if (!m) throw new Error(`TOML: key expected at ${i}`); parts.push(m[0]); i += m[0].length; }
      lineWs();
      if (text[i] !== '.') return parts.join('.');
      i++;
    }
  };
  const str = (): string => {
    const q = text[i];
    const multi = text.startsWith(q.repeat(3), i);
    i += multi ? 3 : 1;
    let out = '';
    while (i < text.length) {
      if (multi ? text.startsWith(q.repeat(3), i) : text[i] === q) { i += multi ? 3 : 1; return out; }
      if (q === '"' && text[i] === '\\') {
        const c = text[i + 1];
        const esc: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\' };
        if (c === 'u' || c === 'U') { const n = c === 'u' ? 4 : 8; out += String.fromCodePoint(parseInt(text.slice(i + 2, i + 2 + n), 16)); i += 2 + n; continue; }
        out += esc[c] ?? c; i += 2; continue;
      }
      out += text[i++];
    }
    throw new Error('TOML: unterminated string');
  };
  const value = (): Value => {
    lineWs();
    const c = text[i];
    if (c === '"' || c === "'") return str();
    if (c === '[') {
      i++;
      const arr: Value[] = [];
      for (;;) {
        ws();
        if (text[i] === ']') { i++; return arr; }
        arr.push(value());
        ws();
        if (text[i] === ',') i++;
      }
    }
    if (c === '{') { let depth = 0; do { if (text[i] === '{') depth++; else if (text[i] === '}') depth--; else if (text[i] === '"' || text[i] === "'") { str(); continue; } i++; } while (depth && i < text.length); return null; }
    const m = /^[^\s,\]#}]+/.exec(text.slice(i));
    if (!m) throw new Error(`TOML: value expected at ${i}`);
    i += m[0].length;
    if (m[0] === 'true' || m[0] === 'false') return m[0] === 'true';
    const n = Number(m[0].replace(/_/g, ''));
    return Number.isNaN(n) ? null : n;
  };
  for (;;) {
    ws();
    if (i >= text.length) return into;
    if (text[i] === '[') {
      const arrayTable = text[i + 1] === '[';
      i += arrayTable ? 2 : 1;
      table = key();
      if (!text.startsWith(arrayTable ? ']]' : ']', i)) throw new Error(`TOML: “]” expected after [${table}`);
      i += arrayTable ? 2 : 1;
      continue;
    }
    const k = key();
    lineWs();
    if (text[i] !== '=') throw new Error(`TOML: “=” expected after ${k}`);
    i++;
    into.set(table ? `${table}.${k}` : k, value());
  }
}

// ---------- the project ----------

const parentOf = (p: string) => p.replace(/[^/]*\/?$/, '');

// a path of the configuration (relative to the project root, with ".." and "./") as an upload path
function joinPath(base: string, rel: string): string | null {
  const parts = base.split('/').filter(Boolean);
  for (const s of rel.replace(/\\/g, '/').split('/')) {
    if (s === '..') { if (!parts.length) return null; parts.pop(); } else if (s && s !== '.') parts.push(s);
  }
  return parts.join('/');
}

// the tool a Callisto tool section is, by its executable
const TOOL_EXE: [RegExp, CallistoTool][] = [[/uberasm/i, 'uberasm'], [/^gps/i, 'gps'], [/^pixi/i, 'pixi']];
// a list file of a tool, by its content
const LIST_OF: Record<CallistoTool, (text: string) => boolean> = {
  uberasm: isUberList,
  gps: isGpsListText,
  pixi: (t) => /^\s*SPRITE\s*:/m.test(t) || t.split(/\r?\n/).some((l) => /^\s*[0-9a-f]{1,2}\s+\S+\.(cfg|json)\s*(;.*)?$/i.test(l)),
};
// Lunar Magic data Callisto applies as BPS: not part of the package
const LEFT_OUT: [string, string][] = [
  ['initial_patch', 'Callisto’s initial patch (FastROM/SA-1 ROM base)'],
  ['overworld', 'the overworld (Lunar Magic data; only its layer 1 tiles\' graphics and the sample levels\' messages are taken from it)'],
  ['titlescreen', 'the title screen (Lunar Magic data)'],
  ['credits', 'the credits (Lunar Magic data)'],
];

// the Callisto project an upload is, null when it is none
export function callistoProject(files: Map<string, Uint8Array>): CallistoProject | null {
  const tomls = [...files.keys()].filter((p) => CONFIG.test(p)).sort();
  if (!tomls.length) return null;
  const dir = parentOf(tomls[0]);
  const conf = new Map<string, Value>();
  for (const t of tomls) if (parentOf(t) === dir) {
    try { parseToml(dec.decode(files.get(t)!), conf); } catch (e) { throw new Error(`${t}: ${e instanceof Error ? e.message : e}`); }
  }
  // the root: project_root, relative to Callisto's folder
  const rootRel = conf.get('settings.project_root');
  const r = joinPath(dir, typeof rootRel === 'string' ? rootRel : '../..');
  const root = r ? r + '/' : '';
  // {variables} in paths
  const vars = new Map<string, string>();
  for (const [k, v] of conf) if (k.startsWith('variables.') && typeof v === 'string') vars.set(k.slice(10), v);
  const subst = (s: string, depth = 0): string => depth > 16 ? s : s.replace(/\{([A-Za-z0-9_]+)\}/g, (all, n: string) => vars.has(n) ? subst(vars.get(n)!, depth + 1) : all);
  const path = (v: Value | undefined): string | null => typeof v === 'string' ? joinPath(root, subst(v)) : null;

  const listed = conf.get('resources.patches');
  const all = (Array.isArray(listed) ? listed : []).map((p) => path(p)).filter((p): p is string => !!p);
  const patches = all.filter((p) => files.has(p)), missing = all.filter((p) => !files.has(p));
  const header = path(conf.get('resources.callisto_header'));

  // tool folders: the tool sections naming UberASM Tool, GPS or PIXI; a list missing from the folder
  // is the upload's only list file of that tool elsewhere (the baserom keeps them in setup/lists/)
  const tools: CallistoProject['tools'] = { uberasm: null, gps: null, pixi: null };
  const sections = new Set([...conf.keys()].filter((k) => /^tools\.(generic\.)?[^.]+\.executable$/.test(k)).map((k) => k.slice(0, -'.executable'.length)));
  for (const s of sections) {
    const exe = String(conf.get(`${s}.executable`) ?? '').replace(/\\/g, '/').split('/').pop()!;
    const tool = TOOL_EXE.find(([re]) => re.test(exe))?.[1];
    const folder = path(conf.get(`${s}.directory`) ?? null);
    if (!tool || folder === null || tools[tool]) continue;
    const f = folder ? folder + '/' : '';
    const inside = f + 'list.txt';
    const lists = [...files.keys()].filter((p) => /\.txt$/i.test(p) && !p.startsWith(f) && LIST_OF[tool](dec.decode(files.get(p)!)));
    tools[tool] = { folder: f, list: files.has(inside) ? inside : lists.length === 1 ? lists[0] : null };
  }
  const left: CallistoProject['left'] = [];
  let overworld: string | null = null;
  for (const [k, what] of LEFT_OUT) {
    const p = path(conf.get(`resources.${k}`));
    if (p) left.push({ file: p, what });
    if (p && k === 'overworld' && files.has(p)) overworld = p;
  }
  // Lunar Magic inserts the global GFX files from the folder Graphics/ next to the ROM
  const output = path(conf.get('output.output_rom'));
  const graphics = output === null ? null : output.slice(0, output.lastIndexOf('/') + 1) + 'Graphics/';
  return { root, version: pinnedVersion(files), patches, missing, header, tools, left, overworld, graphics };
}

// the Callisto version the project's setup downloads (".../callisto/releases/download/v0.6.2/..."), else
// the one followed here
function pinnedVersion(files: Map<string, Uint8Array>): [number, number, number] {
  for (const [p, c] of files) {
    if (!/\.(json|txt|toml|ps1|sh|bat|md)$/i.test(p)) continue;
    const m = /callisto\/releases\/download\/v(\d+)\.(\d+)\.(\d+)/i.exec(dec.decode(c));
    if (m) return [+m[1], +m[2], +m[3]];
  }
  return FOLLOWED;
}

// code including the generated header: a file of a Callisto project
const INCLUDES_HEADER = /^\s*incsrc\s+"?callisto\.asm"?\s*(;.*)?$/im;
export function includesCallistoHeader(text: string): boolean {
  return INCLUDES_HEADER.test(text);
}

// the header Callisto generates (callisto.asm), its paths in the assembler's file system: `root` is where
// the project's root is there ('' = the top, so paths are "/shared/…")
export function callistoAsm(p: CallistoProject, root = ''): string {
  const [ma, mi, pa] = p.version;
  const at = (f: string) => `${root.replace(/\/$/, '')}/${f}`;
  const header = p.header
    ? `; Define containing path to user-specified header file\n!CALLISTO_HEADER = "${at(p.header.slice(p.root.length))}"\n\nincsrc "!CALLISTO_HEADER"\n\n`
    : '';
  return `if not(defined("CALLISTO_INCLUDED"))

; Asar compatible file containing information about callisto, can be imported using incsrc as needed

; Marker define to mark that callisto.asm has been included
!CALLISTO_INCLUDED = 1

; Marker define to determine that callisto is assembling a file
!CALLISTO_ASSEMBLING = 1

; Define containing callisto's version number as a string
!CALLISTO_VERSION = "${ma}.${mi}.${pa}"

; Defines containing callisto's version number as individual numbers
!CALLISTO_VERSION_MAJOR = ${ma}
!CALLISTO_VERSION_MINOR = ${mi}
!CALLISTO_VERSION_PATCH = ${pa}

${header}; Define containing path to project root
!CALLISTO_ROOT = "${root.replace(/\/$/, '')}"

; Define containing path to .callisto folder
!CALLISTO_PATH = "${at('.callisto')}"

; Define containing path to callisto's module imprint folder
!CALLISTO_MODULES = "${at('.callisto/modules')}"

; Macro which includes a specified source code file relative to the project root
macro incsrc_file(file_path)
\tincsrc "!CALLISTO_ROOT/<file_path>"
endmacro

; Macro which includes a specified binary file relative to the project root
macro incbin_file(file_path)
\tincbin "!CALLISTO_ROOT/<file_path>"
endmacro

; Macro which includes the labels of the given module into the current file
macro include_module(module)
\tincsrc "!CALLISTO_MODULES/<module>"
endmacro

; Macro which calls a module label and automatically sets the data bank register
macro call_module(module_label)
\tPHB
\tPEA.w <module_label>>>8
\tPLB
\tPLB
\tJSL <module_label>
\tPLB
endmacro

; Macro which can be used to error out if the version number of the Callisto that's in use is lower than the one passed to the macro
macro require_callisto_version(major, minor, patch)
if !CALLISTO_VERSION_MAJOR > <major>
elseif !CALLISTO_VERSION_MAJOR == <major> && !CALLISTO_VERSION_MINOR > <minor>
elseif !CALLISTO_VERSION_MAJOR == <major> && !CALLISTO_VERSION_MINOR == <minor> && !CALLISTO_VERSION_PATCH >= <patch>
else
\terror "Required Callisto version: <major>.<minor>.<patch>, actual Callisto version: !CALLISTO_VERSION"
endif
endmacro

endif
`;
}

// the project's code outside its tool folders and patches (shared headers, defines, free RAM): what the
// tools' code may include through the project root, kept with them in their projects
export function sharedCode(p: CallistoProject, files: Map<string, Uint8Array>): string[] {
  const folders = Object.values(p.tools).flatMap((t) => (t ? [t.folder] : []));
  return [...files.keys()].filter((f) => f.startsWith(p.root) && /\.(asm|asar)$/i.test(f) && !p.patches.includes(f) && !folders.some((d) => f.startsWith(d))).sort();
}

// the files a tool project gets: callisto.asm and the shared code under TOOL_ROOT (paths in the project)
export function toolFiles(p: CallistoProject, files: Map<string, Uint8Array>): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>([['callisto.asm', new TextEncoder().encode(callistoAsm(p, '/' + TOOL_ROOT))]]);
  for (const f of sharedCode(p, files)) out.set(TOOL_ROOT + f.slice(p.root.length), files.get(f)!);
  return out;
}
