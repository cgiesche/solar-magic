// The World check's checks beyond the paths (owchecks.ts): events never run, links stranding Mario, levels without
// level tile an exit leads into, events drawn by a loaded save in another order than in play. The clean game: only
// the cases the game itself has (listed here); each check provoked by a ROM edit on the test ROM.
import { Rom } from '../src/core/rom.ts';
import { OverworldEmulator, OverworldLoads, gameL1, l1XY, l1Index, OW_EVENTS, readL1, writeL1, readTranslevels, writeTranslevels, baseEvent, setBaseEvent, revealedTile, setRevealAt, readDestroyList, writeDestroyList, NO_EVENT } from '../src/core/overworld.ts';
import { readEvents, writeEvents, eventRunners } from '../src/core/owevents.ts';
import { shownSecretExits } from '../src/core/secretexits.ts';
import { readTeleport, writeTeleport, readExitPaths, writeExitPath } from '../src/core/owteleport.ts';
import { progressSaves } from '../src/core/owprogress.ts';
import { reach, reachInput } from '../src/core/owreach.ts';
import { readStart } from '../src/core/owsprites.ts';
import { RAM } from '../src/core/ram.ts';
import { ExitGraph } from '../src/core/exitgraph.ts';
import { checkContext, eventsNeeded, eventsNeverRun, stranded, untiledLevelsEntered, eventOrderProblems, starsWithoutTranslevelProblems, type CheckContext } from '../src/core/owchecks.ts';
import type { CheckedAt, WorldProblem } from '../src/core/worldcheck.ts';
import { editorImage, pathKinds, pathShapes } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const hx = (v: number, n = 2) => v.toString(16).toUpperCase().padStart(n, '0');
const at = (i: number) => { const { x, y } = l1XY(i); return `${i >> 10 ? 'submaps' : 'main'} ${hx(x)},${hx(y)}`; };

const rom = new Rom(await editorImage());
const kinds = pathKinds(rom), shapes = pathShapes(rom);
// every check of a ROM, with every event passed (its loads and saves emulated anew)
type Checks = { never: WorldProblem[]; stranded: WorldProblem[]; untiled: WorldProblem[]; order: WorldProblem[]; needed: number[][] };
function checks(r: Rom): Checks {
  const loads = new OverworldLoads(new OverworldEmulator(r), 4), saves = progressSaves(loads), g = loads.get(0, OW_EVENTS);
  const inp = reachInput(r, gameL1(g).slice(), g.wram.slice(RAM.owTranslevels, RAM.owTranslevelsEnd), saves[OW_EVENTS].levelFlags, kinds, shapes, readStart(r, 0));
  const all: CheckedAt = { inp, r: reach(inp), progress: OW_EVENTS }, c = checkContext(r, all, at);
  const t0 = performance.now();
  const needed = eventsNeeded(c);
  const out = { never: eventsNeverRun(c), stranded: stranded(c), untiled: untiledLevelsEntered(c, new ExitGraph(r)), order: eventOrderProblems(c, needed), needed };
  console.log(`     checked in ${Math.round(performance.now() - t0)} ms`);
  return out;
}
const list = (ps: WorldProblem[]) => ps.map((p) => `     ${p.severity} ${p.key} @${hx(p.progress)} ${p.tile >= 0 ? at(p.tile) : '-'}: ${p.text}`).join('\n');

const copy = () => new Rom(rom.data.slice());
const has = (ps: WorldProblem[], key: string) => ps.find((p) => p.key === key);
// layer 1 tiles Mario doesn't walk on, other than the one at `cell`
const emptyTiles = (r: Rom, cell: number) => [...kinds.keys()].filter((t) => kinds[t] === 'none' && t !== readL1(r)[cell]);

// ---- the clean game: none of them ----
const clean = checks(rom);
{
  const all = [...clean.never, ...clean.stranded, ...clean.untiled, ...clean.order];
  console.log(list(all));
  check(!all.length, `the clean game: no event never run, no link stranding Mario, no level without level tile an exit leads into, no events out of order (${all.length})`);
  // (the play order: Star World 5's secret exit's event before the Special World levels' events, as it opens the way
  // there; the star leading there runs no event, #390. Events whose numbers are not in play order change no tile both)
  const outOfOrder = clean.needed.flatMap((as, b) => as.filter((a) => a < b).map((a) => [b, a]));
  check(clean.needed[0x5e].includes(0x65) && outOfOrder.length > 0,
    `play order: event 5E before 65 (${clean.needed[0x5e].map((e) => hx(e)).join(' ')}); out of number order: ${outOfOrder.map(([b, a]) => `${hx(b)} before ${hx(a)}`).join(', ')}`);
}
const [late, early] = clean.needed.flatMap((as, b) => as.filter((a) => a < b).map((a) => [b, a]))[0];

