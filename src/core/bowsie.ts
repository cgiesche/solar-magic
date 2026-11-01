// Custom overworld sprites in BOWSIE's format (Better Overworld Sprite Insertion Engine, Arinsu;
// https://github.com/arinsuwu/bowsie). A project is a set of files in BOWSIE's layout (sprites/, routines/) with its
// list.txt (`NN file.asm`, numbers 01–7E). BOWSIE itself is not run: its steps are done here with the built-in Asar
// and BOWSIE's own ASM (src/vendor/bowsie, with three fixes for running without MaxTile: tools/build-bowsie.sh), all runs
// recorded as one patch:
//  1. the shared routines, all in one free space block (each %name() a JSL to it)
//  2. each sprite on its own in a namespace (init/main labels, `!extra` its extra bytes, 2 when not set)
//  3. the system of a vanilla overworld (vldc9.asm): its signature and pointers at $04EF3E, the loader in place of
//     the game's overworld sprite load (at $04F625, so the game's 13 sprite slots are gone while it is installed),
//     the size table for Lunar Magic's custom sprite table ($0DE18C, $42) and bit 3 of $0FFFE0 cleared
// BOWSIE's settings as it runs by default, except MaxTile: off (BOWSIE needs Lunar Magic's "disable event path fade
// effect" for it). What its meOWmeOW does – rewriting the sprite table when the sizes change – is done after the
// patch (the table in Lunar Magic's format, owcustom.ts). Its Lunar Magic display files (.s16ov/.sscov) are not made:
// the editor draws the sprites by emulation.

import { zipSync, unzipSync } from 'fflate';
import type { Rom } from './rom.ts';
import { applyPatch, reapplyPatch, uninstallPatch, type ApplyResult, type PatchSource } from './patchapply.ts';
import { listPatches, patchArchive, missingSources, type PatchEntry } from './patchreg.ts';
import { BOWSIE_ASM, BOWSIE_ROUTINES, BOWSIE_VERSION } from '../vendor/bowsie/bowsie.ts';
import { readCustomSprites, writeCustomSprites, customSizeTable, OW_CUSTOM_IDS, BOWSIE_PTR } from './owcustom.ts';

export const BOWSIE_NAME = 'Overworld Sprites (BOWSIE)';
export { BOWSIE_PTR, bowsieInstalled } from './owcustom.ts';
export const BOWSIE_SLOTS = 24; // sprites at a time (BOWSIE's default for a vanilla overworld)
export const BOWSIE_FIRST = 0x01, BOWSIE_LAST = 0x7e; // numbers (its pointer tables have 0x7E entries)
const LM_VERSION = 371; // the Lunar Magic whose formats the editor writes (BOWSIE reads it from the ROM)
const UNUSED = 0x048414; // an RTL in bank 4: the init and main of numbers without a sprite

export interface BowsieEntry { num: number; file: string } // file relative to the project root (sprites/…)
export interface BowsieProject { files: Map<string, Uint8Array>; list: BowsieEntry[] }

const enc = new TextEncoder();
const dec = new TextDecoder();
const hx = (n: number, w = 2) => n.toString(16).toUpperCase().padStart(w, '0');
const base = (f: string) => f.slice(f.lastIndexOf('/') + 1);

// ---------------------------------------------------------------- list.txt

export function parseBowsieList(text: string): BowsieEntry[] {
  const out: BowsieEntry[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith(';')) return;
    const m = /^([0-9a-f]{1,2})\s+(.+\.asm)"?$/i.exec(line.replace(/"/g, ''));
    if (!m) throw new Error(`list.txt line ${i + 1}: unrecognized entry “${line}”`);
    const num = parseInt(m[1], 16);
    if (num < BOWSIE_FIRST || num > BOWSIE_LAST) throw new Error(`list.txt line ${i + 1}: number ${m[1]} is outside 01–7E`);
    if (out.some((e) => e.num === num)) throw new Error(`list.txt line ${i + 1}: number ${m[1]} twice`);
    out.push({ num, file: 'sprites/' + m[2].trim().replace(/\\/g, '/') });
  });
  return out;
}
export function writeBowsieList(list: BowsieEntry[]): string {
  return [...list].sort((a, b) => a.num - b.num).map((e) => `${hx(e.num)} ${e.file.replace(/^sprites\//, '')}`).join('\n') + '\n';
}

