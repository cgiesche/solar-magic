// Quarters of a Map16 tile selection (core/quarters.ts): marking them as a set (click, rectangle, Ctrl to add
// or remove, a whole 16x16 tile, all), editing every marked quarter, stamping a block of 8x8 tiles, what
// the marked quarters have in common, mirroring them as a whole, and which 16x16 tiles are wholly marked (acts-like).
import { QuarterGrid, markRect, editMarked, setPalette, setBit, setTileNum, stamp, mirror, summary, wholeTiles, paletteOn, FLIP_X, FLIP_Y, PRIO } from '../src/core/quarters.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const W = (t: number, p = 0, flags = 0) => flags | (p << 10) | t;
const sorted = (s: Set<number>) => [...s].sort((a, b) => a - b).join();

// ---- the grid: 3x2 tiles are 6x4 quarters ----
const g = new QuarterGrid(3, 2);
check(g.cols === 6 && g.rows === 4 && g.all().size === 24, '3x2 tiles: 6x4 quarters');
check(g.at(0, 0).tile === 0 && g.at(0, 0).q === 0, 'top-left quarter: tile 0, word 0');
check(g.at(0, 1).q === 1 && g.at(1, 0).q === 2 && g.at(1, 1).q === 3, 'word order TL, BL, TR, BR');
check(g.at(3, 2).tile === 4 && g.at(3, 2).q === 2, 'quarter (3,2): tile 4 (second row, middle), its top right');
check(g.locate(g.key(3, 2)).tile === 4 && g.locate(g.key(3, 2)).q === 2, 'locate: a key\'s tile and word');
check(sorted(g.wholeTile(g.key(3, 3))) === sorted(new Set([g.key(2, 2), g.key(3, 2), g.key(2, 3), g.key(3, 3)])), 'Shift+click: the quarter\'s whole 16x16 tile');

// ---- marking ----
let m = markRect(g, new Set(), { x: 1, y: 1, w: 1, h: 1 }, 'set');
check(sorted(m) === String(g.key(1, 1)), 'click marks one quarter');
m = markRect(g, m, { x: 0, y: 0, w: 3, h: 2 }, 'set');
check(m.size === 6 && m.has(g.key(1, 1)), 'drag marks a rectangle (replacing)');
m = markRect(g, m, { x: 5, y: 3, w: 1, h: 1 }, 'add');
check(m.size === 7 && m.has(g.key(5, 3)), 'Ctrl+click adds');
m = markRect(g, m, { x: 0, y: 0, w: 2, h: 1 }, 'remove');
check(m.size === 5 && !m.has(g.key(0, 0)) && !m.has(g.key(1, 0)), 'Ctrl+drag from a marked quarter removes');
const before = new Set(m);
markRect(g, m, { x: 0, y: 0, w: 6, h: 4 }, 'add');
check(sorted(m) === sorted(before), 'marking returns a new set');
check(markRect(g, new Set(), { x: 4, y: 2, w: 9, h: 9 }, 'set').size === 4, 'a rectangle is cut to the grid');

// ---- editing every marked quarter ----
const g2 = new QuarterGrid(2, 1); // 4x2 quarters
const words = [[W(0x10, 1), W(0x11, 2, FLIP_X), W(0x12, 3), W(0x13, 4)], [W(0x20, 5), W(0x21, 6), W(0x22, 7, PRIO), W(0x23, 0)]];
const left = markRect(g2, new Set(), { x: 1, y: 0, w: 2, h: 2 }, 'set'); // tile 0 right column, tile 1 left column
let e = editMarked(g2, words, left, setPalette(6));
check(e.changed.join() === '0,1', 'both tiles touched');
check(e.words[0].join() === [W(0x10, 1), W(0x11, 2, FLIP_X), W(0x12, 6), W(0x13, 6)].join()
  && e.words[1].join() === [W(0x20, 6), W(0x21, 6), W(0x22, 7, PRIO), W(0x23, 0)].join(), 'palette on the marked quarters only');
