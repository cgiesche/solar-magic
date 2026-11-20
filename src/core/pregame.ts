// The game's screens and menus that belong to no level, reached by emulation (CONTEXT.md: pre-game, menu): the
// pre-game's – Nintendo Presents, the title screen, file select, file erase, player select – and the overworld's two
// prompts, the save prompt and the game over prompt. Each is a state the emulated game gets into by what a player
// does: nothing (Nintendo Presents from power-on, the title screen), a button (file select), a choice of a menu
// (file erase, player select: every choice is tried, the game mode it leads to says which screen it is), walking a
// tile on the overworld with the save prompt asked for, a game over's flag on the overworld. A screen the game
// doesn't get into (a patch removed it: One File, One Player; No Title, No Intro, No Problems) is not among them.
// Nothing here knows where a screen's data is or what draws it: the picture is the game's own (docs/research/
// pre-game-screens.md, 5.1).

import type { LevelEmulator } from './levelemu.ts';
import type { Snes, SnesState, MemHook } from './snes.ts';
import { drive, replay, shownKey, Drive, type DriveStart, type ScreenPath, type ReplayOptions } from './drive.ts';
export type { ScreenPath, ReplayOptions } from './drive.ts';
import { PPU } from './ppu.ts';
import { GM, RAM, PAD } from './ram.ts';
import { L3_MAP_VRAM, layer3CharBase } from './layer3map.ts';
import { holds, type RomReads } from './romdeps.ts';
import type { BootSnapshot } from './bootsnapshot.ts';

export type GameScreenId = 'presents' | 'title' | 'fileSelect' | 'fileErase' | 'playerSelect' | 'savePrompt' | 'gameOverPrompt';

export interface GameScreenKind {
  id: GameScreenId;
  name: string;
  about: string; // what it is, for the user
  pregame: boolean; // of the pre-game (else: a prompt of the overworld)
  menu: boolean; // a menu: text on layer 3 with a cursor
}
// in the order the game shows them
export const GAME_SCREENS: readonly GameScreenKind[] = [
  { id: 'presents', name: 'Nintendo Presents', about: 'The logo at power-on', pregame: true, menu: false },
  { id: 'title', name: 'Title screen', about: 'The title screen: its level with the title screen movement, and its layer 3 – the logo, the frame and the copyright line', pregame: true, menu: false },
  { id: 'fileSelect', name: 'File select', about: 'The menu that chooses the save file, each with its exit count', pregame: true, menu: true },
  { id: 'fileErase', name: 'File erase', about: 'The menu that erases a save file ("ERASE DATA" in the file select)', pregame: true, menu: true },
  { id: 'playerSelect', name: 'Player select', about: 'The menu that chooses a 1 or 2 player game', pregame: true, menu: true },
  { id: 'savePrompt', name: 'Save prompt', about: 'The overworld\'s menu after a level that saves: continue and save, or continue without', pregame: false, menu: true },
  { id: 'gameOverPrompt', name: 'Game over prompt', about: 'The overworld\'s menu after a game over: continue or end', pregame: false, menu: true },
];
export const gameScreenKind = (id: GameScreenId): GameScreenKind => GAME_SCREENS.find((k) => k.id === id)!;

export interface ReachedScreen {
  id: GameScreenId;
  state: SnesState; // the machine showing it (a menu: with its cursor shown, on its first choice)
  mode: number; // the game mode it runs in
  path: ScreenPath | null; // null: the title screen, which is the emulator's boot (LevelEmulator.bootState)
}

const DIRECTIONS = [PAD.right, PAD.left, PAD.down, PAD.up];
const PRESENTS_FRAMES = 600; // from power-on, while the game is before its title screen
const LEAVE_FRAMES = 120; // a button pressed until the game mode changes
export const MAX_CHOICES = 8; // a menu's choices tried (the cursor moved down this often at most)
const WALK_FRAMES = 240; // Mario walking to the next tile of the overworld
const PROMPT_FRAMES = 64; // a prompt opening

