// A play session (CONTEXT.md): a level played in the emulator from gameplay on, frame by frame with the
// buttons held, until Mario dies, the level is left or the caller stops. It loads the level (on its own, or
// within a game in progress as a player gets there), waits until it is ready, holds the machine's memory hook
// for the watchers registered with it, and puts the buttons back when a run of frames is over.

import type { Snes, SnesState, MemHook } from './snes.ts';
import { joinHooks } from './snes.ts';
import { PPU } from './ppu.ts';
import { LevelEmulator, type LevelOverride, type LevelRender } from './levelemu.ts';
import { levelTranslevel, encodeSecondaryHeader, startHeader, entrancePos, mainSpot, type SecondaryHeader, type StartEntrance } from './level.ts';
import { eventBits, passedCount, type EventProgress } from './eventset.ts';
import type { ProgressSave } from './owprogress.ts';
import { GM, RAM, MARIO_DYING, PAD, marioX, marioY, setMarioPos } from './ram.ts';
import { cpuLoad } from './playlog.ts';
import { RewindRing, REWIND_EVERY, REWIND_STATES } from './rewind.ts';

// frames from the load (the level faded in) until gameplay, or until Mario has settled; more: the level hangs
export const READY_FRAMES = 300;
// frames the game takes to load a level it enters itself (from the overworld, through a pipe), fade-in included
const LOAD_FRAMES = 600;
// frames until the overworld or the next level after the level was left (the overworld's events run on)
const FOLLOW_FRAMES = 2000;

// gameplay: the level's game mode runs (Mario may still walk or come out of a pipe); settled: also Mario
// standing on his own and the sprites running
export type Ready = 'gameplay' | 'settled';
// why a run of frames ended before its count: Mario dying, or the level left (goal, exit, death's fade-out)
export type PlayEnd = 'died' | 'left';

// something that watches the running game through the memory hook (slotwatch.ts, deaths.ts)
export interface Watcher { readonly hook: MemHook; reset(): void }

export interface PlayStart {
  ov?: LevelOverride;
  until?: Ready; // default gameplay
  // within a game in progress (lives; dying or leaving returns to the overworld, entering from there sets up
  // the midway point): the level's translevel (default: as the game reaches the level); setup changes the
  // game's RAM on the overworld before the level is entered. A level the game can't enter so is loaded on its own.
  game?: { translevel?: number; setup?: (wram: Uint8Array) => void };
}

// test play of a level (the level editor's): within a game in progress, entered from its overworld tile
export interface TestStart {
  ov?: LevelOverride;
  // Mario's start tile (his feet stand in it) instead of the main entrance, with the camera start, options (face
  // left, water) and action of the entrance played from (a secondary entrance's; else the main entrance's without an
  // action); level: the level's secondary header, its last screen and its rows (entrances of a sized level, else 0)
  at?: { tx: number; ty: number; entrance?: StartEntrance; level: { secondary: SecondaryHeader; maxScreen: number; rows: number } };
  // a message box open once the level runs (messages.ts messageToShow); yoshi: Mario brings Yoshi along
  show?: { message: number; yoshi: boolean };
}

export class PlaySession {
  readonly emu: LevelEmulator;
  // the load (null: started from the overworld or a savestate)
  readonly render: LevelRender | null;
  private readonly s: Snes;
  private watchers: Watcher[] = [];
  private ready_: boolean;
  private frames_ = 0;
  // the states kept to rewind to (keepRewind), each with its frame
  private rewind_: { every: number; ring: RewindRing<{ frame: number; state: SnesState }> } | null = null;

  private constructor(emu: LevelEmulator, render: LevelRender | null, ready: boolean) {
    this.emu = emu;
    this.s = emu.snes;
    this.render = render;
    this.ready_ = ready;
  }

  // level n loaded and played until ready (see ready)
  static start(emu: LevelEmulator, n: number, opt: PlayStart = {}): PlaySession {
    let r: LevelRender;
    if (opt.game) {
      const tl = opt.game.translevel ?? levelTranslevel(emu.rom, n);
      try {
        emu.startGame(tl);
        opt.game.setup?.(emu.snes.wram);
        r = emu.loadInGame(n, tl, opt.ov);
      } catch {
        r = emu.load(n, { ...opt.ov, translevel: tl });
      }
    } else r = emu.load(n, opt.ov);
    const p = new PlaySession(emu, r, false);
    p.ready_ = r.ok && p.until(opt.until ?? 'gameplay');
    return p;
  }

