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
//
// The sync check: a change to the title screen level, its sprites, blocks or code after recording moves the movement
// out of sync – the buttons stay, Mario's way doesn't. Lunar Magic only warns of it in its help. Here the run as
// recorded (Mario's position after every frame, how it ended) is written with a recording, as the editor's own block
// in the ROM ("SMWT", the game reads none of it), and the run as the game plays it now is compared with it: the first
// frame Mario is elsewhere, or the frame one run ends and the other goes on. A movement without such a block (the
// clean game's) is compared with its run as the editor first saw it for the ROM opened.
//
// A recording of more pairs than the game's table holds (34 in the clean game) needs the table elsewhere, and the
// game's three reads of it are 16-bit addresses in bank 0. The editor's patch (TITLE_MOVE_ASM, installed when a
// recording first needs it, applied anew with every recording after) keeps the game's format – pairs of buttons and
// frames, $FF – in free space, read by a routine there; the game's place in the table ($1DF4) then counts pairs, not
// bytes: 254 pairs. It is installed only where the reads found by emulation are the clean game's code. Beside the
// community's patches of this place – No Title Screen Movement ($009C82), Playable Title Screen ($009C67), Multiple
// Title Screen Demos ($009C6C), Lunar Magic's playback ($009C6F): they change the code the patch hooks, so the
// patch registry refuses them while it is installed; removeMovementPatch takes it out again (the title screen page
// offers it), and the page says what plays the title screen where it is no table (titlePlays). (The bytes are laid
// out so that No Title Screen Movement's edit, written over the patch by other means, does what it does to the game.)

import type { LevelEmulator } from './levelemu.ts';
import type { Rom } from './rom.ts';
import { pcToSnes, snesToPc } from './rom.ts';
import { applyPatch, reapplyPatch, uninstallPatch, type PatchSource } from './patchapply.ts';
import { listPatches, type PatchEntry } from './patchreg.ts';
import { asarReady } from './asar.ts';
import { Snes, type SnesState } from './snes.ts';
import { PPU } from './ppu.ts';
import { GM, RAM, PAD, MARIO_DYING, marioX, marioY } from './ram.ts';
import { holds, type RomReads } from './romdeps.ts';
import { deflateSync, inflateSync } from 'fflate';

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
  capacity: number; // the pairs the table holds where it is (the editor's patch installed: as many as it plays)
  patched: boolean; // the table is the editor's patch's, in free space
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
  if (pairs.length > n) throw new Error(`${pairs.length} pairs don't fit a table of ${n}`);
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
  const patched = movementPatch(emu.rom) !== null;
  return { at, pairs, frames: pairs.reduce((n, p) => n + p[1], 0), capacity: patched ? PATCH_PAIRS : pairs.length, patched, reads };
}

// What plays the title screen level: the game's table ('table'), the player (the joypad is passed on: Playable
// Title Screen), nothing (no button is ever held: No Title Screen Movement), or something else the editor doesn't
// read (several tables, another format: Multiple Title Screen Demos, Lunar Magic's playback). By what the game does.
export type TitlePlays = 'table' | 'player' | 'none' | 'other';
const PLAY_FRAMES = 120; // frames looked at for a button held
export function titlePlays(emu: LevelEmulator, mv: TitleMovement | null = learnMovement(emu)): TitlePlays {
  if (mv) return 'table';
  const s = emu.snes, w = s.wram, hook = s.hook;
  s.hook = null;
  try {
    const held = (pad: number) => {
      let any = 0;
      s.loadState(emu.bootState());
      for (let f = 0; f < PLAY_FRAMES && w[RAM.gameMode] === GM.title; f++) { s.joy1 = pad; s.runFrame(); any |= w[RAM.padHeld]; }
      s.joy1 = 0;
      return any;
    };
    const alone = held(0);
    if (alone) return 'other';
    return held(PAD.right) & MOVE.right ? 'player' : 'none';
  } finally { s.hook = hook; s.joy1 = 0; }
}


// how a run of the title screen ended: at the table's end (the game fades out and loads the title screen again),
// with Mario dying, with the level left another way, or not within the frames run
export type MovementEnd = 'table' | 'died' | 'left' | 'none';

