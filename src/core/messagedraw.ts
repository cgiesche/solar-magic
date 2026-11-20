// Whether the game draws the messages the editor holds (SMWM, messages.ts) – told by emulation, never by known
// patches: a level (105, else the first of the next overworld levels that plays) is played within a game and message
// boxes opened as players open them – Mario hitting a message box sprite from below at two neighboring columns (which
// message it opens depends on where it is), a baby Yoshi growing up from eating a mushroom (Yoshi's thank-you, which
// the game shows only where it does: on its submap, before Yoshi was rescued). The characters the game writes into the
// message box's stripes ($7F837D: 4 byte header, then 18 × (character, attribute) per line) once a box opens are
// compared with the message it opened ($1426: 1, 2 the level's, 3 Yoshi's thank-you). A package replacing the message
// routine (a VWF dialog patch drawing its own text in its own format) leaves them unwritten or writes others.
// Which package that is: of the ones whose code or data the game reads only while a box opens (the same frames played
// again from the same moment without the box opening tell them apart from what runs every frame), those without whose
// patches (their original bytes back, on a copy of the ROM) the game draws the boxes again – a package hooking in
// near the routine (Retry System's switch palace hijack) is no drawer.
// Learned in the probe worker (probeprotocol.ts msgRoutine, App.messageRoutine), stored. Cost: a level started (up
// to 4 tries) and 3 boxes opened, ~0.4 s when the game draws them; boxes it doesn't draw are played again without
// opening, and per package that may draw them the level is started and those boxes opened again on a copy (VWF
// Dialogues: ~1.4 s).

import { Rom } from './rom.ts';
import { LevelEmulator } from './levelemu.ts';
import { PlaySession } from './playsession.ts';
import type { SnesState } from './snes.ts';
import { RAM, marioX, marioY, setMarioPos } from './ram.ts';
import { countReads } from './romdeps.ts';
import { runJob } from './jobrunner.ts';
import { translevelToLevel } from './overworld.ts';
import { readMessage, YOSHI_THANKS, MSG_COLS, MSG_LINES, SPACE } from './messages.ts';
import { listPatches, backupBytes, type PatchEntry } from './patchreg.ts';
import { listPackages, type Package } from './pkgreg.ts';

const LEVEL = 0x105; // the level played (a level of a translevel, as the game enters it) …
const TRIES = 4; // … else the next overworld levels, as many
const OPEN_FRAMES = 90; // frames for a box to open (a hit: ~20, Yoshi growing up: ~90 from the mushroom)
const FRAMES = 120; // frames for the box's text to be written once it opened (the game's: ~30)
const STRIPES = RAM.stripes, LINE = 4 + MSG_COLS * 2; // the stripe buffer ($7F837D), one line's stripe
// the sprites opening a box: the message box (hit from below), a baby Yoshi and a mushroom it eats (sprite numbers of
// the game; a ROM whose sprites differ opens fewer boxes, those are not compared)
const MESSAGE_BOX = 0xb9, BABY_YOSHI = 0x2d, MUSHROOM = 0x74;
const SLOT = 11; // the sprite slot of the probe's (items spawned take lower free slots)

export interface MessageRoutine {
  // the game draws the editor's messages; null: unknown (no level played, or no box opened)
  game: boolean | null;
  // when not: the packages whose code draws them instead (names, as the package list shows them; empty when
  // no package's can be told – a patch outside any package, or unknown)
  packages: string[];
  // the level played (null: none played)
  level: number | null;
  // the message boxes opened and compared ($1426: 1, 2 the level's, 3 Yoshi's thank-you)
  messages: number[];
}

// unknown: the check could not be made (also when it failed)
export const UNKNOWN_ROUTINE: MessageRoutine = { game: null, packages: [], level: null, messages: [] };

// a way to open a box from the saved state; spawn false: the same without the sprites (Mario does the same)
type Opener = (p: PlaySession, spawn: boolean) => void;
const hit = (dx: number): Opener => (p, spawn) => {
  const w = p.wram, x = (marioX(w) & ~15) + 32 + dx, y = marioY(w);
  if (spawn) p.emu.spawnSprite(SLOT, MESSAGE_BOX, x, y - 48);
  p.frame();
  // Mario jumping into it from below, as the sprite probe makes him (blockprobe.ts hitSprite)
  setMarioPos(w, x, y - 24);
  w[RAM.marioSpeedY] = 0xa0; w[RAM.marioInAir] = 0x0b;
};
const yoshi: Opener = (p, spawn) => {
  const w = p.wram, x = (marioX(w) & ~15) + 64, y = marioY(w);
  if (spawn) { p.emu.spawnSprite(SLOT - 1, BABY_YOSHI, x, y); p.emu.spawnSprite(SLOT - 2, MUSHROOM, x, y); }
};
const OPENERS: Opener[] = [hit(0), hit(16), yoshi];

