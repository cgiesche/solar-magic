// The reveal walk (revealwalk.ts): which translevels' exits skip it, learned by emulation. In the clean game the
// list at $04906C (Yoshi's House, the switch palaces …) – read here only to check the result; the list changed in
// a ROM copy (as a patch would), the result follows it. Passed as the game plays it, Yoshi's Island 1 enables the
// way back on the level tile its path leads to, but no longer once it is on the list – its own direction it still
// enables. A level whose base event is "No event" ($1DEA = FF) skips it too, whatever the list: passed with its
// normal exit Yoshi's Island 1 goes from handling the exit ($13D9 1) straight to 5, enabling the way back on no tile
// and no direction of its own (only "passed"); its secret exit 1 runs event 00 (FF + 1) and walks. The learned
// exits with no event match that. The result doesn't depend on the overworld's data (the base event of the level
// entered changed).
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { runJob } from '../src/core/jobrunner.ts';
import { revealWalkJob, skipsRevealWalk, handledWithoutEvent, type RevealWalkSkips } from '../src/core/revealwalk.ts';
import { exitEvent } from '../src/core/owevents.ts';
import { MAX_TRANSLEVEL, readTranslevels, setBaseEvent, NO_EVENT, DIR_FLAGS, exitDirections, FLAG, EXIT_NAMES } from '../src/core/overworld.ts';
import { PlaySession } from '../src/core/playsession.ts';
import { GM, RAM, OW_PROCESS } from '../src/core/ram.ts';
import { editorImage } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const hx = (v: number) => v.toString(16).toUpperCase().padStart(2, '0');

const LIST = 0x04906c, LIST_LEN = 6; // the game's list (16-bit entries), only to check against
const listOf = (rom: Rom) => Array.from({ length: LIST_LEN }, (_, k) => rom.r16(LIST + k * 2)).sort((a, b) => a - b);
const learned = (rom: Rom) => runJob(revealWalkJob(new LevelEmulator(rom)) as Generator<unknown, RevealWalkSkips>);
const skipped = (s: RevealWalkSkips) => [...s.translevels.keys()].filter((tl) => s.translevels[tl]);
// the process after handling the exit ($13D9 1)
const afterHandling = (procs: number[]) => procs[procs.indexOf(OW_PROCESS.handleExit) + 1];

// a new game, Yoshi's Island 1 entered and passed with exit `exit` (0 normal, 1–3 the secret exits), the overworld
// until it has handled it: the translevels other than 29 whose flags changed, 29's flags, the overworld's processes
// ($13D9) in turn, the events it ran ($1DEA) in turn
function passYI1(rom: Rom, exit = 0): { others: number[]; own: number; processes: number[]; events: number[] } | null {
  const p = PlaySession.overworld(new LevelEmulator(rom), readTranslevels(rom).indexOf(0x29));
  if (!p.enter()) return null;
  const w = p.wram, before = w.slice(RAM.levelFlags, RAM.levelFlags + MAX_TRANSLEVEL + 1);
  w[RAM.levelExit] = exit + 1; w[RAM.midwayTouched] = 1; w[RAM.levelBeaten] = 1; w[RAM.gameMode] = GM.overworldReturn;
  p.follow();
  const processes: number[] = [], events: number[] = [];
  for (let k = 0; k < 600; k++) {
    p.frame();
    if (w[RAM.gameMode] !== GM.overworld) continue;
    if (processes.at(-1) !== w[RAM.owProcess]) processes.push(w[RAM.owProcess]);
    if (events.at(-1) !== w[RAM.owEvent]) events.push(w[RAM.owEvent]);
  }
  return { others: [...before.keys()].filter((tl) => tl !== 0x29 && w[RAM.levelFlags + tl] !== before[tl]), own: w[RAM.levelFlags + 0x29], processes, events };
}

const rom = new Rom((await editorImage()).slice());
const t0 = Date.now();
const s = learned(rom);
const ms = Date.now() - t0;
check(s.translevels.length === MAX_TRANSLEVEL + 1, `a result per translevel (${ms} ms)`);
check(skipped(s).join() === listOf(rom).join(), `the clean game's translevels skip it: ${skipped(s).map(hx).join(' ')} (the list: ${listOf(rom).map(hx).join(' ')})`);
check(skipped(s).every((tl) => s.translevels[tl] === 0xf), 'every exit of them');
check(skipsRevealWalk(s, 0x28, 0, 0x0a) && !skipsRevealWalk(s, 0x29, 3, 0x01), 'skipsRevealWalk reads it per exit');

