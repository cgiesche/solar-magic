// Problems of the edited level, gathered for one list (see ui/problems.ts): each check is a plain
// function of the level and of what emulation found out, so it can run after every change.

import type { Level } from './level.ts';
import type { Rom } from './rom.ts';
import { exitTarget, type ExitGraph } from './exitgraph.ts';
import { hex2, hex3, spriteName } from './names.ts';
import type { ScanResult } from './levelscan.ts';

export type Severity = 'error' | 'warn' | 'info';

// where a problem is: a tile, a screen (exit: its screen exit) or sprites (uids)
export type ProblemPlace = { tx: number; ty: number } | { screen: number; exit?: boolean } | { sprites: number[] };

export interface Problem {
  key: string; // stable per problem (list updates keep the scroll position of unchanged entries)
  severity: Severity;
  text: string;
  title?: string; // longer explanation
  where?: ProblemPlace;
  message?: { translevel: number; msg: number }; // the message it is about (msg 1 or 2)
  fix?: { label: string; run: () => void };
}

// Screens with pipes or doors but no exit, exits without anything to enter, exits to a secondary
// entrance that is not set up. enterable(screen): null while the block probes are still running
// (nothing is reported for that screen then).
export function exitProblems(rom: Rom, level: Level, graph: ExitGraph, enterable: (screen: number) => boolean | null): Problem[] {
  const out: Problem[] = [];
  const exits = new Map(level.exits.map((e) => [e.screen, e]));
  for (let s = 0; s < level.header.screens; s++) {
    const e = exits.get(s), en = enterable(s);
    if (!e && en === true) {
      out.push({ key: `exit-missing:${s}`, severity: 'warn', text: `Screen ${hex2(s)} has a pipe or door but no exit`,
        title: 'Entering it leads nowhere useful: the game takes the screen exit, which this screen does not have.', where: { screen: s, exit: true } });
    } else if (e && en === false) {
      out.push({ key: `exit-unused:${s}`, severity: 'info', text: `Screen ${hex2(s)} has an exit but no pipe or door`,
        title: 'Fine if something else uses the exit (custom blocks, sprites, walking off the level edge).', where: { screen: s, exit: true } });
    }
  }
  for (const e of level.exits) {
    if (e.screen >= level.header.screens) continue; // reported by levelProblems
    const t = exitTarget(rom, level.number, e);
    if (t.entrance >= 0 && !t.overworld && !graph.entrancesOf(t.to).includes(t.entrance)) {
      out.push({ key: `exit-target:${e.screen}`, severity: 'error', text: `Exit of screen ${hex2(e.screen)}: secondary entrance ${hex3(t.entrance)} is not set up`,
        where: { screen: e.screen, exit: true } });
    }
  }
  return out;
}

// level data the game ignores: more sprites than it loads, content beyond the last screen
export function levelProblems(level: Level, vertical: boolean): Problem[] {
  const out: Problem[] = [];
  if (level.sprites.length > 128) {
    out.push({ key: 'sprites-128', severity: 'error', text: `${level.sprites.length} sprites: the game only loads the first 128`,
      where: { sprites: level.sprites.slice(128).map((s) => s.uid) } });
  }
  const n = level.header.screens, scr = (x: number, y: number) => (vertical ? y : x) >> 4;
  const obj = level.objects.find((o) => scr(o.x, o.y) >= n);
  const spr = level.sprites.filter((s) => scr(s.x, s.y) >= n);
  const ex = level.exits.filter((e) => e.screen >= n);
  if (obj || spr.length || ex.length) {
    const what = [obj && 'objects', spr.length && 'sprites', ex.length && 'exits'].filter(Boolean).join(', ');
    out.push({ key: 'beyond-screens', severity: 'warn', text: `${what[0].toUpperCase()}${what.slice(1)} beyond the last screen (${hex2(n - 1)})`,
      title: 'They are kept but cannot be reached in the game. Raise the number of screens in the level header to use them.',
      where: obj ? { tx: obj.x, ty: obj.y } : spr.length ? { sprites: spr.map((s) => s.uid) } : { screen: ex[0].screen, exit: true } });
  }
  return out;
}

// from the level scan: screens with slowdown (a few lag frames are ignored), sprites that fall
// out right after appearing or stay stuck; uids: the level's sprites in load order
export function scanProblems(level: Level, r: ScanResult, uids: number[]): Problem[] {
  const out: Problem[] = [];
  for (const s of r.screens) {
    if (s.lag < 3) continue;
    out.push({ key: `lag:${s.screen}`, severity: 'warn', text: `Slowdown on screen ${hex2(s.screen)} (${s.lag} of ${s.frames} frames)`,
      title: 'Found by playing the level through: in these frames the game did not finish its work before the next picture. Usually too many (or too busy) sprites at once.',
      where: { screen: s.screen } });
  }
  for (const f of r.sprites) {
    const sp = level.sprites.find((q) => q.uid === uids[f.index]);
    if (!sp) continue;
    const name = `Sprite ${hex2(sp.num)} ${spriteName(sp.num)} at ${hex2(sp.x)}/${hex2(sp.y)}`;
    out.push(f.kind === 'fell'
      ? { key: `fell:${sp.uid}`, severity: 'warn', text: `${name} falls out of the level right after appearing`, where: { sprites: [sp.uid] },
        title: 'Found by playing the level through (with Mario passing by above the screen; sprites that follow Mario may behave differently).' }
      : { key: `stuck:${sp.uid}`, severity: 'info', text: `${name} is stuck between blocks`, where: { sprites: [sp.uid] },
        title: 'It keeps bumping into blocks on both sides without getting anywhere – placed inside a wall or in a gap too narrow.' });
  }
  return out;
}

const ORDER: Record<Severity, number> = { error: 0, warn: 1, info: 2 };

export function sortProblems(l: Problem[]): Problem[] {
  return l.sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
}
