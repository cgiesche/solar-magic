// UberASM-compatible code per level, game mode and overworld map, plus global and status bar code.
// A project is a set of files in UberASM Tool's layout (level/, gamemode/, overworld/, library/,
// routines/, other/) with its list.txt, so existing UberASM folders can be imported and exported as-is.
// Unlike UberASM Tool, everything is assembled as one Asar patch: libraries first (labels
// <file>_<label>), then one free space block per resource (namespace UberR<n>) with a small entry
// stub, then the dispatch code. The hijacks and calling conventions are those of UberASM Tool 2.x:
// labels init/main/end/load/nmi end in RTL, 8-bit A/X/Y, DBR = the resource's bank unless
// ";>dbr off", extra bytes (";>bytes n" / ";>bytes any") pointed to by $00-$01.
// The level number comes from $7E010B, set by the editor patch (SMWE).

import { zipSync } from 'fflate';
import type { PatchSource } from './patchapply.ts';

export type UberContext = 'level' | 'gamemode' | 'overworld';
export const CONTEXT_SIZE: Record<UberContext, number> = { level: 0x200, gamemode: 0x100, overworld: 7 };
const FOLDER: Record<UberContext, string> = { level: 'level/', gamemode: 'gamemode/', overworld: 'overworld/' };
export const ALL = -1; // "*" in list.txt

export interface UberCall { file: string; bytes: number[] } // file relative to the project root
export interface UberList {
  level: Map<number, UberCall[]>;
  gamemode: Map<number, UberCall[]>;
  overworld: Map<number, UberCall[]>;
  global: string | null;
  statusbar: string | null;
  macrolib: string | null;
  freeram: number;
}

export const DEFAULT_FREERAM = 0x7fac80;
export const UBER_NAME = 'UberASM';

function normPath(p: string): string {
  const out: string[] = [];
  for (const part of p.replace(/\\/g, '/').split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop(); else out.push(part);
  }
  return out.join('/');
}
function dirOf(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i + 1);
}

// ---------------------------------------------------------------- list.txt

function parseByte(tok: string): number[] {
  let t = tok.trim();
  let width = 1;
  if (/^\(.*\)$/.test(t)) { width = 2; t = t.slice(1, -1); } else if (/^\[.*\]$/.test(t)) { width = 3; t = t.slice(1, -1); }
  let neg = false;
  if (t.startsWith('-')) { neg = true; t = t.slice(1); }
  let v: number;
  if (t.startsWith('@')) v = parseInt(t.slice(1), 10);
  else if (t.startsWith('%')) v = parseInt(t.slice(1), 2);
  else v = parseInt(t.replace(/^(\$|0x)/i, ''), 16);
  if (Number.isNaN(v)) throw new Error(`Ungültiges Extra-Byte „${tok}“`);
  if (neg) v = -v;
  return Array.from({ length: width }, (_, i) => (v >> (i * 8)) & 0xff);
}

export function emptyList(): UberList {
  return { level: new Map(), gamemode: new Map(), overworld: new Map(), global: null, statusbar: null, macrolib: null, freeram: DEFAULT_FREERAM };
}

export function parseList(text: string): UberList {
  const list = emptyList();
  let ctx: UberContext | null = null;
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.replace(/;.*$/, '').trim();
    if (!line) return;
    const err = (m: string) => new Error(`list.txt Zeile ${i + 1}: ${m}`);
    const cmd = /^([a-z]+):\s*(.*)$/i.exec(line);
    if (cmd) {
      const [, c, arg] = cmd;
      const k = c.toLowerCase();
      if (k === 'level' || k === 'gamemode' || k === 'overworld') { ctx = k; if (arg) throw err('Nach „' + k + ':“ folgen die Einträge in eigenen Zeilen'); return; }
      ctx = null;
      if (k === 'global') list.global = normPath(arg);
      else if (k === 'statusbar') list.statusbar = normPath(arg);
      else if (k === 'macrolib') list.macrolib = normPath(arg);
      else if (k === 'freeram') list.freeram = parseInt(arg.replace(/^\$/, ''), 16);
      // verbose:, rom:, sprite: (1.x) and others are irrelevant here
      return;
    }
    if (!ctx) throw err('Eintrag außerhalb von level:/gamemode:/overworld:');
    const m = /^(\*|[0-9a-f]+)\s+(.+)$/i.exec(line);
    if (!m) throw err(`Unverständlicher Eintrag „${line}“`);
    const num = m[1] === '*' ? ALL : parseInt(m[1], 16);
    if (num !== ALL && num >= CONTEXT_SIZE[ctx]) throw err(`Nummer ${m[1]} außerhalb des gültigen Bereichs`);
    const calls = list[ctx].get(num) ?? [];
    for (const part of m[2].split(',')) {
      const [file, bytes] = part.split(':');
      const f = file.trim();
      if (!f) continue;
      if (f.startsWith('-')) throw err('Das Überspringen von „*“-Ressourcen (-datei.asm) wird nicht unterstützt');
      calls.push({ file: normPath(FOLDER[ctx] + f), bytes: bytes ? bytes.trim().split(/\s+/).flatMap(parseByte) : [] });
    }
    list[ctx].set(num, calls);
  });
  return list;
}