  // test play of level n (TestStart): a game in progress (lives, the overworld with Mario on the level's tile,
  // entered from there so that the midway point counts – dying returns there). The start tile: the nearest main
  // entrance setting loads the level around it (camera, tilemap; FG and BG start as set), in gameplay Mario is then
  // moved to the exact pixel – with an entrance action by how far the setting is from it, keeping where the action
  // put him (in the pipe, shot out of it)
  static test(emu: LevelEmulator, n: number, opt: TestStart = {}): PlaySession {
    const ov = { ...opt.ov }, at = opt.at, show = opt.show;
    const start = at && { x: at.tx * 16, y: at.ty * 16 - 16 };
    let move: { x: number; y: number } | undefined;
    if (at && start) {
      const sec = startHeader(emu.rom, at.level.secondary, start.x, start.y, at.level.maxScreen, at.level.rows, at.entrance);
      const p = entrancePos(emu.rom, mainSpot(sec), (sec.verticalPositioning & 1) !== 0);
      if (sec.entranceAction) move = { x: start.x - p.x, y: start.y - p.y };
      ov.secondaryHeader = encodeSecondaryHeader(sec);
    }
    const p = PlaySession.start(emu, n, { ov, game: { setup: show?.yoshi ? (w) => { w[RAM.yoshiCarried] = 1; } : undefined } });
    if (show && p.ready) p.wram[RAM.message] = show.message;
    if (start && p.ready) {
      const w = p.wram;
      if (move) setMarioPos(w, marioX(w) + move.x, marioY(w) + move.y);
      else setMarioPos(w, start.x, start.y);
    }
    return p;
  }

  // a new game with Mario on the overworld on layer 1 tile i (overworld.ts l1Index order); enter() plays the level there
  static overworld(emu: LevelEmulator, i: number): PlaySession {
    emu.startGameAt(i);
    return new PlaySession(emu, null, false);
  }

  // test play from the overworld: a new game at event progress `progress` (events 0 … progress-1 passed or any set,
  // eventset.ts, as the overworld view shows it) with the save learned for it (owprogress.ts progressSaveJob: the level
  // flags, switch palaces and events triggered; none: a new file's), Mario on layer 1 tile i (< 0: at the start
  // position), the overworld loaded where he stands. Levels entered from there load from the ROM as the game does
  static fromOverworld(emu: LevelEmulator, i: number, progress: EventProgress = 0, save?: ProgressSave): PlaySession {
    const events = passedCount(progress) > 0 ? eventBits(progress) : undefined;
    emu.startGameAt(i, events);
    const w = emu.snes.wram;
    if (save) {
      w.set(save.levelFlags, RAM.levelFlags);
      w.set(save.switchPalaces, RAM.switchPalaces);
      w[RAM.eventsTriggered] = save.eventsTriggered;
    }
    emu.reloadOverworld(events);
    return new PlaySession(emu, null, false);
  }

  // the game where the emulator is (to go on from a savestate: load it)
  static resume(emu: LevelEmulator): PlaySession {
    return new PlaySession(emu, null, true);
  }

  // whether the level got ready (the load worked, gameplay or the settled state reached in time)
  get ready(): boolean { return this.ready_; }
  get wram(): Uint8Array { return this.s.wram; }
  get mode(): number { return this.s.wram[RAM.gameMode]; }
  // the samples of the latest frame, with a sound unit (stereo, 32 kHz)
  get audio(): Int16Array | null { return this.s.audio; }
  get hasSound(): boolean { return this.s.apu !== null; }
  // frames played by frame() (play, follow and enter too); a rewind sets it back
  get frames(): number { return this.frames_; }

  // runs frames until the game is in the state; false when it doesn't get there in time (the level hangs or ended)
  until(state: Ready, limit = READY_FRAMES): boolean {
    const w = this.s.wram;
    const there = () => w[RAM.gameMode] === GM.level && (state === 'gameplay' || (w[RAM.marioAnim] === 0 && !w[RAM.spritesLocked]));
    try {
      for (let f = 0; f < limit && !there(); f++) this.s.runFrame();
    } catch { return false; } // (the emulated game crashed)
    return state === 'settled' ? w[RAM.gameMode] === GM.level : there();
  }

