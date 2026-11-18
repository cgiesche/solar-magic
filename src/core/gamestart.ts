// The start of a game (CONTEXT.md: intro, new file data): what a new save file starts with, learned by playing one
// from the title screen as a player does – a button on the title screen, the first choice of each menu, a button
// while a message is open – with every byte's source tracked (Snes.trackSources).
// - The intro: the level the game loads before the first overworld (the entry of the layer 1 pointer table it reads,
//   as levelemu.ts titleScreenLevel finds the title screen level), the message box it opens there, whether the game
//   writes SRAM before the overworld comes (Lunar Magic's "Save game after intro message"), and where Mario stands on
//   the overworld after it – beside where he stands without it.
// - The byte that chooses the intro level: the ROM byte the game last set its "level instead of the overworld"
//   ($0109, RAM.introLevel) from before a file is chosen. That it chooses the level is tried: with another value
//   there, the game loads another level – which also tells the level each value gives, without the game's rule for
//   it. 0 there is no intro: the edit the community knows (docs/research/pre-game-screens.md, 5.5).
// - The lives: the ROM byte the game set the lives from on the way; tried the same way.
// A game whose code computes these (Random Intro Level; Retry System's own lives are a byte still, written by its
// patch: valueOwner) has the values without the bytes: shown, no fields. Nothing here knows the addresses.

import type { LevelEmulator } from './levelemu.ts';
import type { Rom } from './rom.ts';
import type { SnesState } from './snes.ts';
import { snesToPc, pcToSnes } from './rom.ts';
import { L1_PTRS } from './level.ts';
import { GM, RAM, PAD, get16 } from './ram.ts';
import { holds, type RomReads } from './romdeps.ts';
import { ownerOf } from './patchreg.ts';
import { packageOfPatch, listPackages } from './pkgreg.ts';
import { loadProject } from './uberproject.ts';

// a value the game uses and the ROM offset it reads it from (-1: computed, or not confirmed – no field)
export interface StartValue { value: number; at: number }
// where a player stands on the overworld: the submap, the pixel position, the tile
export interface StartSpot { submap: number; x: number; y: number; tx: number; ty: number }
export interface IntroPair { value: number; level: number }
export interface GameStart {
  reached: boolean; // a new file gets to its first overworld
  intro: {
    level: number | null; // the level a new file loads before its first overworld (null: none)
    // what the game set RAM.introLevel to before the file was chosen (null: nothing); at: the byte that chooses the level
    armed: StartValue | null;
    tried: IntroPair[]; // values of that byte with the levels the game was seen to load for them (none: no such byte)
    message: { translevel: number; msg: number } | null; // the message box the intro level opens
    saves: boolean; // the game writes SRAM between the intro level's load and the first overworld
    spot: StartSpot | null; // where Mario stands on the first overworld after the intro
    shown: SnesState | null; // the machine showing the intro (its message open; without one: its level as it starts)
  };
  lives: StartValue | null; // RAM.lives as a new file starts (the lives left after this one: one less than shown)
  spot: StartSpot | null; // where Mario stands on the first overworld without the intro: the start position
  overworld: SnesState | null; // the machine on a new file's first overworld
}

const RUN_FRAMES = 4000; // a new file from the title screen to its first overworld, the intro's message closed
const PRESS = 16, HELD = 4; // a button pressed anew every PRESS frames, for HELD
const STAND_FRAMES = 300, STANDS = 30; // until Mario stands on the overworld: what it does stays for this many frames
const MESSAGE_FRAMES = 64; // from a message box's opening until it shows its text

const spotOf = (w: Uint8Array): StartSpot => ({
  submap: w[RAM.submap], x: get16(w, RAM.owPlayerX), y: get16(w, RAM.owPlayerY), tx: get16(w, RAM.owPlayerTileX), ty: get16(w, RAM.owPlayerTileY),
});
export const sameSpot = (a: StartSpot, b: StartSpot): boolean => a.submap === b.submap && a.x === b.x && a.y === b.y && a.tx === b.tx && a.ty === b.ty;

