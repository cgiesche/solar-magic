// A level tile moved with its paths (#367, owlevelmove.ts): the paths from it to the next level, stop or exit tile are
// drawn again from there to where it goes – the shortest way, the old path's cells first, its tiles chosen by the route
// solver (owroute.ts), the cells it no longer uses cleared, the level's exit directions and initial flags turned with
// it. A path with a cell not of the progress edited, one forking on the way, one no way or no tile leads along: kept
// where it was (said). On a map with only the tiles put, then written on the test ROM before events: one ROM edit,
// Mario walks the new path both ways, undo restores.
// node tools/testowlevelmove.ts
import { Rom } from '../src/core/rom.ts';
import { RomEditSession } from '../src/core/romedit.ts';
import { readL1, readTranslevels, l1Index, l1XY, exitDirections, setExitDirection, initialFlags, setInitialFlags, DIR_FLAGS } from '../src/core/overworld.ts';
import { readEvents } from '../src/core/owevents.ts';
import { walkFrom, neighbor, type ReachInput } from '../src/core/owreach.ts';
import { levelPaths, planLevelMove, moveLevelTileWithPaths } from '../src/core/owlevelmove.ts';
import { routeTiles, writeRoute, stopTranslevels } from '../src/core/owroute.ts';
import { moveLevelTile, stopTile } from '../src/core/owleveltiles.ts';
import { editorImage, pathKinds, pathShapes } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const hx = (v: number, n = 2) => v.toString(16).toUpperCase().padStart(n, '0');
const at = (i: number) => { const { x, y } = l1XY(i); return `${hx(x)},${hx(y)}`; };
const same = (a: ArrayLike<number>, b: ArrayLike<number>) => a.length === b.length && Array.from(a).every((v, i) => v === b[i]);

const image = await editorImage();
const kinds = pathKinds(new Rom(image.slice())), shapes = pathShapes(new Rom(image.slice()));
const LEVEL = kinds.indexOf('level') as number, STOP = stopTile(kinds), H = 0x04, V = 0x10;
const c = (x: number, y: number) => l1Index(0, x, y);
const map = (put: [number, number, number][]) => {
  const l1 = new Uint16Array(0x800);
  for (const [x, y, t] of put) l1[c(x, y)] = t;
  return l1;
};
// where Mario walks from cell `from` in direction d on map l1 (the tile he stops at, -1 none)
const walkTo = (l1: ArrayLike<number>, from: number, d: number) => {
  const inp: ReachInput = { l1, tls: new Uint8Array(l1.length), flags: [], kinds, shapes, start: 0, stars: new Map(), exitPaths: [], hard: [] };
  return walkFrom(inp, from, d)?.to ?? -1;
};
const all = () => true, empty = () => 0;

// ---- the paths of a level tile ----
// level at 3,5; a path right to a stop at 7,5; one up to a stop at 3,2
const base = map([[3, 5, LEVEL], [4, 5, H], [5, 5, H], [6, 5, H], [7, 5, STOP], [3, 4, V], [3, 3, V], [3, 2, STOP]]);
const paths = levelPaths(base, kinds, shapes, c(3, 5));
check(paths.length === 2 && paths.some((p) => p.dir === 3 && same(p.cells, [c(4, 5), c(5, 5), c(6, 5)]) && p.far === c(7, 5))
  && paths.some((p) => p.dir === 0 && same(p.cells, [c(3, 4), c(3, 3)]) && p.far === c(3, 2)),
`its paths: ${paths.map((p) => `${'udlr'[p.dir]} ${p.cells.map(at).join(' ')} → ${p.far === null ? '–' : at(p.far)}`).join('; ')}`);

