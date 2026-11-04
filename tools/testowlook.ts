// The World check's path look warnings (owlook.ts, issue #366). The clean game: no "path shown after Mario walks it"
// (A) nor "path without a look" (B) at any event progress. A route drawn into a level's event (the Path tool's
// writeRoute) over ground: one B per path cell, said as new warnings; map pieces painted under it in the same event
// clear them (said as fixed); the same pieces in a later event give A instead of B, Show going to that event. A path
// tile with its own look (its Map16 tile given a visible one's 8x8s) is never warned about. The maps at every event
// progress the World check searches (owprogress.ts progressMapsFromEvents: layer 1 through the events, the saves' level
// flags, #381) are those the game loads at every progress in the clean game (owexitedges.ts progressMapsJob). The
// searches' time, and how long the saves and maps at every event progress take to be learned again after an edit, are
// printed.
// node tools/testowlook.ts
import { Rom } from '../src/core/rom.ts';
import { RomEditSession } from '../src/core/romedit.ts';
import { OverworldEmulator, OverworldLoads, l1XY, l2Index, readL2, readTranslevels, baseEvent, owTileWords, setOwTileWords, translevelToLevel, OW_EVENTS, NO_EVENT, OW_L1_TILES } from '../src/core/overworld.ts';
import { reach, neighbor } from '../src/core/owreach.ts';
import { readEvents, writeEvents, applyEvents, eventPieces, pieceCells, isBig, paintEvent, eventPlace, eventRunners, layer1Without, submapViews, submapOf } from '../src/core/owevents.ts';
import { progressMapsJob, progressInput, type ProgressMap } from '../src/core/owexitedges.ts';
import { progressFlagsJob, progressMapsFromEvents } from '../src/core/owprogress.ts';
import type { Job } from '../src/core/jobrunner.ts';
import { ExitGraph } from '../src/core/exitgraph.ts';
import { levelTileTest } from '../src/core/owpaths.ts';
import { routeTiles, routeKind, writeRoute } from '../src/core/owroute.ts';
import { l1OwnLooks, lookProblems, hasOwnLook } from '../src/core/owlook.ts';
import { diffProblems, diffText, progressSearches, type WorldProblem } from '../src/core/worldcheck.ts';
import { editorImage, pathKinds, pathShapes } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const hx = (v: number, n = 2) => v.toString(16).toUpperCase().padStart(n, '0');
const at = (i: number) => { const { x, y } = l1XY(i); return `${i >> 10 ? 'submaps' : 'main'} ${hx(x)},${hx(y)}`; };
const runJob = <T>(job: Job<T>): T => { let st = job.next(); while (!st.done) st = job.next(); return st.value; };
const keys = (ps: WorldProblem[], kind: string) => ps.filter((p) => p.key.startsWith(`${kind}:`)).map((p) => +p.key.split(':')[1]).sort((a, b) => a - b).join();

const rom = new Rom(await editorImage()), s = new RomEditSession(rom);
const kinds = pathKinds(rom), shapes = pathShapes(rom), isLevel = levelTileTest(kinds);
// (one set of loads for every edit, as the probe worker keeps them: what an edit leaves alone is not emulated again)
const loads = new OverworldLoads(new OverworldEmulator(rom), 4);
interface Checked { maps: ProgressMap[]; views: ReturnType<typeof submapViews>; problems: WorldProblem[] }
function checkLooks(what: string): Checked {
  let t = performance.now();
  const maps = progressMapsFromEvents(rom, runJob(progressFlagsJob(loads))), views = submapViews(loads), own = l1OwnLooks(rom, loads);
  const learned = performance.now() - t;
  const search = progressSearches(progressInput(rom, maps, kinds, shapes, new ExitGraph(rom)));
  t = performance.now();
  const problems = lookProblems({ rom, maps, ownLooks: own, kinds, views, search, place: at });
  console.log(`     ${what}: the saves and maps at every progress and the looks in ${Math.round(learned)} ms, the rules in ${Math.round(performance.now() - t)} ms`);
  for (const p of problems.slice(0, 4)) console.log(`     ${p.key} @${hx(p.progress)}: ${p.text}`);
  return { maps, views, problems };
}

