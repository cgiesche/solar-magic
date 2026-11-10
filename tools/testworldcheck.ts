// The World check (worldcheck.ts): the problems of the overworld in groups, errors and warnings, at the event progress
// they are found at, with a stable key (kind and place). The clean game: the two level tiles nothing leads to (warnings:
// the original game's, #379) and the event of one of them (a warning, the original game's too), no error, nothing
// else; a level tile placed where nothing leads and level 019 moved elsewhere are errors; level 112's event or tile
// changed: its warning one as any other; the same keys searched again. A path made to lead nowhere on the test ROM
// (a ROM edit): a dead end, its fix "Add a stop tile here" – one layer 1 tile of the map before events – leaves Mario
// stopping there, the dead end gone, the other problems' keys as before. What an edit changed (diffProblems, diffText):
// the new dead end and up to three errors named, then "and N more"; its undo and the fix say them fixed; warnings
// counted; nothing changed, nothing said. Budgets: the clean game's two warnings (the reveal list full, the levels with a
// level tile amber), none an error; the destroy list amber, then full (an error said new); the fullest submap's custom
// sprites; where Show goes. Dead ends at every event progress (#377): none in the clean game; a path tile a late
// event (the last) takes away gives one, found after that event, listed with the playthrough strip at progress 0; the searches at progress 0 from the maps at every progress
// find the dead ends the World check's search there finds. The part learned in the probe worker (worldCheckJob, #387):
// the same problems, budgets and problems at every progress as found from those searches, in steps, as sent. A star led
// to a tile Mario can't move on from standing (#405): a warning of Links at the progress the star is reached, none in
// the clean game.
import { Rom } from '../src/core/rom.ts';
import { OverworldEmulator, OverworldLoads, gameL1, l1XY, l1Index, readL1, writeL1, readTranslevels, writeTranslevels, freeTranslevel, OW_EVENTS, readDestroyList, writeDestroyList, revealEventCount, NO_EVENT } from '../src/core/overworld.ts';
import { reach, reachInput, stuckProblems } from '../src/core/owreach.ts';
import { progressSaves, progressFlagsJob, progressMapsFromEvents, progressInput, progressSearches } from '../src/core/owprogress.ts';
import { ExitGraph } from '../src/core/exitgraph.ts';
import type { Job } from '../src/core/jobrunner.ts';
import { readStart } from '../src/core/owsprites.ts';
import { RAM } from '../src/core/ram.ts';
import { worldProblems, worldChecks, worldCheckJob, stuckAtEveryProgress, applyFix, errorCount, stopTile, diffProblems, diffText, checkAgainst, budgetProblems, budgetPlace, type CheckedAt, type WorldProblem, type WorldFix } from '../src/core/worldcheck.ts';
import { owBudgets, fullestSubmap } from '../src/core/owbudget.ts';
import { eventReveal } from '../src/core/oweventtiles.ts';
import { readEvents, writeEvents, submapViews, submapOf } from '../src/core/owevents.ts';
import { l1OwnLooks, lookProblems } from '../src/core/owlook.ts';
import { tileText } from '../src/core/owteleport.ts';
import { readCustomSprites, writeCustomSprites, OW_CUSTOM_MAX } from '../src/core/owcustom.ts';
import { makeLink, readLinks } from '../src/core/owlinks.ts';
import { editorImage, pathKinds, pathShapes, loadedProgressMaps, romDiff } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const hx = (v: number, n = 2) => v.toString(16).toUpperCase().padStart(n, '0');
const at = (i: number) => { const { x, y } = l1XY(i); return `${i >> 10 ? 'submaps' : 'main'} ${hx(x)},${hx(y)}`; };

