// What a level exit opens (owexitedges.ts): exit E opens level B when B is reached with every event passed and not
// with every event but E's – or at the event progress after E's event and not at the one before – the first levels
// on the way only. On the test ROM (the clean game): Yoshi's Island's edges as the game has them, Forest of Illusion's
// and Chocolate Island's (events out of number order there), a castle opening the level behind it (not the exit
// before it), an arrow to another submap ending at the link leaving the exit's submap, the maps built from the events
// (#384) those the game loads at every progress. With the events still passable without an exit's event
// (passableEdgesJob, the probe worker's, #380): the Valley of Bowser and Chocolate Island exits Mario reaches back
// through Star Road get their arrows, the Star World ones a star revealed by another exit makes needless lose theirs,
// Yoshi's Island's the same.
import { Rom } from '../src/core/rom.ts';
import { OverworldEmulator, OverworldLoads, translevelToLevel, l1XY, gameL1, OW_EVENTS, EXIT_NAMES } from '../src/core/overworld.ts';
import { progressSaves, progressSearches, progressMapsFromEvents, type ProgressMap } from '../src/core/owprogress.ts';
import { reachInput } from '../src/core/owreach.ts';
import { readStart } from '../src/core/owsprites.ts';
import { submapViews, submapOf, eventRunners, eventChanges } from '../src/core/owevents.ts';
import { exitEdges, passableEdgesJob, type ExitEdge } from '../src/core/owexitedges.ts';
import { RAM } from '../src/core/ram.ts';
import { ExitGraph } from '../src/core/exitgraph.ts';
import { levelTeleports } from '../src/core/owlinks.ts';
import { editorImage, pathKinds, pathShapes, loadedProgressMaps } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const hx = (v: number, n = 2) => v.toString(16).toUpperCase().padStart(n, '0');
const at = (i: number) => { const { x, y } = l1XY(i); return `${i >> 10 ? 'submaps' : 'main'} ${hx(x)},${hx(y)}`; };
const lv = (tl: number) => hx(translevelToLevel(tl), 3);

const rom = new Rom(await editorImage());
const kinds = pathKinds(rom), shapes = pathShapes(rom);
const loads = new OverworldLoads(new OverworldEmulator(rom), 4);

// the maps the game loads at every progress
const job = loadedProgressMaps(loads);
let step = job.next(), steps = 0;
while (!step.done) { step = job.next(); steps++; }
const loaded: ProgressMap[] = step.value;
const saves = progressSaves(loads);
check(loaded.length === OW_EVENTS + 1 && steps === OW_EVENTS + 2 && [0, 0x20, OW_EVENTS].every((p) => {
  const r = loads.get(0, p);
  return gameL1(r).every((t, i) => t === loaded[p].l1[i]) && r.wram.subarray(RAM.owTranslevels, RAM.owTranslevelsEnd).every((t, i) => t === loaded[p].tls[i])
    && saves[p].levelFlags.every((f, i) => f === loaded[p].flags[i]);
}), `the maps loaded at every progress (${loaded.length}, a step each): layer 1, translevels and flags as the loads and saves have them`);
// the maps the arrows search: built from the events (#384), those loaded at every progress
const maps = progressMapsFromEvents(rom, saves.map((s) => s.levelFlags));
const equal = (a: ArrayLike<number>, b: ArrayLike<number>) => a.length === b.length && Array.prototype.every.call(a, (v: number, i: number) => v === b[i]);
const differ = maps.map((_, p) => p).filter((p) => !equal(maps[p].l1, loaded[p].l1) || !equal(maps[p].tls, loaded[p].tls) || !equal(maps[p].flags, loaded[p].flags));
check(!differ.length, `the maps built from the events are those loaded at all ${maps.length} progresses (differing: ${differ.map((p) => hx(p)).join(' ')})`);

const views = submapViews(loads), sub = (i: number) => submapOf(views, i);
const start = readStart(rom, 0);
// (as the overworld view searches: with the levels' exits to the overworld teleporting)
const graph = new ExitGraph(rom), warps = new Map<number, ReturnType<typeof levelTeleports>>();
const levelWarps = (tl: number) => (warps.get(tl) ?? warps.set(tl, levelTeleports(rom, graph, tl)).get(tl)!).map((t) => t.to);
const input = (p: number) => reachInput(rom, maps[p].l1, maps[p].tls, maps[p].flags, kinds, shapes, start, levelWarps);
const t0 = performance.now(), edges = exitEdges(rom, progressSearches(input), sub);
console.log(`     ${edges.length} exits in ${Math.round(performance.now() - t0)} ms: ${edges.filter((e) => e.opens.length).length} with arrows (${edges.reduce((n, e) => n + e.opens.length, 0)})`);
const text = (e: (typeof edges)[number]) => `${lv(e.tl)} ${EXIT_NAMES[e.exit].toLowerCase()} → ${e.opens.map((o) => lv(o.tl)).join(' ') || 'nothing'}`;

