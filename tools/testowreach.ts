// Path validation (owreach.ts): which tiles Mario reaches at an event progress, by a search over the path kinds and
// shapes (owpaths.ts) and the save. Its ways are checked by emulation: Mario put on a stop tile with the map and level
// flags of the event progress, walking off in a direction, stops where the search says (ways along paths, bends and
// junctions, through exit paths to another submap, the game's hardcoded paths, a way the flags close, a path cut). The
// clean game's map: every level tile reached with every event passed but two nothing leads to, only Yoshi's house
// and Yoshi's Islands 1 and 2 before any; a path tile leading nowhere is a dead end, reported. The path shapes don't
// depend on the overworld's data.
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import {
  OverworldEmulator, OverworldLoads, gameL1, translevelToLevel, l1Index, l1XY, OW_EVENTS, MAX_TRANSLEVEL, DIR_NAMES, readL1, writeL1, readTranslevels, writeTranslevels, setExitDirection,
} from '../src/core/overworld.ts';
import { progressSaves } from '../src/core/owprogress.ts';
import { reach, reachInput, reachProblems, walkFrom, type ReachInput } from '../src/core/owreach.ts';
import { readStart } from '../src/core/owsprites.ts';
import { RAM, PAD, get16 } from '../src/core/ram.ts';
import { ResultCache, RomFingerprint } from '../src/core/romdeps.ts';
import { JobRunner } from '../src/core/jobrunner.ts';
import { pathShapesJob, DX, DY } from '../src/core/owpaths.ts';
import { editorImage, pathKinds, pathShapes } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const hx = (v: number, n = 2) => v.toString(16).toUpperCase().padStart(n, '0');
const at = (i: number) => { const { x, y } = l1XY(i); return `${i >> 10 ? 'submaps' : 'main'} ${hx(x)},${hx(y)}`; };

const rom = new Rom(await editorImage());
const kinds = pathKinds(rom), shapes = pathShapes(rom);
const loads = new OverworldLoads(new OverworldEmulator(rom), 4), saves = progressSaves(loads);
const input = (progress: number): ReachInput => {
  const r = loads.get(0, progress);
  return reachInput(rom, gameL1(r).slice(), r.wram.slice(RAM.owTranslevels, RAM.owTranslevelsEnd), saves[progress].levelFlags, kinds, shapes, readStart(rom, 0));
};
const levelTiles = (inp: ReachInput) => Array.from({ length: 0x800 }, (_, i) => i).filter((i) => kinds[inp.l1[i]] === 'level' && inp.tls[i]);
const levelHex = (tl: number) => hx(translevelToLevel(tl), 3);
const name = (inp: ReachInput, i: number) => `${hx(translevelToLevel(inp.tls[i]), 3)} (${at(i)})`;

// ---- the clean game's map ----
const all = input(OW_EVENTS), none = input(0);
{
  const t0 = performance.now(), r = reach(all);
  console.log(`     searched in ${Math.round(performance.now() - t0)} ms, ${r.stops.size} stops, ${r.walks.size} ways`);
  const missed = levelTiles(all).filter((i) => !r.stops.has(i));
  // (two level tiles of the clean game no path, star or hardcoded path leads to: nothing Mario walks onto around them)
  const around = (i: number) => [0, 1, 2, 3].some((d) => { const { x, y } = l1XY(i), nx = x + DX[d], ny = y + DY[d];
    return nx >= 0 && ny >= 0 && nx < 32 && ny < 32 && kinds[all.l1[l1Index(i >> 10, nx, ny)]] !== 'none'; });
  check(missed.map((i) => levelHex(all.tls[i])).join() === '019,112' && !missed.some(around),
    `every event passed: every level tile reached but the two nothing leads to (${missed.map((i) => name(all, i)).join(', ')})`);
  const stuck = [...r.walks].filter(([, w]) => w.stuck);
  check(!stuck.length, `no dead end ${stuck.map(([k, w]) => `${at(k >> 2)} ${DIR_NAMES[k & 3]} → ${w.stuck!.why} at ${at(w.stuck!.at)}`).join('; ')}`);
  const r0 = reach(none), got = levelTiles(none).filter((i) => r0.stops.has(i)).map((i) => hx(translevelToLevel(none.tls[i]), 3));
  check(got.join() === '104,105,106', `no event passed: Yoshi's house, Yoshi's Islands 1 and 2 reached, nothing else (${got.join(' ')})`);
}

