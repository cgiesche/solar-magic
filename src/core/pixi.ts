// Custom sprites in PIXI format (see docs/pixi.md). A project is a set of files in PIXI's layout
// (sprites/, shooters/, generators/, cluster/, extended/, misc_sprites/<type>/, routines/) with its
// list.txt. Like PIXI, every sprite is assembled on its own (so labels and macros of different sprites
// don't collide), but all runs are recorded as one patch:
//  1. the shared routines the sprites use (each one once; routines/ of the project before the built-in ones)
//  2. each sprite, seeing the defines, the routines as %Name() → JSL and the _header.asm of its type
//  3. the runtime (pixirt.ts) with the tables filled from the sprites' cfg/json and their prints

import { zipSync, unzipSync } from 'fflate';
import { Rom } from './rom.ts';
import { applyPatch, reapplyPatch, uninstallPatch, type ApplyResult, type PatchSource } from './patchapply.ts';
import type { AsarResult } from './asar.ts';
import { listPatches, patchArchive, type PatchEntry } from './patchreg.ts';
import { pixiDefines, HEADERS, runtimeAsm, STATUS_LABELS, MISC_OFFSET, type SpriteFolder, type SpriteRow } from './pixirt.ts';
import { ROUTINES } from './pixiroutines.ts';

export const PIXI_NAME = 'Custom Sprites';

export const FOLDER: Record<SpriteFolder, string> = {
  sprites: 'sprites/', shooters: 'shooters/', generators: 'generators/', cluster: 'cluster/', extended: 'extended/',
  minorextended: 'misc_sprites/minorextended/', bounce: 'misc_sprites/bounce/', smoke: 'misc_sprites/smoke/',
  spinningcoin: 'misc_sprites/spinningcoin/', score: 'misc_sprites/score/',
};
// list.txt headlines; shooters and generators are part of SPRITE: (by number)
const SECTION: Record<string, SpriteFolder> = {
  SPRITE: 'sprites', CLUSTER: 'cluster', EXTENDED: 'extended', MINOREXTENDED: 'minorextended', BOUNCE: 'bounce',
  SMOKE: 'smoke', SPINNINGCOIN: 'spinningcoin', SCORE: 'score',
};
export const KIND_LABEL: Record<SpriteFolder, string> = {
  sprites: 'Sprite', shooters: 'Shooter', generators: 'Generator', cluster: 'Cluster', extended: 'Extended',
  minorextended: 'Minor Extended', bounce: 'Bounce', smoke: 'Smoke', spinningcoin: 'Spinning Coin', score: 'Score',
};
export const MISC_KINDS: SpriteFolder[] = ['cluster', 'extended', 'minorextended', 'bounce', 'smoke', 'spinningcoin', 'score'];
// numbers a custom sprite of a type can have
export function numberRange(kind: SpriteFolder): [number, number] {
  if (kind === 'sprites') return [0x00, 0xbf];
  if (kind === 'shooters') return [0xc0, 0xcf];
  if (kind === 'generators') return [0xd0, 0xdf];
  return [0x00, 0xff - MISC_OFFSET[kind]!];
}
const levelKind = (num: number): SpriteFolder => (num < 0xc0 ? 'sprites' : num < 0xd0 ? 'shooters' : 'generators');

export interface PixiEntry { kind: SpriteFolder; num: number; file: string } // file relative to the project root
export interface PixiProject { files: Map<string, Uint8Array>; list: PixiEntry[] }

const enc = new TextEncoder();
const dec = new TextDecoder();

function normPath(p: string): string {
  const out: string[] = [];
  for (const part of p.replace(/\\/g, '/').split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop(); else out.push(part);
  }
  return out.join('/');
}
const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '');

// ---------------------------------------------------------------- list.txt

