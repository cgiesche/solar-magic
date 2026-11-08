// Overworld link ends as objects on layer 1 (#413, owlinks.ts linkEndCells, moveLinkEnds): the cells links, Koopa
// Kids' places and locations end at; a paint stroke and the route brush leave them alone; a level tile moved takes
// them along – star/pipe and exit path links (both ends, swapped with the tile there), a Koopa Kid's place.
import { Rom } from '../src/core/rom.ts';
import { readLinks, linkEndCells, moveLinkEnds, koopaTeleport, type OwLink, type LinkEnd } from '../src/core/owlinks.ts';
import { endTile } from '../src/core/owlinkends.ts';
import { l1Index, readL1, readL2 } from '../src/core/overworld.ts';
import { OverworldStroke } from '../src/core/owstroke.ts';
import { levelTileTest } from '../src/core/owpaths.ts';
import { routeTiles } from '../src/core/owroute.ts';
import { editorImage, pathKinds, pathShapes } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const image = await editorImage();
const fresh = () => new Rom(image.slice());
const rom = fresh(), l1 = readL1(rom), links = readLinks(rom);
const kinds = pathKinds(fresh()), shapes = pathShapes(fresh());
const at = (e: LinkEnd, s: number, x: number, y: number) => e.submap === s && e.x === x && e.y === y;
const find = (ls: OwLink[], s: number, x: number, y: number) => ls.find((l) => at(l.a, s, x, y));

// ---- the cells ----
{
  const cells = linkEndCells(rom, l1);
  check(links.length > 10 && links.every((l) => cells.has(endTile(l.a)) && cells.has(endTile(l.b))), 'both ends of every link of the clean game');
  const k0 = koopaTeleport(rom, 0)!;
  check(cells.has(0x766) && cells.has(l1Index(1, k0.x, k0.y)), 'a Koopa Kid\'s tile with a place and its place');
  check(!cells.has(0x768) && koopaTeleport(rom, 1) === null, 'a Koopa Kid\'s tile without a place: none');
  check(!cells.has(l1Index(0, 0, 0)), 'a cell nothing ends at: none');
}

// ---- painting and routes leave them alone ----
{
  const r = fresh(), maps = { l1: readL1(r), l2: readL2(r) }, cells = linkEndCells(r, maps.l1);
  const src = endTile(find(links, 0, 17, 7)!.a);
  const stroke = new OverworldStroke(r, 'l1', maps, levelTileTest(kinds), null, null, (i) => cells.has(i));
  check(!stroke.paint(0, 17, 7, 0) && maps.l1[src] === l1[src], 'a stroke leaves a star\'s tile alone');
  check(stroke.paint(0, 0, 0, 1) && maps.l1[0] === 1, 'and paints a cell nothing ends at');
  // (a row of 5 cells nothing walks on, the middle one fixed)
  let row: number[] = [];
  for (let y = 0; y < 32 && row.length < 5; y++) for (let x = 0; x + 5 <= 32 && row.length < 5; x++) {
    const r5 = [0, 1, 2, 3, 4].map((d) => l1Index(0, x + d, y));
    if (r5.every((c) => kinds[l1[c]] === 'none')) row = r5;
  }
  const inp = { l1, kinds, shapes, prefer: 'walk' as const };
  const free = routeTiles(row, inp), held = routeTiles(row, { ...inp, fixed: new Set([row[2]]) });
  check(row.length === 5 && free.refusal?.why.kind !== 'routeLinkEnd', 'a route over cells nothing ends at: not refused for a link');
  check(held.refusal?.why.kind === 'routeLinkEnd' && held.refusal.at === 2, 'a route over a link\'s cell: refused there');
  // (a route ending on a star's stop tile: kept)
  const star = find(links, 0, 17, 7)!.a, beside = [l1Index(0, star.x - 2, star.y), l1Index(0, star.x - 1, star.y), endTile(star)];
  check(routeTiles(beside, { ...inp, fixed: new Set([endTile(star)]) }).refusal?.why.kind !== 'routeLinkEnd', 'a route ending on a star\'s tile: kept, not refused');
}

// ---- moved with a level tile ----
{
  const r = fresh(), a = l1Index(0, 17, 7), to = l1Index(0, 18, 7);
  moveLinkEnds(r, a, to);
  const ls = readLinks(r), l = find(ls, 0, 18, 7);
  check(!!l && at(l.b, 2, 10, 20) && l.both && !find(ls, 0, 17, 7) && ls.length === links.length, 'a star link\'s source moved to the cell beside, both ways still');
}
{
  const r = fresh();
  moveLinkEnds(r, l1Index(0, 17, 7), l1Index(0, 10, 3));
  const ls = readLinks(r);
  check(at(find(ls, 0, 10, 3)!.b, 2, 10, 20) && at(find(ls, 0, 17, 7)!.b, 2, 3, 11), 'two stars\' tiles swapped: each link with its tile');
}
{
  const r = fresh();
  moveLinkEnds(r, l1Index(0, 2, 20), l1Index(0, 3, 20));
  const l = find(readLinks(r), 0, 3, 20);
  check(!!l && l.kind === 'exit' && l.a.side === 0 && at(l.b, 1, 4, 0) && l.b.side === 1 && l.both, 'an exit path\'s source moved: its side and target kept, both ways');
}
{
  const r = fresh();
  moveLinkEnds(r, l1Index(1, 4, 0), l1Index(1, 5, 0));
  const l = find(readLinks(r), 0, 2, 20);
  check(!!l && at(l.b, 1, 5, 0) && l.b.side === 1 && l.both, 'an exit path\'s target moved (its way back from there too)');
}
{
  const r = fresh(), p = koopaTeleport(r, 0)!;
  moveLinkEnds(r, l1Index(1, p.x, p.y), l1Index(1, p.x + 1, p.y));
  const q = koopaTeleport(r, 0);
  check(!!q && q.x === p.x + 1 && q.y === p.y, 'a Koopa Kid\'s place moved');
  const r2 = fresh();
  moveLinkEnds(r2, l1Index(0, p.x, p.y), l1Index(0, p.x + 1, p.y));
  check(koopaTeleport(r2, 0)!.x === p.x, 'not by a move on the other region');
}

if (bad) { console.log(`${bad} failed`); process.exit(1); }
console.log('all ok');