const MENU_MODES = new Map<number, GameScreenId>([[GM.fileSelect, 'fileSelect'], [GM.fileErase, 'fileErase'], [GM.playerSelect, 'playerSelect']]);

const reached = (d: Drive, id: GameScreenId): ReachedScreen => ({ id, state: d.state(), mode: d.mode, path: d.path });

// the screen's brightness (the PPU's INIDISP as the game set it): 0 dark or blanked … 15
const brightness = (s: Snes) => (s.ppuRegs[0x00] & 0x80 ? 0 : s.ppuRegs[0x00] & 0x0f);

// The screens the game gets into, in the game's order. The emulator's machine is left in the last state run (every
// entry of the emulator starts from its own snapshot).
export function reachScreens(emu: LevelEmulator): ReachedScreen[] {
  const s = emu.snes, w = s.wram, out = new Map<GameScreenId, ReachedScreen>();
  // every drive of this: nothing watching
  const from = <T>(start: DriveStart, fn: (d: Drive) => T): T => drive(s, start, (d) => { d.watch(null); return fn(d); });
  // Nintendo Presents: from power-on, the brightest frame the game shows before its title screen loads
  from({ from: null }, (d) => {
    let best = 0, at: ReachedScreen | null = null;
    for (let f = 0; f < PRESENTS_FRAMES && d.mode <= GM.presents; f++) {
      d.frame();
      if (d.mode <= GM.presents && brightness(s) > best) { best = brightness(s); at = reached(d, 'presents'); }
    }
    if (at) out.set('presents', at);
  });
  // the title screen: the boot
  let boot: SnesState;
  try { boot = emu.bootState(); } catch { return [...out.values()]; }
  out.set('title', { id: 'title', state: boot, mode: GM.title, path: null });
  // the menus: a button on the title screen, then every choice of each menu found
  {
    const todo: ReachedScreen[] = [], missing = () => [...MENU_MODES.values()].some((id) => !out.has(id));
    const found = (d: Drive) => {
      const id = d.settle() ? MENU_MODES.get(d.mode) : undefined;
      if (!id || out.has(id)) return;
      d.shown();
      const r = reached(d, id);
      out.set(id, r);
      todo.push(r);
    };
    from({ from: boot }, (d) => { if (d.press((m) => m !== GM.title, LEAVE_FRAMES)) found(d); });
    for (let menu = todo.shift(); menu && missing(); menu = todo.shift()) {
      for (let k = 0; k < MAX_CHOICES && missing(); k++) from({ from: menu.state }, (d) => { d.choose(k); found(d); });
    }
  }
  // the overworld's prompts, in a new game
  try {
    emu.startGame(0);
    const ow = s.saveState();
    const without = from({ from: ow }, (d) => { d.frames(PROMPT_FRAMES); d.shown(); return shownKey(s); });
    // the save prompt: asked for (as a level that saves asks when it is passed), it comes when Mario arrives at a
    // tile – walked in the first direction he can go; where he can go nowhere, with every direction enabled
    const ask = (wr: Uint8Array) => { wr[RAM.savePrompt] = 1; };
    const free = (wr: Uint8Array) => { ask(wr); for (let i = RAM.levelFlags; i < RAM.levelFlagsEnd; i++) wr[i] |= 0x0f; };
    walk: for (const setup of [ask, free]) for (const dir of DIRECTIONS) {
      const came = from({ from: ow, setup }, (d) => {
        for (let i = 0; i < 4; i++) d.frame(dir);
        d.wait((m) => !w[RAM.savePrompt] || m !== GM.overworld, WALK_FRAMES);
        if (w[RAM.savePrompt] || d.mode !== GM.overworld) return false;
        d.frames(PROMPT_FRAMES);
        d.shown();
        out.set('savePrompt', reached(d, 'savePrompt'));
        return true;
      });
      if (came) break walk;
    }
    // the game over prompt: asked for as a game over does before the overworld loads
    from({ from: ow, setup: (wr) => { wr[RAM.gameOverPrompt] = 1; } }, (d) => {
      d.frames(PROMPT_FRAMES);
      d.shown();
      if (d.mode === GM.overworld && shownKey(s) !== without) out.set('gameOverPrompt', reached(d, 'gameOverPrompt'));
    });
  } catch { /* no overworld: no prompts */ }
  return GAME_SCREENS.flatMap((k) => out.get(k.id) ?? []);
}