export function parsePixiList(text: string): PixiEntry[] {
  const out: PixiEntry[] = [];
  let section: SpriteFolder = 'sprites';
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.replace(/;.*$/, '').trim();
    if (!line) return;
    const err = (m: string) => new Error(`list.txt Zeile ${i + 1}: ${m}`);
    const head = /^([A-Z]+):$/i.exec(line);
    if (head) {
      const k = SECTION[head[1].toUpperCase()];
      if (!k) throw err(`Unbekannter Abschnitt „${head[1]}:“`);
      section = k;
      return;
    }
    if (/^[0-9a-f]+:[0-9a-f]+\s/i.test(line)) throw err('Per-Level-Sprites (Level:Nummer) werden nicht unterstützt');
    const m = /^([0-9a-f]{1,2})\s+(.+?)(?:\s+(display|nodisplay))?$/i.exec(line);
    if (!m) throw err(`Unverständlicher Eintrag „${line}“`);
    const num = parseInt(m[1], 16);
    const kind = section === 'sprites' ? levelKind(num) : section;
    const [lo, hi] = numberRange(kind);
    if (num < lo || num > hi) throw err(`Nummer ${m[1]} liegt außerhalb von ${lo.toString(16).toUpperCase()}–${hi.toString(16).toUpperCase()}`);
    const file = m[2].trim();
    const isCfg = /\.(cfg|json)$/i.test(file);
    if (section === 'sprites' ? !isCfg : !/\.asm$/i.test(file)) throw err(section === 'sprites' ? `„${file}“: Sprites brauchen eine .cfg- oder .json-Datei` : `„${file}“: hier wird eine .asm-Datei erwartet`);
    out.push({ kind, num, file: normPath(FOLDER[kind] + file) });
  });
  return out;
}

export function writePixiList(list: PixiEntry[]): string {
  const hx = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');
  const out = ['; custom sprites (SMW Editor, PIXI format)'];
  const byKind = (k: SpriteFolder[]) => list.filter((e) => k.includes(e.kind)).sort((a, b) => a.num - b.num);
  for (const e of byKind(['sprites', 'shooters', 'generators'])) out.push(`${hx(e.num)} ${e.file.slice(FOLDER[e.kind].length)}`);
  for (const [head, k] of Object.entries(SECTION)) {
    if (k === 'sprites') continue;
    const es = byKind([k]);
    if (!es.length) continue;
    out.push('', `${head}:`, ...es.map((e) => `${hx(e.num)} ${e.file.slice(FOLDER[k].length)}`));
  }
  return out.join('\n') + '\n';
}

// ---------------------------------------------------------------- cfg / json

export interface SpriteConfig {
  type: number; // 0 = tweak, 1 = custom
  actlike: number;
  tweak: number[]; // $1656 $1662 $166E $167A $1686 $190F
  prop: [number, number];
  asm: string | null; // project path
  bytes: number; // extra bytes with the extra bit clear
  bytesExtra: number; // ... and set
  names: { name: string; extraBit: boolean }[]; // "Collection" of a json
  description: string; // first display text of a json
}

// bit names of the tweaker bytes in json files, in bit order 7..0 (PIXI's CFG editor)
const TWEAK_BITS: Record<string, [string | null, number, number][]> = {
  // [name, bit, width] – names are matched case-insensitively
  $1656: [['Object Clipping', 0, 4], ['Can be jumped on', 4, 1], ['Dies when jumped on', 5, 1], ['Hop in/kick shell', 6, 1], ['Disappears in cloud of smoke', 7, 1]],
  $1662: [['Sprite Clipping', 0, 6], ['Use shell as death frame', 6, 1], ['Fall straight down when killed', 7, 1]],
  $166E: [['Use second graphics page', 0, 1], ['Palette', 1, 3], ['Disable fireball killing', 4, 1], ['Disable cape killing', 5, 1], ['Disable water splash', 6, 1], ["Don't interact with Layer 2", 7, 1]],
  $167A: [["Don't disable cliping when starkilled", 0, 1], ['Invincible to star/cape/fire/bounce blk.', 1, 1], ['Process when off screen', 2, 1], ["Don't change into shell when stunned", 3, 1],
    ["Can't be kicked like shell", 4, 1], ['Process interaction with Mario every frame', 5, 1], ['Gives power-up when eaten by yoshi', 6, 1], ["Don't use default interaction with Mario", 7, 1]],
  $1686: [['Inedible', 0, 1], ["Stay in Yoshi's mouth", 1, 1], ['Weird ground behaviour', 2, 1], ["Don't interact with other sprites", 3, 1],
    ["Don't change direction if touched", 4, 1], ["Don't turn into coin when goal passed", 5, 1], ['Spawn a new sprite', 6, 1], ["Don't interact with objects", 7, 1]],
  $190F: [['Make platform passable from below', 0, 1], ["Don't erase when goal passed", 1, 1], ["Can't be killed by sliding", 2, 1], ['Takes 5 fireballs to kill', 3, 1],
    ['Can be jumped on with upwards Y speed', 4, 1], ['Death frame two tiles high', 5, 1], ["Don't turn into a coin with silver POW", 6, 1], ["Don't get stuck in walls (carryable sprites)", 7, 1]],
};