interface NewFile {
  reached: boolean;
  level: number | null;
  armed: { value: number; src: number } | null;
  lives: { value: number; src: number } | null;
  message: { translevel: number; msg: number } | null;
  saves: boolean;
  shown: SnesState | null;
}

// A new file played from the title screen until its first overworld (`untilLevel`: or until the game reads the
// intro level's pointer). The machine is left where the run ended.
function newFile(emu: LevelEmulator, o: { sources?: boolean; untilLevel?: boolean } = {}): NewFile {
  const s = emu.snes, w = s.wram, outer = s.hook, table = snesToPc(L1_PTRS);
  const r: NewFile = { reached: false, level: null, armed: null, lives: null, message: null, saves: false, shown: null };
  let sramAtLevel = -1, messageAt = -1, stop = false;
  s.loadState(emu.bootState());
  s.hook = {
    onRomRead: (ro) => {
      if (r.level !== null || ro < table || ro >= table + 0x200 * 3) return;
      r.level = Math.floor((ro - table) / 3);
      sramAtLevel = s.sramWrites;
      if (o.untilLevel) stop = true;
    },
    onWramWrite: (a, v) => {
      const m = w[RAM.gameMode];
      if (a === RAM.introLevel && m < GM.playerSelect) r.armed = { value: v, src: s.writeSource };
      else if (a === RAM.lives && m <= GM.overworldReturn && r.level === null) r.lives = { value: v, src: s.writeSource };
      else if (a === RAM.message && v && r.level !== null && !r.message) r.message = { translevel: w[RAM.translevel], msg: v };
    },
  };
  if (o.sources) s.trackSources(true);
  try {
    for (let f = 0; f < RUN_FRAMES && !stop; f++) {
      const m = w[RAM.gameMode];
      if (m === GM.overworld) { r.reached = true; break; }
      s.joy1 = f % PRESS < HELD ? (m === GM.title ? PAD.start : PAD.a) : 0;
      s.runFrame();
      // the picture of the intro: its message open and written, else the level's first frame of gameplay
      if (r.level !== null && w[RAM.gameMode] === GM.level) {
        if (r.message && messageAt < 0) messageAt = f;
        if (!r.shown || (messageAt >= 0 && f === messageAt + MESSAGE_FRAMES)) r.shown = s.saveState();
      }
    }
    if (r.level !== null && r.reached) r.saves = s.sramWrites !== sramAtLevel;
  } catch { /* the emulated game crashed: what was seen until then */ } finally {
    if (o.sources) s.trackSources(false);
    s.hook = outer;
    s.joy1 = 0;
  }
  return r;
}

// a new file played until the game reads the intro level's pointer, with other bytes in the ROM for the run
function tryBytes(emu: LevelEmulator, bytes: [at: number, value: number][]): NewFile {
  const d = emu.rom.data, was = bytes.map(([at]) => d[at]);
  bytes.forEach(([at, v]) => { d[at] = v; });
  try { return newFile(emu, { untilLevel: true }); } finally { bytes.forEach(([at], k) => { d[at] = was[k]; }); }
}

// on the overworld: frames until Mario stands (what the overworld does stays), then where
function stands(emu: LevelEmulator): StartSpot {
  const s = emu.snes, w = s.wram;
  for (let f = 0, same = 0, last = -1; f < STAND_FRAMES && same < STANDS; f++) {
    s.runFrame();
    const k = w[RAM.owProcess] | (w[RAM.owPlayerX] << 8) | (w[RAM.owPlayerY] << 16);
    same = k === last ? same + 1 : 0;
    last = k;
  }
  return spotOf(w);
}