// a box opened: its number ($1426), the translevel then and the characters written into its lines (at most a box's)
interface Opened { message: number; translevel: number; chars: number[] }

// The level played within a game, its state once ready to open boxes from, the box opened (the first box number
// written to $1426: a patch taking over may clear it at once) and what is written into the box's lines from then on,
// and the ROM read meanwhile (read: the ROM offsets read, while set)
class Play {
  readonly p: PlaySession;
  readonly before: SnesState;
  private chars: number[] = [];
  private opened: { message: number; translevel: number } | null = null;
  read: Uint8Array | null = null;

  constructor(p: PlaySession) {
    this.p = p;
    const w = p.wram, self = this;
    p.watch(() => ({
      hook: {
        onWramWrite(a: number, v: number) {
          if (a === RAM.message && v && !self.opened) self.opened = { message: v, translevel: w[RAM.translevel] };
          const rel = (a - STRIPES - 4) % LINE;
          if (self.opened && a >= STRIPES + 4 && a < STRIPES + MSG_LINES * LINE && rel < MSG_COLS * 2 && !(rel & 1)) self.chars.push(v);
        },
        onRomRead(o: number) { if (self.read) self.read[o] = 1; },
      },
      reset() {},
    }));
    this.before = p.save();
  }

  // level n played within a game on emu, null when it doesn't get ready
  static start(emu: LevelEmulator, n: number): Play | null {
    let p: PlaySession;
    try { p = PlaySession.start(emu, n, { game: {} }); } catch { return null; }
    if (p.ready) return new Play(p);
    p.close();
    return null;
  }

  // the box `open` opens (null: none), with the frames it took
  open(open: Opener, spawn = true): { box: Opened | null; frames: number } {
    const p = this.p;
    p.load(this.before);
    this.chars = [];
    this.opened = null;
    let f = 0, at = -1; // frames played, the one the box opened in
    try {
      open(p, spawn);
      while (f < OPEN_FRAMES + FRAMES && this.chars.length < MSG_LINES * MSG_COLS) {
        p.frame();
        f++;
        if (at < 0 && this.opened) at = f;
        if (at < 0 && f > OPEN_FRAMES) break;
        if (at >= 0 && f - at >= FRAMES) break;
      }
    } catch { /* (the emulated game crashed: what was written) */ }
    const o = this.opened as { message: number; translevel: number } | null; // (set by the hook)
    return { box: o && { ...o, chars: this.chars.slice(0, MSG_LINES * MSG_COLS) }, frames: f };
  }

  close(): void { this.p.close(); }
}

// what the box should show: the editor's message the box opened, as the box's characters
function wanted(rom: Rom, b: Opened): number[] {
  const m = b.message === 3 ? readMessage(rom, YOSHI_THANKS.translevel, YOSHI_THANKS.msg) : readMessage(rom, b.translevel, b.message);
  return Array.from({ length: MSG_LINES }, (_, l) => Array.from({ length: MSG_COLS }, (_, k) => m[l]?.[k] ?? SPACE)).flat();
}
const drawn = (rom: Rom, b: Opened) => { const want = wanted(rom, b); return b.chars.length === want.length && b.chars.every((c, i) => c === want[i]); };

// the registered patches with bytes in `only` (read with the box, not without it): bytes they changed or their
// free space
function readers(rom: Rom, only: Uint8Array): PatchEntry[] {
  const any = (pc: number, n: number) => { for (let i = pc; i < pc + n; i++) if (only[i]) return true; return false; };
  return listPatches(rom).filter((e) => e.segs.some(([pc, n]) => any(pc, n)) || e.own.some((o) => { const n = rom.isRatsAt(o); return n > 0 && any(o, n + 8); }));
}

// whether the game draws the boxes the openers open (the box each opened, by opener) on the ROM with the patches of
// package pkg undone (their original bytes back, on a copy); the copy's reads count as the ROM's, every byte the
// game reads there (a full picture's: which patch draws a box may show in what it draws with)
function drawnWithout(rom: Rom, emu: LevelEmulator, pkg: Package, level: number, openers: Opener[]): boolean {
  const copy = new Rom(rom.data.slice()), patches = listPatches(rom);
  for (const id of pkg.patches) {
    const e = patches.find((x) => x.id === id);
    if (!e) continue;
    const orig = backupBytes(rom, e);
    let k = 0;
    for (const [pc, n] of e.segs) { copy.data.set(orig.subarray(k, k + n), pc); k += n; }
  }
  const other = new LevelEmulator(copy);
  other.adoptBoot(emu.snapshot);
  const { result, reads } = other.record('full picture', () => {
    const play = Play.start(other, level);
    if (!play) return false;
    try {
      return openers.every((o) => { const b = play.open(o).box; return !!b && drawn(copy, b); });
    } finally { play.close(); }
  }, { base: null });
  countReads(rom, null, reads);
  return result;
}