check(words[0][2] === W(0x12, 3), 'the words given stay');
e = editMarked(g2, words, markRect(g2, new Set(), { x: 0, y: 0, w: 1, h: 1 }, 'set'), setPalette(1));
check(e.changed.length === 0, 'nothing changes: no tile touched');
e = editMarked(g2, words, left, setTileNum(0x155));
check(e.words[0][2] === W(0x155, 3) && e.words[1][1] === W(0x155, 6) && e.words[1][2] === W(0x22, 7, PRIO), '8x8 tile into every marked quarter, palette and flips kept');

// toggles: all on → off, else (none or mixed) → on
const tl = markRect(g2, new Set(), { x: 0, y: 0, w: 1, h: 2 }, 'set'); // tile 0 words 0 (no flip) and 1 (flip)
const s = summary(g2, words, tl);
check(s.flipX === 'mixed' && s.flipY === 'off' && s.prio === 'off', 'summary: flip X mixed');
check(sorted(s.pals) === '1,2', 'summary: every palette in use');
e = editMarked(g2, words, tl, setBit(FLIP_X, s.flipX !== 'on'));
check(e.words[0][0] === W(0x10, 1, FLIP_X) && e.words[0][1] === W(0x11, 2, FLIP_X), 'mixed flip: a click sets it on all');
const s2 = summary(g2, e.words, tl);
check(s2.flipX === 'on', 'now all flipped');
e = editMarked(g2, e.words, tl, setBit(FLIP_X, s2.flipX !== 'on'));
check(e.words[0][0] === W(0x10, 1) && e.words[0][1] === W(0x11, 2), 'all flipped: a click clears it');
check(summary(g2, words, new Set()).flipX === 'off' && summary(g2, words, new Set()).pals.size === 0, 'nothing marked: nothing in use');
e = editMarked(g2, words, tl, setBit(FLIP_Y, true));
check(e.words[0][0] === W(0x10, 1, FLIP_Y), 'flip Y');

// ---- flips mirror the marked quarters as a whole ----
// one 16x16 tile wholly marked: X swaps its columns, every quarter's flip toggled
const g1 = new QuarterGrid(1, 1);
const w1 = [[W(0x10, 1), W(0x11, 2), W(0x12, 3, FLIP_X), W(0x13, 4, PRIO)]];
let mi = mirror(g1, w1, g1.all(), FLIP_X)!;
check(mi.words[0].join() === [W(0x12, 3), W(0x13, 4, FLIP_X | PRIO), W(0x10, 1, FLIP_X), W(0x11, 2, FLIP_X)].join(), 'X on a whole tile: columns swapped, flips toggled, palette and priority with the quarters');
mi = mirror(g1, w1, g1.all(), FLIP_Y)!;
check(mi.words[0].join() === [W(0x11, 2, FLIP_Y), W(0x10, 1, FLIP_Y), W(0x13, 4, FLIP_Y | PRIO), W(0x12, 3, FLIP_X | FLIP_Y)].join(), 'Y on a whole tile: rows swapped');
check(mirror(g1, mirror(g1, w1, g1.all(), FLIP_X)!.words, g1.all(), FLIP_X)!.words[0].join() === w1[0].join(), 'flipping twice: as before');
// a single quarter: its flip toggled only
mi = mirror(g1, w1, new Set([g1.key(1, 0)]), FLIP_X)!;
check(mi.words[0].join() === [w1[0][0], w1[0][1], W(0x12, 3), w1[0][3]].join(), 'a single quarter: just its flip');
// 2x1 tiles (a pipe) wholly marked: the mirrored area crosses the tile border
mi = mirror(g2, words, g2.all(), FLIP_X)!;
check(mi.changed.join() === '0,1', 'both tiles of 2x1 change');
check(mi.words[0].join() === [W(0x22, 7, FLIP_X | PRIO), W(0x23, 0, FLIP_X), W(0x20, 5, FLIP_X), W(0x21, 6, FLIP_X)].join()
  && mi.words[1].join() === [W(0x12, 3, FLIP_X), W(0x13, 4, FLIP_X), W(0x10, 1, FLIP_X), W(0x11, 2)].join(), 'X across 2x1: the right tile\'s quarters on the left, mirrored');