// assigns a sprite file to a number, in place of what had that number
export function assignOwSprite(p: BowsieProject, e: BowsieEntry): void {
  p.list = p.list.filter((x) => x.num !== e.num);
  p.list.push(e);
}

// ---------------------------------------------------------------- the sprites' files

// a sprite of BOWSIE: an .asm with the labels init and main
export function isBowsieSprite(text: string): boolean {
  const st = text.split(/\r?\n/).map((l) => l.replace(/;.*$/, '').trim());
  return st.some((l) => /^init\s*:/i.test(l)) && st.some((l) => /^main\s*:/i.test(l))
    && /ow_sprite_|!bowsie_|oam_buffer\[|%get_draw_info\(|%maxtile_|OWSpr/i.test(text);
}

// what the editor shows of a sprite: its name (the file's), its tooltip (BOWSIE's .json next to it), its extra bytes
// (`!extra`, 2 when not set: BOWSIE's default)
export interface BowsieSpriteInfo { num: number; file: string; name: string; description: string; extra: number }
export function bowsieSpriteInfo(p: BowsieProject, e: BowsieEntry): BowsieSpriteInfo {
  const text = p.files.get(e.file);
  const json = p.files.get(e.file.replace(/\.asm$/i, '.json'));
  let description = '';
  try { if (json) description = String(JSON.parse(dec.decode(json).replace(/^﻿/, '')).tooltip ?? ''); } catch { /* no tooltip */ }
  const m = text ? /^\s*!extra\s*=\s*(\$?[0-9a-f]+)\s*$/im.exec(dec.decode(text)) : null;
  const extra = m ? (m[1].startsWith('$') ? parseInt(m[1].slice(1), 16) : parseInt(m[1], 10)) : 2;
  return { num: e.num, file: e.file, name: base(e.file).replace(/\.asm$/i, ''), description, extra };
}
export const bowsieSprites = (p: BowsieProject): BowsieSpriteInfo[] => [...p.list].sort((a, b) => a.num - b.num).map((e) => bowsieSpriteInfo(p, e));

// ---------------------------------------------------------------- patch

const DIR = '__bowsie/';

// bowsie_defines.asm as BOWSIE generates it for its settings
function defines(): string {
  return `!bowsie_ow_slots = ${BOWSIE_SLOTS}
!bowsie_version = 1
!bowsie_subversion = ${BOWSIE_VERSION.split('.')[1]}

!bowsie_contiguous = 0

!bowsie_maxtile = 0

!bowsie_lmver = ${LM_VERSION}

if read1($00FFD5) == $23
    if read1($00FFD7) == $0D
        fullsa1rom
    else
        sa1rom
    endif
    !sa1 = 1
    !dp = $3000
    !addr = $6000
    !bank = $000000
else
    lorom
    !sa1 = 0
    !dp = $0000
    !addr = $0000
    !bank = $800000
endif

!bowsie_owrev = 0
if read4($048000) == $524F4659
    !bowsie_owrev = 1
endif

!bowsie_widescreen_ow = equal(read1($04FB2A), $5C)
if !bowsie_owrev
    !bowsie_widescreen_ow = not(equal(read1($0480D3)&$30, $00))
endif

optimize dp always
dpbase !dp

optimize address mirrors
bank auto

`;
}

// a sprite's label as BOWSIE makes it: its file name and number (decimal), without what can't be in a label
const spriteLabel = (e: BowsieEntry) => (base(e.file).replace(/\..*$/, '') + '_' + e.num).toLowerCase().replace(/[^a-z0-9_]/g, '');

export function buildBowsiePatch(p: BowsieProject): { src: PatchSource; sizes: () => Uint8Array } {
  for (const e of p.list) if (!p.files.has(e.file)) throw new Error(`Overworld sprite ${hx(e.num)}: file “${e.file}” is missing`);
  const files = new Map<string, Uint8Array | string>(p.files);
  for (const [f, t] of Object.entries(BOWSIE_ASM)) files.set(DIR + f, t);
  files.set(DIR + 'bowsie_defines.asm', defines());
  const routines = Object.keys(BOWSIE_ROUTINES).map((f) => f.replace(/\.asm$/, ''));
  for (const [f, t] of Object.entries(BOWSIE_ROUTINES)) files.set(`${DIR}routines/${f}`, t);
  // step 1: the routines, calling each other by their labels
  files.set(DIR + 'routines_main.asm', [
    'incsrc vldc9_defines.asm', 'incsrc maxtile_defines.asm', '',
    ...routines.map((n) => `macro ${n}()\n    JSL ${n}_${n}\nendmacro\n`),
    'freecode cleaned', '',
    ...routines.map((n) => `namespace ${n}\n    ${n}:\n        incsrc "routines/${n}.asm"\n    print "Shared subroutine %${n}() inserted at $", hex(${n})\nnamespace off\n`),
  ].join('\n'));
  const sprites = [...p.list].sort((a, b) => a.num - b.num);
  const init = new Array<number>(BOWSIE_LAST).fill(UNUSED), main = new Array<number>(BOWSIE_LAST).fill(UNUSED);
  const sizes = new Uint8Array(OW_CUSTOM_IDS).fill(3);
  let ssr = '';
  const addr = (line: string) => parseInt(/\$([0-9A-Fa-f]+)/.exec(line)?.[1] ?? 'x', 16);
  let step = 0; // 0: routines done; 1..n: sprite n done; n+1: the system done
  const src: PatchSource = {
    name: BOWSIE_NAME,
    version: BOWSIE_VERSION,
    main: DIR + 'routines_main.asm',
    files,
    kind: 'owsprite',
    archive: bowsieToZip(p),
    next: (done) => {
      const last = done[done.length - 1], out = new Map<string, string>();
      if (step === 0) {
        const at = last.prints.filter((l) => l.includes('Shared subroutine')).map(addr);
        if (at.length !== routines.length || at.some(Number.isNaN)) throw new Error('BOWSIE: the shared routines were not all inserted');
        ssr = routines.map((n, i) => `macro ${n}()\n    JSL $${hx(at[i], 6)}\nendmacro\n`).join('\n');
        out.set(DIR + 'ssr.asm', ssr);
        // (the system's step writes their pointers after the signature, as BOWSIE does)
        out.set(DIR + 'routine_ptrs.asm', at.map((a, i) => `org $${hx(BOWSIE_PTR + 7 + i * 3, 6)}\n    dl $${hx(a, 6)}`).join('\n') + '\n');
      } else if (step <= sprites.length) {
        const e = sprites[step - 1], ps = last.prints;
        const i = ps.find((l) => /Init routine inserted at/.test(l)), m = ps.find((l) => /Main routine inserted at/.test(l));
        if (!i || !m) throw new Error(`${e.file}: BOWSIE found no init or main label`);
        init[e.num - 1] = addr(i); main[e.num - 1] = addr(m);
        const x = ps.find((l) => /Extra bytes:/.test(l));
        const extra = x ? parseInt(x.slice(x.indexOf(':') + 1).trim(), 10) : 2;
        if (!(extra >= 0 && extra <= 8)) throw new Error(`${e.file}: extra bytes ${x?.slice(x.indexOf(':') + 1).trim()} – BOWSIE takes 0–8`);
        sizes[e.num - 1] = 3 + extra;
      } else if (step === sprites.length + 1) return null;
      step++;
      if (step <= sprites.length) {
        const e = sprites[step - 1], label = spriteLabel(e);
        const f = `${DIR}sprite_${step}.asm`;
        out.set(f, `incsrc vldc9_defines.asm
incsrc maxtile_defines.asm
incsrc ssr.asm
incsrc macro.asm
namespace ${label}
    freecode cleaned
    incsrc "../${e.file}"
    !extra ?= 2
    print "Sprite ${hx(e.num)} - ${base(e.file)}"
    print "    Init routine inserted at: $", hex(${label}_init)
    print "    Main routine inserted at: $", hex(${label}_main)
    if !bowsie_lmver > 350
        print "    Extra bytes: ", dec(!extra)
    endif
namespace off
`);
        return { main: f, files: out };
      }
      // the system, its pointer tables and the size table
      const ptrs = (a: number[]) => Uint8Array.from(a.flatMap((v) => [v & 0xff, (v >> 8) & 0xff, v >> 16]));
      const bins = new Map<string, Uint8Array | string>([...out, [DIR + 'init_ptrs.bin', ptrs(init)], [DIR + 'main_ptrs.bin', ptrs(main)], [DIR + 'extra_size.bin', sizes]]);
      const f = DIR + 'system.asm';
      bins.set(f, `incsrc "vldc9_defines.asm"
incsrc "ssr.asm"
incsrc "macro.asm"
incsrc "maxtile_defines.asm"
org $${hx(BOWSIE_PTR, 6)}
    dd $05C7CA00
    dl ow_sprite_init_ptrs

${BOWSIE_ASM['vldc9.asm']}
ow_sprite_init_ptrs:
    incbin init_ptrs.bin
ow_sprite_main_ptrs:
    incbin main_ptrs.bin
incsrc "routine_ptrs.asm"
`);
      return { main: f, files: bins };
    },
  };
  return { src, sizes: () => sizes };
}

// ---------------------------------------------------------------- project storage

export function bowsieToZip(p: BowsieProject): Uint8Array {
  const all: Record<string, Uint8Array> = Object.fromEntries(p.files);
  all['list.txt'] = enc.encode(writeBowsieList(p.list));
  return zipSync(all, { level: 9 });
}
export function bowsieFromZip(data: Uint8Array): BowsieProject {
  const files = new Map<string, Uint8Array>();
  let list: Uint8Array | undefined;
  for (const [k, v] of Object.entries(unzipSync(data))) {
    if (k.endsWith('/')) continue;
    if (k === 'list.txt') list = v; else files.set(k, v);
  }
  return { files, list: list ? parseBowsieList(dec.decode(list)) : [] };
}

export function bowsieEntry(rom: Rom): PatchEntry | null {
  return listPatches(rom).find((p) => p.kind === 'owsprite') ?? null;
}
export function loadBowsieProject(rom: Rom): BowsieProject | null {
  const e = bowsieEntry(rom);
  if (!e) return null;
  const a = patchArchive(rom, e);
  if (!a) throw missingSources('overworld sprite');
  return bowsieFromZip(a);
}

// assembles the project (replacing an installed one); a project without sprites and files removes BOWSIE. The custom
// sprite table is written again for the new sizes (as BOWSIE's meOWmeOW: extra bytes kept as far as they go; with
// BOWSIE in the ROM its pointer is a table or 0, owcustom.ts).
export function saveBowsieProject(rom: Rom, p: BowsieProject): ApplyResult {
  const e = bowsieEntry(rom);
  const fail = (err: unknown): ApplyResult => ({ ok: false, errors: [err instanceof Error ? err.message : String(err)], warnings: [], prints: [] });
  let lists;
  try { lists = readCustomSprites(rom); } catch (err) { return fail(err); }
  const after = (r: ApplyResult): ApplyResult => {
    if (!r.ok) return r;
    const was = JSON.stringify(lists);
    writeCustomSprites(rom, lists, customSizeTable(rom));
    if (JSON.stringify(readCustomSprites(rom)) !== was) r.warnings.push('The extra bytes of placed overworld sprites were adjusted to their new count.');
    return r;
  };
  try {
    if (!p.list.length && !p.files.size) return e ? after({ ok: true, errors: [], warnings: uninstallPatch(rom, e.id), prints: [] }) : { ok: true, errors: [], warnings: [], prints: [] };
    const { src } = buildBowsiePatch(p);
    return after(e ? reapplyPatch(rom, e.id, src) : applyPatch(rom, src));
  } catch (err) { return fail(err); }
}

export function removeBowsie(rom: Rom): string[] {
  const r = saveBowsieProject(rom, { files: new Map(), list: [] });
  if (!r.ok) throw new Error(r.errors.join(' '));
  return r.warnings;
}

// ---------------------------------------------------------------- packages

// the sprites of an upload (their .asm files) and, per sprite, the files going with it: its folder's (the .json next
// to it, what it includes), without other sprites' own files
export function bowsieUploadSprites(files: Map<string, Uint8Array>): string[] {
  return [...files.keys()].filter((f) => /\.asm$/i.test(f) && isBowsieSprite(dec.decode(files.get(f)!))).sort();
}

// where a file of the upload goes in the project: below sprites/, with the path after a sprites folder of the upload
// kept (else its own folder's name and the file)
function destOf(f: string): string {
  const parts = f.split('/'), i = parts.map((p) => p.toLowerCase()).lastIndexOf('sprites', parts.length - 2);
  return 'sprites/' + (i >= 0 ? parts.slice(i + 1) : parts.slice(Math.max(0, parts.length - 2))).join('/');
}

// the numbers a BOWSIE list.txt of the upload gives its sprites (by the sprite's file)
function listedNumbers(files: Map<string, Uint8Array>, sprites: string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const [f, data] of files) {
    if (!/(^|\/)list\.txt$/i.test(f)) continue;
    for (const line of dec.decode(data).split(/\r?\n/)) {
      const m = /^\s*([0-9a-f]{1,2})\s+"?([^"]+\.asm)"?\s*$/i.exec(line);
      if (!m) continue;
      const file = sprites.find((s) => s.toLowerCase().endsWith('/' + m[2].replace(/\\/g, '/').toLowerCase()) || s.toLowerCase() === m[2].toLowerCase());
      const n = parseInt(m[1], 16);
      if (file && !out.has(file) && n >= BOWSIE_FIRST && n <= BOWSIE_LAST) out.set(file, n);
    }
  }
  return out;
}