// Runs the game to a screen again as it got there, `hook` watching: what it reads and writes on the way (the bytes
// a menu's text comes from). The machine is left showing the screen. The options: drive.ts replay.
export function replayScreen(emu: LevelEmulator, screen: ReachedScreen, hook: MemHook | null = null, o: ReplayOptions = {}): void {
  if (screen.path) replay(emu.snes, screen.path, hook, o); else emu.snes.loadState(screen.state);
}

// The screens reached, kept per emulator while the ROM bytes the game read to get there are as they were. Which
// screens are reached is a full picture: it doesn't show the title screen picture and is kept when that is painted.
// Their machines show the title screen (a menu is drawn over the picture): they are those of the boot snapshot they
// were reached from, which is booted again when the picture is painted.
interface Reached { gen: number; reads: RomReads; from: BootSnapshot; screens: ReachedScreen[]; ids: GameScreenId[] }
const kept = new WeakMap<LevelEmulator, Reached>();
function reach(emu: LevelEmulator): Reached {
  const from = emu.bootSnapshot(), r = emu.record('full picture', () => reachScreens(emu));
  const k = { gen: r.gen, reads: r.reads, from, screens: r.result, ids: r.result.map((s) => s.id) };
  kept.set(emu, k);
  return k;
}
export function gameScreens(emu: LevelEmulator): ReachedScreen[] {
  const had = kept.get(emu);
  // (the snapshot is asked for only when the rest holds: a stale one is booted again there)
  return (had && holds(emu.rom, had) && had.from === emu.bootSnapshot() ? had : reach(emu)).screens;
}

// Which screens the game reaches (gameScreens' ids): kept also when the title screen picture is painted, which
// only their machines show.
export function reachedScreenIds(emu: LevelEmulator): GameScreenId[] {
  const had = kept.get(emu);
  return (had && holds(emu.rom, had) ? had : reach(emu)).ids;
}

export interface ScreenPicture {
  frame: Uint32Array; // 256 × 224, as the game draws it
  vram: Uint8Array;
  cgram: Uint8Array;
  charBase: number; // layer 3's graphics in VRAM (bytes)
  l3Scroll: { x: number; y: number }; // layer 3's scroll as the game set it: the tilemap's pixel at the screen's top left
}

// A screen as the game draws it from the machine `state`, with `map` as the first screen of its layer 3 tilemap
// (default: its own). The state is not changed; the emulator's machine is left after the frames drawn.
export function screenPicture(emu: LevelEmulator, state: SnesState, map?: Uint16Array): ScreenPicture {
  const s = emu.snes, ppu = new PPU(s), hook = s.hook;
  s.loadState(state);
  if (map) map.forEach((v, i) => { s.vram[(L3_MAP_VRAM + i) * 2] = v & 0xff; s.vram[(L3_MAP_VRAM + i) * 2 + 1] = v >> 8; });
  s.ppu = ppu;
  s.hook = null;
  s.joy1 = 0;
  try {
    // the first frame is drawn before the NMI sets the scroll registers of a PPU new to them
    s.runFrame();
    s.runFrame();
  } finally {
    s.ppu = null;
    s.hook = hook;
  }
  return { frame: ppu.frame.slice(), vram: s.vram.slice(), cgram: s.cgram.slice(), charBase: layer3CharBase(s.ppuRegs), l3Scroll: { x: ppu.hofs[2], y: ppu.vofs[2] } };
}
