// A play session (CONTEXT.md): a level played in the emulator from gameplay on, frame by frame with the
// buttons held, until Mario dies, the level is left or the caller stops. It loads the level (on its own, or
// within a game in progress as a player gets there), waits until it is ready, holds the machine's memory hook
// for the watchers registered with it, and puts the buttons back when a run of frames is over.

import type { Snes, SnesState, MemHook } from './snes.ts';
import { joinHooks } from './snes.ts';
import { PPU } from './ppu.ts';
import { LevelEmulator, type LevelOverride, type LevelRender } from './levelemu.ts';
import { levelTranslevel } from './level.ts';
import { GM, RAM, MARIO_DYING, PAD } from './ram.ts';
import { cpuLoad } from './playlog.ts';

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

export class PlaySession {
  readonly emu: LevelEmulator;
  // the load (null: started from the overworld or a savestate)
  readonly render: LevelRender | null;
  private readonly s: Snes;
  private watchers: Watcher[] = [];
  private ready_: boolean;

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

  // a new game with Mario on the overworld on layer 1 tile i (overworld.ts l1Index order); enter() plays the level there
  static overworld(emu: LevelEmulator, i: number): PlaySession {
    emu.startGameAt(i);
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
    const mode = this.s.wram[RAM.gameMode];
    this.s.joy1 = pad;
    this.s.runFrame();
    return cpuLoad(this.s.busyLines, mode, this.s.wram[RAM.gameMode]);
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
  load(state: SnesState): void {
    this.s.loadState(state);
    for (const w of this.watchers) w.reset();
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
