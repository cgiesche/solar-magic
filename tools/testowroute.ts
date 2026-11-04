// Route solving (owroute.ts routeTiles): the path tiles for a route of cells, proven on the game's own paths. Every
// path of the test ROM's main map and Yoshi's Island (the ways Mario walks with every event passed, owreach.ts), its
// path tiles cleared, is given back by the route of its cells: tiles with the ways the game's tiles have there, and
// Mario walks the rebuilt map along the route both ways as the game moves him (owreach.ts walkFrom: the path shapes
// learned by emulation). A route running into a path gets a stop tile at the junction (as the game's own junctions
// have one), a route ending on nothing a stop tile there; a turn no tile makes is refused with the cell, why and what
// would work there.
// node tools/testowroute.ts
import { Rom } from '../src/core/rom.ts';
import { OverworldEmulator, OverworldLoads, gameL1, l1Index, l1XY, OW_EVENTS, DIR_NAMES } from '../src/core/overworld.ts';
import { progressSaves } from '../src/core/owprogress.ts';
import { reach, reachInput, walkFrom, type ReachInput, type Walk } from '../src/core/owreach.ts';
import { readStart } from '../src/core/owsprites.ts';
import { submapViews, submapOf } from '../src/core/owevents.ts';
import { RAM } from '../src/core/ram.ts';
import { DX, DY, PATH_TILES_END, reverse, type PathKind } from '../src/core/owpaths.ts';
import { tileWays, SHAPED_KINDS } from '../src/core/owpathshape.ts';
import { routeTiles, type RouteInput } from '../src/core/owroute.ts';
import { stopTile } from '../src/core/owleveltiles.ts';
import { refusalDetails } from '../src/core/owrefusal.ts';
import { editorImage, pathKinds, pathShapes } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const hx = (v: number, n = 2) => v.toString(16).toUpperCase().padStart(n, '0');
const at = (i: number) => { const { x, y } = l1XY(i); return `${i >> 10 ? 'submaps' : 'main'} ${hx(x)},${hx(y)}`; };

const rom = new Rom(await editorImage());
const kinds = pathKinds(rom), shapes = pathShapes(rom);
const loads = new OverworldLoads(new OverworldEmulator(rom), 4), saves = progressSaves(loads);
const r = loads.get(0, OW_EVENTS);
const all = reachInput(rom, gameL1(r).slice(), r.wram.slice(RAM.owTranslevels, RAM.owTranslevelsEnd), saves[OW_EVENTS].levelFlags, kinds, shapes, readStart(rom, 0));
const game = all.l1, views = submapViews(loads), STOP = stopTile(kinds);
const shaped = (t: number) => SHAPED_KINDS.includes(kinds[t]);
const stepDir = (a: number, b: number) => [0, 1, 2, 3].find((d) => { const p = l1XY(a), q = l1XY(b); return a >> 10 === b >> 10 && p.x + DX[d] === q.x && p.y + DY[d] === q.y; }) ?? -1;
const solveInput = (l1: ArrayLike<number>, prefer: PathKind): RouteInput => ({ l1, kinds, shapes, prefer });
// the way a tile takes Mario from cell `a` over cell c to cell b (null: it doesn't)
const wayOver = (t: number, a: number, c: number, b: number) => tileWays(t, kinds[t], shapes).find((w) => w.dir === stepDir(a, c) && w.out === stepDir(c, b)) ?? null;