export function writeList(list: UberList): string {
  const out = ['; UberASM list (SMW Editor, UberASM Tool 2.x format)', ''];
  const hex = (n: number, w: number) => n.toString(16).toUpperCase().padStart(w, '0');
  for (const ctx of ['level', 'overworld', 'gamemode'] as UberContext[]) {
    out.push(`${ctx}:`);
    const keys = [...list[ctx].keys()].sort((a, b) => a - b);
    for (const k of keys) {
      const calls = list[ctx].get(k)!;
      if (!calls.length) continue;
      const rel = calls.map((c) => {
        const f = c.file.startsWith(FOLDER[ctx]) ? c.file.slice(FOLDER[ctx].length) : '../' + c.file;
        return c.bytes.length ? `${f} : ${c.bytes.map((b) => hex(b, 2)).join(' ')}` : f;
      });
      out.push(`${k === ALL ? '*' : hex(k, ctx === 'level' ? 3 : 2)} ${rel.join(', ')}`);
    }
    out.push('');
  }
  if (list.global) out.push(`global: ${list.global}`);
  if (list.statusbar) out.push(`statusbar: ${list.statusbar}`);
  if (list.macrolib) out.push(`macrolib: ${list.macrolib}`);
  out.push(`freeram: $${hex(list.freeram, 6)}`, '');
  return out.join('\n');
}

// ---------------------------------------------------------------- defines

// vanilla (non SA-1) addresses of the defines UberASM Tool provides
const SPRITE_TABLES: [string, number][] = [
  ['sprite_num', 0x9e], ['sprite_speed_y', 0xaa], ['sprite_speed_x', 0xb6], ['sprite_misc_c2', 0xc2], ['sprite_y_low', 0xd8], ['sprite_x_low', 0xe4],
  ['sprite_status', 0x14c8], ['sprite_y_high', 0x14d4], ['sprite_x_high', 0x14e0], ['sprite_speed_y_frac', 0x14ec], ['sprite_speed_x_frac', 0x14f8],
  ['sprite_misc_1504', 0x1504], ['sprite_misc_1510', 0x1510], ['sprite_misc_151c', 0x151c], ['sprite_misc_1528', 0x1528], ['sprite_misc_1534', 0x1534],
  ['sprite_misc_1540', 0x1540], ['sprite_misc_154c', 0x154c], ['sprite_misc_1558', 0x1558], ['sprite_misc_1564', 0x1564], ['sprite_misc_1570', 0x1570],
  ['sprite_misc_157c', 0x157c], ['sprite_blocked_status', 0x1588], ['sprite_misc_1594', 0x1594], ['sprite_off_screen_horz', 0x15a0], ['sprite_misc_15ac', 0x15ac],
  ['sprite_slope', 0x15b8], ['sprite_off_screen', 0x15c4], ['sprite_being_eaten', 0x15d0], ['sprite_obj_interact', 0x15dc], ['sprite_oam_index', 0x15ea],
  ['sprite_oam_properties', 0x15f6], ['sprite_misc_1602', 0x1602], ['sprite_misc_160e', 0x160e], ['sprite_index_in_level', 0x161a], ['sprite_misc_1626', 0x1626],
  ['sprite_behind_scenery', 0x1632], ['sprite_misc_163e', 0x163e], ['sprite_in_water', 0x164a], ['sprite_tweaker_1656', 0x1656], ['sprite_tweaker_1662', 0x1662],
  ['sprite_tweaker_166e', 0x166e], ['sprite_tweaker_167a', 0x167a], ['sprite_tweaker_1686', 0x1686], ['sprite_off_screen_vert', 0x186c], ['sprite_misc_187b', 0x187b],
  ['sprite_tweaker_190f', 0x190f], ['sprite_misc_1fd6', 0x1fd6], ['sprite_cape_disable_time', 0x1fe2], ['sprite_load_table', 0x1938],
  ['extra_bits', 0x7fab10], ['new_code_flag', 0x7fab1c], ['extra_prop_1', 0x7fab28], ['extra_prop_2', 0x7fab34], ['new_sprite_num', 0x7fab9e],
  ['extra_byte_1', 0x7fab40], ['extra_byte_2', 0x7fab4c], ['extra_byte_3', 0x7fab58], ['extra_byte_4', 0x7fab64],
];
const RAW_TABLES = ['9E', 'AA', 'B6', 'C2', 'D8', 'E4', '14C8', '14D4', '14E0', '14EC', '14F8', '1504', '1510', '151C', '1528', '1534', '1540', '154C', '1558',
  '1564', '1570', '157C', '1588', '1594', '15A0', '15AC', '15B8', '15C4', '15D0', '15DC', '15EA', '15F6', '1602', '160E', '161A', '1626', '1632', '163E', '164A',
  '1656', '1662', '166E', '167A', '1686', '186C', '187B', '190F', '1FD6', '1FE2', '1938', '7FAB10', '7FAB1C', '7FAB28', '7FAB34', '7FAB9E', '7FAB40', '7FAB4C', '7FAB58'];
