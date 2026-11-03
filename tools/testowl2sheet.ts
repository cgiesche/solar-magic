// The overworld layer 2 sheet (core/owl2sheet.ts, #336): a brush picked from the map found in the sheet – the sheet's
// palette the brush's, a rectangle of the sheet found also mirrored (X, Y, both), else its 8x8 tiles one by one.
// node tools/testowl2sheet.ts
import { Rom } from '../src/core/rom.ts';
import { readL2, l2Index } from '../src/core/overworld.ts';
import { findL2Brush, l2BrushPalettes, l2SharedBits, L2_FLIP_X, L2_FLIP_Y, L2_PRIORITY, type SheetMark } from '../src/core/owl2sheet.ts';
import { editorImage } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const rect = (m: SheetMark, x: number, y: number, w: number, h: number, flip: number) => m.kind === 'rect' && m.x === x && m.y === y && m.w === w && m.h === h && m.flip === flip;
const cells = (m: SheetMark) => (m.kind === 'tiles' ? m.cells.map((c) => `${c.x},${c.y}`).join(' ') : 'rect');
const P = (p: number) => p << 10;

// a 2x2 block of the sheet from tile 012 (x 2, y 1) in palette 3: 012 013 / 022 023
const block = [0x012, 0x013, 0x022, 0x023].map((t) => t | P(3));
check(rect(findL2Brush({ w: 2, h: 2, entries: block }, 3), 2, 1, 2, 2, 0), 'a sheet rectangle in the palette shown: found');
check(cells(findL2Brush({ w: 2, h: 2, entries: block }, 4)) === '2,1 3,1 2,2 3,2', 'in another palette: its tiles one by one');
const fx = [0x013, 0x012, 0x023, 0x022].map((t) => t | P(3) | L2_FLIP_X);
check(rect(findL2Brush({ w: 2, h: 2, entries: fx }, 3), 2, 1, 2, 2, L2_FLIP_X), 'mirrored in X (the whole block): found, its flip said');
const fy = [0x022, 0x023, 0x012, 0x013].map((t) => t | P(3) | L2_FLIP_Y);
check(rect(findL2Brush({ w: 2, h: 2, entries: fy }, 3), 2, 1, 2, 2, L2_FLIP_Y), 'mirrored in Y: found');
const fxy = [0x023, 0x022, 0x013, 0x012].map((t) => t | P(3) | L2_FLIP_X | L2_FLIP_Y);
check(rect(findL2Brush({ w: 2, h: 2, entries: fxy }, 3), 2, 1, 2, 2, L2_FLIP_X | L2_FLIP_Y), 'mirrored in X and Y: found');
check(findL2Brush({ w: 2, h: 2, entries: [0x013, 0x012, 0x023, 0x022].map((t) => t | P(3)) }, 3).kind === 'tiles', 'the tiles mirrored without the flip bits: not the rectangle');
check(findL2Brush({ w: 2, h: 2, entries: [fx[0], fx[1], block[2], block[3]] }, 3).kind === 'tiles', 'flips not of the whole block: not a rectangle');
check(rect(findL2Brush({ w: 2, h: 2, entries: block.map((v) => v | L2_PRIORITY) }, 3), 2, 1, 2, 2, 0), 'the priority bit does not matter');
check(findL2Brush({ w: 2, h: 1, entries: [0x01f | P(3), 0x020 | P(3)] }, 3).kind === 'tiles', 'a row wrapping past the sheet\'s edge: not a rectangle');
check(cells(findL2Brush({ w: 2, h: 2, entries: [0x075, 0x075, 0x075, 0x076].map((t) => t | P(7)) }, 7)) === '5,7 6,7', 'tiles one by one: each once');
check(rect(findL2Brush({ w: 1, h: 1, entries: [0x3ff | P(1)] }, 1), 15, 63, 1, 1, 0), 'the sheet\'s last tile');

check(l2BrushPalettes(block).join() === '3', 'one palette');
check(l2BrushPalettes([P(3), P(2), P(3)]).join(', ') === '2, 3', 'several palettes, in order');
check(l2SharedBits(fx) === L2_FLIP_X && l2SharedBits(fxy) === (L2_FLIP_X | L2_FLIP_Y) && l2SharedBits([fx[0], block[0]]) === 0, 'the flips all entries share');
check(l2SharedBits(block.map((v) => v | L2_PRIORITY)) === L2_PRIORITY, 'the priority all share');

// the test ROM's main map
const l2 = readL2(new Rom(await editorImage()));
const pick = (x: number, y: number, w: number, h: number) => Array.from({ length: w * h }, (_, k) => l2[l2Index(0, x + (k % w), y + Math.floor(k / w))]);
const water = pick(0, 0, 2, 2), wp = l2BrushPalettes(water);
check(wp.join() === '7', `water (the main map's corner) in palette 7, not 0: the sheet switches to it (${wp})`);
const wm = findL2Brush({ w: 2, h: 2, entries: water }, wp[0]);
check(wm.kind === 'tiles' && cells(wm) === '5,7', `water (one tile four times) marked as its tile: ${cells(wm)}`);
check(rect(findL2Brush({ w: 1, h: 1, entries: pick(0, 0, 1, 1) }, 7), 5, 7, 1, 1, 0), 'one water tile: found in palette 7');
const shore = pick(23, 3, 2, 1);
check(rect(findL2Brush({ w: 2, h: 1, entries: shore }, l2BrushPalettes(shore)[0]), 1, 0, 2, 1, L2_FLIP_X) && l2SharedBits(shore) === L2_FLIP_X,
  'a block mirrored in X on the main map (23,3: 002 001 flipped): found at tile 001, X-Flip shown');

if (bad) { console.log(`${bad} failed`); process.exit(1); }
console.log('all ok');