// ---- the game's paths, rebuilt ----
// the ways Mario walks with every event passed, on the main map and Yoshi's Island: each path once (one of its two
// directions), not the game's hardcoded paths (no tiles)
const reached = reach(all);
const onMaps = (i: number) => [0, 1].includes(submapOf(views, i));
const paths: { from: number; dir: number; w: Walk }[] = [];
const seenPath = new Set<string>();
for (const [k, w] of reached.walks) {
  const from = k >> 2, cells = [from, ...w.path, w.to];
  if (w.to < 0 || !w.path.length || !cells.every(onMaps)) continue;
  if (w.path.some((i) => kinds[game[i]] === 'none')) continue; // (a hardcoded path)
  const id = [...cells].sort((a, b) => a - b).join();
  if (seenPath.has(id)) continue;
  seenPath.add(id);
  paths.push({ from, dir: k & 3, w });
}
// a walk's routes: its cells split where an exit takes Mario to another submap (an exit tile ends one, the exit tile
// he comes out at starts the next)
const routesOf = (from: number, w: Walk): number[][] => {
  const out: number[][] = [[from]];
  for (const c of [...w.path, w.to]) {
    const cur = out.at(-1)!;
    if (stepDir(cur.at(-1)!, c) < 0) out.push([c]); else cur.push(c);
  }
  return out;
};
let tilesN = 0, sameTile = 0, samePoints = 0;
const failed: string[] = [];
for (const p of paths) {
  const l1 = Uint16Array.from(game), routes = routesOf(p.from, p.w);
  for (const c of p.w.path) if (shaped(game[c])) l1[c] = 0;
  for (const route of routes) {
    const firstPath = route.find((c, k) => k > 0 && shaped(game[c]));
    if (firstPath === undefined) continue;
    const res = routeTiles(route, solveInput(l1, kinds[game[firstPath]]));
    if (res.refusal) { failed.push(`${at(p.from)} ${DIR_NAMES[p.dir]}: refused at ${at(res.refusal.cell)} (${refusalDetails(res.refusal.why)})`); continue; }
    for (let k = 1; k < route.length - 1; k++) {
      const c = route[k], t = res.tiles[k];
      if (!shaped(game[c])) continue;
      tilesN++;
      const mine = t === null ? null : wayOver(t, route[k - 1], c, route[k + 1]), theirs = wayOver(game[c], route[k - 1], c, route[k + 1]);
      if (!mine || !theirs) { failed.push(`${at(c)}: ${t === null ? 'no tile' : hx(t)} for the game's ${hx(game[c])}: ${mine ? '' : 'no way'}`); continue; }
      if (t === game[c]) sameTile++;
      if (mine.from.join() === theirs.from.join() && mine.to.join() === theirs.to.join()) samePoints++;
      l1[c] = t!;
    }
  }
  // Mario walks the rebuilt map as the game's, both ways
  const inp: ReachInput = { ...all, l1 };
  const there = walkFrom(inp, p.from, p.dir), back = walkFrom(inp, p.w.to, reverse(p.w.dir));
  const same = (a: Walk | null, path: number[], to: number) => !!a && a.to === to && a.path.join() === path.join();
  if (!same(there, p.w.path, p.w.to)) failed.push(`${at(p.from)} ${DIR_NAMES[p.dir]}: Mario walks ${there?.path.map(at).join(' ')} → ${there && there.to >= 0 ? at(there.to) : 'stuck'}`);
  else if (!same(back, [...p.w.path].reverse(), p.from)) failed.push(`${at(p.w.to)} back: Mario walks ${back?.path.map(at).join(' ')} → ${back && back.to >= 0 ? at(back.to) : 'stuck'}`);
}
check(paths.length >= 40 && !failed.length, `the game's ${paths.length} paths on the main map and Yoshi's Island, their path tiles cleared: each route's tiles have the ways the game's have, Mario walks them both ways ${failed.slice(0, 8).join('; ')}`);
console.log(`     ${tilesN} path tiles: ${samePoints} with the game's line, ${sameTile} the game's own tile`);
// the route over the path as it is: nothing replaced but by a tile with the same way, no stop tile added (the path it
// runs along is no junction)
{
  const changed: string[] = [];
  for (const p of paths) for (const route of routesOf(p.from, p.w)) {
    const firstPath = route.find((c, k) => k > 0 && shaped(game[c]));
    if (firstPath === undefined) continue;
    const res = routeTiles(route, solveInput(game, kinds[game[firstPath]]));
    route.forEach((c, k) => { if (res.tiles[k] !== null && res.tiles[k] !== game[c]) changed.push(`${at(c)} ${hx(game[c])}→${hx(res.tiles[k]!)}`); });
  }
  check(!changed.length, `the routes over the paths as they are: the game's tiles kept ${changed.slice(0, 6).join(', ')}`);
}

