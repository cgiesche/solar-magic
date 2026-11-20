// A drive (CONTEXT.md): the emulated game played by the editor, frame by frame, with the buttons a player would
// press – to a screen of the pre-game, a new file's first overworld, a save file loaded, the overworld of a game the
// editor starts. One place knows how that is done: a button is pressed anew every PRESS frames (the game takes a
// button when it is newly down), the title screen is left with Start and everything after it confirmed with A, a
// screen is there when the game mode stays, and a menu's cursor moves a choice per press. Which screen is wanted,
// how long to wait for it and what an emulated game that never gets there means is the caller's.
//
// A drive is a scope (drive, driveOn): what it changed of the machine besides the game's own state – the hook, the
// joypad, the tracking of sources – is as before when it ends, also when the emulated game threw. It swallows
// nothing: a step with a frame limit says whether the game got there.
//
// It logs its screen path: what it started from and the joypad of each frame, enough to play the same way again
// with something watching (replay). A drive on from the machine as it is (driveOn), or one whose step set RAM
// before a frame (Press.before), has no path: nothing says how to play it again.
//
// Below levelemu.ts: it knows the machine and the game's modes, no emulator and no ROM.

import type { Snes, SnesState, MemHook } from './snes.ts';
import { GM, RAM, PAD } from './ram.ts';

// What a drive starts from, and the joypad of each frame it ran.
export interface ScreenPath {
  from: SnesState | null; // the machine it started from (null: power-on)
  sram?: Uint8Array; // the save files the game finds (else: the machine's own, at power-on none)
  setup?: (wram: Uint8Array) => void; // what was set in its RAM before the first frame
  pad: number[];
}
export type DriveStart = Omit<ScreenPath, 'pad'>;

const PRESS = 16, HELD = 4; // a button pressed anew every PRESS frames, for HELD
const SETTLE_FRAMES = 600, SETTLED = 8; // until the game mode stays (this many frames)
export const BLINK = 32; // the frames looked at for what a screen shows most of the time (a cursor's blinking)
const SHOWN = 4; // of them in a row

// the button a player gets on with: Start on the title screen, A anywhere after it
const onward = (mode: number): number => (mode === GM.title ? PAD.start : PAD.a);

export interface Press {
  button?: number; // the button pressed (default: Start on the title screen, else A; 0: none, the frames only)
  before?: (mode: number) => void; // called before each frame; setting RAM in it leaves the drive without a path
  each?: (frame: number) => boolean | void; // called after each frame with its number; false ends the step
}

export class Drive {
  private s: Snes;
  private log: ScreenPath | null;
  // (made by drive and driveOn only)
  constructor(s: Snes, log: ScreenPath | null) { this.s = s; this.log = log; }
  get mode(): number { return this.s.wram[RAM.gameMode]; }
  // the way so far, to play again (replay)
  get path(): ScreenPath {
    if (!this.log) throw new Error('this drive has no screen path');
    return { ...this.log, pad: this.log.pad.slice() };
  }
  state(): SnesState { return this.s.saveState(); }

  // from here on `hook` watches (null: nothing does), until the drive ends
  watch(hook: MemHook | null): void { this.s.hook = hook; }
  // from here on every byte's source is tracked (Snes.trackSources, writeSource for the hook), until the drive ends
  sources(): void { this.s.trackSources(true); }

  frame(joy = 0): void {
    this.s.joy1 = joy;
    this.s.runFrame();
    this.s.joy1 = 0;
    this.log?.pad.push(joy);
  }
  frames(n: number): void { for (let i = 0; i < n; i++) this.frame(); }
  // a button newly pressed for one frame, and released
  tap(joy: number): void { this.frame(joy); this.frames(2); }
  // a menu's k-th choice taken: the cursor moved down to it, A
  choose(k: number): void { this.down(k); this.tap(PAD.a); }
  // a menu's cursor moved down by k choices
  down(k: number): void { for (let i = 0; i < k; i++) this.tap(PAD.down); }

