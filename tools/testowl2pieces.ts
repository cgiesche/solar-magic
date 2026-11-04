// The overworld layer 2 "pieces on this map" (core/owl2pieces.ts, #337): the 2x2 entry blocks on the 16-pixel grid of
// a submap's view (the main map whole), from the map before events, each once with its palettes and flips, the most
// used first. "Replace piece" (#370, replacePiece): every occurrence of a piece on its grid in a rectangle (or a submap's
// whole view) becomes another one, through a stroke: one ROM edit, in an event painted as the map after it.
// node tools/testowl2pieces.ts
import { Rom } from '../src/core/rom.ts';
import { OverworldEmulator, OverworldLoads, readL2, readMaps, l2Index, baseEvent } from '../src/core/overworld.ts';
import { OverworldStroke, type OwEventMaps } from '../src/core/owstroke.ts';
import { RomEditSession } from '../src/core/romedit.ts';
import { BrushDrag } from '../src/ui/brushsurface.ts';
import { submapViews, readEvents, applyEvents, eventRunners, eventPlace, l2XY } from '../src/core/owevents.ts';
import { mapPieces, l2Block, piecesAt, replacePiece, gridInside } from '../src/core/owl2pieces.ts';
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

// ---- Replace piece (#370) ----
{
  const rom = new Rom(await editorImage()), s = new RomEditSession(rom), l2r = readL2(rom), whole = { x: 0, y: 0, w: 64, h: 64 };
  const pieces = mapPieces(l2r, 0, whole), water = pieces[0], other = pieces[1];
  const count = (m: ArrayLike<number>, p: number[]) => mapPieces(m, 0, whole).find((q) => q.entries.join() === p.join())?.count ?? 0;
  const sel = { x: 3, y: 2, w: 20, h: 13 }, area = gridInside(sel)!; // (odd corners: the grid cells wholly inside, x 4–20, y 2–12)
  check(area.x === 4 && area.y === 2 && area.w === 18 && area.h === 12, `a selection's pieces: those wholly inside it (${JSON.stringify(area)})`);
  check(gridInside({ x: 3, y: 3, w: 2, h: 2 }) === null && gridInside({ x: 2, y: 2, w: 2, h: 2 })?.w === 2, 'a selection holding no whole piece: none');
  const inside = piecesAt(l2r, 0, area, water.entries);
  check(inside.length > 10 && inside.length < water.count && inside.every((c) => c.x >= 4 && c.x + 2 <= 23 && c.y >= 2 && c.y + 2 <= 15 && !(c.x & 1) && !(c.y & 1)),
    `water in the rectangle: ${inside.length} of ${water.count}, on its 2-cell grid, wholly inside`);
  const maps = readMaps(rom), st = new OverworldStroke(rom, 'l2', maps, () => false);
  const n = replacePiece(maps.l2, 0, area, water.entries, other.entries, (x, y, v) => st.paint(0, x, y, v));
  const end = st.end();
  s.edit(end.label, end.write!, { key: null });
  const after = readL2(rom);
  check(n === inside.length, `the number replaced: ${n}`);
  check(count(after, water.entries) === water.count - n && count(after, other.entries) === other.count + n, `the water's count down by ${n} (${water.count} → ${count(after, water.entries)}), the new piece's up by it`);
  check(inside.every((c) => l2Block(after, 0, c.x, c.y).join() === other.entries.join()), 'each replaced one is the new piece, entries with its palettes and flips');
  const changed = [...after.keys()].filter((i) => after[i] !== l2r[i]);
  const cellsOf = new Set(inside.map((c) => `${c.x >> 1},${c.y >> 1}`));
  check(changed.every((i) => { const c = l2XY(i); return c.r === 0 && cellsOf.has(`${c.x >> 1},${c.y >> 1}`); }), `only the replaced pieces' entries changed (${changed.length})`);
  check(piecesAt(after, 0, whole, water.entries).length === water.count - n, 'water outside the rectangle left as it was');
  check(s.history.undoStack.length === 1, `one ROM edit (${s.history.undoStack.length})`);
  s.undo();
  check(count(readL2(rom), water.entries) === water.count, 'undo: the water back');
  check(replacePiece(after, 0, area, other.entries, other.entries, () => { throw new Error('put'); }) === 0, 'a piece replaced by itself: nothing put');
  // without a selection: the submap's whole view, the number replaced the count the pieces sheet shows (the confirmation's)
  const views2 = submapViews(new OverworldLoads(new OverworldEmulator(new Rom(await editorImage())), 2));
  const yiAll = mapPieces(readL2(rom), 1, views2[1]), grass = yiAll[1];
  const m2 = readMaps(rom), st2 = new OverworldStroke(rom, 'l2', m2, () => false);
  const n2 = replacePiece(m2.l2, 1, views2[1], grass.entries, yiAll[0].entries, (x, y, v) => st2.paint(1, x, y, v));
  st2.end().write!();
  check(n2 === grass.count && !mapPieces(readL2(rom), 1, views2[1]).some((p) => p.entries.join() === grass.entries.join()), `Yoshi's Island's whole view: all ${grass.count} grass pieces replaced`);
  // in an event: painted as the map after it (its steps), the map before it as it was
  const r3 = new Rom(await editorImage()), s3 = new RomEditSession(r3), e = baseEvent(r3, 0x29), d = readEvents(r3), base = readL2(r3);
  const pl = eventPlace(eventRunners(r3), views2, e, 0);
  const em: OwEventMaps = { event: e, after: applyEvents(base, d, 0, e + 1), l1: null, game: null, without: undefined, place: () => pl };
  const beforeEv = applyEvents(base, d, 0, e), mainArea = { x: 0, y: 0, w: 8, h: 8 };
  const wEv = piecesAt(em.after, 0, mainArea, water.entries).length;
  const st3 = new OverworldStroke(r3, 'l2', readMaps(r3), () => false, em);
  const n3 = replacePiece(em.after, 0, mainArea, water.entries, other.entries, (x, y, v) => st3.paint(0, x, y, v));
  const e3 = st3.end();
  s3.edit(e3.label, e3.write!, { key: null });
  const d3 = readEvents(r3), b3 = readL2(r3);
  check(n3 === wEv && n3 > 0 && piecesAt(applyEvents(b3, d3, 0, e + 1), 0, mainArea, other.entries).length >= n3, `in event ${e.toString(16)}: ${n3} pieces replaced in the map after it`);
  check(piecesAt(applyEvents(b3, d3, 0, e), 0, mainArea, water.entries).length === piecesAt(beforeEv, 0, mainArea, water.entries).length && b3.every((v, i) => v === base[i]),
    'the map before the event and before events as they were');
  check(s3.history.undoStack.length === 1, 'one ROM edit');
}

if (bad) { console.log(`${bad} failed`); process.exit(1); }
console.log('all ok');
