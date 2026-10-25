// Custom blocks in GPS format. A project holds blocks/*.asm, routines/*.asm (shared routines, used as
// %name()) and a list.txt as GPS uses it ("200 block.asm" or "200:130 block.asm" = tile, acts like).
// All blocks are assembled as one Asar patch; the editor then enters the address of each block's JMP
// table into the block table of the Map16 extension (map16ext.ts), which calls the block code.
// A block starts with "db $42" (10 offsets) or "db $37" (+ WallFeet, WallBody), followed by one JMP per
// offset; the code ends with RTL.

import { zipSync, unzipSync } from 'fflate';
import { Rom } from './rom.ts';
import { applyPatch, reapplyPatch, uninstallPatch, type ApplyResult, type PatchSource } from './patchapply.ts';
import { listPatches, patchArchive, missingSources, type PatchEntry } from './patchreg.ts';
import { setBlock, setActsLike, EXT_TILES } from './map16ext.ts';
import { definesFile, DEFAULT_FREERAM } from './uberasm.ts';
import { GPS_ROUTINES, GPS_DEFINES } from './gpsroutines.ts';

export const BLOCKS_NAME = 'Custom Blocks';

export interface BlockAssign { tile: number; file: string; acts?: number } // file relative to the project root
export interface BlockProject { files: Map<string, Uint8Array>; list: BlockAssign[] }

// puts a block on a Map16 tile, in place of the block that was on it (one block per tile) – for
// installing and for the Blocks tab
export function assignBlock(p: BlockProject, a: BlockAssign): void {
  p.list = p.list.filter((b) => b.tile !== a.tile);
  p.list.push(a);
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export function parseBlockList(text: string): BlockAssign[] {
  const out: BlockAssign[] = [];
  let blocks = true; // GPS's further sections (@dsc: Lunar Magic's tile descriptions) are not read
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.replace(/;.*$/, '').trim();
    if (line.startsWith('@')) blocks = false;
    if (!line || !blocks) return;
    // a tile or a range of tiles ("332-335"), each with the block
    const m = /^([0-9a-f]+)(?:-([0-9a-f]+))?(?::([0-9a-f]+))?\s+(.+)$/i.exec(line);
    if (!m) throw new Error(`list.txt line ${i + 1}: unrecognized entry “${line}”`);
    const first = parseInt(m[1], 16), last = m[2] ? parseInt(m[2], 16) : first;
    if (last >= EXT_TILES) throw new Error(`list.txt line ${i + 1}: tile ${m[2] ?? m[1]} is outside 000–FFF`);
    if (last < first) throw new Error(`list.txt line ${i + 1}: range ${m[1]}-${m[2]} is backwards`);
    for (let tile = first; tile <= last; tile++) out.push({ tile, file: 'blocks/' + m[4].trim().replace(/\\/g, '/'), acts: m[3] ? parseInt(m[3], 16) : undefined });
  });
  return out;
}

export function writeBlockList(list: BlockAssign[]): string {
  const h = (n: number) => n.toString(16).toUpperCase().padStart(3, '0');
  return ['; custom blocks (Solar Magic, GPS format)', ...[...list].sort((a, b) => a.tile - b.tile)
    .map((b) => `${h(b.tile)}${b.acts !== undefined ? ':' + h(b.acts) : ''} ${b.file.replace(/^blocks\//, '')}`), ''].join('\n');
}

export function blockFiles(files: Map<string, Uint8Array>): string[] {
  return [...files.keys()].filter((p) => p.startsWith('blocks/') && /\.asm$/i.test(p)).sort();
}

// freeram: !UberFreeram of the ROM's UberASM patch (the defines are those of UberASM's). As GPS does it:
// each block in an Asar run of its own (blocks may define the same macros); a shared routine is put in
// the run of the first block using it (with that block's defines; after its code, so the routine's label
// doesn't become the parent of the block's sublabels), later blocks call it there
export function buildBlockPatch(p: BlockProject, freeram = DEFAULT_FREERAM): PatchSource {
  const used = [...new Set(p.list.map((b) => b.file))];
  for (const f of used) if (!p.files.has(f)) throw new Error(`Block file “${f}” is missing`);
  // shared routines as %name(): the project's own, then GPS's standard ones
  const files = new Map<string, Uint8Array | string>(p.files);
  const routines = new Map([...p.files.keys()].filter((f) => /^routines\/[A-Za-z0-9_]+\.asm$/.test(f)).map((f) => [f.slice(9, -4), f]));
  for (const [n, text] of Object.entries(GPS_ROUTINES)) {
    if (routines.has(n)) continue;
    files.set(`__gps_routines/${n}.asm`, text);
    routines.set(n, `__gps_routines/${n}.asm`);
  }
  const defines = definesFile(freeram) + GPS_DEFINES + '\n';
  const placed = new Map<string, number>(); // routine → where an earlier run put it
  const hex6 = (a: number) => '$' + a.toString(16).toUpperCase().padStart(6, '0');
  // the run of block i: the routines placed so far as calls, the others put after the block when used
  // (by it or by a routine put there: as many rounds as there are routines)
  const run = (i: number) => {
    const open = [...routines].filter(([n]) => !placed.has(n));
    const macros = [...routines].map(([n]) => `macro ${n}()\n  ${placed.has(n) ? `JSL ${hex6(placed.get(n)!)}` : `!GpsNeed_${n} = 1\n  JSL GpsRoutine_${n}`}\nendmacro`);
    // (in a macro: the standard routines use macro labels)
    const put = open.map(([n, f]) => `macro GpsPut_${n}()\n  freecode cleaned\n  GpsRoutine_${n}:\n  incsrc "${f}"\nendmacro`);
    const tail = Array.from({ length: open.length }, () => open.map(([n]) => `if defined("GpsNeed_${n}") && not(defined("GpsDone_${n}"))\n  !GpsDone_${n} = 1\n  %GpsPut_${n}()\nendif`)).flat();
    const main = `__gps_block_${i}.asm`;
    const out = new Map<string, string>([
      ['__gps_defines.asm', defines + [...macros, ...put].join('\n') + '\n'],
      // each block in its namespace: GpsB<i>_GpsBlock
      // (a project without assignments keeps its files: nothing to assemble)
      [main, ['; generated by Solar Magic from list.txt – do not edit', 'incsrc "__gps_defines.asm"', ...(i < used.length ? ['freecode cleaned', `namespace GpsB${i}`, 'GpsBlock:', `incsrc "${used[i]}"`, 'namespace off', ...tail] : []), ''].join('\n')],
    ]);
    return { main, files: out };
  };
  const first = run(0);
  for (const [k, v] of first.files) files.set(k, v);
  let step = 1;
  return {
    name: BLOCKS_NAME, main: first.main, files, kind: 'block', archive: projectToZip(p),
    next: (done) => {
      for (const [n] of routines) { const a = done[done.length - 1].labels[`GpsRoutine_${n}`]; if (a !== undefined && !placed.has(n)) placed.set(n, a); }
      return step < used.length ? run(step++) : null;
    },
  };
}