const rom = new Rom(await editorImage());
const kinds = pathKinds(rom), shapes = pathShapes(rom); // (they don't depend on the overworld's data: testowreach)
// the World check of a ROM at progress 0 (the event progress shown) and with every event passed, its loads and saves
// emulated anew
function checkRom(r: Rom): { problems: WorldProblem[]; now: CheckedAt; all: CheckedAt } {
  const loads = new OverworldLoads(new OverworldEmulator(r), 4), saves = progressSaves(loads);
  const search = (progress: number): CheckedAt => {
    const g = loads.get(0, progress);
    const inp = reachInput(r, gameL1(g).slice(), g.wram.slice(RAM.owTranslevels, RAM.owTranslevelsEnd), saves[progress].levelFlags, kinds, shapes, readStart(r, 0));
    return { inp, r: reach(inp), progress };
  };
  const now = search(0), all = search(OW_EVENTS);
  return { problems: worldProblems(r, now, all, at), now, all };
}
const runJob = <T>(job: Job<T>): T => { let st = job.next(); while (!st.done) st = job.next(); return st.value; };
const list = (ps: WorldProblem[]) => ps.map((p) => `     ${p.severity} [${p.group}] ${p.key} @${hx(p.progress as number)}: ${p.text}${p.fix ? ` – fix: ${p.fix.label}` : ''}`).join('\n');
// the layer 1 tile a fix puts (none: a link end moved)
const toOf = (f: WorldFix) => ('to' in f ? f.to : undefined);
const keys = (ps: WorldProblem[]) => ps.map((p) => p.key).sort().join();

// ---- the clean game ----
const clean = checkRom(rom);
console.log(list(clean.problems));
{
  const ps = clean.problems, levels = ps.filter((p) => p.key.startsWith('unreached-level:'));
  check(levels.length === 2 && levels.every((p) => p.severity === 'warn' && p.group === 'progress' && p.progress === OW_EVENTS && p.text.endsWith('not reached – as in the original game'))
    && levels.map((p) => at(p.tile)).join() === 'main 03,19,submaps 12,07',
    'the clean game: the two level tiles nothing leads to (019, 112) are warnings of Progress ("as in the original game"), found with every event passed');
  // (level 112's event 43 destroys its tile 078, which has no destroy effect: it changes nothing – #391)
  const events = ps.filter((p) => p.key.startsWith('event-reveals-nothing:'));
  check(!events.length, `no event revealing nothing reached: level 112's (43) destroys its tile 078 as it is (${events.map((p) => p.text).join('; ') || 'none'})`);
  check(ps.length === 2 && errorCount(ps) === 0, `nothing else, no error (${ps.length} problems, ${errorCount(ps)} errors)`);
  check(ps.every((p, k) => k === 0 || !(p.severity === 'error' && ps[k - 1].severity === 'warn')), 'errors listed before warnings');
  const again = checkRom(new Rom(rom.data.slice())).problems;
  check(keys(again) === keys(ps), 'searched again: the same keys');
  check(diffText(diffProblems(ps, again)) === null, 'nothing changed: nothing said');
  const warn = (n: number): WorldProblem => ({ ...events[0], key: `w${n}` });
  check(diffText({ added: [warn(1), warn(2)], gone: [warn(3)] })?.text === '+2 warnings · −1 warning', 'warnings counted, not named');
  // up to three named in all, the rest of each list counted with it
  const err = (n: number): WorldProblem => ({ ...ps[0], severity: 'error', key: `e${n}`, brief: `e${n}` });
  const mixed = diffText({ added: [err(1), err(2)], gone: [err(3), err(4), err(5)] });
  check(mixed?.text === 'New: e1; e2 · Fixed: e3 and 2 more' && mixed.show?.key === 'e1', `two new, three fixed: "${mixed?.text}", Show the first new`);
}

// ---- level tiles nothing leads to, not the original game's: errors ----
{
  // a cell of the main map with nothing Mario walks on around it (nothing leads there)
  const l1 = readL1(rom), lonely = Array.from({ length: 0x400 }, (_, i) => i).find((i) => {
    const { x, y } = l1XY(i);
    return x > 0 && y > 0 && x < 31 && y < 31 && [-1, 0, 1].every((dy) => [-1, 0, 1].every((dx) => kinds[l1[l1Index(0, x + dx, y + dy)]] === 'none'));
  })!;
  const at019 = l1Index(0, 0x03, 0x19), levelTile = l1[at019];
  const unreached = (r: Rom, i: number) => checkRom(r).problems.find((p) => p.key === `unreached-level:${i}`);
  // a level tile of a level without one placed there
  {
    const r = new Rom(rom.data.slice()), m = readL1(r), tls = readTranslevels(r), tl = freeTranslevel(tls);
    m[lonely] = levelTile;
    tls[lonely] = tl;
    writeL1(r, m);
    writeTranslevels(r, tls);
    const p = unreached(r, lonely);
    check(tl > 0 && p?.severity === 'error' && p.text.endsWith('can\'t be reached'), `a level tile placed at ${at(lonely)} where nothing leads: an error (${p?.text})`);
  }
  // level 019's tile moved there: still not reached, an error (only the original game's place is a warning)
  {
    const r = new Rom(rom.data.slice()), m = readL1(r), tls = readTranslevels(r);
    m[lonely] = levelTile;
    tls[lonely] = tls[at019];
    m[at019] = l1[lonely];
    tls[at019] = 0;
    writeL1(r, m);
    writeTranslevels(r, tls);
    const ps = checkRom(r).problems, p = ps.find((q) => q.key === `unreached-level:${lonely}`);
    check(p?.severity === 'error' && p.text.startsWith('Level 019') && !ps.some((q) => q.key === `unreached-level:${at019}`), `level 019 moved to ${at(lonely)}, still not reached: an error (${p?.text})`);
  }
  // level 112's event changing another cell (nothing leads there either): it reveals nothing Mario reaches, a warning
  {
    const r = new Rom(rom.data.slice()), d = readEvents(r);
    d.silent[0x43].push({ layer: 1, tile: levelTile, loc: lonely });
    writeEvents(r, d);
    const p = checkRom(r).problems.find((q) => q.key === `event-reveals-nothing:${0x43}`);
    check(p?.severity === 'warn' && p.tile === lonely, `level 112's event also changing ${at(lonely)}: a warning (${p?.text})`);
  }
}