// Mario's way: his position after each frame run on the title screen, and how the run ended
export interface MovementTrace { x: Int16Array; y: Int16Array; end: MovementEnd }
export interface MovementRun extends MovementTrace {
  frames: number; // the frames run on the title screen
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
// With the title screen picture as booted: a run is kept when the picture is painted (titleMovement: a full
// picture), so the boot snapshot puts the picture back where the run left layer 3's tilemap as its first machine has it.
export function runState(emu: LevelEmulator, run: MovementRun, frame: number): SnesState {
  const boot = emu.bootSnapshot(), first = run.states[0].state.vram as Uint8Array;
  const s = emu.snes, hook = s.hook, f = Math.max(0, Math.min(frame, run.frames));
  let from = run.states[0];
  for (const k of run.states) if (k.frame <= f) from = k;
  s.loadState(from.state);
  s.hook = null;
  s.joy1 = 0;
  try { for (let i = from.frame; i < f; i++) s.runFrame(); } finally { s.hook = hook; }
  boot.putPictureBack(s.vram, first);
  return s.saveState();
}

// The movement and its run, kept per emulator while the ROM bytes the game read for them are as they were.
const kept = new WeakMap<LevelEmulator, { gen: number; reads: RomReads; movement: TitleMovement | null; run: MovementRun | null; plays: TitlePlays }>();
export function titleMovement(emu: LevelEmulator): { movement: TitleMovement | null; run: MovementRun | null; plays: TitlePlays } {
  const had = kept.get(emu);
  if (had && holds(emu.rom, had)) return had;
  emu.ensureBoot();
  // (a full picture, not the title screen: Mario's way doesn't show its picture, and runState gives a machine the picture)
  const r = emu.record('full picture', () => {
    const movement = learnMovement(emu);
    return { movement, run: movement ? runMovement(emu, movement) : null, plays: titlePlays(emu, movement) };
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

// ---- the table in free space ----
export const TITLE_MOVE_PATCH_NAME = 'Title screen movement table';
export const PATCH_PAIRS = 254; // the pairs the patch's table holds: the game's place in it is a byte, the end one of them
const hx = (v: number, d = 4) => v.toString(16).toUpperCase().padStart(d, '0');

// the clean game's code that plays the table (LDX index … STA $16, before its JMP to the level's frame), the table
// at SNES address `table`: what the patch's hooks expect
const gameCode = (table: number): number[] => {
  const i = RAM.titleMoveIndex, t = RAM.titleMoveTimer, w = (a: number) => [a & 0xff, (a >> 8) & 0xff];
  return [0xae, ...w(i), 0xce, ...w(t), 0xd0, 0x0b, 0xbd, ...w(table + 1), 0x8d, ...w(t), 0xe8, 0xe8, 0x8e, ...w(i), 0xbd, ...w(table - 2), 0xc9, 0xff, 0xd0, 0x06,
    0xa0, GM.titleFadeOut, 0x8c, ...w(RAM.gameMode), 0x60, 0x29, 0xdf, 0x85, RAM.padHeld, 0xdd, ...w(table - 2), 0xd0, 0x02, 0x29, 0x9f, 0x85, RAM.padHeld + 1];
};
const CODE = 0x009c6f, READS = [0x009c77, 0x009c82, 0x009c93]; // that code and its three reads of the table, in the clean game

const titleMoveAsm = (pairs: readonly MovePair[]): string => {
  const b = tableBytes(pairs), rows: string[] = [];
  for (let i = 0; i < b.length; i += 16) rows.push(`  db ${Array.from(b.subarray(i, i + 16), (v) => `$${hx(v, 2)}`).join(',')}`);
  return `asar 1.90
lorom
!Index = $${hx(RAM.titleMoveIndex)}   ; the game's place in the table: here the pair after the one played, not a byte offset
!Timer = $${hx(RAM.titleMoveTimer)}   ; the frames left of the pair played

org $${hx(CODE, 6)}   ; LDX !Index : DEC !Timer : BNE … (A, X/Y 8)
  JSL Move        ; A = the pair's buttons, V set: with Y newly pressed (the Select bit)
  BRA Buttons
org $${hx(READS[1], 6)}   ; LDA Table-2,x
Buttons:
  NOP #3          ; (No Title Screen Movement writes NOP : LDA #$00 here: it still works)
org $${hx(READS[2], 6)}   ; CMP Table-2,x : BNE +
  NOP #3
  db $70,$02      ; BVS +: with the Select bit, Y stays in the pressed byte

freecode
Move:
  DEC !Timer
  BNE .same
  REP #$30
  LDA !Index : AND #$00FF : ASL : TAX
  SEP #$20
  LDA.l Table+1,x : STA !Timer
  INC !Index
  BRA .buttons
.same
  REP #$30
  LDA !Index : AND #$00FF : DEC : ASL : TAX
  SEP #$20
.buttons
  LDA.l Table,x
  SEP #$10
  CLV
  PHA
  AND #$20 : BEQ +
  SEP #$40
+ PLA
  RTL

Table:            ; pairs of buttons and frames, $FF; a byte the game reads past the end
${rows.join('\n')}
  db $00
`;
};
const patchSource = (pairs: readonly MovePair[]): PatchSource => ({ name: TITLE_MOVE_PATCH_NAME, main: 'titlemove.asm', files: new Map([['titlemove.asm', titleMoveAsm(pairs)]]), kind: 'titlemove' });

export function movementPatch(rom: Rom): PatchEntry | null {
  return listPatches(rom).find((p) => p.kind === 'titlemove') ?? null;
}

// The editor's patch removed: the game reads its own table again, as it was before the patch (a movement of the pairs
// that fit there). For a patch of the title screen's code, which the registry refuses beside this one.
export function removeMovementPatch(rom: Rom): void {
  const p = movementPatch(rom);
  if (!p) return;
  uninstallPatch(rom, p.id);
  writeTrace(rom, null);
}

// how a recording of the buttons of every frame is written: into the table where it is ('place'), with the editor's
// patch ('patch': Asar is needed, loadAsar) – or why it can't be
export function movementFit(rom: Rom, mv: TitleMovement, frames: ArrayLike<number>): { how: 'place' | 'patch' } | { how: 'none'; why: string } {
  const n = movePairs(frames).length;
  if (mv.patched) return n <= PATCH_PAIRS ? { how: 'patch' } : { how: 'none', why: tooMany(n, PATCH_PAIRS) };
  if (n <= mv.capacity) return { how: 'place' };
  if (n > PATCH_PAIRS) return { how: 'none', why: `${tooMany(n, mv.capacity)}; with the table moved to free space it would hold ${PATCH_PAIRS}` };
  // the patch fits the clean game's code only: the reads found by emulation are its three, the code around them its own
  const code = gameCode(pcToSnes(mv.at) & 0xffff), at = snesToPc(CODE);
  const own = mv.at < 0x8000 && mv.reads.length === READS.length && READS.every((a) => mv.reads.some((r) => (r & 0x7fffff) === a)) && code.every((v, i) => rom.data[at + i] === v);
  return own ? { how: 'patch' } : { how: 'none', why: `${tooMany(n, mv.capacity)}, and the game reads its table with other code than its own (a patch's): the editor's table in free space does not fit it` };
}
const tooMany = (n: number, holds_: number) => `The recording has ${n} pairs of buttons and frames: ${n - holds_} more than the game's table holds (${holds_})`;

// Writes the movement of the buttons of every frame (a recording's): into the game's table in place where it fits
// (split to the pairs the table has there), else into the editor's patch's table in free space – the patch installed
// or applied anew (Asar loaded: loadAsar). Throws when it has more pairs than either holds, or the patch can't be
// applied. `trace`: the run as recorded, written with it for the sync check (none: the check compares with the run as
// the editor first sees it). How it was written.
export function writeMovement(rom: Rom, mv: TitleMovement, frames: ArrayLike<number>, trace?: MovementTrace): 'place' | 'patch' {
  if (!frames.length) throw new Error('A recording of no frames');
  const fit = movementFit(rom, mv, frames);
  if (fit.how === 'none') throw new Error(fit.why);
  let pairs = movePairs(frames);
  if (fit.how === 'place') {
    pairs = fitPairs(pairs, mv.capacity);
    rom.writeAt(mv.at, tableBytes(pairs));
  } else {
    if (!asarReady()) throw new Error('The assembler is not loaded');
    const had = movementPatch(rom), r = had ? reapplyPatch(rom, had.id, patchSource(pairs)) : applyPatch(rom, patchSource(pairs));
    if (!r.ok) throw new Error(`The title screen movement's table could not be moved to free space: ${r.errors.join(' ')}`);
  }
  // (a recording of fewer frames than the table's pairs was filled: its run is not the one recorded)
  writeTrace(rom, trace && pairs.reduce((n, p) => n + p[1], 0) === frames.length ? trace : null);
  return fit.how;
}

// ---- the sync check ----
const TRACE_MAGIC = [0x53, 0x4d, 0x57, 0x54]; // "SMWT"
const TRACE_VERSION = 1;
const ENDS: readonly MovementEnd[] = ['table', 'died', 'left', 'none'];

function findTrace(rom: Rom): number {
  for (const b of rom.scanRats()) {
    const p = b.start + 8;
    if (b.size > 6 && TRACE_MAGIC.every((m, i) => rom.data[p + i] === m)) return p;
  }
  return -1;
}

// the run as recorded, as the ROM has it (null: none written, or by a newer editor)
export function recordedTrace(rom: Rom): MovementTrace | null {
  const p = findTrace(rom);
  if (p < 0 || rom.data[p + 4] !== TRACE_VERSION) return null;
  const size = rom.isRatsAt(p - 8), end = ENDS[rom.data[p + 5]] ?? 'none';
  const d = inflateSync(rom.data.subarray(p + 6, p + size)), n = d.length >> 2, x = new Int16Array(n), y = new Int16Array(n);
  // (each frame: how far Mario moved since the frame before, X and Y as 16 bits)
  for (let f = 0, px = 0, py = 0; f < n; f++) {
    x[f] = px = (px + (d[f * 4] | (d[f * 4 + 1] << 8))) & 0xffff;
    y[f] = py = (py + (d[f * 4 + 2] | (d[f * 4 + 3] << 8))) & 0xffff;
  }
  return { x, y, end };
}

// the run as recorded written (the one written before freed; null: none)
function writeTrace(rom: Rom, t: MovementTrace | null): void {
  const old = findTrace(rom);
  if (old >= 0) rom.freeAt(pcToSnes(old));
  if (!t) return;
  const n = t.x.length, d = new Uint8Array(n * 4);
  for (let f = 0, px = 0, py = 0; f < n; f++) {
    const dx = (t.x[f] - px) & 0xffff, dy = (t.y[f] - py) & 0xffff;
    d.set([dx & 0xff, dx >> 8, dy & 0xff, dy >> 8], f * 4);
    px = t.x[f]; py = t.y[f];
  }
  const z = deflateSync(d, { level: 9 }), buf = new Uint8Array(z.length + 6);
  buf.set(TRACE_MAGIC);
  buf[4] = TRACE_VERSION;
  buf[5] = ENDS.indexOf(t.end);
  buf.set(z, 6);
  rom.allocWrite(buf);
}

// Where two runs part: the first frame Mario is elsewhere after, or – his way the same as far as both go – the frame
// the shorter one ends while the other goes on or ends another way. null: the same run.
export interface MovementDrift {
  frame: number;
  was: { x: number; y: number } | null; // Mario after that frame in the run compared with (null: it had ended)
  now: { x: number; y: number } | null; // … in the run as the game plays it now
  endWas: MovementEnd; endNow: MovementEnd; // how each run ends
  framesWas: number; framesNow: number;
}
export function compareRuns(was: MovementTrace, now: MovementTrace): MovementDrift | null {
  const a = was.x.length, b = now.x.length, n = Math.min(a, b);
  let f = 0;
  while (f < n && was.x[f] === now.x[f] && was.y[f] === now.y[f]) f++;
  if (f === n && a === b && was.end === now.end) return null;
  const at = (t: MovementTrace) => (f < t.x.length ? { x: t.x[f], y: t.y[f] } : null);
  return { frame: f, was: at(was), now: at(now), endWas: was.end, endNow: now.end, framesWas: a, framesNow: b };
}

// The run as the game plays it now against the run as recorded – or, for a movement the ROM has no recorded run of,
// against its run as the editor first saw it for this ROM (`since`: which). null: in sync, or no movement.
// (first seen: of the table as it is – another table without a recorded run, an undo's or the game's own after the
// patch was removed, is seen anew)
const firstSeen = new WeakMap<Rom, { table: string; trace: MovementTrace }>();
export function movementDrift(emu: LevelEmulator): (MovementDrift & { since: 'recorded' | 'opened' }) | null {
  const { movement: mv, run } = titleMovement(emu);
  if (!mv || !run) return null;
  const recorded = recordedTrace(emu.rom), table = `${mv.at}:${mv.pairs.join(' ')}`;
  if (!recorded && firstSeen.get(emu.rom)?.table !== table) firstSeen.set(emu.rom, { table, trace: { x: run.x, y: run.y, end: run.end } });
  const d = compareRuns(recorded ?? firstSeen.get(emu.rom)!.trace, run);
  return d && { ...d, since: recorded ? 'recorded' : 'opened' };
}

// the table's place, for the user
export const movementPlace = (mv: TitleMovement): string => {
  const a = mv.at < 0x80000 ? pcToSnes(mv.at) & 0x7fffff : pcToSnes(mv.at); // (the game's own banks as the community names them)
  return `$${(a >> 16).toString(16).toUpperCase().padStart(2, '0')}:${(a & 0xffff).toString(16).toUpperCase().padStart(4, '0')}`;
};
