// Remap lists (core/remap.ts): Lunar Magic's syntax (LM help: editor_16x16.htm, level_ex20_offset.htm)
// for 8x8 tile numbers, palettes and acts-like of Map16 tiles and for ExAnimation slots; sources always
// mean the values before the remap; bad pairs are reported where they are in the text.
import { parseRemap, remapTile, remapSlot, remapLine, slotRemapLine, type Remap } from '../src/core/remap.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const tiles = (r: Remap) => [...r.tiles.entries()].map(([a, b]) => `${a.toString(16)}>${b.toString(16)}`).join(' ');
const ok = (text: string) => { const p = parseRemap(text); if (p.problems.length) console.log('  ', text, p.problems); return p.remap; };

// ---- the help's examples ----
check(tiles(ok('100,25')) === '100>25', '100,25: one tile into another');
check(tiles(ok('100-101,25')) === '100>25 101>25', '100-101,25: a range into one tile');
check(tiles(ok('100-101,+25')) === '100>125 101>126', '100-101,+25: offset');
check(tiles(ok('100-101,-25')) === '100>db 101>dc', '100-101,-25: negative offset');
check(tiles(ok('100-101,M125')) === '100>125 101>126', '100-101,M125: move to a start');
check(tiles(ok('R100-111,M25')) === '100>25 101>26 110>35 111>36', 'R100-111,M25: a rectangle');
const pal = ok('P5-6,7');
check([...pal.pals.entries()].join(' ') === '5,7 6,7', 'P5-6,7: palettes 5 and 6 become 7');
const tp = ok('100-101,P7');
check([...tp.tilePals.entries()].join(' ') === '256,7 257,7' && !tp.tiles.size, '100-101,P7: these tiles get palette 7');
const g = ok('G100-101,+25');
check([...g.acts.entries()].map(([a, b]) => `${a.toString(16)}>${b.toString(16)}`).join(' ') === '100>125 101>126', 'G100-101,+25: acts-like offset');
check([...ok('G100-101,M125').acts.values()].join(' ') === [0x125, 0x126].join(' '), 'G100-101,M125: acts-like move');
const s = ok('R200-211,S25');
check([...s.tileActs.entries()].map(([a, b]) => `${a.toString(16)}>${b.toString(16)}`).join(' ') === '200>25 201>26 210>35 211>36', 'R200-211,S25: Map16 rectangle gets a rectangle of acts-like');

// ---- sources before the remap ----
const sw = ok('100,25,25,100');
check(tiles(sw) === '100>25 25>100', '100,25,25,100 swaps');
check(tiles(ok('100,25,100,30')) === '100>30', '100,25,100,30: the second pair supersedes the first');
check(tiles(ok('100,25\n101 , 26\n\n')) === '100>25 101>26', 'pairs on lines, spaces and blank lines');
check(tiles(ok('r100-101,m200')) === '100>200 101>201', 'lower case');

// ---- applying ----
const W = (t: number, p = 0, flags = 0) => flags | (p << 10) | t;
let r = remapTile([W(0x100, 2, 0x4000), W(0x25, 3), W(0x101, 5), W(0x40, 6)], 0x130, 0x200, ok('100,25,25,100,P5,7'));
check(r.words.join() === [W(0x25, 2, 0x4000), W(0x100, 3), W(0x101, 7), W(0x40, 6)].join() && r.acts === 0x130, 'words: tile numbers and palettes from the values before, flips kept');
r = remapTile([W(0x100, 2), W(0x101, 2), W(0x102, 2), W(0x103, 2)], 0x130, 0x200, ok('100-101,P7\nP2,4'));
check(r.words.join() === [W(0x100, 7), W(0x101, 7), W(0x102, 4), W(0x103, 4)].join(), 'a tile\'s own palette goes before the palette pair');
r = remapTile([0, 0, 0, 0], 0x101, 0x210, ok('G100-101,M125\nR200-211,S25'));
check(r.acts === 0x35, 'R…,S… (by Map16 tile) goes before G… (by acts-like)');
check(remapTile([0, 0, 0, 0], 0x101, 0x300, ok('G100-101,M125')).acts === 0x126, 'G… by the tile\'s acts-like');
check(remapTile([0, 0, 0, 0], null, 0x300, ok('G100-101,M125')).acts === null, 'BG tiles have no acts-like');
const off = parseRemap('', { offset: 0x80 });
r = remapTile([W(0x100), W(0x17f), W(0x3a0), W(0)], null, 0x200, off.remap);
check(r.words.join() === [W(0x180), W(0x1ff), W(0x3a0), W(0x80)].join() && r.out.join() === '928', 'offset field: every 8x8 tile; leaving 000–3FF is reported and kept');
r = remapTile([W(0x100), W(0x101), 0, 0], null, 0x200, parseRemap('100,25', { offset: 1 }).remap);
check(r.words.join() === [W(0x25), W(0x102), W(1), W(1)].join(), 'the list goes before the offset');