// messageRoutine as a job of the result learner, on its emulator (booted): a step per level tried and per box
export function* messageRoutineJob(rom: Rom, emu: LevelEmulator): Generator<void, MessageRoutine> {
  const levels = [LEVEL, ...Array.from({ length: TRIES - 1 }, (_, k) => translevelToLevel(k + 1))];
  let play: Play | null = null, level = 0;
  for (const n of levels) {
    play = Play.start(emu, n);
    if (play) { level = n; break; }
    yield;
  }
  // no level plays: nothing to tell
  if (!play) return UNKNOWN_ROUTINE;
  const boxes: { opener: Opener; box: Opened; frames: number }[] = [];
  try {
    for (const opener of OPENERS) {
      yield;
      const { box, frames } = play.open(opener);
      // (a message opened again: compared once)
      if (box && !boxes.some((b) => b.box.message === box.message)) boxes.push({ opener, box, frames });
    }
    const messages = boxes.map((b) => b.box.message).sort((a, b) => a - b);
    if (!boxes.length) return { game: null, packages: [], level, messages };
    const wrong = boxes.filter((b) => !drawn(rom, b.box));
    if (!wrong.length) return { game: true, packages: [], level, messages };
    // the same frames with and without the boxes opening: what only they read (ROM bytes, pc)
    const withBox = new Uint8Array(rom.data.length), without = new Uint8Array(rom.data.length);
    for (const b of wrong) {
      yield;
      play.read = withBox;
      play.open(b.opener);
      play.read = without;
      const p = play.p;
      p.load(play.before);
      try {
        b.opener(p, false);
        for (let f = 0; f < b.frames; f++) p.frame();
      } catch { /* (what was read) */ }
      play.read = null;
    }
    for (let i = 0; i < withBox.length; i++) if (without[i]) withBox[i] = 0;
    const ids = new Set(readers(rom, withBox).map((e) => e.id));
    const names: string[] = [];
    for (const pkg of listPackages(rom).filter((k) => k.patches.some((id) => ids.has(id)))) {
      yield;
      if (drawnWithout(rom, emu, pkg, level, wrong.map((b) => b.opener))) names.push(pkg.name);
    }
    return { game: false, packages: names, level, messages };
  } finally { play.close(); }
}

// messageRoutine run at once, on an emulator of its own (tests)
export function messageRoutine(rom: Rom): MessageRoutine {
  const emu = new LevelEmulator(rom);
  emu.boot();
  return runJob(messageRoutineJob(rom, emu));
}

// what decides the result besides the ROM bytes the game reads: the registered patches and packages (their names)
export function messageRoutineInput(rom: Rom): string {
  return [...listPatches(rom).map((e) => `${e.id}:${e.check}`), ...listPackages(rom).map((p) => `${p.id}:${p.name}:${p.patches.join('+')}`)].join();
}

// "Messages in this ROM are drawn by package X" – what the editor says instead of its message editor
export function messageRoutineNote(r: MessageRoutine): string {
  const by = r.packages.length ? `by ${r.packages.length > 1 ? 'packages' : 'package'} ${r.packages.map((n) => `“${n}”`).join(', ')}`
    : 'by a patch that replaces the game\'s message routine';
  return `Messages in this ROM are drawn ${by}, not by the game's message box: the editor's messages are not what players see.`;
}
// what the editor says while it is checked
export const MESSAGE_ROUTINE_CHECKING = 'Checking whether the game draws the editor\'s messages (a package may draw them instead)…';
// what the editor says when it could not tell (MessageRoutine game null)
export function messageRoutineUnknown(r: MessageRoutine): string {
  return r.level === null
    ? 'Whether the game draws the editor\'s messages could not be checked: no level could be played in the emulator.'
    : `Whether the game draws the editor's messages could not be checked: no message box opened in level ${r.level.toString(16).toUpperCase()}.`;
}

// what installing package `name` says when it took over drawing the messages: before and after the install (before
// undefined: not known then; the package named as a drawer after it tells it)
export function messageRoutineTaken(name: string, before: MessageRoutine | undefined, after: MessageRoutine): string | null {
  if (after.game !== false) return null;
  if (!after.packages.includes(name) && (after.packages.length || before?.game !== true)) return null;
  return 'Message boxes are now drawn by this package, not by the game\'s message routine: the editor\'s message editing (the message panel, its preview and checks) no longer applies while it is installed.';
}
