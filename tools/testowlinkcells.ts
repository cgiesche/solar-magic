// Overworld link ends as objects on layer 1 (#413, owlinks.ts linkEndCells, moveLinkEnds): the cells links, Koopa
// Kids' places and locations end at; a paint stroke and the route brush leave them alone; a level tile moved takes
// them along – star/pipe and exit path links (both ends, swapped with the tile there), a Koopa Kid's place. What ends
// at a cell (linkMarks): its mark's meaning in the status bar (#461).
import { Rom } from '../src/core/rom.ts';
import { readLinks, linkEndCells, linkMarks, moveLinkEnds, koopaTeleport, warpCells, type OwLink, type LinkEnd } from '../src/core/owlinks.ts';
import { endTile } from '../src/core/owlinkends.ts';
import { sameTile } from '../src/core/owteleport.ts';
import { readSecondaryEntrance, writeSecondaryEntrance, newOverworldExit } from '../src/core/level.ts';
import { l1Index, readL1, readL2, gameL1, OverworldLoads, OverworldEmulator, OW_EVENTS } from '../src/core/overworld.ts';
import { OverworldStroke } from '../src/core/owstroke.ts';
import { levelTileTest } from '../src/core/owpaths.ts';
import { routeTiles } from '../src/core/owroute.ts';
import { linkTileProblems, applyFix } from '../src/core/worldcheck.ts';
import { editorImage, pathKinds, pathShapes } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const image = await editorImage();
const fresh = () => new Rom(image.slice());
const rom = fresh(), l1 = readL1(rom), links = readLinks(rom);
const kinds = pathKinds(fresh()), shapes = pathShapes(fresh());
const gameL1Every = gameL1(new OverworldLoads(new OverworldEmulator(fresh()), 1).get(0, OW_EVENTS)).slice();
const hx = (v: number) => v.toString(16);
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