// ---- a path leading nowhere: a dead end and its fix ----
{
  // the way from Yoshi's house to Yoshi's Island 2 at progress 0: its level tile made the path tile before it (the
  // path goes on with nothing after it)
  const none = clean.now, k = [...none.r.walks.keys()].find((k) => (k >> 2) === none.inp.start && none.inp.tls[none.r.walks.get(k)!.to] === 0x2a)!;
  const w = none.r.walks.get(k)!, end = w.to, r = new Rom(rom.data.slice()), l1 = readL1(r);
  l1[end] = l1[w.path.at(-1)!];
  writeL1(r, l1);
  const cutCheck = checkRom(r), dead = cutCheck.problems.find((p) => p.key === `dead-end:${end}`);
  console.log(list(cutCheck.problems.filter((p) => p.group !== 'progress')));
  check(!!dead && dead.severity === 'error' && dead.group === 'paths' && dead.progress === 0 && dead.text.startsWith(`Dead end at ${at(end)}`),
    `level tile ${at(end)} made a path tile: a dead end at ${at(end)}, an error of Paths (${dead?.text})`);
  check(clean.problems.every((p) => cutCheck.problems.some((q) => q.key === p.key)), 'the clean game\'s problems keep their keys');
  // what the edit says: the dead end new (shown), with the levels it keeps Mario from up to three, then "and N more";
  // its undo (the clean game again): all of them fixed
  const said = diffText(diffProblems(clean.problems, cutCheck.problems)), newErrors = errorCount(cutCheck.problems) - errorCount(clean.problems);
  check(newErrors > 3 && !!said && said.text.startsWith(`New: dead end at ${at(end)}; level `) && said.text.includes(` and ${newErrors - 3} more · +`) && !said.text.includes('Fixed')
    && said.show?.key === dead?.key, `the edit says: "${said?.text}" (Show: ${said?.show?.brief})`);
  // when it is said: after an edit (another ROM generation) at the same event progress
  const base = checkAgainst(null, 1, 0, clean.problems);
  check(!base.change && checkAgainst(base.baseline, 1, 0, cutCheck.problems).change === null && checkAgainst(base.baseline, 2, 5, cutCheck.problems).change === null
    && checkAgainst(base.baseline, 2, 0, cutCheck.problems).change?.added.length === cutCheck.problems.length - clean.problems.length,
    'said after an edit at the same event progress; not first, not without an edit, not at another progress');
  // the problems at every event progress learned (#377): the dead end found at the progress shown listed once – with
  // the first progress they have it at, kept where they don't have it (a hack whose overworld code differs from the
  // maps built from the events)
  {
    const once = (every: WorldProblem[]) => worldProblems(r, cutCheck.now, cutCheck.all, at, [], every).filter((p) => p.key === dead?.key);
    const kept = once([]), later = once(dead ? [{ ...dead, progress: 5 }] : []);
    check(kept.length === 1 && kept[0].progress === 0 && !!kept[0].fix, 'the problems at every progress without the dead end shown: it is kept, at the progress shown, with its fix');
    check(later.length === 1 && later[0].progress === 5, 'the problems at every progress with it (first found at progress 5): listed once, at 5');
  }
  const undone = diffText(diffProblems(cutCheck.problems, clean.problems));
  check(!!undone && undone.text.startsWith(`Fixed: dead end at ${at(end)}; `) && !undone.text.includes('New') && !undone.show, `its undo says: "${undone?.text}"`);
  const stop = stopTile(readL1(rom), kinds);
  check(!!dead?.fix && dead.fix.tile === end && toOf(dead.fix) === stop && kinds[stop] === 'stop', `fixed by "${dead?.fix?.label}": stop tile ${hx(stop, 3)} at ${at(end)}`);
  if (dead?.fix) {
    const before = readL1(r);
    applyFix(r, dead.fix);
    const after = readL1(r), changed = [...after.keys()].filter((i) => after[i] !== before[i]);
    check(changed.join() === String(end), `the fix changes one tile of layer 1 (${changed.map(at).join(', ')})`);
    const fixed = checkRom(r), w2 = fixed.now.r.walks.get(k);
    check(!fixed.problems.some((p) => p.key.startsWith('dead-end:')) && w2?.to === end, `fixed: no dead end, the way stops at ${at(end)} (${w2 && at(w2.to)})`);
    const saidFix = diffText(diffProblems(cutCheck.problems, fixed.problems));
    check(!!saidFix && saidFix.text.startsWith(`Fixed: dead end at ${at(end)}`) && !saidFix.text.includes('New'), `the fix says: "${saidFix?.text}"`);
  }
}