function tweakByte(obj: Record<string, unknown> | undefined, key: string): number {
  if (!obj) return 0;
  const vals = new Map(Object.entries(obj).map(([k, v]) => [k.toLowerCase(), v]));
  let b = 0;
  for (const [name, bit, width] of TWEAK_BITS[key]) {
    const v = vals.get(name!.toLowerCase());
    const n = typeof v === 'boolean' ? (v ? 1 : 0) : Number(v ?? 0);
    b |= (n & ((1 << width) - 1)) << bit;
  }
  return b;
}

export function parseCfg(text: string, path: string): SpriteConfig {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const hexes = (l: string | undefined, n: number, what: string) => {
    const v = (l ?? '').split(/\s+/).map((x) => parseInt(x, 16));
    if (v.length < n || v.slice(0, n).some((x) => Number.isNaN(x))) throw new Error(`${path}: ${what} fehlt oder ist ungültig`);
    return v.slice(0, n);
  };
  const [type] = hexes(lines[0], 1, 'Typ');
  const [actlike] = hexes(lines[1], 1, '„acts like“');
  const tweak = hexes(lines[2], 6, 'Tweaker-Zeile');
  const prop = hexes(lines[3], 2, 'Extra Property Bytes') as [number, number];
  const asm = lines[4] ? normPath(dirOf(path) + lines[4]) : null;
  let bytes = 0, bytesExtra = 0;
  const bc = lines[5];
  if (bc && bc.includes(':')) {
    const [a, b] = bc.split(':').map((x) => parseInt(x.trim(), 16));
    if (Number.isNaN(a) || Number.isNaN(b) || a > 12 || b > 12) throw new Error(`${path}: Anzahl der Extra-Bytes ungültig (00–0C)`);
    bytes = a; bytesExtra = b;
  }
  const name = path.slice(path.lastIndexOf('/') + 1).replace(/\.cfg$/i, '');
  return { type, actlike, tweak, prop, asm: type ? asm : null, bytes, bytesExtra, names: [{ name, extraBit: false }], description: '' };
}

export function parseJsonCfg(text: string, path: string): SpriteConfig {
  let j: Record<string, any>;
  try { j = JSON.parse(text.replace(/^﻿/, '')); } catch (e) { throw new Error(`${path}: ungültiges JSON (${e instanceof Error ? e.message : e})`); }
  const num = (k: string, d = 0) => { const v = j[k]; return v === undefined ? d : Number(v); };
  const type = num('Type');
  const clamp = (n: number) => Math.max(0, Math.min(12, n | 0));
  const names = Array.isArray(j.Collection) ? j.Collection.map((c: any) => ({ name: String(c.Name ?? ''), extraBit: !!c.ExtraBit })).filter((c: any) => c.name) : [];
  const disp = Array.isArray(j.Displays) ? j.Displays : [];
  const description = String(disp[0]?.Description ?? '').replace(/\\n/g, '\n').trim();
  return {
    type, actlike: num('ActLike'),
    tweak: ['$1656', '$1662', '$166E', '$167A', '$1686', '$190F'].map((k) => tweakByte(j[k], k)),
    prop: [num('Extra Property Byte 1') & 0xff, num('Extra Property Byte 2') & 0xff],
    asm: type && j.AsmFile ? normPath(dirOf(path) + String(j.AsmFile)) : null,
    bytes: type ? clamp(num('Additional Byte Count (extra bit clear)')) : 0,
    bytesExtra: type ? clamp(num('Additional Byte Count (extra bit set)')) : 0,
    names: names.length ? names : [{ name: path.slice(path.lastIndexOf('/') + 1).replace(/\.json$/i, ''), extraBit: false }],
    description,
  };
}

// the cfg/json of a sprite, shooter or generator; misc sprites only have their asm
export function spriteConfig(p: PixiProject, e: PixiEntry): SpriteConfig {
  const data = p.files.get(e.file);
  if (!data) throw new Error(`Datei „${e.file}“ fehlt`);
  if (/\.json$/i.test(e.file)) return parseJsonCfg(dec.decode(data), e.file);
  if (/\.cfg$/i.test(e.file)) return parseCfg(dec.decode(data), e.file);
  const name = e.file.slice(e.file.lastIndexOf('/') + 1).replace(/\.asm$/i, '');
  return { type: 1, actlike: 0, tweak: [0, 0, 0, 0, 0, 0], prop: [0, 0], asm: e.file, bytes: 0, bytesExtra: 0, names: [{ name, extraBit: false }], description: '' };
}

// $400 byte size table (index = extra bits * $100 + number, value = 3 + extra bytes)
export function sizeTable(p: PixiProject): Uint8Array {
  const t = new Uint8Array(0x400).fill(3);
  for (const e of p.list) {
    if (MISC_KINDS.includes(e.kind)) continue;
    const c = spriteConfig(p, e);
    t[0x200 + e.num] = 3 + c.bytes;
    t[0x300 + e.num] = 3 + c.bytesExtra;
  }
  return t;
}

