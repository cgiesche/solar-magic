// The reveal walk (revealwalk.ts): which translevels' exits skip it, learned by emulation. In the clean game the
// list at $04906C (Yoshi's House, the switch palaces …) – read here only to check the result; the list changed in
// a ROM copy (as a patch would), the result follows it. Passed as the game plays it, Yoshi's Island 1 enables the
// way back on the level tile its path leads to, but no longer once it is on the list.
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { runJob } from '../src/core/jobrunner.ts';
import { revealWalkJob, skipsRevealWalk } from '../src/core/revealwalk.ts';
import { MAX_TRANSLEVEL, readTranslevels } from '../src/core/overworld.ts';
import { PlaySession } from '../src/core/playsession.ts';
import { GM, RAM } from '../src/core/ram.ts';
import { editorImage } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const hx = (v: number) => v.toString(16).toUpperCase().padStart(2, '0');

const LIST = 0x04906c, LIST_LEN = 6; // the game's list (16-bit entries), only to check against
const listOf = (rom: Rom) => Array.from({ length: LIST_LEN }, (_, k) => rom.r16(LIST + k * 2)).sort((a, b) => a - b);
const learned = (rom: Rom) => runJob(revealWalkJob(new LevelEmulator(rom)) as Generator<unknown, number[]>);
const skipped = (s: number[]) => [...s.keys()].filter((tl) => s[tl]);

// a new game, Yoshi's Island 1 entered and passed with its normal exit, the overworld until it has handled it: the
// translevels other than 29 whose flags changed
function passYI1(rom: Rom): number[] | null {
  const p = PlaySession.overworld(new LevelEmulator(rom), readTranslevels(rom).indexOf(0x29));
  if (!p.enter()) return null;
  const w = p.wram, before = w.slice(RAM.levelFlags, RAM.levelFlags + MAX_TRANSLEVEL + 1);
  w[RAM.levelExit] = 1; w[RAM.midwayTouched] = 1; w[RAM.levelBeaten] = 1; w[RAM.gameMode] = GM.overworldReturn;
  p.follow();
  for (let k = 0; k < 600; k++) p.frame();
  return [...before.keys()].filter((tl) => tl !== 0x29 && w[RAM.levelFlags + tl] !== before[tl]);
}

const rom = new Rom((await editorImage()).slice());
const t0 = Date.now();
const s = learned(rom);
const ms = Date.now() - t0;
check(s.length === MAX_TRANSLEVEL + 1, `a result per translevel (${ms} ms)`);
check(skipped(s).join() === listOf(rom).join(), `the clean game's translevels skip it: ${skipped(s).map(hx).join(' ')} (the list: ${listOf(rom).map(hx).join(' ')})`);
check(skipped(s).every((tl) => s[tl] === 0xf), 'every exit of them');
check(skipsRevealWalk(s, 0x28, 0) && !skipsRevealWalk(s, 0x29, 3), 'skipsRevealWalk reads it per exit');

// the list changed: Yoshi's Island 1 (29) in the place of Yoshi's House (28)
{
  const r = new Rom(rom.data.slice());
  const k = listOf(r).indexOf(0x28);
  for (let i = 0; i < LIST_LEN; i++) if (r.r16(LIST + i * 2) === 0x28) r.w16(LIST + i * 2, 0x29);
  const c = learned(r);
  check(k >= 0 && !c[0x28] && c[0x29] === 0xf && skipped(c).length === LIST_LEN, `a patched list is followed: ${skipped(c).map(hx).join(' ')}`);
  const walked = passYI1(rom), skippedWalk = passYI1(r);
  check(!!walked?.length && !!skippedWalk && !skippedWalk.length,
    `passing 29: the way back enabled on ${walked?.map(hx).join(' ')}; with 29 on the list on none (${skippedWalk?.map(hx).join(' ')})`);
}

if (bad) { console.log(`${bad} failed`); process.exit(1); }
console.log('reveal walk ok');