// What a new file starts with. The emulator's machine is left in the last state run.
export function learnGameStart(emu: LevelEmulator): GameStart {
  const s = emu.snes, d = emu.rom.data, hook = s.hook;
  s.hook = null;
  try {
    const run = newFile(emu, { sources: true });
    const out: GameStart = {
      reached: run.reached,
      intro: { level: run.level, armed: run.armed && { value: run.armed.value, at: -1 }, tried: [], message: run.level === null ? null : run.message, saves: run.saves, spot: null, shown: run.shown },
      lives: run.lives && { value: run.lives.value, at: -1 }, spot: null, overworld: null,
    };
    if (run.reached) {
      const spot = stands(emu);
      out.overworld = s.saveState();
      if (run.level === null) out.spot = spot;
      else {
        out.intro.spot = spot;
        // without the intro: the new file as every play of the editor starts it
        try { emu.startGameAt(-1); out.spot = stands(emu); out.overworld = s.saveState(); } catch { /* no overworld without it */ }
      }
    }
    // the bytes tried: with other values there, the game loads another level and starts with other lives
    const a = run.armed, l = run.lives;
    const introAt = a && a.src >= 0 && d[a.src] === a.value ? a.src : -1, livesAt = l && l.src >= 0 && d[l.src] === l.value && l.src !== introAt ? l.src : -1;
    if (livesAt >= 0) {
      const other = l!.value ^ 1;
      if (tryBytes(emu, [[livesAt, other]]).lives?.value === other) out.lives!.at = livesAt;
    }
    if (introAt >= 0) {
      // (a value beside the byte's, and the lowest and the highest: the game's rule may differ between them)
      const tried: IntroPair[] = [];
      for (const v of new Set([a!.value < 0xff ? a!.value + 1 : 0xfe, 1, 0xff])) {
        const level = v === a!.value ? run.level : tryBytes(emu, [[introAt, v]]).level;
        if (level !== null) tried.push({ value: v, level });
      }
      if (tried.some((t) => t.level !== run.level)) {
        out.intro.armed!.at = introAt;
        if (run.level !== null && !tried.some((t) => t.value === a!.value)) tried.unshift({ value: a!.value, level: run.level });
        out.intro.tried = tried;
      }
    }
    return out;
  } finally {
    s.hook = hook;
    s.joy1 = 0;
  }
}

// What a new file starts with, kept per emulator while the ROM bytes the game read for it are as they were.
const kept = new WeakMap<LevelEmulator, { gen: number; reads: RomReads; start: GameStart }>();
export function gameStart(emu: LevelEmulator): GameStart {
  const had = kept.get(emu);
  if (had && holds(emu.rom, had)) return had.start;
  emu.ensureBoot();
  const r = emu.recordAll(() => learnGameStart(emu));
  kept.set(emu, { gen: r.gen, reads: r.reads, start: r.result });
  return r.result;
}

// whether the game chooses the intro level by a byte of the ROM (a field)
export const introIsField = (g: GameStart): boolean => !!g.intro.armed && g.intro.armed.at >= 0 && g.intro.tried.length > 0;

// The value of the intro's byte that makes the game load `level` (null: none found): the values beside those tried –
// as far from one as the level is from its level – each tried in the game. Not the game's rule: what it does.
export function introValueFor(emu: LevelEmulator, g: GameStart, level: number): number | null {
  if (!introIsField(g)) return null;
  const s = emu.snes, hook = s.hook, at = g.intro.armed!.at;
  s.hook = null;
  emu.ensureBoot();
  try {
    for (const v of new Set(g.intro.tried.map((t) => t.value + level - t.level))) {
      if (v >= 1 && v <= 0xff && tryBytes(emu, [[at, v]]).level === level) return v;
    }
    return null;
  } finally { s.hook = hook; s.joy1 = 0; }
}