// ---------------------------------------------------------------- routines

// routine name → file: routines/Bounce/GetDrawInfo.asm is %BounceGetDrawInfo()
export function projectRoutines(files: Map<string, Uint8Array>): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of files.keys()) {
    const m = /^routines\/(.+)\.asm$/i.exec(f);
    if (m) out.set(m[1].split('/').join(''), f);
  }
  return out;
}

const ROUTINE_USE = /%([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;

// ---------------------------------------------------------------- patch

const BUILTIN_DIR = '__pixi/';

interface Built { entry: PixiEntry; cfg: SpriteConfig }

export function buildPixiPatch(p: PixiProject): PatchSource {
  const files = new Map<string, Uint8Array | string>(p.files);
  const built: Built[] = p.list.map((entry) => ({ entry, cfg: spriteConfig(p, entry) }));
  for (const b of built) if (b.cfg.asm && !p.files.has(b.cfg.asm)) throw new Error(`${b.entry.file}: ASM-Datei „${b.cfg.asm}“ fehlt`);
  const code = built.filter((b) => b.cfg.asm);

  // shared routines: the project's own, then the built-in ones
  const own = projectRoutines(p.files);
  const all = new Map<string, string>(own);
  for (const name of Object.keys(ROUTINES)) {
    if (all.has(name)) continue;
    const f = `${BUILTIN_DIR}routines/${name}.asm`;
    files.set(f, ROUTINES[name]);
    all.set(name, f);
  }
  // routines named anywhere in the project's code or the headers of the types it uses
  const kinds = new Set(code.map((b) => b.entry.kind));
  const texts = [...[...p.files].filter(([f]) => /\.asm$/i.test(f) && !f.startsWith('routines/')).map(([, v]) => dec.decode(v)),
    ...[...kinds].map((k) => HEADERS[k])];
  const used = new Set<string>();
  for (const t of texts) for (const m of t.matchAll(ROUTINE_USE)) if (all.has(m[1])) used.add(m[1]);

  files.set(`${BUILTIN_DIR}defines.asm`, pixiDefines());
  for (const k of Object.keys(HEADERS) as SpriteFolder[]) files.set(`${BUILTIN_DIR}header_${k}.asm`, HEADERS[k]);
  // step 1: each routine once, in free space; routines may call each other
  const rel = (f: string) => '../'.repeat(BUILTIN_DIR.split('/').length - 1) + f;
  const defs = ['namespace nested on'];
  for (const [name, f] of all) {
    defs.push(`macro PixiUse_${name}()
  if not(defined("PixiR_${name}_done"))
    !PixiR_${name}_done = 1
    pushpc
    freecode cleaned
    global #PixiR_${name}:
    namespace PixiN_${name}
    incsrc "${rel(f)}"
    namespace off
    pullpc
  endif
endmacro
macro ${name}()
  %PixiUse_${name}()
  JSL PixiR_${name}
endmacro`);
  }
  files.set(`${BUILTIN_DIR}routines_main.asm`, ['incsrc "defines.asm"', ...defs, ...[...used].sort().map((n) => `%PixiUse_${n}()`), ''].join('\n'));

  const sizes = sizeTable(p);
  const rows: (SpriteRow | null)[] = new Array(256).fill(null);
  for (const b of built) {
    if (MISC_KINDS.includes(b.entry.kind)) continue;
    rows[b.entry.num] = { type: b.cfg.type ? 1 : 0, actlike: b.cfg.actlike, tweak: b.cfg.tweak, prop: b.cfg.prop, init: 0, main: 0, status: [0, 0, 0, 0, 0] };
  }

  // the prints of a sprite's run: INIT/MAIN/... with their address
  const entryPoints = (r: AsarResult, b: Built): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const line of r.prints) {
      const m = /^\s*([A-Z]+)\s*:?\s*\$?([0-9A-Fa-f]{6})\s*$/.exec(line);
      if (m) out[m[1]] = parseInt(m[2], 16);
    }
    if (out.MAIN === undefined) throw new Error(`${b.cfg.asm}: kein „print "MAIN ",pc“`);
    return out;
  };

  let step = 0; // 0 = routines done, 1..code.length = sprites done
  return {
    name: PIXI_NAME,
    main: `${BUILTIN_DIR}routines_main.asm`,
    files,
    kind: 'pixi',
    archive: projectToZip(p),
    next: (done) => {
      const out = new Map<string, string>();
      if (step > code.length) return null; // the runtime was the last run
      if (step === 0) {
        // routines as JSL to where they were put
        const labels = done[0].labels;
        const calls = [...all.keys()].map((n) => labels[`PixiR_${n}`] !== undefined
          ? `macro ${n}()\n  JSL $${labels[`PixiR_${n}`].toString(16).toUpperCase().padStart(6, '0')}\nendmacro`
          : `macro ${n}()\n  error "Shared Routine ${n} wurde nicht eingefügt"\nendmacro`);
        out.set(`${BUILTIN_DIR}routines.asm`, calls.join('\n') + '\n');
      } else {
        const b = code[step - 1];
        const ep = entryPoints(done[step], b);
        const row = rows[b.entry.num];
        if (row) {
          row.init = ep.INIT ?? 0;
          row.main = ep.MAIN;
          row.status = STATUS_LABELS.map((l) => ep[l] ?? 0);
        }
      }
      if (step < code.length) {
        const b = code[step++];
        const header = p.files.has(FOLDER[b.entry.kind] + '_header.asm') ? rel(FOLDER[b.entry.kind] + '_header.asm') : `header_${b.entry.kind}.asm`;
        const main = `${BUILTIN_DIR}sprite_${step}.asm`;
        out.set(main, ['incsrc "defines.asm"', 'incsrc "routines.asm"', `incsrc "${header}"`, 'freecode cleaned', 'PixiEntry:', `incsrc "${rel(b.cfg.asm!)}"`, ''].join('\n'));
        return { main, files: out };
      }
      {
        step++;
        const main = `${BUILTIN_DIR}runtime.asm`;
        out.set(main, 'incsrc "defines.asm"\n' + runtimeAsm({ sizes, sprites: rows }));
        return { main, files: out };
      }
    },
  };
}

