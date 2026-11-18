// Title screen movement (CONTEXT.md): the joypad input the game plays the title screen level with – a table of
// (buttons, frames) pairs, ended by $FF. Lunar Magic records it with an external emulator, a savestate and an ASM
// installed and removed by hand, and plays it back with code and a format of its own; the editor records it itself
// and keeps the game's table (docs/research/pre-game-screens.md, 2.2 and 5.3).
//
// Nothing here knows where the table is. The title screen is run from the emulator's boot (game mode 07, the game's
// own setup of the level): the ROM byte the game loads its pair timer from on the first frame is a pair's frame count,
// the byte before it the pair's buttons – tried: with another button there, the game holds that one; the table is
// walked from there to its end. After its last pair the game takes one more frame to read the end.
//
// A button byte is the joypad's high byte – B, Y, Select, Start, Up, Down, Left, Right – which the game writes to its
// "held" byte ($15) without Select and to its "newly pressed" byte ($16) every frame: a button of the table is pressed
// anew each frame it is held. Y is left out of the pressed byte unless the Select bit is set: that bit means "Y newly
// pressed this frame". A, X, L and R can't be in the table.
//
// Recording feeds the buttons to the game through the table itself: the machine recorded on has its own copy of the
// ROM, and before every frame the table's first pair is the buttons held, for one frame, with the game's place in the
// table set back to it. So what is played while recording is what the table will play, pressed bits and all.
//
// Death on the title screen (learned by emulation, tools/testtitlemovement.ts): the title screen runs with no lives,
// so a death is a game over – game over screen, then the game loads the title screen level again as a level to play
// (its number still in $0109), with the status bar and the player's own joypad, and every death there is the next
// game over. A recording in which Mario dies is not written. The status bar is not hidden on the title screen but
// never drawn: its tilemap is written by a level's load in game mode 12 and its counters every frame of modes 13 and
// 14; the title screen loads through modes 03 and 04, which put the title screen picture's stripe image there, and
// runs without the IRQ that splits layer 3 below the status bar (NMITIMEN $81, a level's $A1).

import type { LevelEmulator } from './levelemu.ts';
import type { Rom } from './rom.ts';
import { pcToSnes } from './rom.ts';
import { Snes, type SnesState } from './snes.ts';
import { PPU } from './ppu.ts';
import { GM, RAM, PAD, MARIO_DYING, marioX, marioY } from './ram.ts';
import { holds, type RomReads } from './romdeps.ts';

// the bits of a button byte
export const MOVE = { b: 0x80, y: 0x40, yPress: 0x20, start: 0x10, up: 0x08, down: 0x04, left: 0x02, right: 0x01 } as const;
// the buttons a recording holds, in the timeline's order
export const MOVE_BUTTONS: readonly { bit: number; name: string }[] = [
  { bit: MOVE.b, name: 'B' }, { bit: MOVE.y, name: 'Y' }, { bit: MOVE.up, name: 'Up' }, { bit: MOVE.down, name: 'Down' },
  { bit: MOVE.left, name: 'Left' }, { bit: MOVE.right, name: 'Right' },
];
const END = 0xff; // ends the table
const MAX_PAIR = 255; // frames of one pair (the game counts a byte down; 0 would be 256)
const MAX_TABLE = 256; // pairs looked at for the table's end
const LOOK_FRAMES = 8; // frames of the title screen run to see the table read
const RUN_STATES = 32; // machine states kept of a run, to show any frame of it
const RUN_EVERY = 64; // frames between two of them at least
// frames a recording may have: the run is emulated again after every change that could move it out of sync
export const MAX_RECORD_FRAMES = 2 * 60 * 60;

export type MovePair = [buttons: number, frames: number];

export interface TitleMovement {
  at: number; // the table's ROM offset
  pairs: MovePair[]; // as the table has them
  frames: number; // the frames they last
  capacity: number; // the pairs the table holds where it is
  reads: number[]; // the instructions seen to read it (SNES addresses)
}