// ---- moved: each path drawn again, the shortest way, the old cells first ----
{
  // level 3,5 → 4,8 (below): the path right goes from 6,5 (the cell beside its stop) down to it
  const plan = planLevelMove({ l1: base, kinds, shapes, editable: all, cleared: empty }, c(3, 5), c(4, 8));
  const l1 = plan.l1;
  check(plan.kept.length === 0 && plan.routes.length === 2, `both paths drawn again (kept: ${plan.kept.map((k) => k.why).join(' ') || '–'})`);
  const onRoutes = new Set(plan.routes.flatMap((r) => r.route));
  check(l1[c(4, 8)] === LEVEL && (onRoutes.has(c(3, 5)) || kinds[l1[c(3, 5)]] === 'none'), 'the level tile at 4,8, at 3,5 nothing or a path drawn again');
  check(walkTo(l1, c(7, 5), 2) === c(4, 8), `from the stop at 7,5 to the left Mario walks to the level (${at(walkTo(l1, c(7, 5), 2))})`);
  check(walkTo(l1, c(3, 2), 1) === c(4, 8), `from the stop at 3,2 down Mario walks to the level (${at(walkTo(l1, c(3, 2), 1))})`);
  const right = plan.routes.find((r) => r.path.dir === 3)!;
  check(right.route.length === 1 + 2 + 4 && right.route[0] === c(7, 5) && right.route[1] === c(6, 5) && right.route.at(-1) === c(4, 8),
    `the way right: the shortest from 6,5 (${right.route.map(at).join(' ')})`);
  check(right.route.includes(c(5, 5)) && right.route.includes(c(4, 5)), 'the old cells first (5,5 and 4,5 on it)');
  // from the level its ways: the path right arrives from above or the right, the one up from another side
  const sides = plan.routes.map((r) => r.dirNew);
  check(new Set(sides).size === 2, `the two paths reach the level from different sides (${sides.map((d) => 'udlr'[d]).join(' ')})`);
  // the level's own ways turned with it: the old direction of each path → its new one
  check(plan.routes.every((r) => r.dirOld === r.path.dir && neighbor(c(4, 8), r.dirNew) === r.route.at(-2)), 'each path\'s old and new direction from the level');
}
// moved along its own path (onto 5,5): the path right shortened, the cells behind cleared
{
  const plan = planLevelMove({ l1: base, kinds, shapes, editable: all, cleared: empty }, c(3, 5), c(5, 5));
  const l1 = plan.l1, right = plan.routes.find((r) => r.path.dir === 3);
  const onRoutes2 = new Set(plan.routes.flatMap((r) => r.route));
  check(!!right && same(right.route, [c(7, 5), c(6, 5), c(5, 5)]) && [c(3, 5), c(4, 5)].every((i) => onRoutes2.has(i) || kinds[l1[i]] === 'none'),
    `moved onto its path: the path right shortened (${right?.route.map(at).join(' ')}), 3,5 and 4,5 cleared where no new path runs`);
  check(walkTo(l1, c(3, 2), 1) === c(5, 5), 'the path up drawn to it');
}

// ---- kept where they were ----
{
  // a cell not of the progress edited (an event's): kept
  const p1 = planLevelMove({ l1: base, kinds, shapes, editable: (i) => i !== c(5, 5), cleared: empty }, c(3, 5), c(4, 8));
  check(p1.routes.length === 1 && p1.kept.length === 1 && p1.kept[0].why === 'progress' && p1.kept[0].path.dir === 3 && p1.l1[c(5, 5)] === H,
    `a path with a cell of another progress: kept (${p1.kept.map((k) => k.why)})`);
  // forking on the way (a second path off it at 5,5 without a stop): not one path – kept
  const fork = map([[3, 5, LEVEL], [4, 5, H], [5, 5, 0x1a], [6, 5, H], [7, 5, STOP], [5, 6, V], [5, 7, STOP]]);
  const pf = planLevelMove({ l1: fork, kinds, shapes, editable: all, cleared: empty }, c(3, 5), c(3, 8));
  check(pf.kept.some((k) => k.why === 'fork' && k.path.dir === 3) && pf.l1[c(4, 5)] === H && pf.l1[c(3, 8)] === LEVEL,
    `a path forking on the way: kept, the level moved (${pf.kept.map((k) => k.why)})`);
  // no way: the level walled in (stops all round the target): kept, the level moved
  const walled = map([[3, 5, LEVEL], [4, 5, H], [5, 5, H], [6, 5, STOP], [10, 9, STOP], [10, 11, STOP], [9, 10, STOP], [11, 10, STOP]]);
  const pw = planLevelMove({ l1: walled, kinds, shapes, editable: all, cleared: empty }, c(3, 5), c(10, 10));
  check(pw.routes.length === 0 && pw.kept.length === 1 && pw.kept[0].why === 'noWay' && pw.l1[c(10, 10)] === LEVEL && pw.l1[c(4, 5)] === H,
    `no way to it: kept where it was, the level moved (${pw.kept.map((k) => k.why)})`);
}