// ---- the clean game ----
const clean = checkLooks('the clean game');
{
  const t = performance.now(), loaded = runJob(progressMapsJob(loads));
  const same = (a: ArrayLike<number>, b: ArrayLike<number>) => a.length === b.length && Array.prototype.every.call(a, (v: number, i: number) => v === b[i]);
  const differ = loaded.map((m, p) => p).filter((p) => !same(loaded[p].l1, clean.maps[p].l1) || !same(loaded[p].tls, clean.maps[p].tls) || !same(loaded[p].flags, clean.maps[p].flags));
  check(loaded.length === clean.maps.length && !differ.length,
    `the maps at every progress: those the game loads (emulated in ${Math.round(performance.now() - t)} ms after the saves) at all ${loaded.length} progresses (differing: ${differ.map((p) => hx(p)).join(' ')})`);
}
check(!clean.problems.length, `the clean game: no path warning at any event progress (${clean.problems.length})`);
const own = l1OwnLooks(rom, loads);
const lookless = (t: number) => kinds[t] === 'walk' && !own[0][t];
check(own.every((o) => o.some((v) => v) && o.some((v, t) => !v && kinds[t] === 'walk')), 'every submap has tiles with a look of their own and walk tiles without one');
check(!hasOwnLook(loads.get(0, 0), owTileWords(rom, 0)), 'tile 000 has no look of its own');