// ---------------------------------------------------------------- project storage

export function projectToZip(p: PixiProject): Uint8Array {
  const all: Record<string, Uint8Array> = Object.fromEntries(p.files);
  all['list.txt'] = enc.encode(writePixiList(p.list));
  return zipSync(all, { level: 9 });
}

export function projectFromZip(data: Uint8Array): PixiProject {
  const raw = new Map<string, Uint8Array>();
  for (const [k, v] of Object.entries(unzipSync(data))) if (!k.endsWith('/') && !k.startsWith('__MACOSX/')) raw.set(k.replace(/\\/g, '/'), v);
  // a PIXI folder may sit one level down; the tool's own files are not needed
  let root = '';
  if (!raw.has('list.txt')) {
    const l = [...raw.keys()].find((k) => /^[^/]+\/list\.txt$/i.test(k));
    if (l) root = l.slice(0, l.indexOf('/') + 1);
  }
  const files = new Map<string, Uint8Array>();
  for (const [k, v] of raw) {
    if (!k.startsWith(root)) continue;
    const rel = k.slice(root.length);
    if (/^(sprites|shooters|generators|cluster|extended|misc_sprites|routines)\//.test(rel)) files.set(rel, v);
  }
  const lt = raw.get(root + 'list.txt');
  return { files, list: lt ? parsePixiList(dec.decode(lt)) : [] };
}

export function pixiEntry(rom: Rom): PatchEntry | null {
  return listPatches(rom).find((p) => p.kind === 'pixi') ?? null;
}
export function loadPixiProject(rom: Rom): PixiProject | null {
  const e = pixiEntry(rom);
  if (!e) return null;
  const a = patchArchive(rom, e);
  return a ? projectFromZip(a) : null;
}

// assembles the project (replacing an installed one); an empty list removes it
export function savePixiProject(rom: Rom, p: PixiProject): ApplyResult {
  const e = pixiEntry(rom);
  if (!p.list.length) {
    const warnings = e ? uninstallPatch(rom, e.id) : [];
    return { ok: true, errors: [], warnings, prints: [] };
  }
  let src: PatchSource;
  try {
    src = buildPixiPatch(p);
  } catch (err) {
    return { ok: false, errors: [err instanceof Error ? err.message : String(err)], warnings: [], prints: [] };
  }
  const snapshot = rom.data.slice();
  try {
    return e ? reapplyPatch(rom, e.id, src) : applyPatch(rom, src);
  } catch (err) {
    rom.data = snapshot;
    return { ok: false, errors: [err instanceof Error ? err.message : String(err)], warnings: [], prints: [] };
  }
}

export function removePixi(rom: Rom): string[] {
  const e = pixiEntry(rom);
  return e ? uninstallPatch(rom, e.id) : [];
}
