// The layer 1 mode's Path tool, its ROM edit (owroute.ts writeRoute): a route drawn from a level tile on the test ROM
// to a level Mario doesn't reach yet, through cells without a path, its tiles (routeTiles) written in the level's
// event – layer 1 changes of the event, the level's exit running it set to the route's direction, one ROM edit, undo
// restores – and Mario reaches the level at the event progress after the event (owreach.ts, with the save at that
// progress emulated: the game's reveal walk takes the route). On the map before events the tiles go into the map
// and no exit is set.
// node tools/testowpathtool.ts
import { Rom } from '../src/core/rom.ts';
import { RomEditSession } from '../src/core/romedit.ts';
import {
  OverworldEmulator, OverworldLoads, gameL1, readL1, readTranslevels, baseEvent, exitDirections, l1XY, translevelToLevel, DIR_NAMES, NO_EVENT, OW_EVENTS,
} from '../src/core/overworld.ts';
import { progressSaves } from '../src/core/owprogress.ts';
import { reach, reachInput, neighbor, type ReachInput } from '../src/core/owreach.ts';
import { readStart } from '../src/core/owsprites.ts';
import { readEvents, layer1Without, eventL1Tiles, submapViews, submapOf } from '../src/core/owevents.ts';
import { levelTileTest } from '../src/core/owpaths.ts';
import { RAM } from '../src/core/ram.ts';
import { routeTiles, routeKind, writeRoute } from '../src/core/owroute.ts';
import type { LevelTileEvent } from '../src/core/owleveltiles.ts';
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
  let set: ReturnType<typeof writeRoute> = [];
  s.edit('Path', () => { set = writeRoute(rom, route, solved.tiles, ev); }, { key: null });
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
  s.edit('Path', () => { set = writeRoute(rom, route, plain.tiles, null); }, { key: null });
  const l1 = readL1(rom);
  check(!plain.refusal && route.every((c, k) => plain.tiles[k] === null || l1[c] === plain.tiles[k]) && !set.length && exitDirections(rom, tl).join() === dirs0,
    'before events: the tiles into the map, no exit set');
  s.undo();
  check(same(rom.data, before), 'undone: as before');
}

console.log(bad ? `\n${bad} FAILED` : '\nall ok');
process.exit(bad ? 1 : 0);
