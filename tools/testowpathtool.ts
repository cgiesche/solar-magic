// The layer 1 mode's Path tool, its ROM edit (owroute.ts writeRoute): a route drawn from a level tile on the test ROM
// to a level Mario doesn't reach yet, through cells without a path, its tiles (routeTiles) written in the level's
// event – layer 1 changes of the event, the level's exit running it set to the route's direction, one ROM edit, undo
// restores – and Mario reaches the level at the event progress after the event (owreach.ts, with the save at that
// progress emulated: the game's reveal walk takes the route). On the map before events the tiles go into the map
// and no exit is set. A second route across it (#376): its stop tiles – the junction and its ends – take translevels
// no tile held, their initial flags the stops' ways, and Mario leaves the junction in every direction at every
// progress from the event on (with translevel 0 he doesn't); undo frees them; no translevel left: refused, nothing
// written.
// node tools/testowpathtool.ts
import { Rom } from '../src/core/rom.ts';
import { RomEditSession } from '../src/core/romedit.ts';
import {
  OverworldEmulator, OverworldLoads, gameL1, readL1, readTranslevels, writeTranslevels, baseEvent, exitDirections, initialFlags, l1XY, translevelToLevel,
  DIR_NAMES, DIR_FLAGS, NO_EVENT, OW_EVENTS,
} from '../src/core/overworld.ts';
import { progressSaves } from '../src/core/owprogress.ts';
import { reach, reachInput, neighbor, type ReachInput } from '../src/core/owreach.ts';
import { readStart } from '../src/core/owsprites.ts';
import { readEvents, layer1Without, eventL1Tiles, submapViews, submapOf } from '../src/core/owevents.ts';
import { levelTileTest } from '../src/core/owpaths.ts';
import { RAM } from '../src/core/ram.ts';
import { routeTiles, routeKind, writeRoute } from '../src/core/owroute.ts';
import { levelsWithoutTile, type LevelTileEvent } from '../src/core/owleveltiles.ts';
import { refusalOf, refusalDetails } from '../src/core/owrefusal.ts';
import { editorImage, pathKinds, pathShapes } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const hx = (v: number, n = 2) => v.toString(16).toUpperCase().padStart(n, '0');
const at = (i: number) => { const { x, y } = l1XY(i); return `${i >> 10 ? 'submaps' : 'main'} ${hx(x)},${hx(y)}`; };
const same = (a: ArrayLike<number>, b: ArrayLike<number>) => a.length === b.length && Array.from(a).every((v, i) => v === b[i]);

const image = await editorImage();
const kinds = pathKinds(new Rom(image.slice())), shapes = pathShapes(new Rom(image.slice())), isLevel = levelTileTest(kinds);
// the tiles Mario reaches in `rom` at event progresses (the saves there emulated once)
const reacher = (rom: Rom) => {
  const loads = new OverworldLoads(new OverworldEmulator(rom), 4), saves = progressSaves(loads), views = submapViews(loads);
  return (progress: number) => {
    const r = loads.get(0, progress);
    const inp: ReachInput = reachInput(rom, gameL1(r).slice(), r.wram.slice(RAM.owTranslevels, RAM.owTranslevelsEnd), saves[progress].levelFlags, kinds, shapes, readStart(rom, 0));
    return { inp, r: reach(inp), views };
  };
};