  // Frames without a button until `there` (asked before each frame, with the game mode), at most `max`.
  // false: the game didn't get there.
  wait(there: (mode: number) => boolean, max: number): boolean { return this.press(there, max, { button: 0 }); }
  // Frames with a button pressed anew every PRESS frames until `there` (asked before each frame, with the game
  // mode), at most `max`. false: the game didn't get there, or `each` ended the step.
  press(there: (mode: number) => boolean, max: number, o: Press = {}): boolean {
    if (o.before) this.log = null;
    for (let f = 0; f < max; f++) {
      const m = this.mode;
      if (there(m)) return true;
      o.before?.(m);
      this.frame(f % PRESS < HELD ? o.button ?? onward(m) : 0);
      if (o.each?.(f) === false) return false;
    }
    return there(this.mode);
  }
  // frames until the game mode stays; false: it never did
  settle(): boolean {
    for (let f = 0, same = 0, last = -1; f < SETTLE_FRAMES; f++) {
      this.frame();
      same = this.mode === last ? same + 1 : 0;
      last = this.mode;
      if (same >= SETTLED) return true;
    }
    return false;
  }
  // What the screen shows most of the time (a blinking cursor: shown, not hidden – what the game does, not which
  // frames it blinks in): frames until it shows that, and goes on showing it for the frames a picture takes.
  shown(): void {
    const s = this.s, st = s.saveState(), seen: number[] = [], count = new Map<number, number>();
    for (let f = 0; f < BLINK + SHOWN; f++) {
      s.runFrame();
      const k = shownKey(s);
      seen.push(k);
      if (f < BLINK) count.set(k, (count.get(k) ?? 0) + 1);
    }
    const most = [...count].sort((a, b) => b[1] - a[1])[0][0];
    let n = seen.findIndex((_, i) => i < BLINK && seen.slice(i, i + SHOWN).every((k) => k === most));
    if (n < 0) n = seen.indexOf(most);
    s.loadState(st);
    this.frames(n + 1);
  }
}

// What is on the screen, as a number: the layers' tilemaps (where the PPU's registers $2107–$210A have them) and the
// sprites. Not the graphics: the game animates tiles under a menu, and writes into them in the player select.
export function shownKey(s: Snes): number {
  let h = 0;
  const add = (m: Uint8Array, from: number, to: number) => { for (let i = from; i < to; i++) h = (Math.imul(h, 31) + m[i & (m.length - 1)]) | 0; };
  for (let bg = 0; bg < 4; bg++) {
    const sc = s.ppuRegs[0x07 + bg], at = (sc & 0xfc) << 9; // (bytes)
    add(s.vram, at, at + [1, 2, 2, 4][sc & 3] * 0x800);
  }
  h = Math.imul(h, 31);
  for (let i = 0; i < s.oam.length; i++) h = (Math.imul(h, 31) + s.oam[i]) | 0;
  return h;
}

function scope<T>(s: Snes, d: Drive, fn: (d: Drive) => T): T {
  const hook = s.hook, tracked = s.taintOn;
  try { return fn(d); } finally {
    if (!tracked && s.taintOn) s.trackSources(false);
    s.hook = hook;
    s.joy1 = 0;
  }
}

// The game played from `start`; the machine is left where fn left it. The hook watching outside goes on watching
// until fn says otherwise (Drive.watch).
export function drive<T>(s: Snes, start: DriveStart, fn: (d: Drive) => T): T {
  return scope(s, new Drive(s, { ...start, pad: [] }), (d) => {
    if (start.from) s.loadState(start.from); else s.powerOn();
    s.joy1 = 0;
    if (start.sram) s.sram.set(start.sram.subarray(0, s.sram.length));
    start.setup?.(s.wram);
    return fn(d);
  });
}
// The game played on from the machine as it is (a drive without a path).
export function driveOn<T>(s: Snes, fn: (d: Drive) => T): T { return scope(s, new Drive(s, null), fn); }

// Plays `path` again, `hook` watching: what the game reads and writes on the way. The machine is left where the way
// ends. `sram`: other save files than the path's; `sources`: with every byte's source tracked; `frames`: this many
// frames run instead of the way's (past its end: no button held); `each`: called after every frame with its number,
// false ends the run.
export interface ReplayOptions { sram?: Uint8Array; sources?: boolean; frames?: number; each?: (frame: number) => boolean | void }
export function replay(s: Snes, path: ScreenPath, hook: MemHook | null = null, o: ReplayOptions = {}): void {
  drive(s, { from: path.from, sram: o.sram ?? path.sram, setup: path.setup }, (d) => {
    d.watch(hook);
    if (o.sources) d.sources();
    const n = o.frames ?? path.pad.length;
    for (let f = 0; f < n; f++) {
      d.frame(path.pad[f] ?? 0);
      if (o.each?.(f) === false) break;
    }
  });
}