// ---- junctions ----
// the game's junctions: stop tiles (not level tiles) with paths on three sides or more; a route along each path into
// one, where a path runs through it (the junction's tile a path tile leading between two of the other sides), gets a
// stop tile there
{
  const results: string[] = [], tried: string[] = [];
  for (const j of reached.stops) {
    if (kinds[game[j]] !== 'stop' || !onMaps(j)) continue;
    const sides = [0, 1, 2, 3].filter((d) => { const { x, y } = l1XY(j), nx = x + DX[d], ny = y + DY[d];
      return nx >= 0 && ny >= 0 && nx < 32 && ny < 32 && kinds[game[l1Index(j >> 10, nx, ny)]] !== 'none'; });
    if (sides.length < 3) continue;
    // each path into it (its stretch on the junction's submap)
    const arms = paths.flatMap((p) => p.w.to === j ? [routesOf(p.from, p.w).at(-1)!] : p.from === j ? [[...routesOf(p.from, p.w)[0]].reverse()] : [])
      .filter((route) => route.length > 2 && route.at(-1) === j);
    for (const route of arms) {
      const inSide = reverse(stepDir(route.at(-2)!, j)), others = sides.filter((d) => d !== inSide);
      const through = Array.from({ length: PATH_TILES_END - 1 }, (_, k) => k + 1).find((t) => shaped(t) && tileWays(t, kinds[t], shapes).some((w) => reverse(w.dir) === others[0] && w.out === others[1]));
      if (through === undefined) continue;
      tried.push(`${at(j)} from ${DIR_NAMES[inSide]}`);
      const l1 = Uint16Array.from(game);
      l1[j] = through;
      for (const c of route.slice(1, -1)) if (shaped(game[c])) l1[c] = 0;
      const res = routeTiles(route, solveInput(l1, 'walk'));
      if (res.refusal || res.tiles.at(-1) !== STOP) results.push(`${at(j)}: ${res.refusal ? refusalDetails(res.refusal.why) : hx(res.tiles.at(-1) ?? 0)}`);
    }
  }
  check(tried.length >= 4 && !results.length, `the game's junctions: a route running into the path through one gets a stop tile there (${tried.join(', ')}) ${results.join('; ')}`);
}
// a route crossing a path in its middle, from nothing to nothing: stop tiles at its ends and where it crosses
const empty = (cx: number, cy: number) => {
  const l1 = Uint16Array.from(game);
  for (let y = cy - 4; y <= cy + 4; y++) for (let x = cx - 4; x <= cx + 4; x++) l1[l1Index(0, x, y)] = 0;
  return l1;
};
const CX = 16, CY = 16;
{
  const l1 = empty(CX, CY), cell = (x: number, y: number) => l1Index(0, x, y);
  // a path left to right: stop, 04, 04, 04, stop
  l1[cell(CX - 2, CY)] = l1[cell(CX + 2, CY)] = STOP;
  for (let x = CX - 1; x <= CX + 1; x++) l1[cell(x, CY)] = 0x04;
  const route = [-2, -1, 0, 1, 2].map((k) => cell(CX, CY + k));
  const res = routeTiles(route, solveInput(l1, 'walk'));
  check(!res.refusal && res.tiles[0] === STOP && res.tiles[4] === STOP && res.tiles[2] === STOP && res.tiles[1] !== null && wayOver(res.tiles[1]!, route[0], route[1], route[2])?.dir === 1,
    `a route down across a path: stop tiles at its ends and the crossing, path tiles between (${res.tiles.map((t) => t === null ? '–' : hx(t)).join(' ')})`);
  // along the path, from its stop to its stop: the path's tiles kept, no junction
  const along = [-2, -1, 0, 1, 2].map((k) => cell(CX + k, CY));
  const res2 = routeTiles(along, solveInput(l1, 'walk'));
  check(!res2.refusal && res2.tiles.join() === ',4,4,4,', `a route along the path: its tiles kept, its stops left alone (${res2.tiles.join()})`);
}
// a route ending on nothing: a stop tile at each end; a route leaving and coming back to a level tile left alone
{
  const l1 = empty(CX, CY), cell = (x: number, y: number) => l1Index(0, x, y);
  const route = [cell(CX - 2, CY), cell(CX - 1, CY), cell(CX, CY), cell(CX, CY - 1), cell(CX, CY - 2)];
  const res = routeTiles(route, solveInput(l1, 'walk'));
  check(!res.refusal && res.tiles[0] === STOP && res.tiles[4] === STOP && res.tiles.slice(1, 4).every((t) => t !== null && shaped(t)),
    `a route from nothing right then up to nothing: stop tiles at its ends, a bend (${res.tiles.map((t) => t === null ? '–' : hx(t)).join(' ')})`);
  const lvl = kinds.findIndex((k) => k === 'level');
  l1[cell(CX - 2, CY)] = lvl;
  const res2 = routeTiles([cell(CX - 2, CY), cell(CX - 1, CY), cell(CX - 1, CY - 1), cell(CX - 2, CY - 1), cell(CX - 2, CY)], solveInput(l1, 'walk'));
  check(res2.tiles[0] === null && res2.tiles[4] === null && !res2.refusal, `a route round from a level tile back to it: the level tile left alone (${res2.tiles.map((t) => t === null ? '–' : hx(t)).join(' ')}${res2.refusal ? ' ' + res2.refusal.why : ''})`);
}
// the preferred kind: a ladder up where a climbing tile fits, a walk tile where none bends
{
  const l1 = empty(CX, CY), cell = (x: number, y: number) => l1Index(0, x, y);
  const route = [cell(CX, CY + 2), cell(CX, CY + 1), cell(CX, CY), cell(CX + 1, CY), cell(CX + 2, CY)];
  const res = routeTiles(route, solveInput(l1, 'climb'));
  check(!res.refusal && kinds[res.tiles[1]!] === 'climb' && kinds[res.tiles[2]!] === 'walk',
    `preferring climbing: a ladder up (${hx(res.tiles[1] ?? 0)}), the bend walked (${hx(res.tiles[2] ?? 0)})`);
}