// marks inside: the axis is their bounding box, not the selection
mi = mirror(g2, words, left, FLIP_X)!;
check(mi.words[0][0] === words[0][0] && mi.words[1][2] === words[1][2], 'quarters outside the marks stay');
check(mi.words[0][2] === W(0x20, 5, FLIP_X) && mi.words[1][0] === W(0x12, 3, FLIP_X), 'the middle columns swap');
// not symmetric to the axis: nothing
const ell = markRect(g2, new Set([g2.key(0, 1)]), { x: 0, y: 0, w: 2, h: 1 }, 'add'); // an L
check(mirror(g2, words, ell, FLIP_X) === null && mirror(g2, words, ell, FLIP_Y) === null, 'an L: not mirrored');
const gap = new Set([g2.key(0, 0), g2.key(3, 0)]);
check(mirror(g2, words, gap, FLIP_X) !== null, 'two quarters apart, symmetric: mirrored');

// ---- stamping a block of 8x8 tiles ----
// a 4x4 block onto a 2x2 tile selection (4x4 quarters) at its top left: fills it, flips cleared, palettes kept
const g3 = new QuarterGrid(2, 2);
const w3 = [0, 1, 2, 3].map((i) => [W(0, i, FLIP_X | PRIO), W(0, i, FLIP_Y), W(0, i), W(0, i)]);
const block = (bw: number, bh: number, first: number) => Array.from({ length: bh }, (_, y) => Array.from({ length: bw }, (_, x) => first + y * 16 + x));
let st = stamp(g3, w3, { x: 0, y: 0 }, block(4, 4, 0x100));
check(st.cut === 0 && st.changed.join() === '0,1,2,3', '4x4 on 2x2: every tile');
check(st.words[0].join() === [W(0x100, 0, PRIO), W(0x110, 0), W(0x101, 0), W(0x111, 0)].join(), 'tile 0: top-left 2x2 of the block, flips cleared, priority kept');
check(st.words[1][0] === W(0x102, 1, PRIO) && st.words[2][0] === W(0x120, 2, PRIO) && st.words[3][3] === W(0x133, 3), 'the other tiles lie where the block is, palettes kept');
st = stamp(g3, w3, { x: 3, y: 2 }, block(4, 4, 0x100));
check(st.cut === 14 && st.changed.join() === '3', 'dropped on the last column: 14 of 16 cut off');
check(st.words[3][2] === W(0x100, 3) && st.words[3][3] === W(0x110, 3) && st.words[3][0] === w3[3][0], 'the part inside lands from the drop quarter');
st = stamp(g3, w3, { x: 1, y: 1 }, [[-1, 0x5], [0x6, 0x7]]);
check(st.words[0][3] === w3[0][3] && st.words[1][1] === W(0x5, 1), 'an 8x8 tile outside the graphics (-1) leaves the quarter as it is');

// ---- acts-like: wholly marked 16x16 tiles ----
check(wholeTiles(g, g.all())!.join() === '0,1,2,3,4,5', 'everything marked: all tiles');
const two = new Set([...g.wholeTile(g.key(0, 0)), ...g.wholeTile(g.key(5, 3))]);
check(wholeTiles(g, two)!.join() === '0,5', 'two whole tiles');
two.add(g.key(2, 0));
check(wholeTiles(g, two) === null, 'a partly marked tile: none');
check(wholeTiles(g, new Set()) === null, 'nothing marked: none');

// ---- an animation's palette: the quarters showing its target tiles ----
const tw = [W(0x60, 2), W(0x70, 2, FLIP_X), W(0x61, 4), W(0x12, 2)];
const pt = paletteOn(tw, new Set([0x60, 0x61, 0x70]), 4)!;
check(pt[0] === W(0x60, 4) && pt[1] === W(0x70, 4, FLIP_X) && pt[2] === tw[2], 'target quarters take the palette, flips kept');
check(pt[3] === tw[3], 'other quarters stay');
check(paletteOn(pt, new Set([0x60, 0x61, 0x70]), 4) === null, 'all in the palette already: nothing changes');
check(paletteOn(tw, new Set([0x99]), 4) === null, 'no quarter shows the target: nothing changes');

console.log(bad ? `${bad} FAILED` : 'all ok');
if (bad) process.exit(1);
