// Whether the game draws the messages the editor holds (SMWM, messages.ts) – told by emulation, never by known
// patches: a level (105, else the first of the next overworld levels that plays) is played within a game, a message box opened ($1426 = 1), and the characters the game writes
// into the message box's stripes ($7F837D: 4 byte header, then 18 × (character, attribute) per line) compared with
// the level's message 1. A package replacing the message routine (a VWF dialog patch drawing its own text in its own
// format) leaves them unwritten or writes others. Which package that is: the ones whose code or data the game reads
// only while the box opens – the same frames played again from the same moment without it tell them apart from
// what runs every frame.

import { Rom } from './rom.ts';
import { LevelEmulator } from './levelemu.ts';
import { PlaySession } from './playsession.ts';
import { RAM } from './ram.ts';
import { levelTranslevel } from './level.ts';
import { translevelToLevel } from './overworld.ts';
import { readMessage, MSG_COLS, MSG_LINES, SPACE } from './messages.ts';
import { listPatches, type PatchEntry } from './patchreg.ts';
import { packageOfPatch } from './pkgreg.ts';

const LEVEL = 0x105; // the level played (a level of a translevel, as the game enters it) …
const TRIES = 4; // … else the next overworld levels, as many
const FRAMES = 120; // frames for the box to open and its text to be written (the game's: ~30)
const STRIPES = 0x1837d, LINE = 4 + MSG_COLS * 2; // $7F837D in WRAM, one line's stripe

export interface MessageRoutine {
  // the game draws the editor's messages
  game: boolean;
  // when not: the packages whose code draws them instead (names, as the package list shows them; empty when
  // no package's can be told – a patch outside any package, or unknown)
  packages: string[];
  // the level played (null: none played – the editor's messages are then taken as the game's)
  level: number | null;
}

// the characters written into the message box's lines while a box opens, in order (at most a box's worth)
function written(p: PlaySession, frames: number): number[] {
  const chars: number[] = [];
  p.watch(() => ({
    hook: { onWramWrite(a: number, v: number) {
      const rel = (a - STRIPES - 4) % LINE;
      if (a >= STRIPES + 4 && a < STRIPES + MSG_LINES * LINE && rel < MSG_COLS * 2 && !(rel & 1)) chars.push(v);
    } },
    reset() {},
  }));
  for (let f = 0; f < frames && chars.length < MSG_LINES * MSG_COLS; f++) p.frame();
  return chars.slice(0, MSG_LINES * MSG_COLS);
}

// the registered patches with bytes in `only` (read with the box, not without it): bytes they changed or their
// free space
function readers(rom: Rom, only: Uint8Array): PatchEntry[] {
  const any = (pc: number, n: number) => { for (let i = pc; i < pc + n; i++) if (only[i]) return true; return false; };
  return listPatches(rom).filter((e) => e.segs.some(([pc, n]) => any(pc, n)) || e.own.some((o) => { const n = rom.isRatsAt(o); return n > 0 && any(o, n + 8); }));
}

export function messageRoutine(rom: Rom): MessageRoutine {
  const copy = new Rom(rom.data.slice());
  const emu = new LevelEmulator(copy);
  emu.boot();
  const levels = [LEVEL, ...Array.from({ length: TRIES - 1 }, (_, k) => translevelToLevel(k + 1))];
  let p: PlaySession | null = null, level = 0;
  for (const n of levels) {
    const s = PlaySession.start(emu, n, { game: {} });
    if (s.ready) { p = s; level = n; break; }
    s.close();
  }
  // no level plays, nothing to tell: the editor's messages are taken as the game's
  if (!p) return { game: true, packages: [], level: null };
  const tl = levelTranslevel(copy, level);
  const want = readMessage(copy, tl, 1);
  const box = Array.from({ length: MSG_LINES }, (_, l) => Array.from({ length: MSG_COLS }, (_, k) => want[l]?.[k] ?? SPACE)).flat();
  const before = p.save();
  p.wram[RAM.message] = 1;
  const chars = written(p, FRAMES);
  p.close();
  if (chars.length === box.length && chars.every((c, i) => c === box[i])) return { game: true, packages: [], level };
  // the same frames with and without the box: what only the box reads (ROM bytes, pc)
  const q = PlaySession.resume(emu);
  let seen = new Uint8Array(copy.data.length);
  q.watch(() => ({ hook: { onRomRead(o: number) { seen[o] = 1; } }, reset() {} }));
  q.load(before);
  q.wram[RAM.message] = 1;
  for (let f = 0; f < FRAMES; f++) q.frame();
  const withBox = seen;
  seen = new Uint8Array(copy.data.length);
  q.load(before);
  for (let f = 0; f < FRAMES; f++) q.frame();
  q.close();
  for (let i = 0; i < withBox.length; i++) if (seen[i]) withBox[i] = 0;
  const names = new Set<string>();
  for (const e of readers(copy, withBox)) {
    const pkg = packageOfPatch(copy, e.id);
    if (pkg) names.add(pkg.name);
  }
  return { game: false, packages: [...names], level };
}

// "Messages in this ROM are drawn by package X" – what the editor says instead of its message editor
export function messageRoutineNote(r: MessageRoutine): string {
  const by = r.packages.length ? `by ${r.packages.length > 1 ? 'packages' : 'package'} ${r.packages.map((n) => `“${n}”`).join(', ')}`
    : 'by a patch that replaces the game\'s message routine';
  return `Messages in this ROM are drawn ${by}, not by the game's message box: the editor's messages are not what players see.`;
}

// messageRoutine for the ROM as it is, emulated again only when its patches changed (installed, removed, undone)
const cache = new WeakMap<Rom, { gen: number; key: string; r: MessageRoutine }>();
export function currentMessageRoutine(rom: Rom): MessageRoutine {
  const c = cache.get(rom);
  if (c?.gen === rom.gen) return c.r;
  const key = listPatches(rom).map((e) => `${e.id}:${e.check}`).join();
  const r = c?.key === key ? c.r : messageRoutine(rom);
  cache.set(rom, { gen: rom.gen, key, r });
  return r;
}

// what installing a package that took over drawing the messages says (before: the ROM before the install)
export function messageRoutineTaken(before: Rom, after: Rom): string | null {
  if (currentMessageRoutine(after).game || !messageRoutine(before).game) return null;
  return 'Message boxes are now drawn by this package, not by the game\'s message routine: the editor\'s message editing (the message panel, its preview and checks) no longer applies while it is installed.';
}