// ---- dead ends at every event progress (#377) ----
{
  // the problems found at every event progress of a ROM, from the maps at every progress
  const atEvery = (r: Rom) => {
    const loads = new OverworldLoads(new OverworldEmulator(r), 4);
    const maps = progressMapsFromEvents(r, runJob(progressFlagsJob(loads)));
    // (the maps the game loads at every progress: the same – #381)
    const loaded = runJob(loadedProgressMaps(loads)), same = (a: ArrayLike<number>, b: ArrayLike<number>) => Array.prototype.every.call(a, (v: number, i: number) => v === b[i]);
    const differ = loaded.map((_, p) => p).filter((p) => !same(loaded[p].l1, maps[p].l1) || !same(loaded[p].tls, maps[p].tls));
    check(!differ.length, `the maps from the events are those the game loads at every progress (differing: ${differ.map((p) => hx(p)).join(' ')})`);
    const t = performance.now(), search = progressSearches(progressInput(r, maps, kinds, shapes, new ExitGraph(r)));
    const ps = stuckAtEveryProgress(r, search, at);
    console.log(`     the searches at every progress and their dead ends in ${Math.round(performance.now() - t)} ms`);
    return { ps, search };
  };
  const cleanEvery = atEvery(rom).ps;
  // (#455: but its star/pipe entry from the level tile at Yoshi's Island 06,07, where A enters the level: a warning)
  const yiLink = cleanEvery.filter((p) => p.key.startsWith('link-tile:') && p.tile === l1Index(1, 6, 7) && p.severity === 'warn');
  check(cleanEvery.length === 1 && yiLink.length === 1, `the clean game: no dead end, no exit path tile leading nowhere at any event progress – only the star/pipe link from the level tile at Yoshi's Island 06,07 (${cleanEvery.map((p) => p.brief).join('; ')})`);
  // the last event's layer 1 changes taking away a path tile Mario walks over (one the map before events has) – one
  // whose taking away leaves him stuck at one place (found by a search with every event passed without the tile)
  const full = clean.all, e = OW_EVENTS - 1, empty = kinds.findIndex((k) => k === 'none'), before = readL1(rom);
  const stuckWithout = (cut: number) => {
    const l1 = Uint16Array.from(full.inp.l1);
    l1[cut] = empty;
    return stuckProblems({ inp: { ...full.inp, l1 }, r: reach({ ...full.inp, l1 }) }, at);
  };
  const cut = [...full.r.walks.values()].filter((w) => !w.stuck).flatMap((w) => w.path)
    .find((i) => full.inp.l1[i] === before[i] && stuckWithout(i).length === 1)!;
  const end = stuckWithout(cut)[0].tile, r = new Rom(rom.data.slice()), d = readEvents(r);
  d.silent[e].push({ layer: 1, tile: empty, loc: cut });
  writeEvents(r, d);
  const { ps: every, search } = atEvery(r), dead = every.filter((p) => p.key.startsWith('dead-end:'));
  check(dead.length === 1 && dead[0].tile === end && dead[0].progress === e + 1 && dead[0].severity === 'error' && dead[0].group === 'paths',
    `the path tile at ${at(cut)} taken away by event ${hx(e)}: one dead end at ${at(end)}, found after event ${hx(e)} (${dead.map((p) => `${p.brief} @${hx(p.progress as number)}`).join('; ')})`);
  check(!!dead[0]?.fix && dead[0].fix.tile === end, `its fix: a stop tile at ${at(end)} on the map before events (${dead[0]?.fix?.label ?? dead[0]?.noFix?.kind})`);
  // the playthrough strip at progress 0: the dead end listed (none there), once, with the progress it is found at
  const shown = checkRom(r), ps = worldProblems(r, shown.now, shown.all, at, [], every);
  check(!stuckProblems(shown.now, at).length && ps.filter((p) => p.key === dead[0]?.key).length === 1 && ps.find((p) => p.key === dead[0]?.key)?.progress === e + 1,
    'the playthrough strip at progress 0 (no dead end there): the dead end listed once, with the progress it is found at');
  // (the search at the progress shown and the one from the maps at every progress agree: the list doesn't change
  // when the maps come)
  const keysOf = (c: CheckedAt) => stuckProblems(c, at).map((p) => p.key).sort().join();
  check(keysOf(search(0)) === keysOf(shown.now) && keysOf(search(OW_EVENTS)) === keysOf(shown.all) && keysOf(shown.all) === dead.map((p) => p.key).join(),
    'the searches from the maps at every progress find what the search at the progress shown finds (progress 0, every event passed)');

  // ---- the World check learned in the probe worker (#387) ----
  // worldCheckJob (what the editor's main thread no longer finds): the problems found with every event passed and the
  // budgets, those found at every event progress – the same as found from the searches the overworld view has, places
  // named by the submaps' views; a job of steps, its result as the worker sends it (structured clone)
  const learned = (x: Rom) => {
    const loads = new OverworldLoads(new OverworldEmulator(x), 4), job = worldCheckJob(x, loads, kinds, shapes);
    let steps = 0, st = job.next();
    while (!st.done) { steps++; st = job.next(); }
    const views = submapViews(loads), place = (i: number) => tileText({ submap: submapOf(views, i), ...l1XY(i) });
    return { got: structuredClone(st.value), steps, place, loads };
  };
  const same = (a: WorldProblem[], b: WorldProblem[]) => JSON.stringify(a) === JSON.stringify(b);
  for (const [name, x] of [['the clean game', rom], [`the path tile at ${at(cut)} taken away`, r]] as [string, Rom][]) {
    const { got, steps, place, loads } = learned(x), shownX = checkRom(x), graph = new ExitGraph(x), budgets = owBudgets(x, fullestSubmap(x), kinds);
    const maps = progressMapsFromEvents(x, runJob(progressFlagsJob(loads))), search = progressSearches(progressInput(x, maps, kinds, shapes, graph));
    const checks = [...worldChecks(x, shownX.all, place, graph, submapViews(loads)), ...budgetProblems(budgets)];
    const everyX = [...stuckAtEveryProgress(x, search, place), ...lookProblems({ rom: x, maps, ownLooks: l1OwnLooks(x, loads), kinds, views: submapViews(loads), search, place })];
    check(steps >= 3 && same(got.checks, checks) && JSON.stringify(got.budgets) === JSON.stringify(budgets) && same(got.every, everyX) && checks.length > 0,
      `${name}: worldCheckJob (${steps + 1} steps) finds the problems with every event passed (${got.checks.length}), the budgets and those at every progress (${got.every.map((p) => p.brief).join('; ') || 'none'}) as found on the main thread before`);
  }
}

