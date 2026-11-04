// The World check (worldcheck.ts): the problems of the overworld in groups, errors and warnings, at the event progress
// they are found at, with a stable key (kind and place). The clean game: the two level tiles nothing leads to (errors)
// and the event of one of them (a warning), nothing else, the same keys searched again. A path made to lead nowhere on the test ROM
// (a ROM edit): a dead end, its fix "Add a stop tile here" – one layer 1 tile of the map before events – leaves Mario
// stopping there, the dead end gone, the other problems' keys as before. What an edit changed (diffProblems, diffText):
// the new dead end and up to three errors named, then "and N more"; its undo and the fix say them fixed; warnings
// counted; nothing changed, nothing said.
import { Rom } from '../src/core/rom.ts';
import { OverworldEmulator, OverworldLoads, gameL1, l1XY, readL1, writeL1, OW_EVENTS } from '../src/core/overworld.ts';
import { progressSaves } from '../src/core/owprogress.ts';
import { reach, reachInput } from '../src/core/owreach.ts';
import { readStart } from '../src/core/owsprites.ts';
import { RAM } from '../src/core/ram.ts';
import { worldProblems, applyFix, errorCount, stopTile, diffProblems, diffText, checkAgainst, type CheckedAt, type WorldProblem } from '../src/core/worldcheck.ts';
import { editorImage, pathKinds, pathShapes } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const hx = (v: number, n = 2) => v.toString(16).toUpperCase().padStart(n, '0');
const at = (i: number) => { const { x, y } = l1XY(i); return `${i >> 10 ? 'submaps' : 'main'} ${hx(x)},${hx(y)}`; };

const rom = new Rom(await editorImage());
const kinds = pathKinds(rom), shapes = pathShapes(rom); // (they don't depend on the overworld's data: testowreach)
// the World check of a ROM at progress 0 (the event progress shown) and with every event passed, its loads and saves
// emulated anew
function checkRom(r: Rom): { problems: WorldProblem[]; now: CheckedAt } {
  const loads = new OverworldLoads(new OverworldEmulator(r), 4), saves = progressSaves(loads);
  const search = (progress: number): CheckedAt => {
    const g = loads.get(0, progress);
    const inp = reachInput(r, gameL1(g).slice(), g.wram.slice(RAM.owTranslevels, RAM.owTranslevelsEnd), saves[progress].levelFlags, kinds, shapes, readStart(r, 0));
    return { inp, r: reach(inp), progress };
  };
  const now = search(0);
  return { problems: worldProblems(r, now, search(OW_EVENTS), at), now };
}
const list = (ps: WorldProblem[]) => ps.map((p) => `     ${p.severity} [${p.group}] ${p.key} @${hx(p.progress)}: ${p.text}${p.fix ? ` – fix: ${p.fix.label}` : ''}`).join('\n');
const keys = (ps: WorldProblem[]) => ps.map((p) => p.key).sort().join();

// ---- the clean game ----
const clean = checkRom(rom);
console.log(list(clean.problems));
{
  const ps = clean.problems, levels = ps.filter((p) => p.key.startsWith('unreached-level:'));
  check(levels.length === 2 && levels.every((p) => p.severity === 'error' && p.group === 'progress' && p.progress === OW_EVENTS)
    && levels.map((p) => at(p.tile)).join() === 'main 03,19,submaps 12,07',
    'the clean game: the two level tiles nothing leads to (019, 112) are errors of Progress, found with every event passed');
  const events = ps.filter((p) => p.key.startsWith('event-reveals-nothing:'));
  check(events.length === 1 && events[0].severity === 'warn' && events[0].group === 'progress', 'the event of level 112 reveals nothing Mario reaches: a warning');
  check(ps.length === 3 && errorCount(ps) === 2, `nothing else (${ps.length} problems, ${errorCount(ps)} errors)`);
  check(ps.every((p, k) => k === 0 || !(p.severity === 'error' && ps[k - 1].severity === 'warn')), 'errors listed before warnings');
  const again = checkRom(new Rom(rom.data.slice())).problems;
  check(keys(again) === keys(ps), 'searched again: the same keys');
  check(diffText(diffProblems(ps, again)) === null, 'nothing changed: nothing said');
  const warn = (n: number): WorldProblem => ({ ...events[0], key: `w${n}` });
  check(diffText({ added: [warn(1), warn(2)], gone: [warn(3)] })?.text === '+2 warnings · −1 warning', 'warnings counted, not named');
  // up to three named in all, the rest of each list counted with it
  const err = (n: number): WorldProblem => ({ ...ps[0], key: `e${n}`, brief: `e${n}` });
  const mixed = diffText({ added: [err(1), err(2)], gone: [err(3), err(4), err(5)] });
  check(mixed?.text === 'New: e1; e2 · Fixed: e3 and 2 more' && mixed.show?.key === 'e1', `two new, three fixed: "${mixed?.text}", Show the first new`);
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
  const undone = diffText(diffProblems(cutCheck.problems, clean.problems));
  check(!!undone && undone.text.startsWith(`Fixed: dead end at ${at(end)}; `) && !undone.text.includes('New') && !undone.show, `its undo says: "${undone?.text}"`);
  const stop = stopTile(readL1(rom), kinds);
  check(!!dead?.fix && dead.fix.tile === end && dead.fix.to === stop && kinds[stop] === 'stop', `fixed by "${dead?.fix?.label}": stop tile ${hx(stop, 3)} at ${at(end)}`);
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

if (bad) { console.log(`${bad} failed`); process.exit(1); }
console.log('world check ok');