// the frames a pair lasts
const pairFrames = (n: number) => n || 256;

// the buttons of every frame
export function moveFrames(pairs: readonly MovePair[]): Uint8Array {
  const out = new Uint8Array(pairs.reduce((n, p) => n + p[1], 0));
  let f = 0;
  for (const [b, n] of pairs) { out.fill(b, f, f + n); f += n; }
  return out;
}

// the pairs of the buttons of every frame: runs of the same buttons, each as long as a pair can be
export function movePairs(frames: ArrayLike<number>): MovePair[] {
  const out: MovePair[] = [];
  for (let f = 0; f < frames.length; f++) {
    const last = out[out.length - 1];
    if (last && last[0] === frames[f] && last[1] < MAX_PAIR) last[1]++; else out.push([frames[f], 1]);
  }
  return out;
}

// The same movement as exactly n pairs (a table written in place keeps its length, so that what fits there stays
// known by it): the longest pairs split in two; a movement of fewer frames than pairs is filled with frames of no
// button. Throws when it has more than n.
export function fitPairs(pairs: readonly MovePair[], n: number): MovePair[] {
  if (pairs.length > n) throw new Error(`The recording has ${pairs.length} pairs of buttons and frames: ${pairs.length - n} more than the game's table holds (${n})`);
  const out = pairs.map((p): MovePair => [p[0], p[1]]);
  while (out.length < n) {
    let k = -1;
    out.forEach((p, i) => { if (p[1] > 1 && (k < 0 || p[1] > out[k][1])) k = i; });
    if (k < 0) out.push([0, 1]);
    else { const [b, f] = out[k], half = f >> 1; out.splice(k, 1, [b, f - half], [b, half]); }
  }
  return out;
}

// the table's bytes
export function tableBytes(pairs: readonly MovePair[]): Uint8Array {
  const out = new Uint8Array(pairs.length * 2 + 1);
  pairs.forEach(([b, n], i) => {
    if (b === END || n < 1 || n > MAX_PAIR) throw new Error('Not a pair of the game\'s table');
    out[i * 2] = b; out[i * 2 + 1] = n;
  });
  out[pairs.length * 2] = END;
  return out;
}

// The joypad (PAD bits) as a button byte: B, Y and the directions; X counts as Y, as the game has it. `before`: the
// joypad the frame before – Y newly pressed sets the bit that passes the press on.
export function moveOfPad(pad: number, before = 0): number {
  const y = (p: number) => (p & (PAD.y | PAD.x)) !== 0;
  let m = (pad >> 8) & (MOVE.b | MOVE.up | MOVE.down | MOVE.left | MOVE.right);
  if (y(pad)) m |= MOVE.y | (y(before) ? 0 : MOVE.yPress);
  return m;
}

// The table the game plays its title screen with (null: it reads no such table – a patch plays the title screen
// another way). The emulator's machine is left in the last state run.
export function learnMovement(emu: LevelEmulator): TitleMovement | null {
  const s = emu.snes, w = s.wram, d = emu.rom.data, hook = s.hook;
  s.loadState(emu.bootState());
  if (w[RAM.gameMode] !== GM.title || w[RAM.titleMoveIndex] !== 0) return null;
  let at = -1, frame: { o: number; pc: number }[] = [];
  s.hook = {
    onRomRead: (o) => { frame.push({ o, pc: s.cpu.opPc }); },
    onWramWrite: (a, v) => { if (at < 0 && a === RAM.titleMoveTimer && s.writeSource > 0 && d[s.writeSource] === v) at = s.writeSource - 1; },
  };
  s.trackSources(true);
  s.joy1 = 0;
  let n = 0;
  try {
    for (; n < LOOK_FRAMES && at < 0 && w[RAM.gameMode] === GM.title; n++) { frame = []; s.runFrame(); }
  } finally {
    s.trackSources(false);
    s.hook = hook;
  }
  if (at < 0) return null;
  // the instructions that read the first pair
  const reads = [...new Set(frame.filter((r) => r.o === at || r.o === at + 1).map((r) => r.pc))];
  // that the byte before the frames is the pair's buttons is tried: with another button there, the game holds that
  // (a game that reads the table's frames but no buttons plays no table: No Title Screen Movement)
  const v = d[at], other = v ^ MOVE.right;
  d[at] = other;
  try {
    s.loadState(emu.bootState());
    for (let f = 0; f < n; f++) s.runFrame();
    if (w[RAM.padHeld] !== (other & ~MOVE.yPress)) return null;
  } finally { d[at] = v; }
  const pairs: MovePair[] = [];
  for (let o = at; d[o] !== END; o += 2) {
    if (pairs.length >= MAX_TABLE || o + 2 >= d.length) return null;
    pairs.push([d[o], pairFrames(d[o + 1])]);
  }
  return { at, pairs, frames: pairs.reduce((n, p) => n + p[1], 0), capacity: pairs.length, reads };
}