// ---- an event nothing runs ----
{
  // event 77 (past every level's base event + 3) given a layer 1 change: nothing runs it
  const r = copy(), d = readEvents(r), cell = l1Index(1, 0, 0), e = 0x77;
  d.silent[e].push({ layer: 1, tile: emptyTiles(r, cell)[0], loc: cell });
  writeEvents(r, d);
  const p = checks(r).never, n = has(p, `event-never-run:${e}`);
  console.log(list(p));
  check(!!n && n.severity === 'warn' && n.group === 'progress' && n.progress === e + 1 && n.tile === cell && p.length === 1,
    `event ${hx(e)} changing ${at(cell)}: never run, a warning of Progress (${n?.text})`);
}
{
  // a level's base event + 2 where the level has no secret exit 2 (eventRunners, #383) and no level's exit runs it,
  // given a layer 1 change: never run (no longer counted as run by the base event + 0…3 of every level)
  const runners = eventRunners(rom), tls = [...new Set(readTranslevels(rom))].filter((tl) => tl).sort((a, b) => a - b);
  const tl = tls.find((tl) => baseEvent(rom, tl) + 2 < OW_EVENTS && !runners.has(baseEvent(rom, tl) + 2))!;
  const r = copy(), d = readEvents(r), cell = l1Index(1, 0, 0), e = baseEvent(rom, tl) + 2;
  d.silent[e].push({ layer: 1, tile: emptyTiles(r, cell)[0], loc: cell });
  writeEvents(r, d);
  const p = checks(r).never, n = has(p, `event-never-run:${e}`);
  console.log(list(p));
  check(!!n && n.severity === 'warn' && n.progress === e + 1 && n.tile === cell && p.length === 1,
    `event ${hx(e)} (translevel ${hx(tl)}'s base event + 2, no secret exit 2) changing ${at(cell)}: never run (${n?.text})`);
}

{
  // #391: a reveal, a destroy or a layer 1 change leaving the cell's tile as it is – as the events before it in number
  // order left it and on the map before events – changes nothing: event 77 given one is not never run (as Journey to
  // Kaizo's reveals at main 00,01, tile 000 before and after); one that changes the tile on either still counts
  const e = 0x77, cell = l1Index(0, 0, 1), level = l1Index(1, 9, 6), revealable = readL1(rom)[level]; // (6E, revealed as 66)
  const never = (edit: (r: Rom) => void) => { const r = copy(); edit(r); return has(checks(r).never, `event-never-run:${e}`); };
  check(readL1(rom)[cell] === 0 && revealedTile(rom, 0) < 0 && revealedTile(rom, revealable) >= 0, `main 00,01 is tile 000, not in the reveal list; ${hx(revealable, 3)} is`);
  check(!never((r) => setRevealAt(r, e, cell)), `event ${hx(e)} revealing ${at(cell)} (tile 000 stays): changes nothing, not never run`);
  check(!!never((r) => setRevealAt(r, e, level)), `event ${hx(e)} revealing ${at(level)} (${hx(revealable, 3)} before events, which it turns into another; 03 reveals it first in number order): never run`);
  check(!never((r) => { const d = readEvents(r); d.silent[e].push({ layer: 1, tile: 0, loc: cell }); writeEvents(r, d); }),
    `event ${hx(e)} writing tile 000 on ${at(cell)} (tile 000): changes nothing`);
  check(!never((r) => { const l = readDestroyList(r), k = l.findIndex((x) => x.event === NO_EVENT); l[k] = { event: e, tile: cell }; writeDestroyList(r, l); }),
    `event ${hx(e)} destroying ${at(cell)} (tile 000 has no destroy effect): changes nothing`);
  // (an earlier event's layer 1 change making the reveal change the tile where the map before events has one it
  // keeps; one making it keep a tile it changes before events: still a change, in play it may pass first)
  const earlier = (tile: number, at: number) => (r: Rom) => { const d = readEvents(r); d.silent[3].push({ layer: 1, tile, loc: at }); writeEvents(r, d); setRevealAt(r, e, at); };
  check(!!never(earlier(revealable, cell)), `event 03 putting ${hx(revealable, 3)} on ${at(cell)}, event ${hx(e)} revealing it: never run`);
  check(!!never(earlier(0, level)), `event 03 putting 000 on ${at(level)}, event ${hx(e)} revealing it (${hx(revealable, 3)} before events): never run`);
  // a secret exit 1 nothing shows runs its event only where it changes something (eventRunners): not for the reveal
  // leaving the tile (Yoshi's Island 2, which shows none, given base event 76: its secret exit 1 would run 77)
  const tl = eventRunners(rom).get(3)![0].tl, runs = (cell: number) => {
    const r = copy();
    setBaseEvent(r, tl, 0x76);
    setRevealAt(r, e, cell);
    return eventRunners(r).get(e)?.some((x) => x.tl === tl && x.exit === 1) ?? false;
  };
  check(!shownSecretExits(rom).get(tl)?.has(1) && !runs(cell) && runs(level), `translevel ${hx(tl)}'s secret exit 1 (not shown) runs event ${hx(e)} revealing ${at(level)}, not revealing ${at(cell)}`);
}