// adds the upload's sprites (mains: their .asm files) to the ROM's project, each with the files of its folder (but
// `others`: the files of the package's other parts) – a sprite already there keeps its number, the others take the
// number a list.txt of the upload gives them when free, else the next free one; claim: every project file it writes
export function applyBowsieUpload(rom: Rom, files: Map<string, Uint8Array>, mains: string[], others: Set<string>, claim: (file: string) => void): ApplyResult {
  const proj: BowsieProject = loadBowsieProject(rom) ?? { files: new Map(), list: [] };
  const listed = listedNumbers(files, mains);
  const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '');
  for (const main of mains) {
    const dir = dirOf(main);
    for (const f of files.keys()) {
      if (!f.startsWith(dir) || f.slice(dir.length).includes('/') || others.has(f) || (f !== main && mains.includes(f)) || /(^|\/)list\.txt$/i.test(f)) continue;
      if (f !== main && !/\.(asm|json|bin|txt)$/i.test(f)) continue;
      const to = destOf(f);
      proj.files.set(to, files.get(f)!);
      claim(to);
    }
  }
  const taken = () => new Set(proj.list.map((e) => e.num));
  for (const main of mains) {
    const file = destOf(main);
    if (proj.list.some((e) => e.file === file)) continue;
    const want = listed.get(main);
    let num = want !== undefined && !taken().has(want) ? want : BOWSIE_FIRST;
    while (taken().has(num) && num <= BOWSIE_LAST) num++;
    if (num > BOWSIE_LAST) return { ok: false, errors: ['All overworld sprite numbers up to 7E are used.'], warnings: [], prints: [] };
    proj.list.push({ num, file });
  }
  return saveBowsieProject(rom, proj);
}