// The intro level written (null: no intro – the byte's 0): the byte the game was seen to choose it by, with the value
// the game was seen to load the level for.
export function writeIntroLevel(emu: LevelEmulator, g: GameStart, level: number | null): void {
  if (!introIsField(g)) throw new Error('The game does not choose the intro level by a byte of the ROM');
  const v = level === null ? 0 : introValueFor(emu, g, level);
  if (v === null) throw new Error(`The game loads no intro level ${level!.toString(16).toUpperCase().padStart(3, '0')}: it chooses the level by one byte, which reaches ${introLevelsText(g)}`);
  emu.rom.writeAt(g.intro.armed!.at, Uint8Array.of(v));
}
// the levels the byte was seen to reach, in words
function introLevelsText(g: GameStart): string {
  const ls = g.intro.tried.map((t) => t.level), bank = ls[0] & ~0xff, hex = (n: number) => n.toString(16).toUpperCase().padStart(3, '0');
  return ls.every((n) => (n & ~0xff) === bank) ? `levels ${hex(bank)}–${hex(bank | 0xff)}, not all of them` : 'some levels only';
}

export const MAX_LIVES = 99; // what the game counts up to
// The lives a new file starts with written (as the player sees them: the game keeps one less).
export function writeStartLives(rom: Rom, g: GameStart, lives: number): void {
  if (!g.lives || g.lives.at < 0) throw new Error('The game does not read the lives from a byte of the ROM');
  if (!Number.isInteger(lives) || lives < 1 || lives > MAX_LIVES) throw new Error(`The lives are 1–${MAX_LIVES}`);
  rom.writeAt(g.lives.at, Uint8Array.of(lives - 1));
}

// Who wrote the ROM byte a value is read from, when it is not the game's own: the patch, the package that brought
// it, and – where the patch's sources (the UberASM project's files) write the byte from a define – that define and
// the file that sets it: the setting to change instead of the byte, which the patch writes anew whenever it is
// applied (Retry System: its lives are !initial_lives of its settings_global.asm).
export interface ValueOwner { patch: string; pkg: string | null; setting: { define: string; file: string } | null }
export function valueOwner(rom: Rom, v: StartValue | null): ValueOwner | null {
  const p = v && v.at >= 0 ? ownerOf(rom, v.at) : null;
  if (!p) return null;
  let pkg = packageOfPatch(rom, p.id)?.name ?? null, setting: ValueOwner['setting'] = null;
  if (p.kind === 'uberasm') {
    let files = new Map<string, Uint8Array>();
    try { files = loadProject(rom)?.files ?? files; } catch { /* its sources are not in the ROM */ }
    const found = settingOf(files, pcToSnes(v ? v.at : 0));
    if (found) {
      setting = { define: found.define, file: found.file };
      pkg = listPackages(rom).find((k) => k.uberasm.files.includes(found.from))?.name ?? pkg;
    }
  }
  return { patch: p.name, pkg, setting };
}

// In assembly sources: the define a byte at `snes` is written from (org $addr, then db/dw/dl of an expression that
// starts with a define), the file that writes it (`from`) and the file that sets the define (`file`).
export function settingOf(files: Map<string, Uint8Array>, snes: number): { define: string; file: string; from: string } | null {
  const dec = new TextDecoder(), texts = new Map<string, string>();
  for (const [path, data] of files) if (/\.asm$/i.test(path)) texts.set(path, dec.decode(data));
  for (const [from, text] of texts) {
    for (const m of text.matchAll(/^[ \t]*org[ \t]+\$([0-9A-Fa-f]{6})[ \t]*(?:;.*)?\r?\n[ \t]*d[bwl][ \t]+!(\w+)/gm)) {
      if ((parseInt(m[1], 16) & 0x7fffff) !== (snes & 0x7fffff)) continue;
      const set = new RegExp(`^[ \\t]*!${m[2]}[ \\t]*=`, 'm');
      const file = [...texts].find(([, t]) => set.test(t))?.[0] ?? from;
      return { define: m[2], file, from };
    }
  }
  return null;
}