// ---- a star stranding Mario ----
{
  // star/pipe entry 0 (main map 11,07) leading to level 019's tile (main 03,19), around which there is no path
  const r = copy(), t = readTeleport(r, 0), to = { submap: 0, x: 3, y: 0x19 };
  writeTeleport(r, 0, { from: t.from, to });
  const p = checks(r).stranded, key = `stranded:${l1Index(0, t.from!.x, t.from!.y)}:${l1Index(0, to.x, to.y)}`;
  console.log(list(p));
  const s = has(p, key);
  check(!!s && s.severity === 'error' && s.group === 'links' && p.length === 1, `the star at ${at(l1Index(0, t.from!.x, t.from!.y))} led to ${at(l1Index(0, to.x, to.y))}: stranded, an error of Links (${s?.text})`);
}

// ---- an exit path stranding Mario ----
{
  // the first exit path entry from the main map leading to level 019's tile (main 03,19) instead
  const r = copy(), k = readExitPaths(r).findIndex((e) => e && !e.from.submap), e = readExitPaths(r)[k]!, to = l1Index(0, 3, 0x19);
  writeExitPath(r, k, { from: e.from, to: { submap: 0, x: 3 * 16 + 8, y: 0x19 * 16 + 8 }, tile: { x: 3, y: 0x19 } });
  const p = checks(r).stranded, s = p.find((q) => q.key.endsWith(`:${to}`));
  console.log(list(p));
  check(!!s && s.severity === 'error' && s.text.includes('exit path tile') && s.tile >> 10 === 0,
    `exit path entry ${k} led to ${at(to)}: stranded at its exit path tile ${s && at(s.tile)} (${s?.text})`);
}

// ---- an exit tile across the path (#400): the warp still taken, nothing stranded ----
{
  // 42 (horizontal) on the Yoshi's Island ladder: Mario comes out off the path (the World check's warning,
  // testworldcheck), but where the link leads – and walks back
  const r = copy(), l1 = readL1(r), ladder = l1Index(0, 0x02, 0x14);
  l1[ladder] = 0x42;
  writeL1(r, l1);
  const p = checks(r).stranded;
  check(!p.length, `42 on the ladder at ${at(ladder)}: no link stranding Mario (${p.length})`);
}

// ---- a level without level tile an exit leads into ----
{
  // level 105's tile entering no level: level 1CB's exit leads into 105
  const r = copy(), tls = readTranslevels(r), i = tls.indexOf(0x29);
  tls[i] = 0;
  writeTranslevels(r, tls);
  const p = checks(r).untiled, u = has(p, 'untiled-level:261');
  console.log(list(p));
  check(!!u && u.severity === 'warn' && u.group === 'progress' && u.text.includes('level 1CB'), `level 105's tile taken away: ${u?.text}`);
}

// ---- events out of order ----
{
  // the first two events out of number order (the later runs first in play) both changing an empty tile of the
  // submaps, to different tiles
  const r = copy(), d = readEvents(r), cell = l1Index(1, 0, 0), none = emptyTiles(r, cell);
  d.silent[early].push({ layer: 1, tile: none[0], loc: cell });
  d.silent[late].push({ layer: 1, tile: none[1], loc: cell });
  writeEvents(r, d);
  const c = checks(r), p = c.order, o = has(p, `event-order:${early}:${late}`);
  console.log(list(p));
  check(!!o && o.severity === 'warn' && o.group === 'look' && o.tile === cell && o.progress === late + 1 && p.length === 1,
    `${hx(early)} and ${hx(late)} changing ${at(cell)} to tiles ${hx(none[0], 3)} and ${hx(none[1], 3)}: out of order (${o?.text})`);
}

// ---- a star or pipe without translevel (#288, #407) ----
{
  // the clean game's pipes are 82s on translevel 0 (walked off any way): none warned; a 5B there (a hack's) is, as a star
  check(!starsWithoutTranslevelProblems({ rom, place: at } as CheckContext).length, 'the clean game: no star or pipe without translevel warned (its pipes are 82s)');
  const r = copy(), l1 = readL1(r), pipe = l1Index(0, 0x0a, 0x03);
  l1[pipe] = 0x5b; writeL1(r, l1);
  const ps = starsWithoutTranslevelProblems({ rom: r, place: at } as CheckContext);
  check(ps.length === 1 && ps[0].tile === pipe && ps[0].severity === 'warn' && ps[0].progress === 0 && ps[0].text === `Pipe at ${at(pipe)} has no translevel of its own`,
    `the pipe 82 at ${at(pipe)} made a 5B on translevel 0: "${ps[0]?.text}"`);
}

if (bad) { console.log(`${bad} failed`); process.exit(1); }
console.log('world checks ok');