// how a run of the title screen ended: at the table's end (the game fades out and loads the title screen again),
// with Mario dying, with the level left another way, or not within the frames run
export type MovementEnd = 'table' | 'died' | 'left' | 'none';

export interface MovementRun {
  frames: number; // the frames run on the title screen
  x: Int16Array; y: Int16Array; // Mario's position after each
  end: MovementEnd;
  states: { frame: number; state: SnesState }[]; // the machine before some of the frames, the first before frame 0
}

class Trace {
  x: number[] = [];
  y: number[] = [];
  end: MovementEnd | null = null;
  // after a frame run from the title screen: `tableEnd`, the frame at which the table ends (-1: not known)
  after(w: Uint8Array, tableEnd: number): MovementEnd | null {
    if (w[RAM.gameMode] !== GM.title) return this.end = tableEnd >= 0 && this.x.length >= tableEnd ? 'table' : 'left';
    this.x.push(marioX(w));
    this.y.push(marioY(w));
    return this.end = w[RAM.marioAnim] === MARIO_DYING ? 'died' : null;
  }
}

// The title screen run as the game plays it: Mario's way. The emulator's machine is left in the last state run.
export function runMovement(emu: LevelEmulator, mv: TitleMovement): MovementRun {
  const s = emu.snes, w = s.wram, hook = s.hook, t = new Trace(), states: MovementRun['states'] = [];
  const every = Math.max(RUN_EVERY, Math.ceil((mv.frames + 1) / RUN_STATES));
  s.loadState(emu.bootState());
  s.hook = null;
  s.joy1 = 0;
  try {
    for (let f = 0; f <= mv.frames && !t.end; f++) {
      if (f % every === 0) states.push({ frame: f, state: s.saveState() });
      s.runFrame();
      t.after(w, mv.frames);
    }
  } finally { s.hook = hook; }
  return { frames: t.x.length, x: Int16Array.from(t.x), y: Int16Array.from(t.y), end: t.end ?? 'none', states };
}

// the machine before frame `frame` of a run (the last: after its last frame). The emulator's machine is left there.
export function runState(emu: LevelEmulator, run: MovementRun, frame: number): SnesState {
  const s = emu.snes, hook = s.hook, f = Math.max(0, Math.min(frame, run.frames));
  let from = run.states[0];
  for (const k of run.states) if (k.frame <= f) from = k;
  s.loadState(from.state);
  s.hook = null;
  s.joy1 = 0;
  try { for (let i = from.frame; i < f; i++) s.runFrame(); } finally { s.hook = hook; }
  return s.saveState();
}

// The movement and its run, kept per emulator while the ROM bytes the game read for them are as they were.
const kept = new WeakMap<LevelEmulator, { gen: number; reads: RomReads; movement: TitleMovement | null; run: MovementRun | null }>();
export function titleMovement(emu: LevelEmulator): { movement: TitleMovement | null; run: MovementRun | null } {
  const had = kept.get(emu);
  if (had && holds(emu.rom, had)) return had;
  emu.ensureBoot();
  const r = emu.recordAll(() => {
    const movement = learnMovement(emu);
    return { movement, run: movement ? runMovement(emu, movement) : null };
  });
  const k = { gen: r.gen, reads: r.reads, ...r.result };
  kept.set(emu, k);
  return k;
}