// ---- a route from a level to one Mario doesn't reach yet, in the level's event ----
const rom = new Rom(image.slice()), s = new RomEditSession(rom), tls = readTranslevels(rom);
const em = new OverworldEmulator(rom), mapAt = (n: number) => gameL1(em.load(0, n)).slice();
// a level tile on the main map or Yoshi's Island running an event, a level tile of its submap Mario doesn't reach
// after the event, the shortest way between them over cells without a path (only level tiles next to them)
let found: { from: number; to: number; e: number; route: number[] } | null = null;
{
  const reachedAt = reacher(rom), all = reachedAt(OW_EVENTS), onMaps = (i: number) => [0, 1].includes(submapOf(all.views, i));
  const levels = Array.from({ length: 0x800 }, (_, i) => i).filter((i) => isLevel(all.inp.l1[i]) && tls[i] && onMaps(i));
  const byEvent = new Map<number, ReturnType<typeof reachedAt>>();
  for (const from of levels) {
    const e = baseEvent(rom, tls[from]);
    if (e === NO_EVENT || e >= OW_EVENTS) continue;
    const then = byEvent.get(e) ?? byEvent.set(e, reachedAt(e + 1)).get(e)!, l1 = then.inp.l1;
    if (!then.r.stops.has(from)) continue;
    // (a cell without a path, none next to it but level tiles)
    const free = (i: number) => i >= 0 && kinds[l1[i]] === 'none' && [0, 1, 2, 3].every((d) => { const n = neighbor(i, d); return n < 0 || ['none', 'level'].includes(kinds[l1[n]]); });
    // (breadth first from the level tile over free cells to a level tile not reached)
    const prev = new Map<number, number>([[from, -1]]), queue = [from];
    let to = -1;
    while (queue.length && to < 0) {
      const c = queue.shift()!;
      for (let d = 0; d < 4 && to < 0; d++) {
        const n = neighbor(c, d);
        if (n < 0 || prev.has(n)) continue;
        if (c !== from && isLevel(l1[n]) && tls[n] && !then.r.stops.has(n) && onMaps(n) && submapOf(all.views, n) === submapOf(all.views, from)) { prev.set(n, c); to = n; }
        else if (free(n) || (c === from && kinds[l1[n]] === 'none')) { prev.set(n, c); queue.push(n); }
      }
    }
    if (to < 0) continue;
    const route: number[] = [];
    for (let c = to; c >= 0; c = prev.get(c)!) route.unshift(c);
    if (!found || route.length < found.route.length) found = { from, to, e, route };
  }
}
check(!!found, found ? `level ${hx(translevelToLevel(tls[found.from]), 3)} (${at(found.from)}, event ${hx(found.e)}) to level ${hx(translevelToLevel(tls[found.to]), 3)} (${at(found.to)}), not reached after the event: a route of ${found.route.length} cells` : 'a route to draw');
if (found) {
  const { from, to, e, route } = found;
  const ev: LevelTileEvent = { event: e, after: mapAt(e + 1), without: layer1Without(rom, e), isLevelTile: isLevel };
  const solved = routeTiles(route, { l1: ev.after, kinds, shapes, prefer: routeKind(route, ev.after, kinds) });
  check(!solved.refusal && solved.tiles[0] === null && solved.tiles.at(-1) === null && solved.tiles.slice(1, -1).every((t) => t !== null),
    `its tiles: ${solved.tiles.map((t) => (t === null ? '–' : hx(t))).join(' ')}${solved.refusal ? ` refused: ${solved.refusal.why.kind}` : ''}`);
  const before = rom.data.slice(), l1b = readL1(rom), tl = tls[from], exit = e - baseEvent(rom, tl), dir = [0, 1, 2, 3].find((d) => neighbor(from, d) === route[1])!;
  let set: ReturnType<typeof writeRoute>['exits'] = [];
  s.edit('Path', () => { set = writeRoute(rom, route, solved, ev).exits; }, { key: null });
  check(s.history.undoStack.length === 1, 'written: one ROM edit');
  const steps = eventL1Tiles(readEvents(rom), e);
  check(route.slice(1, -1).every((c) => steps.includes(c)) && same(readL1(rom), l1b), 'the tiles: layer 1 changes of the event, the map before events unchanged');
  const after = mapAt(e + 1), beforeEv = mapAt(e);
  check(route.slice(1, -1).every((c, k) => after[c] === solved.tiles[k + 1] && beforeEv[c] !== solved.tiles[k + 1]),
    'shown from the event on, not before it (emulated)');
  check(exitDirections(rom, tl)[exit] === dir && set.length === 1 && set[0].tl === tl && set[0].exit === exit,
    `the level's exit running the event (${exit ? `secret ${exit}` : 'normal'}) set to the route's direction (${DIR_NAMES[dir]})`);
  const now = reacher(rom)(e + 1);
  check(now.r.stops.has(to), `at the progress after the event Mario reaches level ${hx(translevelToLevel(tls[to]), 3)}`);
  s.undo();
  check(same(rom.data, before), 'undone: as before');

  // on the map before events: into the map, no exit set
  const dirs0 = exitDirections(rom, tl).join();
  const plain = routeTiles(route, { l1: readL1(rom), kinds, shapes, prefer: 'walk' });
  s.edit('Path', () => { set = writeRoute(rom, route, plain, null).exits; }, { key: null });
  const l1 = readL1(rom);
  check(!plain.refusal && route.every((c, k) => plain.tiles[k] === null || l1[c] === plain.tiles[k]) && !set.length && exitDirections(rom, tl).join() === dirs0,
    'before events: the tiles into the map, no exit set');
  s.undo();
  check(same(rom.data, before), 'undone: as before');

  // ---- a junction: a second route across the first one, in the same event (#376) ----
  // its stop tiles get translevels no tile held, their initial flags the stops' ways; Mario leaves the junction in
  // every direction at every progress from the event on
  s.edit('Path', () => { writeRoute(rom, route, solved, ev); }, { key: null });
  const after1 = mapAt(e + 1), on1 = new Set(route), free = (i: number) => i >= 0 && !on1.has(i) && kinds[after1[i]] === 'none';
  let cross: number[] | null = null;
  for (let k = 2; k < route.length - 2 && !cross; k++) {
    const c = route[k], d = [0, 1, 2, 3].find((d) => neighbor(route[k - 1], d) === c)!;
    if (neighbor(c, d) !== route[k + 1]) continue; // (straight through c)
    const p = d < 2 ? 2 : 0, q = p + 1; // (the two directions across)
    const side = (dir: number, n: number) => { const out: number[] = []; for (let i = c, j = 0; j < n; j++) { i = neighbor(i, dir); out.push(i); } return out; };
    for (const n of [2, 1]) {
      const a = side(p, n), b = side(q, n);
      if ([...a, ...b].every(free)) { cross = [...a.reverse(), c, ...b]; break; }
    }
  }
  check(!!cross, cross ? `a route across it: ${cross.map(at).join(' → ')}` : 'a route across the first one');
  if (cross) {
    const j = cross[(cross.length - 1) / 2], ev2: LevelTileEvent = { ...ev, after: after1 };
    const tls0 = readTranslevels(rom), solved2 = routeTiles(cross, { l1: after1, kinds, shapes, prefer: routeKind(cross, after1, kinds), tls: tls0 });
    const js = solved2.stops.find((x) => x.cell === j);
    check(!solved2.refusal && solved2.stops.length === 3 && !!js && js.dirs.join() === '0,1,2,3',
      `its stop tiles: both ends and the junction, ways ${js?.dirs.map((d) => DIR_NAMES[d]).join(', ')}${solved2.refusal ? ` refused: ${solved2.refusal.why.kind}` : ''}`);
    const before2 = rom.data.slice(), without0 = levelsWithoutTile(tls0);
    let taken: number[] = [];
    s.edit('Path', () => { taken = writeRoute(rom, cross!, solved2, ev2).taken; }, { key: null });
    const tls2 = readTranslevels(rom), got = solved2.stops.map((x) => tls2[x.cell]);
    check(got.every((tl) => without0.includes(tl)) && new Set(got).size === 3 && levelsWithoutTile(tls2).length === without0.length - 3 && got.join() === taken.join(),
      `each stop tile a translevel no tile held (${got.map((tl) => hx(tl)).join(', ')}): 3 fewer levels without level tile`);
    check(got.every((tl) => baseEvent(rom, tl) === NO_EVENT && exitDirections(rom, tl).every((d) => d === 0)), 'their settings reset: no event');
    check(solved2.stops.every((x) => initialFlags(rom, tls2[x.cell]) === x.dirs.reduce((f, d) => f | DIR_FLAGS[d], 0)), 'their initial flags: the stops\' ways');
    const reachedAt = reacher(rom), stuck: string[] = [];
    for (let p = e + 1; p <= OW_EVENTS; p++) {
      const { r } = reachedAt(p);
      const left = js!.dirs.filter((d) => (r.walks.get(j * 4 + d)?.to ?? -1) >= 0);
      if (!r.stops.has(j) || left.length !== js!.dirs.length) stuck.push(`${hx(p)}: ${r.stops.has(j) ? `leaves ${left.map((d) => DIR_NAMES[d]).join(', ') || 'nowhere'}` : 'not reached'}`);
    }
    check(!stuck.length, `at every progress ${hx(e + 1)}–${hx(OW_EVENTS)} Mario reaches the junction and leaves it in all 4 directions (emulated saves) ${stuck.slice(0, 6).join('; ')}`);
    // (the same junction with translevel 0, as before #376: he can't)
    {
      const r0 = new Rom(rom.data.slice()), t0 = readTranslevels(r0);
      for (const x of solved2.stops) t0[x.cell] = 0;
      writeTranslevels(r0, t0);
      const { r } = reacher(r0)(e + 1), left = js!.dirs.filter((d) => (r.walks.get(j * 4 + d)?.to ?? -1) >= 0);
      check(left.length < 4, `without its translevel Mario leaves the junction only ${left.map((d) => DIR_NAMES[d]).join(', ') || 'nowhere'}`);
    }
    s.undo();
    check(same(rom.data, before2) && levelsWithoutTile(readTranslevels(rom)).join() === without0.join(), 'undone: the translevels free again, as before');

    // on the map before events: the stop tiles take translevels too
    const l1b2 = readL1(rom), solved3 = routeTiles(cross, { l1: l1b2, kinds, shapes, prefer: 'walk', tls: tls0 });
    s.edit('Path', () => { writeRoute(rom, cross!, solved3, null); }, { key: null });
    const tls3 = readTranslevels(rom);
    check(!solved3.refusal && solved3.stops.length >= 2 && solved3.stops.every((x) => without0.includes(tls3[x.cell]) && initialFlags(rom, tls3[x.cell]) === x.dirs.reduce((f, d) => f | DIR_FLAGS[d], 0)),
      `before events: its ${solved3.stops.length} stop tiles take free translevels, their flags their ways`);
    s.undo();
    check(same(rom.data, before2), 'undone: as before');

    // no translevel free: refused at the stop tile it runs out at, nothing written
    const full = Uint8Array.from(tls0), left = levelsWithoutTile(full);
    for (let i = 0x7ff; left.length > 1; i--) if (!full[i] && !cross.includes(i)) full[i] = left.pop()!;
    const one = routeTiles(cross, { l1: after1, kinds, shapes, prefer: 'walk', tls: full });
    check(one.refusal?.why.kind === 'routeNoTranslevel' && one.refusal.at === solved2.stops[1].at && one.tiles.slice(one.refusal.at).every((t) => t === null),
      `one translevel free for three stop tiles: refused at the second (${one.refusal ? `${at(one.refusal.cell)}: ${refusalDetails(one.refusal.why)}` : 'not refused'})`);
    writeTranslevels(rom, full);
    const before3 = rom.data.slice();
    let thrown: unknown = null;
    try { writeRoute(rom, cross, solved2, ev2); } catch (err) { thrown = err; }
    check(refusalOf(thrown)?.kind === 'routeNoTranslevel' && same(rom.data, before3), 'written anyway: refused (routeNoTranslevel), nothing written');
  }
}

console.log(bad ? `\n${bad} FAILED` : '\nall ok');
process.exit(bad ? 1 : 0);