// ---- exit tiles across the path (#400) ----
{
  // the problems at every event progress of a ROM (as worldCheckJob finds them: places and submaps by the views)
  const everyOf = (r: Rom) => {
    const loads = new OverworldLoads(new OverworldEmulator(r), 4), views = submapViews(loads);
    const maps = progressMapsFromEvents(r, runJob(progressFlagsJob(loads)));
    return stuckAtEveryProgress(r, progressSearches(progressInput(r, maps, kinds, shapes, new ExitGraph(r))), at, (i) => submapOf(views, i));
  };
  const cases: [number, number, string, number, string][] = [
    [l1Index(0, 0x19, 0x10), 0x4d, 'down', 0x42, 'the exit tile is vertical, the path into it horizontal'], // (the main map has no other 42: the lowest)
    [l1Index(0, 0x19, 0x10), 0x43, 'down', 0x42, 'the exit tile is vertical, the path into it horizontal'],
    [l1Index(0, 0x02, 0x14), 0x42, 'right', 0x4d, 'the exit tile is horizontal, the path into it vertical'], // (the main map's most used vertical one)
  ];
  for (const [cell, t, dir, to, why] of cases) {
    const r = new Rom(rom.data.slice()), l1 = readL1(r);
    l1[cell] = t;
    writeL1(r, l1);
    const ps = everyOf(r), p = ps.find((q) => q.key === `exit-off-path:${cell}`);
    check(!!p && p.severity === 'warn' && p.group === 'paths' && p.text === `Mario comes out of the exit at ${at(cell)} walking ${dir}, off the path (${why})`
      && !ps.some((q) => q.severity === 'error'), `${hx(t)} at ${at(cell)}: a warning of Paths, no error (${p?.text}, found after ${p && hx(p.progress as number)})`);
    check(p?.fix?.tile === cell && toOf(p.fix) === to, `its fix: ${p?.fix?.label} – tile ${p?.fix && hx(toOf(p.fix) ?? -1, 3)} (${p?.fix?.title})`);
    if (!p?.fix) continue;
    const before = readL1(r);
    applyFix(r, p.fix);
    const after = readL1(r), changed = [...after.keys()].filter((i) => after[i] !== before[i]), again = everyOf(r);
    check(changed.join() === String(cell) && !again.some((q) => q.key.startsWith('exit-off-path:') || q.key.startsWith('exit-nowhere:')),
      `fixed: one tile changed, Mario comes out on the path (${again.map((q) => q.brief).join('; ') || 'nothing at any progress'})`);
  }
  // shown with the problems at every progress at progress 0 (the exit isn't reached there): listed once
  const r = new Rom(rom.data.slice()), l1 = readL1(r), cell = l1Index(0, 0x19, 0x10);
  l1[cell] = 0x4d;
  writeL1(r, l1);
  const shown = checkRom(r), ps = worldProblems(r, shown.now, shown.all, at, [], everyOf(r));
  check(ps.filter((p) => p.key === `exit-off-path:${cell}`).length === 1 && errorCount(ps) === 0, 'listed at progress 0, once, no error');
}