// ---- events out of number order: Forest of Illusion, Chocolate Island; castles; the first level on the way only ----
for (const w of [
  '11E normal exit → 120', // Forest of Illusion 1: Forest of Illusion 2
  '11E secret exit 1 → 11D', // Forest of Illusion 1: the Forest Ghost House
  '11D secret exit 1 → 11F', // Forest Ghost House: Forest of Illusion 4
  '11F secret exit 1 → 122', // Forest of Illusion 4: the Forest Secret Area
  '122 normal exit → 01F', // Forest Secret Area: the Forest Fortress
  '123 secret exit 1 → 020', // Forest of Illusion 3: Roy's Castle (not Chocolate Island 1 behind it)
  '021 normal exit → 024', // Choco-Ghost House: Chocolate Island 2 (not the levels behind it)
  '024 normal exit → 023', // Chocolate Island 2: Chocolate Island 3
  '024 secret exit 1 → 117', // Chocolate Island 2: the Chocolate Secret
  '01D normal exit → 01C', // Chocolate Island 4: Chocolate Island 5
  '006 normal exit → 007', // Donut Plains 4: Morton's Castle – destroyed with every event passed, still a level
  '007 normal exit → 11A', // Morton's Castle: Vanilla Dome 1
  '116 normal exit → 115', // Valley of Bowser 1: Valley of Bowser 2
]) check(edges.some((e) => text(e) === w), `opens the first level on the way: ${w}`);

// ---- Yoshi's Island (submap 1) ----
const yi = edges.filter((e) => sub(e.from) === 1);
for (const e of yi) console.log(`     ${text(e)}  (${e.opens.map((o) => `${at(o.tile)} ends ${at(o.end)}`).join('; ')})`);
const want = [
  '105 normal exit → 014', // Yoshi's Island 1: the Yellow Switch Palace
  '106 normal exit → 103', // Yoshi's Island 2: Yoshi's Island 3
  '103 normal exit → 102', // Yoshi's Island 3: Yoshi's Island 4
  '102 normal exit → 101', // Yoshi's Island 4: Iggy's Castle
  '101 normal exit → 015', // Iggy's Castle: Donut Plains 1 (main map)
];
for (const w of want) check(yi.some((e) => text(e) === w), `Yoshi's Island: ${w}`);
check(yi.filter((e) => e.opens.length).length === want.length, `no other exit on Yoshi's Island opens a level (${yi.filter((e) => e.opens.length).map(text).join(', ')})`);

// ---- across submaps: Iggy's Castle's arrow ends at the exit path tile leaving Yoshi's Island ----
{
  const e = yi.find((x) => lv(x.tl) === '101' && x.exit === 0)!, o = e?.opens[0];
  const end = o ? maps[e.event + 1].l1[o.end] : -1;
  check(!!o && sub(o.tile) === 0 && o.end !== o.tile && sub(o.end) === 1 && kinds[end] === 'exit',
    `101's arrow to ${o && at(o.tile)} (main map) ends at ${o && at(o.end)}, an exit path tile of Yoshi's Island (tile ${hx(end, 3)}: ${kinds[end]})`);
  const same = yi.find((x) => lv(x.tl) === '106')?.opens[0];
  check(!!same && same.end === same.tile, `106's arrow on the same submap ends at the level tile (${same && at(same.end)})`);
}