const EXTENDED: [string, number][] = [
  ['extended_num', 0x170b], ['extended_y_low', 0x1715], ['extended_y_high', 0x1729], ['extended_x_low', 0x171f], ['extended_x_high', 0x1733],
  ['extended_x_speed', 0x1747], ['extended_y_speed', 0x173d], ['extended_x_fraction', 0x175b], ['extended_y_fraction', 0x1751], ['extended_table', 0x1765],
  ['extended_timer', 0x176f], ['extended_behind', 0x1779], ['extended_table_1', 0x1765], ['extended_table_2', 0x198c], ['extended_table_3', 0x1996],
  ['extended_table_4', 0x19a0], ['extended_table_5', 0x19aa],
];

export function definesFile(freeram: number): string {
  const h = (n: number) => '$' + n.toString(16).toUpperCase();
  return `; generated by SMW Editor: the defines and macros UberASM Tool offers to resources
lorom
!sa1 = 0
!fullsa1 = 0
!dp = $0000
!addr = $0000
!bank = $800000
!bank8 = $80
!sprite_slots = 12
!Has255SpritesPerLevel = 0
!EXLEVEL = 0
!UberMajorVersion = 2
!UberMinorVersion = 2
!UberFreeram = ${h(freeram)}
!level = $010B
!previous_mode = !UberFreeram
!ExtendedOffset = $13
${SPRITE_TABLES.map(([n, a]) => `!${n} = ${h(a)}`).join('\n')}
${RAW_TABLES.map((n) => `!${n} = $${n}`).join('\n')}
!7FAB64 = $7FAB64
${EXTENDED.map(([n, a]) => `!${n} = ${h(a)}`).join('\n')}

macro require_uber_ver(major, minor)
  if (<major>*256)+<minor> > (!UberMajorVersion*256)+!UberMinorVersion
    error "This resource requires UberASM Tool version at least <major>.<minor>"
  endif
endmacro

macro UberRoutine(name)
  if not(defined("UberRoutine_<name>"))
    pushpc
    freecode cleaned
    global #UberRoutine_<name>:
    !UberRoutine_<name> = UberRoutine_<name>
    incsrc "routines/<name>.asm"
    pullpc
  endif
  JSL !UberRoutine_<name>
endmacro

macro prot_file(file, label, ...)
  pushpc
  freedata cleaned
  <label>:
  if sizeof(...) == 0
    incbin "<file>"
  elseif sizeof(...) == 1
    incbin "<file>":<...[0]>..0
  else
    incbin "<file>":<...[0]>..(<...[0]>)+(<...[1]>)
  endif
  pullpc
endmacro

macro prot_source(file, label)
  pushpc
  freecode cleaned
  <label>:
  incsrc "<file>"
  pullpc
endmacro

macro move_block(src, dest, len)
  PHB
  REP #$30
  LDA.w #<len>-1
  LDX.w #<src>
  LDY.w #<dest>
  MVN <dest>>>16,<src>>>16
  SEP #$30
  PLB
endmacro

macro define_sprite_table(name, addr, addr_sa1)
  !<name> = <addr>
endmacro

macro define_base2_address(name, addr)
  !<name> = <addr>
endmacro

macro Force255SpritesPerLevel()
  !Has255SpritesPerLevel = 1
  !1938 = $7FAF00
  !7FAF00 = $7FAF00
  !sprite_load_table = $7FAF00
endmacro
`;
}