// ---- budgets ----
{
  // the World check's budgets: those of owbudget.ts, the custom sprites of the submap with the most
  const budgets = (r: Rom) => owBudgets(r, fullestSubmap(r), kinds);
  const all = budgets(rom), ps = budgetProblems(all);
  console.log(list(ps));
  check(all.length === 8 && owBudgets(rom, 0, kinds).every((b, k) => b.used === all[k].used && b.max === all[k].max), 'the clean game: every budget listed, the numbers of the gauges (owBudgets)');
  const reveal = ps.find((p) => p.budget?.key === 'revealPairs'), levels = ps.find((p) => p.budget?.key === 'translevels');
  check(ps.length === 2 && !errorCount(ps) && ps.every((p) => p.group === 'budget' && p.tile < 0), `the clean game: two budget warnings, no error (${ps.map((p) => p.brief).join(', ')})`);
  check(reveal?.severity === 'warn' && reveal.text.startsWith('Reveal list full'), `the reveal list (full, 22 of 22) only a warning: "${reveal?.text}"`);
  check(levels?.severity === 'warn' && levels.text.endsWith('almost full: 3 left'), `levels with a level tile (92 of 95): amber, a warning: "${levels?.text}"`);
  check(keys(budgetProblems(budgets(new Rom(rom.data.slice())))) === keys(ps), 'checked again: the same keys');
  // the destroy list amber (20 of 24), then full: a warning, then an error said new
  const r = new Rom(rom.data.slice()), d = readDestroyList(r);
  const fill = (n: number) => { let k = 0; for (const e of d) if (e.event === NO_EVENT && k < n) { e.event = 0x60 + k; e.tile = 0x10 + k; k++; } writeDestroyList(r, d); };
  fill(4);
  const amber = budgetProblems(budgets(r)), dAmber = amber.find((p) => p.budget?.key === 'destroys');
  check(dAmber?.severity === 'warn' && dAmber.text.endsWith('almost full: 4 left'), `20 destroys of 24: a warning "${dAmber?.text}"`);
  fill(4);
  const full = budgetProblems(budgets(r)), dFull = full.find((p) => p.budget?.key === 'destroys');
  check(dFull?.severity === 'error' && errorCount(full) === 1, `24 of 24: an error "${dFull?.text}"`);
  const said = diffText(diffProblems(amber, full));
  check(said?.text === 'New: Destroyed level tiles full · −1 warning' && said.show === dFull, `amber turning full says: "${said?.text}"`);
  const place = budgetPlace(r, dFull!.budget!);
  check(place.mode === 'l1' && place.event === readDestroyList(rom).find((x) => x.event !== NO_EVENT)!.event, `Show: the event of the first destroy (${place.event?.toString(16)}), its gauge beside "+ Destroy"`);
  // the custom sprites: the fullest submap's budget, Show goes there
  const lists = readCustomSprites(r);
  lists[3] = Array.from({ length: OW_CUSTOM_MAX }, (_, k) => ({ id: 1, x: k, y: 3, z: 0, extra: [] }));
  lists[2] = [{ id: 1, x: 3, y: 3, z: 0, extra: [] }];
  writeCustomSprites(r, lists);
  const cs = budgetProblems(budgets(r)).find((p) => p.budget?.key === 'customSprites');
  check(cs?.severity === 'error' && cs.key === 'budget:customSprites:3:full' && cs.text.startsWith('Custom sprites on Forest of Illusion full'), `24 custom sprites on submap 3: "${cs?.text}"`);
  const csPlace = cs && budgetPlace(r, cs.budget!);
  check(csPlace?.mode === 'sprites' && csPlace.submap === 3, 'Show: the sprites mode on that submap');
  // where each other limit applies
  const of = (k: string) => budgetPlace(rom, all.find((b) => b.key === k)!);
  check(of('l1Tiles').mode === 'l1' && of('translevels').mode === 'l1' && of('stars').mode === 'l1' && of('exitPaths').mode === 'l1', 'Show: layer 1 tiles in the layer 1 mode, levels in the layer 1 mode (level tiles as objects there), links in the layer 1 mode too (#413)');
  const rv = of('revealPairs'), st = of('eventStorage'), revealBudget = all.find((b) => b.key === 'revealPairs')!;
  const past = revealEventCount(rom); // (the editor's reveal table has every event: nothing past it)
  check(budgetPlace(rom, revealBudget, 5).event === 5 && (past >= OW_EVENTS || budgetPlace(rom, revealBudget, past).event === rv.event),
    `Show keeps the event chosen where it shows the gauge, not one past the reveal table (events 00–${hx(past - 1)})`);
  check(eventReveal(rom, rv.event!) >= 0 && readEvents(rom).steps[st.event!].length > 0, `Show: reveals at event ${rv.event?.toString(16)} (it reveals a tile), the tile storage at event ${st.event?.toString(16)} (it has steps)`);
}

