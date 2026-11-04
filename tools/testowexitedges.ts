// What a level exit opens (owexitedges.ts): exit E opens level B when B is reached at the event progress after E's
// event and not at the one before. On the test ROM (the clean game): Yoshi's Island's edges as the game has them,
// an arrow to another submap ending at the link leaving the exit's submap, the maps of progressMapsJob the same as
// the loads'.
import { Rom } from '../src/core/rom.ts';
import { OverworldEmulator, OverworldLoads, translevelToLevel, l1XY, gameL1, OW_EVENTS, EXIT_NAMES } from '../src/core/overworld.ts';
import { progressSaves } from '../src/core/owprogress.ts';
import { reachInput } from '../src/core/owreach.ts';
import { readStart } from '../src/core/owsprites.ts';
import { submapViews, submapOf } from '../src/core/owevents.ts';
import { exitEdges, progressMapsJob, type ProgressMap } from '../src/core/owexitedges.ts';
import { RAM } from '../src/core/ram.ts';
import { ExitGraph } from '../src/core/exitgraph.ts';
import { levelTeleports } from '../src/core/owlinks.ts';
import { editorImage, pathKinds, pathShapes } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const hx = (v: number, n = 2) => v.toString(16).toUpperCase().padStart(n, '0');
const at = (i: number) => { const { x, y } = l1XY(i); return `${i >> 10 ? 'submaps' : 'main'} ${hx(x)},${hx(y)}`; };
const lv = (tl: number) => hx(translevelToLevel(tl), 3);

const rom = new Rom(await editorImage());
const kinds = pathKinds(rom), shapes = pathShapes(rom);
const loads = new OverworldLoads(new OverworldEmulator(rom), 4);

// the maps at every progress as the probe worker learns them
const job = progressMapsJob(loads);
let step = job.next(), steps = 0;
while (!step.done) { step = job.next(); steps++; }
const maps: ProgressMap[] = step.value;
const saves = progressSaves(loads);
check(maps.length === OW_EVENTS + 1 && steps === OW_EVENTS + 2 && [0, 0x20, OW_EVENTS].every((p) => {
  const r = loads.get(0, p);
  return gameL1(r).every((t, i) => t === maps[p].l1[i]) && r.wram.subarray(RAM.owTranslevels, RAM.owTranslevelsEnd).every((t, i) => t === maps[p].tls[i])
    && saves[p].levelFlags.every((f, i) => f === maps[p].flags[i]);
}), `the maps at every progress (${maps.length}, a step each): layer 1, translevels and flags as the loads and saves have them`);

const views = submapViews(loads), sub = (i: number) => submapOf(views, i);
const start = readStart(rom, 0);
// (as the overworld view searches: with the levels' exits to the overworld teleporting)
const graph = new ExitGraph(rom), warps = new Map<number, ReturnType<typeof levelTeleports>>();
const levelWarps = (tl: number) => (warps.get(tl) ?? warps.set(tl, levelTeleports(rom, graph, tl)).get(tl)!).map((t) => t.to);
const input = (p: number) => reachInput(rom, maps[p].l1, maps[p].tls, maps[p].flags, kinds, shapes, start, levelWarps);
const t0 = performance.now(), edges = exitEdges(rom, input, sub);
console.log(`     ${edges.length} exits in ${Math.round(performance.now() - t0)} ms`);
const text = (e: (typeof edges)[number]) => `${lv(e.tl)} ${EXIT_NAMES[e.exit].toLowerCase()} → ${e.opens.map((o) => lv(o.tl)).join(' ') || 'nothing'}`;

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
  console.log(`     the level not reached after its event: ${unknown.map(text).join(', ')}`);
  // (the Yellow Switch Palace: its event reveals no way on)
  check(none.some((e) => lv(e.tl) === '014'), `exits opening nothing listed with no level, the Yellow Switch Palace's among them (${none.length}; ${unknown.length} levels not reached after their event)`);
  // (124 has its normal exit only: the events of secret exits 1–3 after its base event change nothing)
  const t124 = edges.filter((e) => lv(e.tl) === '124');
  check(t124.length === 1 && t124[0].exit === 0, `a level's secret exits whose events change and open nothing left out (124: ${t124.map(text).join(', ')})`);
}

if (bad) { console.log(`${bad} failed`); process.exit(1); }
console.log('exit edges ok');
