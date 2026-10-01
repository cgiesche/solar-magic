// ROM undo/redo: edits restore byte for byte, also across a ROM expansion; quick edits with the same
// key merge; an edit whose bytes were changed elsewhere is not undone.
import { readFileSync } from 'node:fs';
import { Rom } from '../src/core/rom.ts';
import { RomHistory } from '../src/core/romhistory.ts';

const rom = new Rom(new Uint8Array(readFileSync('Super Mario World (U) [!].smc')));
const orig = rom.data.slice();
const h = new RomHistory(rom);
let bad = 0;
const check = (ok: boolean, what: string) => { if (!ok) { console.log('FAIL', what); bad++; } };
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

h.edit('Farbe', () => rom.w16(0x00b0a0, 0x1234));
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
h.edit('Farbe', () => rom.w16(0x00b0a0, 0x1234));
rom.w16(0x00b0a0, 0x4321);
let threw = false;
try { h.undo(); } catch { threw = true; }
check(threw && rom.r16(0x00b0a0) === 0x4321, 'conflicting undo refused');

console.log(bad ? `${bad} failures` : 'romhistory ok');
if (bad) process.exit(1);
