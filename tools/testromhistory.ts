// ROM undo/redo: edits restore byte for byte, also across a ROM expansion; quick edits with the same
// key merge; an edit whose bytes were changed elsewhere is not undone (the checksum does not count).
// An assignment change of a tool project (applied at once) undoes as one step, ROM and editor data.
import { readFileSync } from 'node:fs';
import { Rom } from '../src/core/rom.ts';
import { RomHistory } from '../src/core/romhistory.ts';
import { loadAsar } from '../src/core/asar.ts';
import { saveProject, loadProject } from '../src/core/uberproject.ts';
import { parseList } from '../src/core/uberasm.ts';

const rom = new Rom(new Uint8Array(readFileSync('test/fixtures/smw.smc')));
const orig = rom.data.slice();
const h = new RomHistory(rom);
let bad = 0;
const check = (ok: boolean, what: string) => { if (!ok) { console.log('FAIL', what); bad++; } };
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

h.edit('Color', () => rom.w16(0x00b0a0, 0x1234));
h.edit('Tiles', () => { rom.w16(0x0d8000, 0xffff); rom.w16(0x0d8010, 0xaaaa); rom.w8(0x0d8020, 1); });
const two = rom.data.slice();
check(h.undoStack.length === 2, 'two edits recorded');
h.undo(); h.undo();
check(same(rom.data, orig), 'undo restores');
h.redo(); h.redo();
check(same(rom.data, two), 'redo restores');
h.undo(); h.undo();

// merge
h.edit('Slider', () => rom.w16(0x00b0a0, 1), 'c');
h.edit('Slider', () => rom.w16(0x00b0a0, 2), 'c');
h.edit('Slider', () => rom.w16(0x00b0a2, 3), 'c');
check(h.undoStack.length === 1, 'same key merges');
h.undo();
check(same(rom.data, orig), 'merged undo restores');

// no-op edits are not recorded
h.edit('nichts', () => {});
check(h.undoStack.length === 0, 'empty edit dropped');

// expansion
h.edit('Erweitern', () => { rom.expand(0x100000); rom.data[0x90000] = 7; });
check(rom.size === 0x100000, 'expanded');
h.undo();
check(same(rom.data, orig), 'undo of expansion');
h.redo();
check(rom.size === 0x100000 && rom.data[0x90000] === 7, 'redo of expansion');
h.undo();

// conflict
h.edit('Color', () => rom.w16(0x00b0a0, 0x1234));
rom.w16(0x00b0a0, 0x4321);
let threw = false;
try { h.undo(); } catch { threw = true; }
check(threw && rom.r16(0x00b0a0) === 0x4321, 'conflicting undo refused');

// writing the ROM out rewrites the checksum; that must not block undoing an edit (also a whole-ROM one)
h.clear();
const pre = rom.data.slice();
h.edit('Erweitern', () => { rom.expand(rom.data.length * 2); rom.w8(0x00b0a0, 0x55); });
rom.output(false);
let ok = true;
try { h.undo(); } catch { ok = false; }
check(ok && same(rom.data.subarray(0, 0x7fdc), pre.subarray(0, 0x7fdc)) && rom.data.length === pre.length, 'undo after the checksum was rewritten');

// the editor data: undo puts back only the entries the edit changed, so editor data written in
// between (e.g. by a package installed meanwhile) stays
{
  const r = new Rom(new Uint8Array(readFileSync('test/fixtures/smw.smc')));
  const hh = new RomHistory(r);
  hh.edit('Sources', () => { r.extra.set('a', new Uint8Array([1])); r.w8(0x00b0a0, 9); });
  const other = new Uint8Array([2]);
  r.extra.set('b', other);
  hh.undo();
  check(!r.extra.has('a') && r.extra.get('b') === other, 'undo keeps editor data changed elsewhere');
  hh.redo();
  check(r.extra.get('a')?.[0] === 1 && r.extra.get('b') === other, 'redo keeps editor data changed elsewhere');
}

// an UberASM assignment changed (the whole project rebuilt and reapplied) and undone in one step
{
  await loadAsar();
  const enc = new TextEncoder();
  const r = new Rom(new Uint8Array(readFileSync('test/fixtures/smw.smc')));
  const files = new Map<string, Uint8Array>([
    ['list.txt', enc.encode('level:\n105 marker.asm\n')],
    ['level/marker.asm', enc.encode('load:\n  LDA #$11 : STA $7FB001\n  RTL\n')],
  ]);
  check(saveProject(r, { files, list: parseList('level:\n105 marker.asm\n') }).ok, 'UberASM project installed');
  const hh = new RomHistory(r);
  const data0 = r.data.slice(), extra0 = new Map(r.extra);
  const p = loadProject(r)!;
  p.list.level.set(0x106, [{ file: 'level/marker.asm', bytes: [] }]);
  const ok = hh.edit('UberASM: assignment', () => saveProject(r, p).ok);
  check(ok && loadProject(r)!.list.level.has(0x106), 'assignment applied at once');
  const data1 = r.data.slice(), extra1 = new Map(r.extra);
  check(hh.undoStack.length === 1, 'one undo step');
  hh.undo();
  const sameExtra = (a: Map<string, Uint8Array>, b: Map<string, Uint8Array>) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);
  check(same(r.data, data0) && sameExtra(r.extra, extra0) && !loadProject(r)!.list.level.has(0x106), 'undo restores ROM and editor data');
  hh.redo();
  check(same(r.data, data1) && sameExtra(r.extra, extra1), 'redo restores the assignment');
}

console.log(bad ? `${bad} failures` : 'romhistory ok');
if (bad) process.exit(1);