// ---- the ways by emulation ----
const standing = (() => { const e = new LevelEmulator(rom); e.startGame(0); return e.snes.wram[RAM.owProcess]; })();
// Mario on tile i, the map and flags of the search's input in RAM, walking off in direction d: the tile he stands on
// after (his own: he didn't go)
function play(r: Rom, inp: ReachInput, i: number, d: number): number {
  const emu = new LevelEmulator(r), s = emu.snes, w = s.wram;
  emu.startGameAt(i);
  w.set(Uint8Array.from(inp.l1), RAM.owLayer1);
  w.set(Uint8Array.from(inp.flags), RAM.levelFlags);
  const pad = [PAD.up, PAD.down, PAD.left, PAD.right][d];
  let walked = false;
  for (let f = 0; f < 1500; f++) {
    s.joy1 = f < 4 ? pad : 0;
    s.runFrame();
    if (w[RAM.owProcess] !== standing) walked = true;
    else if (walked && f > 30) break;
    else if (!walked && f > 20) break;
  }
  return l1Index(w[RAM.submap] ? 1 : 0, get16(w, RAM.owPlayerTileX), get16(w, RAM.owPlayerTileY));
}
{
  const inp = { ...all, flags: reach(all).flags };
  const ways: [number, number][] = [];
  const r = reach(all);
  // a few ways of each kind: along paths, through an exit path, a hardcoded path, swimming, climbing
  const pick = (f: (k: number) => boolean, n: number) => { for (const k of [...r.walks.keys()].filter(f).slice(0, n)) ways.push([k >> 2, k & 3]); };
  pick((k) => !r.walks.get(k)!.stuck && r.walks.get(k)!.path.length > 3, 3);
  pick((k) => { const w = r.walks.get(k)!; return w.to >= 0 && (w.to >> 10) !== (k >> 12); }, 2);
  pick((k) => { const w = r.walks.get(k)!; return !w.stuck && w.path.some((p) => kinds[inp.l1[p]] === 'swim'); }, 1);
  pick((k) => { const w = r.walks.get(k)!; return !w.stuck && w.path.some((p) => kinds[inp.l1[p]] === 'climb'); }, 1);
  pick((k) => { const { x, y } = l1XY(k >> 2), d = k & 3, n = [x, y], j = d < 2 ? 1 : 0; n[j] += d === 0 || d === 2 ? -1 : 1;
    return n[0] >= 0 && n[1] >= 0 && n[0] < 32 && n[1] < 32 && kinds[inp.l1[l1Index(k >> 12, n[0], n[1])]] === 'none'; }, 2);
  for (const [i, d] of ways) {
    const w = walkFrom(inp, i, d)!, got = play(rom, inp, i, d);
    check(got === w.to, `from ${at(i)} ${DIR_NAMES[d]}: stops at ${at(w.to)} (the game: ${at(got)})`);
  }
  const open = { ...all, flags: new Uint8Array(MAX_TRANSLEVEL + 1).fill(0x0f) };
  for (const [i, d] of [[l1Index(1, 0x12, 0x1d), 0], [l1Index(1, 0x12, 0x1d), 3], [l1Index(1, 0x12, 0x18), 1]]) {
    const w = walkFrom(open, i, d), got = play(rom, open, i, d);
    check(got === (w && w.to >= 0 ? w.to : i), `from ${at(i)} ${DIR_NAMES[d]}: stops at ${w ? at(w.to) : 'none'} (the game: ${at(got)})`);
  }
  // a way the flags close: Mario stays
  const lv = levelTiles(none).find((i) => inp.tls[i] === 0x29)!; // 105
  const closed = { ...none, flags: new Uint8Array(MAX_TRANSLEVEL + 1) };
  const d = [0, 1, 2, 3].find((k) => walkFrom(none, lv, k))!;
  check(play(rom, closed, lv, d) === lv, `the flags closed: from ${at(lv)} ${DIR_NAMES[d]} Mario stays, as the search doesn't go`);
}