// the list changed: Yoshi's Island 1 (29) in the place of Yoshi's House (28)
{
  const r = new Rom(rom.data.slice());
  const k = listOf(r).indexOf(0x28);
  for (let i = 0; i < LIST_LEN; i++) if (r.r16(LIST + i * 2) === 0x28) r.w16(LIST + i * 2, 0x29);
  const c = learned(r);
  check(k >= 0 && !c.translevels[0x28] && c.translevels[0x29] === 0xf && skipped(c).length === LIST_LEN, `a patched list is followed: ${skipped(c).map(hx).join(' ')}`);
  const walked = passYI1(rom), skippedWalk = passYI1(r);
  check(!!walked?.others.length && !!skippedWalk && !skippedWalk.others.length,
    `passing 29: the way back enabled on ${walked?.others.map(hx).join(' ')}; with 29 on the list on none (${skippedWalk?.others.map(hx).join(' ')})`);
  const dir = DIR_FLAGS[exitDirections(r, 0x29)[0]] | FLAG.passed;
  check(!!skippedWalk && (skippedWalk.own & dir) === dir, `with 29 on the list it still enables its own direction (flags ${hx(skippedWalk?.own ?? 0)})`);
}

// a level with no base event ($1DEA = FF) skips the reveal walk too, whatever the list
{
  const r = new Rom(rom.data.slice());
  setBaseEvent(r, 0x29, NO_EVENT);
  const walked = passYI1(rom), none = passYI1(r);
  check(!!walked && afterHandling(walked.processes) !== OW_PROCESS.noRevealWalk && !!walked.others.length,
    `passing 29 with its event: the walk (processes ${walked?.processes.map(hx).join(' ')})`);
  check(!!none && none.events.join() === `${NO_EVENT}` && afterHandling(none.processes) === OW_PROCESS.noRevealWalk,
    `passing 29 with no event ($1DEA ${none?.events.map(hx).join(' ')}): handled at once, no walk (processes ${none?.processes.map(hx).join(' ')})`);
  check(!!none && !none.others.length, `with no event the way back enabled on none (${none?.others.map(hx).join(' ')})`);
  check(!!none && none.own === FLAG.passed, `with no event no direction of its own either, only passed (flags ${hx(none?.own ?? 0)})`);
  // per exit: handled at once with no event as learned
  const got = EXIT_NAMES.map((_, x) => passYI1(r, x));
  const atOnce = got.map((g) => !!g && afterHandling(g.processes) === OW_PROCESS.noRevealWalk);
  check(atOnce.every((a, x) => a === handledWithoutEvent(s, x, NO_EVENT)) && atOnce.some((a) => a),
    `with no event, the exits handled at once: ${atOnce.map((a, x) => (a ? x : '')).join('')} – learned ${hx(s.noEvent)}`);
  // (owevents.ts exitEvent, the ROM-only rule eventRunners follows, as learned: only secret exit 1 runs an event – 00)
  check(atOnce.every((a, x) => a === exitEvent(NO_EVENT, x) < 0) && exitEvent(NO_EVENT, 1) === 0,
    `exitEvent with no event as learned: ${EXIT_NAMES.map((_, x) => exitEvent(NO_EVENT, x)).join(' ')}`);
  check(!!got[1] && got[1].events.join() === `${NO_EVENT},0` && !!got[1].others.length && !handledWithoutEvent(s, 1, NO_EVENT),
    `secret exit 1 with no event runs event 00 and walks ($1DEA ${got[1]?.events.map(hx).join(' ')}, the way back on ${got[1]?.others.map(hx).join(' ')})`);
  check(skipsRevealWalk(s, 0x29, 0, NO_EVENT) && !skipsRevealWalk(s, 0x29, 0, 0x01) && skipsRevealWalk(s, 0x28, 1, NO_EVENT),
    'skipsRevealWalk: the list or no event');
}

// the overworld's data changed: the same result
{
  const r = new Rom(rom.data.slice());
  for (let tl = 0; tl <= MAX_TRANSLEVEL; tl++) setBaseEvent(r, tl, NO_EVENT);
  check(JSON.stringify(learned(r)) === JSON.stringify(s), 'no level runs an event: the same result');
}

if (bad) { console.log(`${bad} failed`); process.exit(1); }
console.log('reveal walk ok');