// ---- an exit opening nothing: a stub ----
{
  const none = edges.filter((e) => e.reached && !e.opens.length), unknown = edges.filter((e) => !e.reached);
  console.log(`     opening nothing: ${none.map(text).join(', ')}`);
  // (besides switch palaces, star roads, stars and castles: exits whose way leads to a level reached another way with
  // every event passed – Donut Secret 1, Donut Secret 2, Cookie Mountain, Forest of Illusion 3 and 4, the Forest Ghost
  // House; the Valley of Bowser and the Chocolate Island exits leading there, whose levels Mario reaches back through
  // Star Road with every event passed: Valley of Bowser 2's secret exit, the Valley Ghost House's, Valley of Bowser 3
  // and 4, Chocolate Island 5, Wendy's Castle, the Sunken Ghost Ship)
  check(edges.filter((e) => e.opens.length).length === 68, `68 exits with arrows (${edges.length - none.length - unknown.length} of ${edges.length})`);
  console.log(`     the level not reached: ${unknown.map(text).join(', ')}`);
  // (the Yellow Switch Palace: its event reveals no way on)
  check(none.some((e) => lv(e.tl) === '014'), `exits opening nothing listed with no level, the Yellow Switch Palace's among them (${none.length})`);
  // (112: a level tile of the clean game no way leads to)
  check(unknown.map((e) => lv(e.tl)).join() === '112', `what an exit opens can't be told only where its level isn't reached with every event passed either (${unknown.map(text).join(', ')})`);
  // (a secret exit whose event changes nothing has no edge; 124 none at all: its tile is a star an event reveals,
  // which runs no event – #390)
  const changes = eventChanges(rom), idle = edges.filter((e) => e.exit && !changes(e.event).l1.length && !changes(e.event).l2.length);
  const t124 = edges.filter((e) => lv(e.tl) === '124');
  check(!idle.length && !t124.length, `a level's secret exits whose events change and open nothing left out (${idle.map(text).join(', ') || 'none'}), the revealed star 124 runs no event (${t124.map(text).join(', ') || 'no edge'})`);
}

// ---- the events still passable without the exit's event (the probe worker's job, after the saves: they are kept) ----
{
  const job = passableEdgesJob(rom, loads, kinds, shapes), t1 = performance.now();
  let s = job.next(), n = 0;
  for (; !s.done; s = job.next()) n++;
  const passable: ExitEdge[] = s.value, ms = Math.round(performance.now() - t1);
  console.log(`     passable: ${passable.filter((e) => e.opens.length).length} exits with arrows in ${ms} ms (${n} steps)`);
  const runs = [...eventRunners(rom)].filter(([e, r]) => e < OW_EVENTS && r.length).length;
  check(n === 2 + runs, `a step for the saves, one for the search with every event passed, then per event a level exit runs (${n} of ${2 + runs})`);
  const same = (a: ExitEdge[], b: ExitEdge[]) => a.length === b.length
    && a.every((e, k) => text(e) === text(b[k]) && e.opens.every((o, j) => o.tile === b[k].opens[j].tile && o.end === b[k].opens[j].end));
  check(same(passable.filter((e) => sub(e.from) === 1), yi), `Yoshi's Island's edges unchanged`);
  for (const w of [
    '115 secret exit 1 → 111', // Valley of Bowser 2: the Valley Fortress
    '113 normal exit → 10F', // Valley of Bowser 3: Valley of Bowser 4
    '111 normal exit → 10E', // the Valley Fortress: the Back Door
    '01A normal exit → 018', // Wendy's Castle: the Sunken Ghost Ship
    '018 normal exit → 116', // the Sunken Ghost Ship: Valley of Bowser 1
  ]) check(passable.some((e) => text(e) === w) && !edges.some((e) => text(e) === w), `reached back through Star Road with every event passed: ${w}`);
  // (Mario gets there without the exit: Wendy's Castle through the Chocolate Secret, Valley of Bowser 3 and Larry's
  // Castle from the Valley's star on Star Road)
  for (const w of ['01C normal exit → nothing', '114 secret exit 1 → nothing', '10F normal exit → nothing']) {
    check(passable.some((e) => text(e) === w), `opens nothing (another way leads there): ${w}`);
  }
  // (Star World 1, 2 and 4 are reached from the Star Road stars of Donut Plains, Vanilla Dome and Forest of Illusion:
  // their stars revealed by another exit too, which every event but the exit's undid)
  const of = (e: ExitEdge) => passable.find((p) => p.tl === e.tl && p.exit === e.exit);
  const lost = edges.filter((e) => e.opens.some((o) => !of(e)?.opens.some((p) => p.tl === o.tl))).map(text);
  check(lost.join() === '134 secret exit 1 → 130,132 secret exit 1 → 135,136 normal exit → 134',
    `lost only the Star World arrows a star of another exit makes needless (${lost.join(', ')})`);
  check(passable.filter((e) => e.opens.length).length === 70, `70 exits with arrows (68 before)`);
}

if (bad) { console.log(`${bad} failed`); process.exit(1); }
console.log('exit edges ok');