// ---- a route in a level's event ----
// a level tile Mario reaches after its event and one he doesn't, on the main map or Yoshi's Island, the shortest way
// between them over cells without a path (only level tiles next to them) – as testowpathtool finds it – where no
// event up to the level's draws layer 2
const tls = readTranslevels(rom), views = clean.views, onMaps = (i: number) => [0, 1].includes(submapOf(views, i));
let found: { from: number; to: number; e: number; route: number[] } | null = null;
// the layer 2 entries under a cell; per event those written by it or an earlier one
const under = (c: number) => { const r = c >> 10, { x, y } = l1XY(c); return [[0, 0], [1, 0], [0, 1], [1, 1]].map(([dx, dy]) => l2Index(r, x * 2 + dx, y * 2 + dy)); };
const written: Uint8Array[] = [];
{
  const d = readEvents(rom), w = new Uint8Array(0x2000);
  for (let e = 0; e < OW_EVENTS; e++) {
    for (const p of eventPieces(d, e)) for (const i of pieceCells(p.pos, isBig(d, p.at))) if (i >= 0) w[i] = 1;
    written.push(w.slice());
  }
}
{
  const search = progressInput(rom, clean.maps, kinds, shapes, new ExitGraph(rom));
  const levels = Array.from({ length: 0x800 }, (_, i) => i).filter((i) => isLevel(clean.maps[OW_EVENTS].l1[i]) && tls[i] && onMaps(i));
  for (const from of levels) {
    const e = baseEvent(rom, tls[from]);
    if (e === NO_EVENT || e >= OW_EVENTS) continue;
    const m = clean.maps[e + 1], l1 = m.l1;
    const r = reach(search(e + 1));
    if (!r.stops.has(from)) continue;
    const free = (i: number) => i >= 0 && kinds[l1[i]] === 'none' && [0, 1, 2, 3].every((d) => { const n = neighbor(i, d); return n < 0 || ['none', 'level'].includes(kinds[l1[n]]); });
    const prev = new Map<number, number>([[from, -1]]), queue = [from];
    let to = -1;
    while (queue.length && to < 0) {
      const c = queue.shift()!;
      for (let d = 0; d < 4 && to < 0; d++) {
        const n = neighbor(c, d);
        if (n < 0 || prev.has(n)) continue;
        if (c !== from && isLevel(l1[n]) && tls[n] && !r.stops.has(n) && onMaps(n) && submapOf(views, n) === submapOf(views, from)) { prev.set(n, c); to = n; }
        else if (free(n) || (c === from && kinds[l1[n]] === 'none')) { prev.set(n, c); queue.push(n); }
      }
    }
    if (to < 0) continue;
    const route: number[] = [];
    for (let c = to; c >= 0; c = prev.get(c)!) route.unshift(c);
    // (no event up to its own drawing layer 2 there yet: the route's cells are bare ground)
    if (route.slice(1, -1).some((c) => under(c).some((i) => written[e][i]))) continue;
    if (!found || route.length < found.route.length) found = { from, to, e, route };
  }
}
check(!!found, found ? `a route from level ${hx(translevelToLevel(tls[found.from]), 3)} (${at(found.from)}) in its event ${hx(found.e)} to level ${hx(translevelToLevel(tls[found.to]), 3)}: ${found.route.length} cells` : 'a route to draw');
if (found) {
  const { e, route } = found, cells = route.slice(1, -1), want = cells.slice().sort((a, b) => a - b).join();
  const solved = routeTiles(route, { l1: clean.maps[e + 1].l1, kinds, shapes, prefer: routeKind(route, clean.maps[e + 1].l1, kinds) });
  check(!solved.refusal && cells.every((_, k) => lookless(solved.tiles[k + 1]!)), `its tiles walk tiles without a look of their own: ${solved.tiles.map((t) => (t === null ? '–' : hx(t))).join(' ')}`);
  s.edit('Path', () => writeRoute(rom, route, solved, { event: e, after: clean.maps[e + 1].l1.slice(), without: layer1Without(rom, e), isLevelTile: isLevel }), { key: null });
  const drawn = checkLooks('the route drawn');
  const b = drawn.problems.filter((p) => p.key.startsWith('path-no-look:'));
  check(keys(drawn.problems, 'path-no-look') === want && b.length === drawn.problems.length,
    `one "path without a look" per cell of the route, nothing else (${b.length} of ${cells.length}: ${b.map((p) => at(p.tile)).join(' ')})`);
  check(b.every((p) => p.group === 'look' && p.severity === 'warn' && p.progress === e + 1 && p.show?.event === e && p.show.mode === 'l2'),
    `found after event ${hx(e)}, Show: that event in layer 2`);
  const said = diffText(diffProblems(clean.problems, drawn.problems));
  check(said?.text === `+${cells.length} warnings`, `the edit says: "${said?.text}"`);

  // map pieces under the route: the block under a path cell of the game Mario walks on the same submap
  const final = applyEvents(readL2(rom), readEvents(rom), 0, OW_EVENTS), l1All = drawn.maps[OW_EVENTS].l1;
  const model = Array.from({ length: 0x800 }, (_, c) => c).find((c) => !cells.includes(c) && submapOf(views, c) === submapOf(views, route[0]) && lookless(l1All[c]))!;
  const piece = under(model).map((i) => final[i]);
  const paint = (ev: number) => {
    const d = readEvents(rom), base = readL2(rom), after = applyEvents(base, d, 0, ev + 1);
    for (const c of cells) under(c).forEach((i, k) => { after[i] = piece[k]; });
    writeEvents(rom, paintEvent(d, base, ev, after, eventPlace(eventRunners(rom), views, ev, 0)));
  };
  s.edit('Pieces', () => paint(e), { key: null });
  const painted = checkLooks('pieces under it in the same event');
  check(!painted.problems.length, `pieces painted under it in event ${hx(e)} (like the one at ${at(model)}): no warning`);
  const fixed = diffText(diffProblems(drawn.problems, painted.problems));
  check(fixed?.text === `−${cells.length} warnings`, `the edit says: "${fixed?.text}"`);
  s.undo();

  const later = e + 1;
  s.edit('Pieces', () => paint(later), { key: null });
  const late = checkLooks('pieces under it in a later event');
  const a = late.problems.filter((p) => p.key.startsWith('path-late-look:'));
  check(keys(late.problems, 'path-late-look') === want && a.length === late.problems.length,
    `the pieces in event ${hx(later)}: "shown after Mario walks it" per cell instead (${a.length}: ${a[0]?.text})`);
  check(a.every((p) => p.progress === e + 1 && p.show?.event === later && p.show.mode === 'l2'), `found after event ${hx(e)}, Show: event ${hx(later)} in layer 2`);
  s.undo();

  // the route's tiles given a look of their own (a visible tile's 8x8s): never warned about
  const visible = Array.from({ length: OW_L1_TILES }, (_, t) => t).find((t) => own[0][t] && own[1][t])!;
  s.edit('Map16', () => { for (const t of new Set(solved.tiles.filter((x) => x !== null))) setOwTileWords(rom, t!, owTileWords(rom, visible)); }, { key: null });
  const shown = checkLooks('the route\'s tiles visible');
  check(!shown.problems.length, `its tiles drawn as tile ${hx(visible)}: no warning (${shown.problems.length})`);
  s.undo();
}

if (bad) { console.log(`${bad} failed`); process.exit(1); }
console.log('path looks ok');