// ---- what ends at a cell (its mark's meaning on hover, #461) ----
{
  const marks = linkMarks(rom, l1), k0 = koopaTeleport(rom, 0)!;
  const star = find(links, 0, 17, 7)!;
  check((marks.get(endTile(star.a)) ?? []).some((m) => m.kind === 'link' && sameTile(m.link.a, star.a)), 'a star\'s tile: its link');
  check((marks.get(0x766) ?? []).some((m) => m.kind === 'koopaTile' && m.k === 0), 'Koopa Kid 1\'s tile: its tile');
  check((marks.get(l1Index(1, k0.x, k0.y)) ?? []).filter((m) => m.kind === 'koopaPlace' && m.k === 0).length === 1, 'and its place, once');
  // (an entrance's exit to the overworld teleporting to the star's entry: its target a location too)
  const r = fresh(), loc = star.entries[0];
  writeSecondaryEntrance(r, 0x40, { ...readSecondaryEntrance(r, 0x40), destLevel: 0x105, overworld: { ...newOverworldExit(), teleport: 1, location: loc } });
  check((linkMarks(r, l1).get(endTile(star.b)) ?? []).some((m) => m.kind === 'location' && m.i === loc), 'the tile an exit to the overworld teleports to: a location');
  check(!marks.has(l1Index(0, 0, 0)), 'a cell nothing ends at: no mark');
  check([...marks.keys()].every((i) => linkEndCells(rom, l1).has(i)) && marks.size === linkEndCells(rom, l1).size, 'the cells: linkEndCells');
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

// ---- where a star/pipe link may start (#455): a cell where A warps at some event progress ----
{
  const warps = warpCells(rom, kinds), yi = l1Index(1, 6, 7);
  const sw = links.filter((l) => l.kind === 'star').flatMap((l) => (l.both ? [l.a, l.b] : [l.a])).filter((e) => l1[endTile(e)] === 0x5a);
  check(warps.has(l1Index(0, 17, 7)), 'a pipe on the map before events: a source');
  check(sw.length === 7 && sw.every((e) => warps.has(endTile(e))), `the seven 05A ends (Star World, Star Road; an event turns them into 05F): sources (${sw.length})`);
  check(!warps.has(yi) && kinds[l1[yi]] === 'level', 'the level tile at Yoshi\'s Island 06,07: not a source');
  const stop = l1.findIndex((t) => kinds[t] === 'stop');
  check(stop >= 0 && !warps.has(stop), `a plain stop tile ${hx(l1[stop])} (${hx(stop)}): not a source`);
}

// ---- the World check: a link from or to a tile Mario can't use it on ----
{
  // (the maps at each progress: `before` up to progress `p`, `after` from it)
  const place = (i: number) => hx(i), on = (before: ArrayLike<number>, after = before, p = 0) =>
    linkTileProblems(links, (q) => ({ inp: { l1: q < p ? before : after, kinds } }), place);
  const every = gameL1Every;
  const deadStar = find(links, 0, 20, 2)!;
  // (#455: A warps only on a star or pipe – path kind 'warp' –, the clean game's entry from Yoshi's Island 06,07 is on
  // the level tile 056 at every progress: A enters the level there)
  const yi = l1Index(1, 6, 7), clean = on(every);
  check(clean.length === 1 && clean[0].tile === yi && clean[0].severity === 'warn' && kinds[every[yi]] === 'level' && !!clean[0].fix && 'link' in clean[0].fix,
    `the clean game: one warning, its star/pipe entry from the level tile at Yoshi's Island 06,07 (${clean.map((p) => `${hx(p.tile)} ${p.text}`).join('; ')})`);
  check(every[endTile(deadStar.a)] === 0 && !clean.some((p) => p.tile === endTile(deadStar.a)), 'its star entry from Main map 14,02 (empty at every progress): none');
  const stop = every.slice();
  stop[endTile(deadStar.a)] = 0x81;
  const s81 = on(stop).filter((p) => p.tile === endTile(deadStar.a));
  check(kinds[0x81] === 'stop' && s81.length === 1 && s81[0].severity === 'warn', `a star/pipe link from a plain stop tile 81: a warning (${s81[0]?.text})`);
  const known = (ps: ReturnType<typeof on>) => ps.filter((p) => p.tile !== yi);
  check(known(on(l1, every, 5)).length === 0, 'a star an event reveals later (none before): none');
  const star = find(links, 0, 17, 7)!, painted = every.slice();
  painted[endTile(star.a)] = 0;
  const p = known(on(every, painted, 3));
  check(p.length === 1 && p[0].group === 'links' && p[0].severity === 'error' && p[0].tile === endTile(star.a) && p[0].progress === 3 && !!p[0].fix && 'link' in p[0].fix && p[0].fix.link === star,
    `a star's tile changed by an event: one error there, from that progress, its fix removing the link (${p[0]?.text})`);
  check(known(on(painted, every, 3)).length === 0, 'changed back by a later event: none');
  const exit = find(links, 0, 2, 20)!, gone = every.slice();
  gone[endTile(exit.b)] = 0;
  const q = known(on(gone)), path = every.slice();
  check(q.length === 0, 'an exit path\'s target empty at every progress: none (Mario never there)');
  path[endTile(exit.b)] = every[l1Index(0, 5, 20)];
  const w = known(on(path));
  check(kinds[path[endTile(exit.b)]] !== 'exit' && kinds[path[endTile(exit.b)]] !== 'none' && w.length === 1 && w[0].tile === endTile(exit.b) && w[0].severity === 'warn' && / to /.test(w[0].text),
    `an exit path's target another tile at every progress: a warning at its target (${w[0]?.text})`);
  const r = fresh();
  applyFix(r, p[0].fix!);
  check(!find(readLinks(r), 0, 17, 7) && readLinks(r).length === links.length - 1, 'the fix removes the link');
}

if (bad) { console.log(`${bad} failed`); process.exit(1); }
console.log('all ok');