// ---- a broken path ----
{
  // no event passed: the way from Yoshi's house to Yoshi's Island 2 cut in its middle
  const r = reach(none), k = [...r.walks.keys()].find((k) => (k >> 2) === none.start && none.tls[r.walks.get(k)!.to] === 0x2a)!;
  const w = r.walks.get(k)!, cut = w.path[w.path.length >> 1], l1 = Uint8Array.from(none.l1);
  l1[cut] = 0;
  const inp = { ...none, l1 }, r2 = reach(inp), w2 = r2.walks.get(k);
  const back = play(rom, inp, k >> 2, k & 3);
  check(!!w2 && w2.to !== w.to && back === w2.to && !r2.stops.has(w.to),
    `a path tile removed at ${at(cut)}: the way from ${at(k >> 2)} ${DIR_NAMES[k & 3]} leads to ${w2 && at(w2.to)} (the game: ${at(back)}), ${name(none, w.to)} not reached`);
  // a path tile next to Yoshi's Island 1 leading nowhere
  const yi1 = r.walks.get(k ^ 1)?.to ?? -1, d = [0, 1, 2, 3].find((d) => { const { x, y } = l1XY(yi1); return !none.l1[l1Index(yi1 >> 10, x + DX[d], y + DY[d])]; })!;
  const { x, y } = l1XY(yi1), l1b = Uint8Array.from(none.l1), flags = Uint8Array.from(none.flags);
  l1b[l1Index(yi1 >> 10, x + DX[d], y + DY[d])] = d < 2 ? 0x06 : 0x04;
  flags[none.tls[yi1]] |= 0x0f;
  const r3 = reach({ ...none, l1: l1b, flags }), w3 = r3.walks.get(yi1 * 4 + d);
  check(none.tls[yi1] === 0x29 && !!w3?.stuck && w3.stuck.why === 'end', `a path tile next to 105 going ${DIR_NAMES[d]}: a dead end (${w3?.stuck?.why})`);
  const p = reachProblems(rom, { inp: { ...none, l1: l1b, flags }, r: r3 }, { inp: all, r: reach(all) }, at);
  check(p.some((q) => q.key === `ow-dead:${yi1 * 4 + d}` && q.severity === 'error'), `reported: ${p.filter((q) => q.severity === 'error').map((q) => q.text).join('; ')}`);
}

// ---- the problems of the clean game ----
{
  const p = reachProblems(rom, { inp: none, r: reach(none) }, { inp: all, r: reach(all) }, at);
  console.log(p.map((q) => `     ${q.severity} ${q.text}`).join('\n'));
  const events = p.filter((q) => q.key.startsWith('ow-event'));
  check(p.filter((q) => q.key.startsWith('ow-level')).length === 2 && !p.some((q) => q.severity === 'error') && events.length === 1 && events[0].text.startsWith('Level 112'),
    `the clean game: the two level tiles nothing leads to, the event of one of them, no dead end (${p.length} problems)`);
  // layer 1 at an event progress is the same whichever map is loaded (the search takes it from any)
  check([0, 0x20].every((n) => gameL1(loads.get(0, n)).every((t, i) => t === gameL1(loads.get(1, n))[i])), 'layer 1 the same with the main map or a submap loaded');
}

// ---- the path shapes hold while the overworld is edited ----
{
  const runner = new JobRunner({ rom, results: new ResultCache(new RomFingerprint(rom)) });
  const run = runner.run({ key: 'owsh', keep: false, picture: false, start: pathShapesJob });
  while (!runner.step('owsh', run));
  const reads = run.reads;
  const r = new Rom(rom.data.slice()), before = r.data.slice(), l1 = readL1(r), tls = readTranslevels(r);
  l1.fill(0x04, 0, 0x40); tls[0x10] = 0x30;
  writeL1(r, l1); writeTranslevels(r, tls); setExitDirection(r, 0x29, 0, 3);
  check(!reads.differ(before, r.data), 'layer 1, translevels and exit directions changed: the path shapes hold');
}

if (bad) { console.log(`${bad} failed`); process.exit(1); }
console.log('path validation ok');