  // one frame with the buttons (PAD bits) held; the CPU's load of the frame (playlog.ts cpuLoad)
  frame(pad = 0): number {
    const modeBefore = this.s.wram[RAM.gameMode];
    this.s.joy1 = pad;
    this.s.runFrame();
    this.frames_++;
    const r = this.rewind_;
    if (r && this.frames_ % r.every === 0) r.ring.push({ frame: this.frames_, state: this.s.saveState() });
    return cpuLoad(this.s.busyLines, modeBefore, this.s.wram[RAM.gameMode]);
  }

  // up to n frames with the buttons held (or per frame), each called before a frame; ends early when Mario dies (he
  // wasn't dying when it began) or the level is left: why (null: all n frames played). The buttons are released afterwards.
  play(n: number, pad: number | ((f: number) => number) = 0, each?: (f: number) => void): PlayEnd | null {
    const w = this.s.wram;
    const dying = w[RAM.marioAnim] === MARIO_DYING;
    try {
      for (let f = 0; f < n; f++) {
        each?.(f);
        this.frame(typeof pad === 'number' ? pad : pad(f));
        if (w[RAM.gameMode] !== GM.level) return 'left';
        if (!dying && w[RAM.marioAnim] === MARIO_DYING) return 'died';
      }
      return null;
    } finally { this.s.joy1 = 0; }
  }

  // after the level was left (or while it is being left): frames until the game is in a level's gameplay again or
  // on the overworld; which (null: neither in time)
  follow(pad = 0): 'level' | 'overworld' | null {
    const w = this.s.wram;
    let left = w[RAM.gameMode] !== GM.level;
    try {
      for (let f = 0; f < FOLLOW_FRAMES; f++) {
        this.frame(pad);
        const m = w[RAM.gameMode];
        if (m === GM.overworld) return 'overworld';
        if (m !== GM.level) left = true;
        else if (left) return 'level';
      }
      return null;
    } finally { this.s.joy1 = 0; }
  }

  // on the overworld: enters the level Mario stands on (A pressed again and again), until gameplay; whether it got there
  enter(until: Ready = 'gameplay'): boolean {
    const w = this.s.wram;
    for (let f = 0; f < 400 && w[RAM.gameMode] !== GM.levelLoad; f++) this.frame(f % 8 < 2 ? PAD.a : 0);
    this.s.joy1 = 0;
    this.ready_ = w[RAM.gameMode] === GM.levelLoad && this.until(until, LOAD_FRAMES + READY_FRAMES);
    return this.ready_;
  }

  // a watcher from here on (made for this machine); reset after each savestate loaded
  watch<W extends Watcher>(make: (s: Snes) => W): W {
    const w = make(this.s);
    this.watchers.push(w);
    this.hook();
    return w;
  }

  save(): SnesState { return this.s.saveState(); }
  // a savestate loaded: the states kept to rewind to are dropped (they lead elsewhere), the frames count on
  load(state: SnesState): void {
    this.s.loadState(state);
    this.rewind_?.ring.clear();
    for (const w of this.watchers) w.reset();
  }

  // from here on a state kept every `every` frames, the newest `states` (rewind.ts)
  keepRewind(every = REWIND_EVERY, states = REWIND_STATES): void {
    this.rewind_ = { every, ring: new RewindRing(states) };
  }

  // one step back: the newest kept state from before the current frame loaded, the watchers reset; the frame gone
  // back to (frames). null: none kept from before it (the oldest stays, to step back to again after playing on)
  rewind(): number | null {
    const ring = this.rewind_?.ring;
    if (!ring) return null;
    // (none is newer than the current frame: stepping back pops them, a savestate loaded clears them)
    const atNow = ring.newest()?.frame === this.frames_;
    const to = ring.at(atNow ? 1 : 0);
    if (!to) return null;
    if (atNow) ring.pop();
    this.s.loadState(to.state);
    this.frames_ = to.frame;
    for (const w of this.watchers) w.reset();
    return to.frame;
  }

  // a PPU from here on, drawing what is on screen; what is on screen is then part of a savestate
  attachPPU(): PPU {
    const ppu = new PPU(this.s);
    this.s.ppu = ppu;
    return ppu;
  }

  // the machine's hook and PPU given back, the buttons released
  close(): void {
    this.watchers = [];
    this.s.hook = null;
    this.s.ppu = null;
    this.s.joy1 = 0;
  }

  // no watcher: no hook (the machine reads ROM the fast way without one)
  private hook(): void {
    const hs = this.watchers.map((w) => w.hook);
    this.s.hook = hs.length === 0 ? null : hs.length === 1 ? hs[0] : joinHooks(...hs);
  }
}