export function projectToZip(p: BlockProject): Uint8Array {
  const all: Record<string, Uint8Array> = Object.fromEntries(p.files);
  all['list.txt'] = enc.encode(writeBlockList(p.list));
  return zipSync(all, { level: 9 });
}
export function projectFromZip(data: Uint8Array): BlockProject {
  const raw = new Map<string, Uint8Array>();
  for (const [k, v] of Object.entries(unzipSync(data))) if (!k.endsWith('/') && !k.startsWith('__MACOSX/')) raw.set(k.replace(/\\/g, '/'), v);
  // a GPS folder may sit one level down; the tool's own files are not needed
  let root = '';
  if (!raw.has('list.txt')) {
    const l = [...raw.keys()].find((k) => /^[^/]+\/list\.txt$/i.test(k));
    if (l) root = l.slice(0, l.indexOf('/') + 1);
  }
  const files = new Map<string, Uint8Array>();
  for (const [k, v] of raw) {
    if (!k.startsWith(root)) continue;
    const rel = k.slice(root.length);
    if (/^(blocks|routines)\//.test(rel)) files.set(rel, v);
  }
  const lt = raw.get(root + 'list.txt');
  return { files, list: lt ? parseBlockList(dec.decode(lt)) : [] };
}

export function blocksEntry(rom: Rom): PatchEntry | null {
  return listPatches(rom).find((p) => p.kind === 'block') ?? null;
}
export function loadBlockProject(rom: Rom): BlockProject | null {
  const e = blocksEntry(rom);
  if (!e) return null;
  const a = patchArchive(rom, e);
  if (!a) throw missingSources('custom block');
  return projectFromZip(a);
}

function clearTable(rom: Rom): void {
  for (let t = 0; t < EXT_TILES; t++) setBlock(rom, t, 0, false);
}

// assembles the blocks and enters them into the block table. A project without assignments keeps its
// files (to assign them again); without files too it is removed.
export function saveBlockProject(rom: Rom, p: BlockProject): ApplyResult {
  const e = blocksEntry(rom);
  if (!p.list.length && ![...p.files.keys()].some((f) => f !== 'list.txt')) {
    const warnings = e ? removeBlocks(rom) : [];
    return { ok: true, errors: [], warnings, prints: [] };
  }
  let r: ApplyResult;
  try {
    const uber = listPatches(rom).find((x) => x.kind === 'uberasm');
    const src = buildBlockPatch(p, uber?.ram?.[0]?.[0]);
    r = e ? reapplyPatch(rom, e.id, src) : applyPatch(rom, src);
  } catch (err) {
    return { ok: false, errors: [err instanceof Error ? err.message : String(err)], warnings: [], prints: [] };
  }
  if (!r.ok) return r;
  // blocks are identified by their GpsB<n>_GpsBlock label, in the order of first use in the list
  const used = [...new Set(p.list.map((b) => b.file))];
  const labels = r.labels ?? {};
  const errors: string[] = [];
  const addrOf = new Map<string, { addr: number; wall: boolean }>();
  used.forEach((f, i) => {
    const a = labels[`GpsB${i}_GpsBlock`];
    const head = a === undefined ? -1 : rom.r8(a);
    if (head !== 0x42 && head !== 0x37) errors.push(`${f}: does not start with “db $42” or “db $37” – not a GPS block`);
    else addrOf.set(f, { addr: a + 1, wall: head === 0x37 });
  });
  if (errors.length) return { ok: false, errors, warnings: r.warnings, prints: r.prints };
  clearTable(rom);
  for (const b of p.list) {
    const x = addrOf.get(b.file)!;
    setBlock(rom, b.tile, x.addr, x.wall);
    if (b.acts !== undefined) setActsLike(rom, b.tile, b.acts);
  }
  return r;
}

// removes the blocks patch and empties the block table
export function removeBlocks(rom: Rom): string[] {
  const e = blocksEntry(rom);
  if (!e) return [];
  const w = uninstallPatch(rom, e.id);
  clearTable(rom);
  return w;
}