// The title screen run on a machine of its own, frame by frame, with its picture: played as the table has it, or
// recorded – the buttons of each frame fed to the game through the table (see above).
export class TitleSession {
  readonly recording: boolean;
  readonly ppu: PPU;
  readonly buttons: number[] = []; // recording: the button byte of each frame
  private s: Snes;
  private mv: TitleMovement;
  private trace = new Trace();
  private pad = 0;
  private first: number;

  // from: played from a frame of the run on (runState's machine before it)
  constructor(emu: LevelEmulator, mv: TitleMovement, recording: boolean, from?: { frame: number; state: SnesState }) {
    this.recording = recording;
    this.mv = mv;
    this.first = from?.frame ?? 0;
    this.s = new Snes(recording ? emu.rom.data.slice() : emu.rom.data);
    this.s.overlay = emu.overlay;
    this.s.loadState(from?.state ?? emu.bootState());
    this.ppu = new PPU(this.s);
    this.s.ppu = this.ppu;
  }

  // the frames run (played from a frame on: counted from the run's start), Mario's position after each run here, how
  // it ended (null: it goes on)
  get frames(): number { return this.first + this.trace.x.length; }
  get x(): readonly number[] { return this.trace.x; }
  get y(): readonly number[] { return this.trace.y; }
  get end(): MovementEnd | null { return this.trace.end; }
  // recording: the pairs so far
  get pairs(): MovePair[] { return movePairs(this.buttons); }

  // One frame, recording with the joypad (PAD bits) held; false: the run has ended (nothing was run).
  frame(pad = 0): boolean {
    const s = this.s, w = s.wram;
    if (this.trace.end) return false;
    if (this.recording) {
      if (this.buttons.length >= MAX_RECORD_FRAMES) { this.trace.end = 'none'; return false; }
      const b = moveOfPad(pad, this.pad);
      this.pad = pad;
      // the table's first pair is this frame's buttons, and the game is at the table's start
      s.rom[this.mv.at] = b;
      s.rom[this.mv.at + 1] = 1;
      w[RAM.titleMoveIndex] = 0;
      w[RAM.titleMoveTimer] = 1;
      this.buttons.push(b);
    }
    s.joy1 = 0;
    s.runFrame();
    this.trace.after(w, this.recording ? -1 : this.mv.frames - this.first);
    // (a frame that began the death or left the level is not of the recording: its buttons led nowhere)
    if (this.recording && this.trace.end === 'left') this.buttons.pop();
    return true;
  }

  // the run so far as a run without states (a recording's: what the table written from it is to play)
  run(): MovementRun {
    const end = this.trace.end;
    return { frames: this.trace.x.length, x: Int16Array.from(this.trace.x), y: Int16Array.from(this.trace.y), end: end === 'died' || end === 'left' ? end : 'table', states: [] };
  }
}

// Writes the movement of the buttons of every frame (a recording's) into the game's table, in place: the pairs the
// table holds there. Throws when it has more pairs than that.
export function writeMovement(rom: Rom, mv: TitleMovement, frames: ArrayLike<number>): void {
  if (!frames.length) throw new Error('A recording of no frames');
  rom.writeAt(mv.at, tableBytes(fitPairs(movePairs(frames), mv.capacity)));
}

// the table's place, for the user
export const movementPlace = (mv: TitleMovement): string => {
  const a = mv.at < 0x80000 ? pcToSnes(mv.at) & 0x7fffff : pcToSnes(mv.at); // (the game's own banks as the community names them)
  return `$${(a >> 16).toString(16).toUpperCase().padStart(2, '0')}:${(a & 0xffff).toString(16).toUpperCase().padStart(4, '0')}`;
};