// ---------------------------------------------------------------- generation

const LABELS = ['init', 'main', 'end', 'load', 'nmi'] as const;
type EntryLabel = (typeof LABELS)[number];
const OFFSET: Record<EntryLabel, number> = { init: 0, main: 2, end: 4, load: 6, nmi: 8 };

const dec = new TextDecoder();
function text(files: Map<string, Uint8Array>, path: string): string {
  const f = files.get(path);
  if (!f) throw new Error(`Datei „${path}“ fehlt im UberASM-Projekt`);
  return dec.decode(f);
}

// top-level labels a resource defines, following its incsrc'd files
function scanLabels(files: Map<string, Uint8Array>, path: string, seen = new Set<string>()): Set<string> {
  const found = new Set<string>();
  if (seen.has(path) || !files.has(path)) return found;
  seen.add(path);
  for (const raw of text(files, path).split(/\r?\n/)) {
    const line = raw.replace(/;.*$/, '');
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(line);
    if (m) found.add(m[1]);
    const inc = /^\s*incsrc\s+"?([^"\s]+)"?/i.exec(line);
    if (inc) for (const l of scanLabels(files, normPath(dirOf(path) + inc[1]), seen)) found.add(l);
  }
  return found;
}

interface ResourceInfo { id: number; file: string; labels: Set<EntryLabel>; dbr: boolean; bytes: number | 'any' | 0; uses: number[][] }

function resourceInfo(files: Map<string, Uint8Array>, file: string, id: number): ResourceInfo {
  const src = text(files, file);
  const lines = src.split(/\r?\n/);
  const labels = new Set([...scanLabels(files, file)].filter((l): l is EntryLabel => (LABELS as readonly string[]).includes(l)));
  const b = lines.find((l) => l.startsWith(';>bytes '));
  let bytes: ResourceInfo['bytes'] = 0;
  if (b) {
    const t = b.slice(8).trim();
    bytes = t === 'any' ? 'any' : parseInt(t, 10);
    if (bytes !== 'any' && (Number.isNaN(bytes) || bytes < 0 || bytes > 255)) throw new Error(`${file}: ungültige „;>bytes“-Angabe`);
  }
  return { id, file, labels, dbr: !lines.includes(';>dbr off'), bytes, uses: [] };
}

export interface UberBuild { source: PatchSource; resources: number; warnings: string[] }

