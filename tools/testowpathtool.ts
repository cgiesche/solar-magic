// The layer 1 mode's route brush ("Path (auto)"), its ROM edit (owroute.ts writeRoute): a route drawn from a level tile on the test ROM
// to a level Mario doesn't reach yet, through cells without a path, its tiles (routeTiles) written in the level's
// event – layer 1 changes of the event, the level's exit running it set to the route's direction, one ROM edit, undo
// restores – and Mario reaches the level at the event progress after the event (owreach.ts, with the save at that
// progress emulated: the game's reveal walk takes the route). On the map before events the tiles go into the map
// and no exit is set. A second route across it (#376): its stop tiles – the junction and its ends – take translevels
// no tile held, their initial flags the stops' ways, and Mario leaves the junction in every direction at every
// progress from the event on (with translevel 0 he doesn't); undo frees them; no translevel left: refused, nothing
// written. Translevels without tile with a name, base event or messages are never taken (#382): only those left,
// refused at the first stop, nothing written, the refusal saying why. A path painted over a stop tile of the route
// brush (#392) frees its translevel and resets it – in the event or before events –, unless the cell is a stop at
// another progress (a stop before events painted over as after an event keeps it).
// node tools/testowpathtool.ts
import { Rom } from '../src/core/rom.ts';
import { RomEditSession } from '../src/core/romedit.ts';
import {
  OverworldEmulator, OverworldLoads, gameL1, readL1, readL2, readTranslevels, writeTranslevels, baseEvent, setBaseEvent, hasNameEventOrMessages, exitDirections, initialFlags, l1XY, translevelToLevel,
  DIR_NAMES, DIR_FLAGS, NO_EVENT, OW_EVENTS, l1Index,
} from '../src/core/overworld.ts';
import { progressSaves } from '../src/core/owprogress.ts';
import { reach, reachInput, neighbor, type ReachInput } from '../src/core/owreach.ts';
import { readStart } from '../src/core/owsprites.ts';
import { readEvents, applyEvents, layer1Without, eventL1Tiles, submapViews, submapOf } from '../src/core/owevents.ts';
import { OverworldStroke, type OwEventMaps } from '../src/core/owstroke.ts';
import { levelTileTest } from '../src/core/owpaths.ts';
import { RAM } from '../src/core/ram.ts';
import { routeTiles, routeKind, routeEnds, writeRoute, stopTranslevels } from '../src/core/owroute.ts';
import { levelsWithoutTile, stopTile, type LevelTileEvent } from '../src/core/owleveltiles.ts';
import { refusalOf, refusalDetails } from '../src/core/owrefusal.ts';
import { refusalWords } from '../src/ui/owrefusal.ts';
import { setLevelNameTiles } from '../src/core/levelnames.ts';
import { readMessage, writeMessages, isBlank } from '../src/core/messages.ts';
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
  // drawn from beside the level tile to beside the other (both ends on cells without a path): taken on to the level
  // tiles, no stop tile put
  const beside = route.slice(1, -1), onto = routeEnds(beside, ev.after, kinds, shapes);
  check(beside.length >= 2 && same(onto.cells, route) && !onto.through.length && !routeTiles(onto.cells, { l1: ev.after, kinds, shapes, prefer: 'walk' }).stops.length,
    `drawn beside the level tiles: taken on to them (${onto.cells.map(at).join(' → ')}), no stop tile`);
  check(same(routeEnds(route, ev.after, kinds, shapes).cells, route), 'drawn from level tile to level tile: as drawn');
  // on a map with nothing but the tiles put (main map, cells (x, y); 04 a straight path left and right)
  {
    const c = (x: number, y: number) => l1Index(0, x, y), STOP = stopTile(kinds), STAR = 0x5f, H = 0x04;
    const LEVEL = kinds.indexOf('level');
    const map = (put: [number, number, number][]) => {
      const l1 = new Uint16Array(0x800);
      for (const [x, y, t] of put) l1[c(x, y)] = t;
      return l1;
    };
    const ends = (r: number[], l1: Uint16Array, kept?: (cell: number) => boolean) => routeEnds(r, l1, kinds, shapes, kept);
    const line = [c(5, 5), c(6, 5), c(7, 5)];
    // beside level and stop tiles
    check(same(ends([c(5, 5)], map([[4, 5, LEVEL]])).cells, [c(5, 5)]), 'a single cell beside a level tile: as drawn');
    check(same(ends(line, map([[4, 5, LEVEL], [5, 4, STOP], [8, 5, STOP]])).cells, [c(4, 5), ...line, c(8, 5)]),
      'beside a level and a stop tile, the level straight on: the level; the other end beside a stop: the stop');
    check(same(ends(line, map([[5, 4, LEVEL]])).cells, [c(5, 4), ...line]), 'beside one level tile, not straight on: that one');
    check(same(ends(line, map([[5, 4, LEVEL], [5, 6, LEVEL]])).cells, line), 'beside two level tiles, none straight on: as drawn');
    // an existing path going on (#: a path drawn on from its end): from its last path tile, or from beside it, the route
    // runs back along the path to the level or stop tile it comes from; its tiles there kept where they fit, no stop
    // tile at the path's end
    const path = map([[3, 5, LEVEL], [4, 5, H], [5, 5, H]]), back = [c(3, 5), c(4, 5), ...line];
    const fromEnd = ends(line, path);
    check(same(fromEnd.cells, back) && !fromEnd.through.length, `from a path's last tile: back along it to the level (${fromEnd.cells.map(at).join(' → ')})`);
    const solvedEnd = routeTiles(fromEnd.cells, { l1: path, kinds, shapes, prefer: 'walk', through: new Set(fromEnd.through) });
    check(!solvedEnd.refusal && solvedEnd.stops.length === 1 && solvedEnd.stops[0].cell === c(7, 5) && solvedEnd.tiles[2] !== STOP && solvedEnd.tiles[1] === H,
      `its tiles: ${solvedEnd.tiles.map((t) => (t === null ? '–' : hx(t))).join(' ')} – a stop at the new end only, the path's tiles kept`);
    check(same(ends(line.slice(1), path).cells, back), 'from beside a path\'s last tile, straight on: back along it to the level');
    // a path ending at a stop tile (a route's end): the route runs through it, the stop becomes a path tile
    const atStop = map([[3, 5, LEVEL], [4, 5, H], [5, 5, STOP]]);
    for (const [r, what] of [[line, 'from the stop tile'], [line.slice(1), 'from beside it']] as const) {
      const e = ends([...r], atStop), t = routeTiles(e.cells, { l1: atStop, kinds, shapes, prefer: 'walk', through: new Set(e.through) });
      check(same(e.cells, back) && same(e.through, [2]) && !t.refusal && t.tiles[2] !== null && kinds[t.tiles[2]!] === 'walk' && t.stops.length === 1,
        `a path's end at a stop tile, ${what}: through it (${e.cells.map(at).join(' → ')}, through ${e.through}), a path tile there: ${t.tiles.map((x) => (x === null ? '–' : hx(x))).join(' ')}`);
    }
    // left alone: a stop tile Mario stops at on the way (the route runs back to it, not through it), a star at a path's
    // end, a stop kept (kept: its translevel has a name …), the middle of a path (a junction), an end beside two paths
    const twoStops = map([[1, 5, LEVEL], [2, 5, H], [3, 5, STOP], [4, 5, H], [5, 5, H]]);
    const viaStop = ends(line, twoStops);
    check(same(viaStop.cells, [c(3, 5), c(4, 5), ...line]) && !viaStop.through.length, 'back along a path: to the first stop tile on it, not through it');
    const star = ends(line, map([[3, 5, LEVEL], [4, 5, H], [5, 5, STAR]]));
    check(same(star.cells, line) && !star.through.length, 'a star at a path\'s end: as drawn (Mario stops there)');
    const kept = ends(line, atStop, (cell) => cell === c(5, 5));
    check(same(kept.cells, line) && !kept.through.length, 'a stop tile to keep at a path\'s end: as drawn');
    const through = map([[3, 5, LEVEL], [4, 5, H], [5, 5, H], [6, 5, H], [7, 5, LEVEL]]), down = [c(5, 5), c(5, 6), c(5, 7)];
    check(same(ends(down, through).cells, down), 'from the middle of a path: as drawn (a junction there)');
    check(same(ends([c(5, 6), c(5, 7)], through).cells, [c(5, 6), c(5, 7)]), 'from beside the middle of a path: as drawn');
    check(same(ends(line, map([[4, 5, LEVEL], [5, 5, 0x10]])).cells, line), 'an end on a path tile leading elsewhere (up and down): as drawn');
    // (a stop tile on cell 0 – the main map's top left – is no end gone on from: nothing run through)
    const corner = ends(line, map([[0, 0, STOP]])), cornerOn = ends([c(0, 0), c(1, 0), c(2, 0)], map([[0, 0, STOP]]));
    check(same(corner.cells, line) && !corner.through.length && !cornerOn.through.length, `a stop tile on cell 0: nothing run through (${corner.through} / ${cornerOn.through})`);
  }
  const before = rom.data.slice(), l1b = readL1(rom), tl = tls[from], exit = e - baseEvent(rom, tl), dir = [0, 1, 2, 3].find((d) => neighbor(from, d) === route[1])!;
  let set: ReturnType<typeof writeRoute>['exits'] = [];
  s.edit('Path', () => { set = writeRoute(rom, route, solved, ev, kinds).exits; }, { key: null });
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
  s.edit('Path', () => { set = writeRoute(rom, route, plain, null, kinds).exits; }, { key: null });
  const l1 = readL1(rom);
  check(!plain.refusal && route.every((c, k) => plain.tiles[k] === null || l1[c] === plain.tiles[k]) && !set.length && exitDirections(rom, tl).join() === dirs0,
    'before events: the tiles into the map, no exit set');
  s.undo();
  check(same(rom.data, before), 'undone: as before');

  // ---- a path drawn on from a stop tile at its end, before events: the stop a path tile, its translevel freed ----
  {
    const part = route.slice(0, -1), firstPart = routeTiles(part, { l1: readL1(rom), kinds, shapes, prefer: 'walk', stopTranslevels: stopTranslevels(rom) });
    s.edit('Path', () => { writeRoute(rom, part, firstPart, null, kinds); }, { key: null });
    const end = part.at(-1)!, tlEnd = readTranslevels(rom)[end];
    const l1 = readL1(rom), on = routeEnds([end, route.at(-1)!], l1, kinds, shapes);
    const t = routeTiles(on.cells, { l1, kinds, shapes, prefer: 'walk', through: new Set(on.through), stopTranslevels: stopTranslevels(rom) });
    check(firstPart.stops.length === 1 && kinds[l1[end]] === 'stop' && tlEnd > 0 && same(on.cells, route) && same(on.through, [route.length - 2]) && !t.refusal && !t.stops.length,
      `a route ending on nothing: a stop tile (${at(end)}, translevel ${hx(tlEnd)}); drawn on from it to the level: back along the path, through the stop (${on.through}), no stop tile`);
    s.edit('Path', () => { writeRoute(rom, on.cells, t, null, kinds); }, { key: null });
    const l1n = readL1(rom), tlsN = readTranslevels(rom);
    check(kinds[l1n[end]] === 'walk' && !tlsN[end] && !tlsN.includes(tlEnd) && initialFlags(rom, tlEnd) === 0,
      `written: a path tile (${hx(l1n[end])}) there, translevel ${hx(tlEnd)} freed and reset (initial flags ${initialFlags(rom, tlEnd)})`);
    s.undo(); s.undo();
    check(same(rom.data, before), 'undone: as before');
  }

  // ---- a junction: a second route across the first one, in the same event (#376) ----
  // its stop tiles get translevels no tile held, their initial flags the stops' ways; Mario leaves the junction in
  // every direction at every progress from the event on
  s.edit('Path', () => { writeRoute(rom, route, solved, ev, kinds); }, { key: null });
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
    const tls0 = readTranslevels(rom), solved2 = routeTiles(cross, { l1: after1, kinds, shapes, prefer: routeKind(cross, after1, kinds), stopTranslevels: stopTranslevels(rom, tls0) });
    const js = solved2.stops.find((x) => x.cell === j);
    check(!solved2.refusal && solved2.stops.length === 3 && !!js && js.dirs.join() === '0,1,2,3',
      `its stop tiles: both ends and the junction, ways ${js?.dirs.map((d) => DIR_NAMES[d]).join(', ')}${solved2.refusal ? ` refused: ${solved2.refusal.why.kind}` : ''}`);
    const before2 = rom.data.slice(), without0 = levelsWithoutTile(tls0), kept0 = without0.filter((tl) => hasNameEventOrMessages(rom, tl));
    let taken: number[] = [];
    s.edit('Path', () => { taken = writeRoute(rom, cross!, solved2, ev2, kinds).taken; }, { key: null });
    const tls2 = readTranslevels(rom), got = solved2.stops.map((x) => tls2[x.cell]);
    check(got.every((tl) => without0.includes(tl)) && new Set(got).size === 3 && levelsWithoutTile(tls2).length === without0.length - 3 && got.join() === taken.join(),
      `each stop tile a translevel no tile held (${got.map((tl) => hx(tl)).join(', ')}): 3 fewer levels without level tile`);
    check(!got.some((tl) => kept0.includes(tl)), `none of those without tile with a name, base event or messages taken (${kept0.map((tl) => hx(tl)).join(', ') || 'none'})`);
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
    const l1b2 = readL1(rom), solved3 = routeTiles(cross, { l1: l1b2, kinds, shapes, prefer: 'walk', stopTranslevels: stopTranslevels(rom, tls0) });
    s.edit('Path', () => { writeRoute(rom, cross!, solved3, null, kinds); }, { key: null });
    const tls3 = readTranslevels(rom);
    check(!solved3.refusal && solved3.stops.length >= 2 && solved3.stops.every((x) => without0.includes(tls3[x.cell]) && initialFlags(rom, tls3[x.cell]) === x.dirs.reduce((f, d) => f | DIR_FLAGS[d], 0)),
      `before events: its ${solved3.stops.length} stop tiles take free translevels, their flags their ways`);
    s.undo();
    check(same(rom.data, before2), 'undone: as before');

    // ---- a path painted over a stop tile of the path tool (#392) ----
    // frees its translevel (reset: no name, event or flags; free for a new stop) – unless the cell is a stop at
    // another event progress: the translevel table is one for every progress (owstars.ts paintStars, owleveltiles.ts
    // heldElsewhere). The stop's translevel is given a name first, so the reset shows
    {
      const paths = { kinds, shapes };
      // (a layer 1 stroke painting tile t at cell i, on the map before events or as after event e; one ROM edit)
      const paintOver = (i: number, t: number, inEvent: boolean) => {
        const game = inEvent ? mapAt(e + 1) : null;
        const evm: OwEventMaps | null = game ? { event: e, after: applyEvents(readL2(rom), readEvents(rom), 0, e + 1), l1: game.slice(), game, without: layer1Without(rom, e), place: () => null } : null;
        const st = new OverworldStroke(rom, 'l1', { l1: readL1(rom), l2: readL2(rom) }, isLevel, evm, paths), { x, y } = l1XY(i);
        const painted = st.paint(i >> 10, x, y, t), end = st.end();
        s.edit(end.label, end.write!, { key: null });
        return painted;
      };
      const freedReset = (tl: number) => {
        const t = readTranslevels(rom);
        return levelsWithoutTile(t).includes(tl) && stopTranslevels(rom, t).free.includes(tl) && !hasNameEventOrMessages(rom, tl) && initialFlags(rom, tl) === 0 && exitDirections(rom, tl).every((d) => d === 0);
      };
      const pathTile = after1[j]; // (the first route's tile at the junction)

      // the junction of the route in the event, painted over as after the event: its translevel freed and reset
      // (a route and a name for one of its stops, as the player might give one)
      const named = (stop: number, write: () => void) => s.edit('Path', () => { write(); setLevelNameTiles(rom, readTranslevels(rom)[stop], [0x00, 0x01]); }, { key: null });
      named(j, () => { writeRoute(rom, cross!, solved2, ev2, kinds); });
      const tlJ = readTranslevels(rom)[j], others = solved2.stops.filter((x) => x.cell !== j).map((x) => [x.cell, readTranslevels(rom)[x.cell]]);
      const undos = s.history.undoStack.length, was = rom.data.slice();
      check(!!tlJ && initialFlags(rom, tlJ) !== 0 && hasNameEventOrMessages(rom, tlJ) && paintOver(j, pathTile, true) && s.history.undoStack.length === undos + 1,
        `a path (${hx(pathTile)}) painted over the junction (translevel ${hx(tlJ)}) as after event ${hx(e)}: one ROM edit`);
      check(readTranslevels(rom)[j] === 0 && freedReset(tlJ) && others.every(([c, tl]) => readTranslevels(rom)[c] === tl),
        `its translevel ${hx(tlJ)} freed and reset (its name and flags gone; free for a new stop), the other stops keep theirs`);
      check(mapAt(e + 1)[j] === pathTile, 'the game shows the path there from the event on');
      s.undo();
      check(same(rom.data, was), 'undone: the junction holds it again, its name and flags back');
      s.undo();
      check(same(rom.data, before2), 'undone: as before');

      // a stop of the route before events, painted over as after the event: kept (the cell is a stop before it)
      const end0 = solved3.stops[0].cell;
      named(end0, () => { writeRoute(rom, cross!, solved3, null, kinds); });
      const tl0 = readTranslevels(rom)[end0], flags0 = initialFlags(rom, tl0), stop0 = readL1(rom)[end0], was0 = rom.data.slice();
      check(flags0 !== 0 && hasNameEventOrMessages(rom, tl0) && paintOver(end0, pathTile, true), `a path (${hx(pathTile)}) painted over it as after event ${hx(e)}`);
      check(readTranslevels(rom)[end0] === tl0 && initialFlags(rom, tl0) === flags0 && hasNameEventOrMessages(rom, tl0) && eventL1Tiles(readEvents(rom), e).includes(end0) && readL1(rom)[end0] === stop0,
        `a stop of the route before events (${at(end0)}, translevel ${hx(tl0)}) painted over with a path as after event ${hx(e)}: kept with its name and flags, the path a change of the event, the map before events still the stop`);
      s.undo();
      check(same(rom.data, was0), 'undone: as before');
      // the same stop painted over before events: freed and reset
      const others0 = solved3.stops.filter((x) => x.cell !== end0).map((x) => [x.cell, readTranslevels(rom)[x.cell]]), undos0 = s.history.undoStack.length;
      check(paintOver(end0, pathTile, false) && s.history.undoStack.length === undos0 + 1 && others0.every(([c, tl]) => readTranslevels(rom)[c] === tl) && readTranslevels(rom)[end0] === 0 && readL1(rom)[end0] === pathTile && freedReset(tl0), `painted over before events (one ROM edit): translevel ${hx(tl0)} freed and reset, the other stop keeps its`);
      s.undo();
      check(same(rom.data, was0), 'undone: the stop holds it again');
      s.undo();
      check(same(rom.data, before2), 'undone: as before');
    }

    // no translevel free: refused at the stop tile it runs out at, nothing written
    const full = Uint8Array.from(tls0), left = levelsWithoutTile(full);
    for (let i = 0x7ff; left.length > 1; i--) if (!full[i] && !cross.includes(i)) full[i] = left.pop()!;
    const one = routeTiles(cross, { l1: after1, kinds, shapes, prefer: 'walk', stopTranslevels: stopTranslevels(rom, full) });
    check(one.refusal?.why.kind === 'routeNoTranslevel' && one.refusal.at === solved2.stops[1].at && one.tiles.slice(one.refusal.at).every((t) => t === null),
      `one translevel free for three stop tiles: refused at the second (${one.refusal ? `${at(one.refusal.cell)}: ${refusalDetails(one.refusal.why)}` : 'not refused'})`);
    writeTranslevels(rom, full);
    const before3 = rom.data.slice();
    let thrown: unknown = null;
    try { writeRoute(rom, cross, solved2, ev2, kinds); } catch (err) { thrown = err; }
    check(refusalOf(thrown)?.kind === 'routeNoTranslevel' && same(rom.data, before3), 'written anyway: refused (routeNoTranslevel), nothing written');

    // (#382) three translevels without tile, but each with a name, base event or messages: never taken – refused at
    // the first stop tile, nothing written, the refusal saying why
    {
      const r2 = new Rom(rom.data.slice()), t2 = Uint8Array.from(tls0), left2 = levelsWithoutTile(t2);
      for (let i = 0x7ff; left2.length > 3; i--) if (!t2[i] && !cross.includes(i)) t2[i] = left2.pop()!;
      writeTranslevels(r2, t2);
      for (const tl of left2) { setBaseEvent(r2, tl, NO_EVENT); setLevelNameTiles(r2, tl, []); }
      const withMsg = Array.from({ length: 0x5f }, (_, k) => k + 1).find((tl) => !left2.includes(tl) && !isBlank(readMessage(r2, tl, 1)))!;
      setBaseEvent(r2, left2[0], 0x10);
      setLevelNameTiles(r2, left2[1], [0x00, 0x01]);
      writeMessages(r2, [{ translevel: left2[2], msg: 1, message: readMessage(r2, withMsg, 1) }]);
      const st = stopTranslevels(r2);
      check(st.free.length === 0 && st.kept === 3, `three without tile, each with settings: none free for a stop (${st.free.length} free, ${st.kept} kept)`);
      const none = routeTiles(cross, { l1: after1, kinds, shapes, prefer: 'walk', stopTranslevels: st }), why = none.refusal?.why;
      check(why?.kind === 'routeNoTranslevel' && why.kept === 3 && none.refusal!.at === solved2.stops[0].at,
        `refused at the first stop tile: ${why ? refusalDetails(why) : 'not refused'}`);
      const words = why ? refusalWords(r2, why) : null;
      check(!!words && /name, base event or messages/.test(words.reason) && /Without level tile/.test(words.instead), `the player's words: "${words?.reason}" ${words?.instead}`);
      const before4 = r2.data.slice();
      let thrown2: unknown = null;
      try { writeRoute(r2, cross, solved2, ev2, kinds); } catch (err) { thrown2 = err; }
      check(refusalOf(thrown2)?.kind === 'routeNoTranslevel' && same(r2.data, before4), 'written anyway: refused, nothing written (their settings kept)');
      // one of them without settings again: the stops take it – refused at the second
      setBaseEvent(r2, left2[0], NO_EVENT);
      const one2 = routeTiles(cross, { l1: after1, kinds, shapes, prefer: 'walk', stopTranslevels: stopTranslevels(r2) });
      const why2 = one2.refusal?.why;
      check(why2?.kind === 'routeNoTranslevel' && why2.kept === 2 && one2.refusal!.at === solved2.stops[1].at,
        `one of them without settings: the first stop takes it, refused at the second (${why2 ? refusalWords(r2, why2).reason : 'not refused'})`);
    }
  }
}

console.log(bad ? `\n${bad} FAILED` : '\nall ok');
process.exit(bad ? 1 : 0);
