// The overworld layer 2 "pieces on this map" (core/owl2pieces.ts, #337): the 2x2 entry blocks on the 16-pixel grid of
// a submap's view (the main map whole), from the map before events, each once with its palettes and flips, the most
// used first.
// node tools/testowl2pieces.ts
import { Rom } from '../src/core/rom.ts';
import { OverworldEmulator, OverworldLoads, readL2, readMaps, l2Index } from '../src/core/overworld.ts';
import { OverworldStroke } from '../src/core/owstroke.ts';
import { RomEditSession } from '../src/core/romedit.ts';
import { BrushDrag } from '../src/ui/brushsurface.ts';
import { submapViews } from '../src/core/owevents.ts';
import { mapPieces, l2Block } from '../src/core/owl2pieces.ts';
import { editorImage } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const hx = (v: number) => v.toString(16).toUpperCase().padStart(4, '0');

// a made-up region 0: all of it piece A, a 4x2 band of piece B at (8,4), one piece C at (20,10) (B's entries flipped)
const l2 = new Uint16Array(0x2000);
const A = [0x1c75, 0x1c75, 0x1c75, 0x1c75], B = [0x1001, 0x1002, 0x1011, 0x1012], C = B.map((v) => v ^ 0x4000);
const put = (x: number, y: number, p: number[]) => p.forEach((v, k) => { l2[l2Index(0, x + (k & 1), y + (k >> 1))] = v; });
for (let y = 0; y < 64; y += 2) for (let x = 0; x < 64; x += 2) put(x, y, A);
put(8, 4, B); put(10, 4, B); put(20, 10, C);
const all = mapPieces(l2, 0, { x: 0, y: 0, w: 64, h: 64 });
check(all.length === 3, `each piece once (${all.length})`);
check(all[0].entries.join() === A.join() && all[0].count === 32 * 32 - 3, 'the most used first, counted');
check(all[1].entries.join() === B.join() && all[1].count === 2 && all[2].entries.join() === C.join() && all[2].count === 1, 'then by count; flips make another piece');
check(all[1].entries.join() === B.join(), 'entries in a 2x2 brush\'s order (top left, top right, bottom left, bottom right)');
const part = mapPieces(l2, 0, { x: 9, y: 3, w: 4, h: 2 });
check(part.map((p) => p.count).join() === '4,2' && part[0].entries.join() === A.join(), `a view: the grid cells it overlaps (x 8–12, y 2–4: 3×2 cells, 4 of A and B's 2 – ${part.map((p) => p.count)})`);
check(mapPieces(l2, 0, { x: 60, y: 60, w: 8, h: 8 }).reduce((n, p) => n + p.count, 0) === 16, 'a view past the region\'s edge wraps around it');
put(0, 0, C);
const wrapped = mapPieces(l2, 0, { x: -2, y: -2, w: 4, h: 4 });
check(wrapped.length === 2 && wrapped.find((p) => p.entries.join() === C.join())?.count === 1 && wrapped[0].count === 3, 'a view starting left of and above the region (as Yoshi\'s Island\'s): the cells across the edge');
check(mapPieces(l2, 0, { x: 0, y: 0, w: 64, h: 64 })[2].count === 2 && mapPieces(l2, 0, { x: 0, y: 0, w: 4, h: 2 })[0].entries.join() === C.join(),
  'equal counts: the one met first (row by row) first');

// the test ROM
const rom = new Rom(await editorImage()), m = readL2(rom);
const main = mapPieces(m, 0, { x: 0, y: 0, w: 64, h: 64 });
console.log('main map:', main.slice(0, 5).map((p) => `${p.entries.map(hx).join(' ')} ×${p.count}`).join(' | '));
check(main[0].entries.every((v) => v === 0x1c75), 'main map: water (1C75 four times) first');
check(main.reduce((n, p) => n + p.count, 0) === 32 * 32, 'main map: all its 32×32 pieces counted');
check(main.every((p, i) => !i || p.count <= main[i - 1].count), 'ordered by count');
check(new Set(main.map((p) => p.entries.join())).size === main.length, 'each piece once');
const views = submapViews(new OverworldLoads(new OverworldEmulator(new Rom(await editorImage())), 2));
const yi = mapPieces(m, 1, views[1]);
console.log('Yoshi\'s Island:', yi.slice(0, 5).map((p) => `${p.entries.map(hx).join(' ')} ×${p.count}`).join(' | '));
check(yi.length > 10 && yi.reduce((n, p) => n + p.count, 0) === 16 * 15, `Yoshi's Island: the pieces of its view (${yi.length})`);
check(yi[0].count > yi[yi.length - 1].count && yi.every((p, i) => !i || p.count <= yi[i - 1].count), 'Yoshi\'s Island: the most used first');
check(yi[0].entries.every((v) => v === 0x1475), 'Yoshi\'s Island: its water (1475 four times, palette 5) first');
check(yi[1].entries.every((v) => v === 0x1071), 'Yoshi\'s Island: then its grass (1071 four times, green)');
check(main[1].entries.every((v) => v === 0x583f), 'main map: then the sea\'s other water (583F, blue; the main map\'s land is brown, no grass)');

// painting with a piece (a 2x2 brush, ADR 0011's grid): its 4 entries with their palettes and flips, one stroke one ROM edit
const piece = main.find((p) => p.entries.some((v) => v & 0xc000) && new Set(p.entries.map((v) => (v >> 10) & 7)).size === 1 && p.entries[0] !== p.entries[1])!;
check(!!piece, `a flipped piece on the main map: ${piece?.entries.map(hx).join(' ')}`);
const s = new RomEditSession(rom), maps = readMaps(rom), st = new OverworldStroke(rom, 'l2', maps, () => false);
const drag = new BrushDrag({
  brush: () => ({ w: 2, h: 2 }),
  stamp: (x, y) => { let ch = false; piece.entries.forEach((v, k) => { if (st.paint(0, x + (k & 1), y + (k >> 1), v)) ch = true; }); return ch; },
  end: () => { const e = st.end(); if (e.write) s.edit(e.label, e.write, { key: null }); },
  cancel: () => st.cancel(), pick: () => {},
});
const before = mapPieces(readL2(rom), 0, { x: 0, y: 0, w: 64, h: 64 }).find((p) => p.entries.join() === piece.entries.join())!.count;
drag.startPaint({ x: 40, y: 20 }); drag.move({ x: 41, y: 20 }); drag.move({ x: 42, y: 21 }); drag.move({ x: 44, y: 20 }); drag.up();
const after = readL2(rom), at = (x: number, y: number) => l2Block(after, 0, x, y).join();
check(at(40, 20) === piece.entries.join() && at(42, 20) === piece.entries.join() && at(44, 20) === piece.entries.join(), 'the stroke stamps the piece on its 2-cell grid (40, 42, 44), entries with palette and flips');
check(s.history.undoStack.length === 1, `one stroke one ROM edit (${s.history.undoStack.length})`);
const counted = mapPieces(after, 0, { x: 0, y: 0, w: 64, h: 64 }).find((p) => p.entries.join() === piece.entries.join())!.count;
check(counted >= before + 1, `the pieces from the ROM after the edit count it again (${before} → ${counted})`);

if (bad) { console.log(`${bad} failed`); process.exit(1); }
console.log('all ok');