// ---- review cases ----
{
  // dropped on the far end of its own path (swapped with the stop there): that path stays between the two
  const pf = planLevelMove({ l1: base, kinds, shapes, editable: all, cleared: empty }, c(3, 5), c(7, 5));
  check(pf.kept.some((k) => k.why === 'far' && k.path.dir === 3) && [4, 5, 6].every((x) => pf.l1[c(x, 5)] === H) && walkTo(pf.l1, c(3, 5), 3) === c(7, 5),
    `dropped on its path's far end: that path kept, still between the two (${pf.kept.map((k) => k.why)})`);
  // a kept path's side: no path drawn again arrives there (its exits keep pointing that way)
  const pk = planLevelMove({ l1: base, kinds, shapes, editable: (i) => i !== c(3, 3), cleared: empty }, c(3, 5), c(5, 8));
  check(pk.kept.length === 1 && pk.kept[0].path.dir === 0 && pk.routes.length === 1 && pk.routes[0].dirNew !== 0,
    `a kept path's side (up) not taken by the path drawn again (it arrives ${'udlr'[pk.routes[0]?.dirNew ?? 0]})`);
  // cells to avoid (before events: those an event changes): the way goes round them
  const wall = new Set([c(5, 6), c(5, 7), c(6, 6), c(6, 7), c(4, 6), c(4, 7)]);
  const pa = planLevelMove({ l1: base, kinds, shapes, editable: all, avoid: (i) => wall.has(i), cleared: empty }, c(3, 5), c(5, 8));
  check(pa.routes.every((r) => r.route.every((i) => !wall.has(i))) && pa.routes.length === 2, 'cells to avoid: no way drawn through them');
  // an old cell cleared to a path tile (an event painting over a path): still a way
  const pc = planLevelMove({ l1: base, kinds, shapes, editable: all, cleared: () => V }, c(3, 5), c(4, 8));
  check(pc.routes.length === 2, `old cells cleared to a path tile: still drawn again (kept: ${pc.kept.map((k) => k.why).join(' ') || '–'})`);
}

// ---- written on the test ROM, before events ----
{
  const rom = new Rom(image.slice()), s = new RomEditSession(rom), l1r = readL1(rom), tls = readTranslevels(rom);
  // an empty 9x7 block of the main map no event changes, nothing walked beside it
  const events = readEvents(rom), changed = new Set(events.silent.flatMap((st) => st.filter((x) => x.layer === 1).map((x) => x.loc)));
  let m = 0;
  const cm = (x: number, y: number) => l1Index(m, x, y);
  const free = (x: number, y: number) => x >= 0 && y >= 0 && x < 32 && y < 32 && kinds[l1r[cm(x, y)]] === 'none' && !changed.has(cm(x, y));
  let bx = -1, by = -1;
  for (m = 0; m < 2 && bx < 0; m++) for (let y = 1; y < 24 && bx < 0; y++) for (let x = 1; x < 22 && bx < 0; x++) {
    let ok = true;
    for (let dy = 1; dy <= 6 && ok; dy++) for (let dx = -1; dx <= 6 && ok; dx++) ok = free(x + dx, y + dy);
    if (ok) { bx = x; by = y; }
  }
  m--;
  // a level tile of the main map moved there bare (a plain one: nothing else moves with it)
  const level = Array.from({ length: 0x400 }, (_, i) => i).find((i) => kinds[l1r[i]] === 'level' && tls[i] && !changed.has(i))!;
  const A = cm(bx + 1, by + 2), B = cm(bx + 3, by + 5), S = cm(bx + 5, by + 2);
  moveLevelTile(rom, level, A, null);
  // a path drawn from it to the right, a stop tile at its end (the route brush)
  const route = [A, cm(bx + 2, by + 2), cm(bx + 3, by + 2), cm(bx + 4, by + 2), S];
  const solved = routeTiles(route, { l1: readL1(rom), kinds, shapes, prefer: 'walk', stopTranslevels: stopTranslevels(rom) });
  writeRoute(rom, route, solved, null, kinds);
  const tl = readTranslevels(rom)[A];
  setExitDirection(rom, tl, 0, 3);
  setInitialFlags(rom, tl, DIR_FLAGS[3]);
  check(bx >= 0 && !solved.refusal && walkTo(readL1(rom), S, 2) === A, `level ${hx(tl)} at ${m ? 'submaps' : 'main'} ${at(A)}, a path right to a stop at ${at(S)}`);
  const before = rom.data.slice();
  let result: ReturnType<typeof moveLevelTileWithPaths> | null = null;
  s.edit('Move', () => { result = moveLevelTileWithPaths(rom, A, B, null, kinds, shapes); }, { key: null });
  const l1 = readL1(rom), r = result as ReturnType<typeof moveLevelTileWithPaths> | null;
  check(s.history.undoStack.length === 1 && !!r && r.rerouted === 1 && !r.kept.length, `moved to ${at(B)}: one ROM edit, its path drawn again`);
  check(readTranslevels(rom)[B] === tl && kinds[l1[A]] === 'none', `the level at ${at(B)}, nothing left at ${at(A)}`);
  check(walkTo(l1, S, 2) === B && walkTo(l1, B, 0) === S, 'Mario walks from the stop to the level and back');
  check(exitDirections(rom, tl)[0] === 0 && initialFlags(rom, tl) === DIR_FLAGS[0], `its exit's direction and initial flags turned with the path: right → up (${exitDirections(rom, tl)[0]}, ${hx(initialFlags(rom, tl))})`);
  s.undo();
  check(same(rom.data, before), 'undone: as before');
}

console.log(bad ? `\n${bad} FAILED` : '\nall ok');
process.exit(bad ? 1 : 0);