// ---- a link end on the other submap of an overlap (#404) ----
{
  // a star led to Forest of Illusion 05,14 – Vanilla Dome's entrance, whose paths are Vanilla Dome's (both views show it)
  const views = submapViews(new OverworldLoads(new OverworldEmulator(new Rom(rom.data.slice())), 4)), graph = new ExitGraph(rom);
  const misplaced = (r: Rom) => worldChecks(r, checkRom(r).all, at, graph, views).filter((p) => p.key.startsWith('link-submap:'));
  check(!misplaced(rom).length, 'the clean game: no link end on the other submap of an overlap');
  const r = new Rom(rom.data.slice()), from = { submap: 0, x: 0x0c, y: 0x09 };
  makeLink(r, 'star', from, { submap: 3, x: 5, y: 0x14 }, false);
  const ps = misplaced(r), p = ps[0];
  check(ps.length === 1 && p.severity === 'warn' && p.group === 'links' && p.tile === l1Index(1, 5, 0x14)
    && p.text === 'The link from Main map 0C,09 leads to Forest of Illusion 05,14 – that cell\'s paths are Vanilla Dome\'s',
    `a star to Forest of Illusion 05,14: a warning of Links (${p?.text})`);
  check(p?.fix?.label === 'Move to Vanilla Dome', `its fix: "${p?.fix?.label}" (${p?.fix?.title})`);
  if (p?.fix) {
    const before = r.data.slice();
    applyFix(r, p.fix);
    const l = readLinks(r).find((k) => k.kind === 'star' && k.a.submap === 0 && k.a.x === 0x0c && k.a.y === 9);
    check(!!l && tileText(l.b) === 'Vanilla Dome 05,14' && !misplaced(r).length && romDiff(before, r.data) === 1,
      `fixed: the star leads to ${l && tileText(l.b)}, no warning (${romDiff(before, r.data)} bytes changed)`);
  }
}