// ---- refused ----
// a turn no tile makes: a ROM whose path tiles make no bend (the bends' kinds 'none'): the cell, why, what would work
{
  const straight = kinds.map((k, t) => (SHAPED_KINDS.includes(k) && t < 0x100 && tileWays(t, k, shapes).some((w) => w.dir !== w.out) ? 'none' : k));
  const l1 = empty(CX, CY), cell = (x: number, y: number) => l1Index(0, x, y);
  const route = [cell(CX - 2, CY), cell(CX - 1, CY), cell(CX, CY), cell(CX, CY - 1), cell(CX, CY - 2)];
  const res = routeTiles(route, { l1, kinds: straight, shapes, prefer: 'walk' });
  const f = res.refusal;
  check(!!f && f.at === 2 && f.cell === route[2] && f.why.kind === 'routeNoTile' && refusalDetails(f.why) === 'No path tile leads Mario from the left up.' && f.stop && f.turns.join() === '3',
    `no bend: refused at the corner (${f ? `${at(f.cell)}: "${refusalDetails(f.why)}", a stop tile there: ${f.stop}, turns: ${f.turns.map((d) => DIR_NAMES[d])}` : 'not refused'})`);
  check(res.tiles[1] !== null && kinds[res.tiles[1]!] === 'walk', `the cells before it still get their tiles (${res.tiles.map((t) => t === null ? '–' : hx(t)).join(' ')})`);
}
// not a route: a cell not next to the one before, an exit tile in the middle, crossing itself
{
  const l1 = empty(CX, CY), cell = (x: number, y: number) => l1Index(0, x, y);
  const gap = routeTiles([cell(CX, CY), cell(CX + 2, CY)], solveInput(l1, 'walk'));
  check(gap.refusal?.at === 1 && gap.refusal.why.kind === 'routeGap', `a gap: refused (${gap.refusal?.why.kind})`);
  const exit = kinds.findIndex((k) => k === 'exit');
  l1[cell(CX, CY)] = exit;
  const ex = routeTiles([cell(CX - 1, CY), cell(CX, CY), cell(CX + 1, CY)], solveInput(l1, 'walk'));
  check(ex.refusal?.at === 1 && ex.refusal.why.kind === 'routeExitInside', `an exit tile in the middle: refused (${ex.refusal?.why.kind})`);
  l1[cell(CX, CY)] = 0;
  const loop = [cell(CX, CY), cell(CX + 1, CY), cell(CX + 1, CY + 1), cell(CX, CY + 1), cell(CX, CY), cell(CX - 1, CY)];
  const cross = routeTiles([cell(CX - 1, CY), ...loop.slice(0, -1), cell(CX + 1, CY)], solveInput(l1, 'walk'));
  check(cross.refusal?.why.kind === 'routeCrosses', `a route over its own path tile: refused (${cross.refusal?.why.kind})`);
}

console.log(bad ? `\n${bad} FAILED` : '\nall ok');
process.exit(bad ? 1 : 0);