export function buildUberPatch(files: Map<string, Uint8Array>, list: UberList): UberBuild {
  const warnings: string[] = [];
  const res = new Map<string, ResourceInfo>();
  const resource = (file: string) => {
    let r = res.get(file);
    if (!r) { r = resourceInfo(files, file, res.size); res.set(file, r); }
    return r;
  };
  // per context: number → [resource, bytes index] in call order ("*" first)
  type Call = { r: ResourceInfo; b: number };
  const calls: Record<UberContext, Map<number, Call[]>> = { level: new Map(), gamemode: new Map(), overworld: new Map() };
  for (const ctx of ['level', 'gamemode', 'overworld'] as UberContext[]) {
    const all = list[ctx].get(ALL) ?? [];
    for (const [num, cs] of list[ctx]) if (num !== ALL && cs.length === 0) list[ctx].delete(num);
    const nums = all.length ? Array.from({ length: CONTEXT_SIZE[ctx] }, (_, i) => i) : [...list[ctx].keys()].filter((n) => n !== ALL);
    for (const n of nums) {
      const cl = [...all, ...(list[ctx].get(n) ?? [])];
      if (!cl.length) continue;
      calls[ctx].set(n, cl.map((c) => {
        const r = resource(c.file);
        let bytes = c.bytes;
        if (r.bytes === 'any') bytes = [bytes.length, ...bytes];
        else if (r.bytes !== bytes.length) {
          if (bytes.length < r.bytes) warnings.push(`${c.file} erwartet ${r.bytes} Extra-Byte(s), angegeben: ${bytes.length}`);
          bytes = [...bytes, ...new Array(Math.max(0, r.bytes - bytes.length)).fill(0)].slice(0, r.bytes);
        }
        let b = -1;
        if (bytes.length) {
          b = r.uses.findIndex((u) => u.length === bytes.length && u.every((v, i) => v === bytes[i]));
          if (b < 0) { b = r.uses.length; r.uses.push(bytes); }
        }
        return { r, b };
      }));
    }
  }

  const out: string[] = [];
  const o = (...l: string[]) => out.push(...l);
  o('; generated by SMW Editor from list.txt – do not edit', 'incsrc "__uber_defines.asm"');
  if (list.macrolib && files.has(list.macrolib)) o(`incsrc "${list.macrolib}"`);
  const used = (ctx: UberContext) => calls[ctx].size > 0;
  const nmiUsed = (ctx: UberContext) => [...calls[ctx].values()].some((cs) => cs.some((c) => c.r.labels.has('nmi')));
  const anyNmi = nmiUsed('level') || nmiUsed('gamemode') || nmiUsed('overworld');

  // hijacks (addresses and replaced code as in UberASM Tool 2.x)
  if (used('level')) {
    o('org $05808C', '  JML UberLevelLoad', '  NOP');
    o('org $00A5EE', '  JML UberLevelInit', '  NOP');
    o('org $00A242', '  JML UberLevelMain', '  NOP');
    o('org $00A295', '  NOP #4 ; OAM clear moved before level main');
    o('org $00A2EE', '  JML UberLevelEnd', '  NOP');
  }
  if (used('overworld')) {
    o('org $00A1C3', '  JML UberOwMainEnd');
    o('org $00A18F', '  JML UberOwInit', '  NOP #2');
  }
  if (used('gamemode')) o('org $009322', '  JML UberGamemode', '  RTS', '  NOP #2');
  o('org $00804E', '  JML UberGlobalInit');
  if (anyNmi) o('org $008176', '  JML UberNmi', '  NOP #2');
  if (list.statusbar && files.has(list.statusbar)) o('org $008E1A', '  JML UberStatus', '  NOP');

  // libraries: labels <path without extension, / and space → _>_<label>
  for (const f of [...files.keys()].filter((p) => p.startsWith('library/')).sort()) {
    const prefix = f.slice(8).replace(/\.[^./]*$/, '').replace(/[ /]/g, '_');
    if (/\.asm$/i.test(f)) o('', 'freecode cleaned', `namespace ${prefix}`, `incsrc "${f}"`, 'namespace off');
    else o('', 'freedata cleaned', `${prefix}:`, `incbin "${f}"`);
  }

  // resources: entry stub (X = label offset) and extra bytes in the resource's bank
  for (const r of res.values()) {
    o('', 'freecode cleaned', `namespace UberR${r.id}`, `incsrc "${r.file}"`, '__UberCall:');
    if (r.dbr) o('  PHB : PHK : PLB');
    o('  PHK : PEA.w __UberRet-1', '  JMP (__UberTbl,x)', '__UberRet:');
    if (r.dbr) o('  PLB');
    o('  RTL', '__UberNone:', '  RTL', `__UberTbl: dw ${LABELS.map((l) => (r.labels.has(l) ? l : '__UberNone')).join(', ')}`);
    r.uses.forEach((u, i) => o(`__UberB${i}: db ${u.map((v) => '$' + v.toString(16).padStart(2, '0')).join(',')}`));
    o('namespace off');
  }

  // dispatch
  o('', 'freecode cleaned', 'UberNoRes:', '  RTS');
  const routine = (name: string, cs: Call[], nmi: boolean) => {
    o(`${name}:`, '  SEP #$30');
    for (const c of cs) {
      if (nmi && !c.r.labels.has('nmi')) continue;
      o('  LDA $03,S : TAX');
      if (c.b >= 0) o(`  LDA.b #UberR${c.r.id}___UberB${c.b} : STA $00`, `  LDA.b #UberR${c.r.id}___UberB${c.b}>>8 : STA $01`);
      o(`  JSL UberR${c.r.id}___UberCall`);
    }
    o('  RTS');
  };
  const tables = (ctx: UberContext, tag: string, nmi: boolean) => {
    const names = new Map<string, string>();
    const ptr: string[] = [];
    for (let n = 0; n < CONTEXT_SIZE[ctx]; n++) {
      const cs = (calls[ctx].get(n) ?? []).filter((c) => !nmi || c.r.labels.has('nmi'));
      if (!cs.length) { ptr.push('UberNoRes'); continue; }
      const key = cs.map((c) => `${c.r.id}:${c.b}`).join(',');
      let name = names.get(key);
      if (!name) { name = `Uber${tag}${names.size}`; names.set(key, name); routine(name, cs, nmi); }
      ptr.push(name);
    }
    o(`Uber${tag}Ptrs:`);
    for (let i = 0; i < ptr.length; i += 8) o('  dw ' + ptr.slice(i, i + 8).join(', '));
  };
  // X (8 bit) = label offset; the offset is kept on the stack for the call routines ($03,S)
  const dispatch = (tag: string, index: string[]) => o(`Uber${tag}Dispatch:`, '  TXA : PHA', ...index, `  JSR (Uber${tag}Ptrs,x)`, '  SEP #$30', '  PLA', '  RTS');
  const lvIndex = ['  REP #$30', '  LDA !level : AND #$01FF : ASL : TAX', '  SEP #$20'];
  const gmIndex = ['  REP #$30', '  LDA !previous_mode : AND #$00FF : ASL : TAX', '  SEP #$20'];
  const owIndex = ['  LDX $0DB3 : LDA $1F11,x : ASL : TAX'];

  if (used('level')) {
    tables('level', 'Lv', false);
    dispatch('Lv', lvIndex);
    o('UberLevelLoad:', '  SEP #$30', '  PHB', `  LDX #${OFFSET.load}`, '  JSR UberLvDispatch', '  PLB',
      '  REP #$10', '  PHK', '  PEA.w .ret-1', '  PEA.w $8125-1', '  JML $0583AC', '.ret', '  SEP #$30', '  JML $058091');
    o('UberLevelInit:', '  SEP #$30', '  PHB', `  LDX #${OFFSET.init}`, '  JSR UberLvDispatch', '  PLB',
      '  PHK', '  PEA.w .ret-1', '  PEA.w $84CF-1', '  JML $00919B', '.ret', '  JML $00A5F3');
    o('UberLevelMain:', '  PHB', '  LDA $13D4', '  BNE +', '  JSL $7F8000', '+', `  LDX #${OFFSET.main}`, '  JSR UberLvDispatch', '  PLB',
      '  LDA $13D4', '  BEQ +', '  JML $00A25B', '+', '  JML $00A28A');
    o('UberLevelEnd:', '  STA $1C', '  PHB', `  LDX #${OFFSET.end}`, '  JSR UberLvDispatch', '  PLB', '  JML $008494');
  }
  if (used('overworld')) {
    tables('overworld', 'Ow', false);
    dispatch('Ow', owIndex);
    o('UberOwMainEnd:', '  JSL $7F8000', '  PHB', `  LDX #${OFFSET.main}`, '  JSR UberOwDispatch',
      '  JSL $048241', `  LDX #${OFFSET.end}`, '  JSR UberOwDispatch', '  PLB', '  JML $008494');
    o('UberOwInit:', '  PHK', '  PEA.w .ret-1', '  PEA.w $84CF-1', '  JML $0092A0', '.ret',
      '  PHB', `  LDX #${OFFSET.init}`, '  JSR UberOwDispatch', '  PLB', '  JML $0093F4');
  }
  if (used('gamemode')) {
    tables('gamemode', 'Gm', false);
    dispatch('Gm', gmIndex);
    o('UberGamemode:', '  PHB', `  LDX #${OFFSET.main}`, '  LDA $0100', '  CMP !previous_mode', '  STA !previous_mode', '  BEQ +', `  LDX #${OFFSET.init}`, '+',
      '  JSR UberGmDispatch', '  PLB',
      '  LDA !previous_mode', '  CMP #$29', '  BCS .end', '  ASL : TAX', '  LDA $9329,x : STA $00', '  LDA $932A,x : STA $01', '  STZ $02',
      '  PHK', '  PEA.w .end-1', '  PEA.w $84CF-1', '  JML [$0000]',
      '.end', '  PHB', `  LDX #${OFFSET.end}`, '  JSR UberGmDispatch', '  PLB', '  JML $009326');
  }
  if (anyNmi) {
    if (nmiUsed('level')) { tables('level', 'LvNmi', true); dispatch('LvNmi', lvIndex); }
    if (nmiUsed('overworld')) { tables('overworld', 'OwNmi', true); dispatch('OwNmi', owIndex); }
    if (nmiUsed('gamemode')) { tables('gamemode', 'GmNmi', true); dispatch('GmNmi', ['  REP #$30', '  LDA $0100 : AND #$00FF : ASL : TAX', '  SEP #$20']); }
    o('UberNmi:', '  LDA $4210', '  PHB', '  PEI ($00)');
    if (nmiUsed('gamemode')) o(`  LDX #${OFFSET.nmi}`, '  JSR UberGmNmiDispatch');
    // level code for game modes $13/$14 (and $05-$07, the title screen level), overworld for $0D/$0E
    o('  LDA $0100', '  CMP #$14 : BEQ .lv', '  CMP #$13 : BEQ .lv', '  CMP #$08 : BCS .ow', '  CMP #$05 : BCC .ow', '.lv');
    if (nmiUsed('level')) o(`  LDX #${OFFSET.nmi}`, '  JSR UberLvNmiDispatch');
    o('  BRA .ret', '.ow', '  LDA $0100', '  CMP #$0D : BEQ +', '  CMP #$0E : BNE .ret', '+');
    if (nmiUsed('overworld')) o(`  LDX #${OFFSET.nmi}`, '  JSR UberOwNmiDispatch');
    o('.ret', '  REP #$20 : PLA : STA $00 : SEP #$20', '  PLB', '  LDA $1DFB', '  JML $00817C');
  }
  // global code: init (RTS) at power-on, also sets up !previous_mode
  o('UberGlobalInit:', '  STA $7F8182', '  LDA #$00 : STA !previous_mode+1', '  DEC : STA !previous_mode', '  JSR UberGlobal_init', '  JML $008052');
  o('namespace UberGlobal');
  const gl = list.global && files.has(list.global) ? list.global : null;
  if (gl) o(`incsrc "${gl}"`);
  if (!gl || !scanLabels(files, gl).has('init')) o('init:', '  RTS');
  o('namespace off');
  if (list.statusbar && files.has(list.statusbar)) {
    o('UberStatus:', '  JSR UberStatus_main', '  LDA $1493', '  ORA $9D', '  JML $008E1F', 'namespace UberStatus', `incsrc "${list.statusbar}"`);
    if (!scanLabels(files, list.statusbar).has('main')) o('main:', '  RTS');
    o('namespace off');
  }
  for (const [ctx, what] of [['global', list.global], ['statusbar', list.statusbar], ['macrolib', list.macrolib]] as const) {
    if (what && !files.has(what)) warnings.push(`${ctx}: Datei „${what}“ fehlt – wird ignoriert`);
  }

  const src = new Map<string, Uint8Array | string>(files);
  src.set('__uber_defines.asm', definesFile(list.freeram));
  src.set('__uber_main.asm', out.join('\n') + '\n');
  const project = new Map(files);
  project.set('list.txt', new TextEncoder().encode(writeList(list)));
  const archive = zipSync(Object.fromEntries(project), { level: 9 });
  return { source: { name: UBER_NAME, main: '__uber_main.asm', files: src, kind: 'uberasm', archive, ram: [[list.freeram, 2]] }, resources: res.size, warnings };
}

// resource files of a context folder (for the UI)
export function resourceFiles(files: Map<string, Uint8Array>, ctx: UberContext): string[] {
  return [...files.keys()].filter((p) => p.startsWith(FOLDER[ctx]) && /\.asm$/i.test(p)).sort();
}
