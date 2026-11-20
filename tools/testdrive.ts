// The drive (drive.ts): the emulated game played by the editor with a player's buttons. A screen path played again
// gives the same machine – from the title screen as booted, and from power-on with save files; with other save
// files the same buttons load another game. What a drive changed besides the game's state (the hook, the joypad,
// the tracking of sources) is as before when it ends, also when it threw. A step says whether the game got there
// within its frames, and presses its button anew every 16 frames for 4. A drive on from the machine as it is, and
// one whose step set RAM before a frame, has no path.
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { GM, RAM, PAD } from '../src/core/ram.ts';
import { drive, driveOn, replay, type ScreenPath } from '../src/core/drive.ts';
import { progressSram } from '../src/core/savefile.ts';
import type { MemHook, SnesState } from '../src/core/snes.ts';
import { editorImage } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const rom = new Rom(await editorImage()), emu = new LevelEmulator(rom), s = emu.snes, w = s.wram;
const same = (a: ArrayLike<number>, b: ArrayLike<number>) => a.length === b.length && Array.from(a).every((x, i) => x === b[i]);
const sameMachine = (a: SnesState, b: SnesState) => (['wram', 'vram', 'cgram', 'oam', 'sram'] as const).every((k) => same(a[k] as Uint8Array, b[k] as Uint8Array));
const boot = emu.bootState();

// ---- a path played again ----
{
  const r = drive(s, { from: boot }, (d) => {
    const left = d.press((m) => m !== GM.title, 120), stays = d.settle();
    return { left, stays, mode: d.mode, path: d.path, state: d.state() };
  });
  check(r.left && r.stays && r.mode === GM.fileSelect, `from the title screen a button leads to the file select (mode ${r.mode.toString(16)}, ${r.path.pad.length} frames)`);
  const starts = r.path.pad.findIndex((j) => j !== PAD.start);
  check(starts >= 1 && starts <= 4 && r.path.pad.slice(starts).every((j) => j === 0), `the path has the joypad of each frame: Start while the title screen shows (${starts}), then none`);
  replay(s, r.path);
  check(sameMachine(s.saveState(), r.state), 'the path played again gives the same machine');
  let reads = 0;
  replay(s, r.path, { onRomRead: () => { reads++; } });
  check(reads > 0 && sameMachine(s.saveState(), r.state) && s.hook === null, `played again with a hook: it saw the game read the ROM (${reads} reads), and is gone after`);
  let frames = 0;
  replay(s, r.path, null, { frames: 1, each: () => { frames++; } });
  check(frames === 1 && w[RAM.gameMode] === GM.title && !sameMachine(s.saveState(), r.state), 'played again for one frame: still the title screen');
}

// ---- from power-on with save files ----
{
  const progress = new Uint8Array(15); progress[0] = 0xc0; // (events 0 and 1 passed)
  const made = progressSram(emu, progress, undefined, 1);
  if (!made.sram) throw new Error(`no save file: ${made.why}`);
  const load = (file: number) => (d: Parameters<Parameters<typeof drive>[2]>[0]) => {
    if (!d.wait((m) => m === GM.title, 2000) || !d.press((m) => m !== GM.title, 120) || !d.settle()) return null;
    d.down(file);
    const there = d.press((m) => m === GM.overworld, 3000, { button: PAD.a });
    return { there, path: d.path, state: d.state(), file: w[RAM.saveFile], events: w.slice(RAM.owEvents, RAM.owEvents + 15) };
  };
  const r = drive(s, { from: null, sram: made.sram }, load(1));
  check(!!r && r.there && r.file === 1 && same(r.events, progress), 'from power-on with a save file as file B: its overworld, with its events');
  if (r) {
    replay(s, r.path);
    check(sameMachine(s.saveState(), r.state), 'the path played again gives the same machine: it holds the save files it started with');
    replay(s, r.path, null, { sram: new Uint8Array(s.sram.length) });
    check(!sameMachine(s.saveState(), r.state) && !same(w.slice(RAM.owEvents, RAM.owEvents + 15), progress), 'the same buttons with empty save files: another game');
  }
}

// ---- what a drive leaves ----
{
  const outer: MemHook = { onRomRead: () => { seen++; } }, inner: MemHook = {};
  let seen = 0;
  s.hook = outer;
  drive(s, { from: boot }, (d) => { d.frames(2); });
  check(seen > 0 && s.hook === outer, 'a hook watching outside goes on watching in a drive');
  drive(s, { from: boot }, (d) => { d.watch(inner); d.sources(); d.frame(PAD.start); });
  check(s.hook === outer && s.joy1 === 0 && !s.taintOn, 'after a drive: the hook as before, no button held, no sources tracked');
  let threw = false;
  try { drive(s, { from: boot }, (d) => { d.watch(null); d.sources(); s.joy1 = PAD.a; throw new Error('the game crashed'); }); } catch { threw = true; }
  check(threw && s.hook === outer && s.joy1 === 0 && !s.taintOn, 'after a drive that threw: the same, and the exception passed on');
  s.loadState(boot);
  driveOn(s, (d) => { d.watch(inner); d.frame(PAD.start); });
  check(s.hook === outer && s.joy1 === 0, 'after a drive on from the machine as it is: the same');
  s.hook = null;
}

// ---- a step's frames ----
{
  const r = drive(s, { from: boot }, (d) => ({ there: d.press(() => false, 40), path: d.path }));
  const pad = r.path.pad;
  check(!r.there && pad.length === 40, 'a step the game never ends says so, after its frames');
  check(pad.every((j, f) => (j !== 0) === (f % 16 < 4)) && pad[0] === PAD.start && pad[16] === PAD.a, 'its button pressed anew every 16 frames, for 4: Start on the title screen, A after it');
  const q = drive(s, { from: boot }, (d) => ({ there: d.wait(() => false, 10), n: d.path.pad.length, held: d.path.pad.some((j) => j !== 0), now: d.wait(() => true, 10), m: d.path.pad.length }));
  check(!q.there && q.n === 10 && !q.held && q.now && q.m === 10, 'waiting presses nothing; a step already there runs no frame');
  const e = drive(s, { from: boot }, (d) => ({ there: d.press(() => false, 40, { each: (f) => f < 4 }), n: d.path.pad.length }));
  check(!e.there && e.n === 5, 'a step ended by its caller after a frame');
}

// ---- drives without a path ----
{
  const noPath = (fn: () => ScreenPath) => { try { fn(); return false; } catch { return true; } };
  s.loadState(boot);
  check(driveOn(s, (d) => { d.frame(); return noPath(() => d.path); }), 'a drive on from the machine as it is has no path');
  check(drive(s, { from: boot }, (d) => { d.press(() => false, 2, { before: () => { w[RAM.lives] = 9; } }); return noPath(() => d.path); }), 'nor one whose step set RAM before a frame');
}

if (bad) { console.log(`${bad} FAILED`); process.exit(1); }
console.log('all ok');