// ---- problems where they are ----
const bads: [string, string, RegExp][] = [
  ['100,25\n100-', '100-', /range/i],
  ['100,25\nxyz,3', 'xyz', /source/i],
  ['101-100,5', '101-100', /backwards/i],
  ['100-101,+3ff', '+3ff', /3FF/],
  ['400,1', '400', /3FF/],
  ['P5,8', '8', /palette/i],
  ['G1ff,+1', '+1', /1FF/],
  ['100,S25', 'S25', /rectangle/i],
  ['P1,P2', 'P2', /palette/i],
  ['R101-110,M0', 'R101-110', /rectangle/i],
  ['100,25,101', '101', /destination/i],
];
for (const [text, at, msg] of bads) {
  const p = parseRemap(text);
  const hit = p.problems.find((q) => text.slice(q.from, q.to).trim() === at && msg.test(q.message));
  check(!!hit, `“${text.replace(/\n/g, '⏎')}”: “${at}” marked (${p.problems.map((q) => `${text.slice(q.from, q.to)}: ${q.message}`).join('; ') || 'nothing'})`);
}
const half = parseRemap('100,25\n101-100,7\n102,26');
check(tiles(half.remap) === '100>25 102>26' && half.problems.length === 1 && half.problems[0].line === 1, 'a bad line leaves the others and says its line');
const lone = parseRemap('100,25,101\n102,26\n103\n104,27');
check(tiles(lone.remap) === '100>25 102>26 104>27' && lone.problems.map((q) => q.line).join() === '0,2', 'a line missing a destination is marked alone; the lines below still pair');
const spaced = parseRemap('100 25\n101, 26 ');
check(tiles(spaced.remap) === '101>26' && spaced.problems.length === 1 && /comma/i.test(spaced.problems[0].message), 'a space between two values is marked (not read as 10025); spaces around values are fine');
const anim = parseRemap('P1,2\nG1,2\n100,25', { what: 'tiles' });
check(anim.problems.length === 2 && tiles(anim.remap) === '100>25', 'tiles only (ExAnimation): palettes and acts-like are problems');
// Map16 tile numbers (Remap Direct Map16 / Background Tiles, tilemove.ts): 000-FFF, no palettes or acts-like
const num = parseRemap('200-2FF,+100\nR500-511,MF00\n345,FFF', { what: 'numbers' });
check(!num.problems.length && num.remap.tiles.get(0x2ff) === 0x3ff && num.remap.tiles.get(0x511) === 0xf11 && num.remap.tiles.get(0x345) === 0xfff, 'Map16 numbers: ranges, rectangles and values up to FFF');
const numBad = parseRemap('P1,2\nG1,2\n100,P3\nF00,+100\n100,1000\nR200-211,S25', { what: 'numbers' });
check(numBad.problems.map((q) => q.line).join() === '0,1,2,3,4,5', `Map16 numbers: palettes, acts-like and numbers past FFF are problems (${numBad.problems.map((q) => q.message).join(' | ')})`);

// ---- written by the visual mode / an offer ----
const line = (from: number, w: number, h: number, to: number) => remapLine(from, w, h, to);
check(line(0x100, 1, 1, 0x25) === '100,025', 'one tile: a pair');
check(line(0x100, 4, 1, 0x200) === '100-103,M200', 'one row: a range');
check(line(0x100, 2, 2, 0x25) === 'R100-111,M025', 'rows: a rectangle');
check(line(0x100, 16, 8, 0x200) === '100-17F,M200', 'whole rows: a range');
for (const [f, w, h, t] of [[0x100, 1, 1, 0x25], [0x100, 4, 1, 0x200], [0x10c, 3, 2, 0x2f0], [0x100, 16, 8, 0x200]]) {
  const m = ok(line(f, w, h, t)).tiles;
  let all = m.size === w * h;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) all &&= m.get(f + y * 16 + x) === t + y * 16 + x;
  check(all, `${line(f, w, h, t)} moves the ${w}×${h} tiles`);
}
check(slotRemapLine(0x100, 0x200) === '100-17F,+100' && slotRemapLine(0x200, 0x80) === '200-27F,-180', 'slot moved: its 128 tiles by the offset');

// ---- ExAnimation slots ----
const CW = 0x2000; // VRAM word of layer tile 000
const slot = { type: 0x02, trigger: 0, framesLess1: 2, dest: 0x8000 | (CW + 0x60 * 16), frames: [0x00, 0x40, 0x80] };
let e = remapSlot(slot, ok('0-3,+10\n60,70'), CW, { frames: true, target: true });
check(e.slot.frames.join() === [0x200, 0x240, 0x80].join() && e.slot.dest === (0x8000 | (CW + 0x70 * 16)) && !e.out.length, 'frames (tiles of the animation graphic) and target (VRAM tile) by the list');
e = remapSlot(slot, ok('0-3,+10\n60,70'), CW, { frames: false, target: true });
check(e.slot.frames.join() === slot.frames.join() && e.slot.dest === (0x8000 | (CW + 0x70 * 16)), 'target only');
e = remapSlot(slot, parseRemap('', { offset: 0x3a0 }).remap, CW, { frames: true, target: false }, 0x3a3);
check(e.out.length === 1 && e.slot.frames[2] === 0x80, 'a frame past the animation graphic is reported and kept');
const ram = { ...slot, dest: CW + 0x60 * 16, frames: [0x1234, 0x5678, 0x9abc] };
e = remapSlot(ram, ok('0-3FE,+1'), CW, { frames: true, target: false });
check(e.slot.frames.join() === ram.frames.join(), 'frames from RAM stay (they are no tiles of the graphic)');
const col = { type: 0x14, trigger: 0, framesLess1: 1, dest: 0x21, frames: [0x1f, 0x7c00] };
check(remapSlot(col, ok('0-3FE,+1'), CW, { frames: true, target: true }).slot === col, 'color slots stay');

if (bad) { console.log(`${bad} failed`); process.exit(1); }
console.log('all passed');