// ---- a link putting Mario standing where he can't move (#405) ----
{
  // the problems at every event progress (as worldCheckJob finds them)
  const everyOf = (r: Rom) => {
    const loads = new OverworldLoads(new OverworldEmulator(r), 4), views = submapViews(loads);
    const maps = progressMapsFromEvents(r, runJob(progressFlagsJob(loads)));
    return stuckAtEveryProgress(r, progressSearches(progressInput(r, maps, kinds, shapes, new ExitGraph(r))), at, (i) => submapOf(views, i));
  };
  const stuck = (ps: WorldProblem[]) => ps.filter((p) => p.key.startsWith('arrival-stuck:'));
  check(!stuck(everyOf(rom)).length && !stuck(clean.problems).length, 'the clean game: no star, pipe or teleport puts Mario where he can\'t move, at any event progress');
  // the star at main map 11,07 (to Vanilla Dome 0A,14 and back) led to Vanilla Dome 05,14: the exit path tile 48
  const r = new Rom(rom.data.slice()), vdi = l1Index(1, 5, 0x14);
  makeLink(r, 'star', { submap: 0, x: 0x11, y: 0x07 }, { submap: 2, x: 5, y: 0x14 }, false);
  const ps = everyOf(r), p = stuck(ps)[0];
  check(stuck(ps).length === 1 && p.severity === 'warn' && p.group === 'links' && p.tile === vdi && !p.fix
    && p.text === 'Mario arrives standing on a path tile at Vanilla Dome 05,14 and can\'t move – a star/pipe link must lead to a tile he stops on (a level, stop, star or pipe tile)',
    `the star at main 11,07 led to Vanilla Dome 05,14: a warning of Links, no fix, found after event ${p && hx(p.progress as number)}: ${p?.text}`);
  check(!!p && (p.progress as number) < OW_EVENTS && !stuck(everyOf(rom)).length, `found at the first progress the star is reached (${p && hx(p.progress as number)}), Show: the target (${p && at(p.tile)})`);
  const shown = checkRom(r), listed = worldProblems(r, shown.now, shown.all, at, [], ps);
  check(listed.filter((q) => q.key === p?.key).length === 1, 'listed once with the problems at every progress');
  // a stop tile without translevel there (81 on the map before events): Mario walking onto it by the main map's exit path
  // opens the way back in translevel 0's flags – shared by every tile without one, so then he walks off it: no warning
  const r2 = new Rom(r.data.slice()), l1 = readL1(r2);
  l1[vdi] = 0x81;
  writeL1(r2, l1);
  const p2 = stuck(everyOf(r2));
  check(!p2.length, `a stop tile 81 without translevel there, walked onto by the exit path first: no warning (${p2.map((q) => q.text).join('; ') || 'none'})`);
}

// ---- a star or pipe on translevel 0 (#288, #407) ----
{
  // the clean game's pipes are 82s on translevel 0 (Mario walks off them any way): no warning; a 5B there is warned
  const noTl = (ps: WorldProblem[]) => ps.filter((p) => p.key.startsWith('star-no-translevel:'));
  const l1 = readL1(rom), pipes = [...l1.keys()].filter((i) => (l1[i] & 0xff) === 0x82), tls = readTranslevels(rom);
  const checksOf = (r: Rom) => worldChecks(r, checkRom(r).all, at, new ExitGraph(r), submapViews(new OverworldLoads(new OverworldEmulator(r), 2)));
  check(!noTl(checksOf(rom)).length && pipes.length === 12 && pipes.every((i) => !tls[i]),
    `the clean game: no star or pipe warned for translevel 0 – its ${pipes.length} pipes are 82s without translevel`);
  const r = new Rom(rom.data.slice()), m = readL1(r), pipe = l1Index(0, 0x0a, 0x03);
  m[pipe] = 0x5b;
  writeL1(r, m);
  const ps = noTl(checksOf(r));
  check(ps.length === 1 && ps[0].tile === pipe && ps[0].severity === 'warn' && ps[0].progress === 0 && ps[0].text === 'Pipe at main 0A,03 has no translevel of its own',
    `the pipe at main 0A,03 made a 5B: "${ps[0]?.text}"`);
}

if (bad) { console.log(`${bad} failed`); process.exit(1); }
console.log('world check ok');
