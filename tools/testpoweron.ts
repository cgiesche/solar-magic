// Play from power-on (playsession.ts powerOn): the game from reset shows its pre-game in sequence – Nintendo Presents,
// the title screen, file select, player select – and, on an empty save file, the intro (no play of the editor showed
// it before: every other start skips it); with the save file of an event progress (savefile.ts progressSram, made by
// the game's own save) the file select shows the file with its exit count, and the file loads with its events passed,
// its level flags and switch palaces, Mario at the start position, without the intro.
import { Rom, snesToPc } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { PlaySession } from '../src/core/playsession.ts';
import { progressSram } from '../src/core/savefile.ts';
import { eventBits, eventSetOf } from '../src/core/eventset.ts';
import type { ProgressSave } from '../src/core/owprogress.ts';
import { L1_PTRS } from '../src/core/level.ts';
import { readStart } from '../src/core/owsprites.ts';
import { GM, RAM, PAD, get16 } from '../src/core/ram.ts';
import { L3_MAP_VRAM } from '../src/core/layer3map.ts';
import { editorImage } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const base = await editorImage();
const same = (a: ArrayLike<number>, b: ArrayLike<number>) => a.length === b.length && Array.from(a).every((x, i) => x === b[i]);
const hex = (n: number) => n.toString(16);

const rom = new Rom(base.slice()), emu = new LevelEmulator(rom), w = emu.snes.wram, table = snesToPc(L1_PTRS);
// a session played as a player does: Start on the title screen, A in the menus and on a message; the game modes it
// went through, the levels it loaded, layer 3 of the file select when it showed, until the overworld
function playThrough(p: PlaySession): { modes: number[]; levels: number[]; fileSelect: Uint8Array | null; frames: number } {
  const modes: number[] = [], levels: number[] = [];
  let fileSelect: Uint8Array | null = null, f = 0;
  emu.snes.hook = { onRomRead: (o) => { if (o >= table && o < table + 0x600 && (o - table) % 3 === 0 && levels[levels.length - 1] !== (o - table) / 3) levels.push((o - table) / 3); } };
  for (; f < 6000 && p.mode !== GM.overworld; f++) {
    const m = p.mode;
    if (modes[modes.length - 1] !== m) modes.push(m);
    // (the file select looked at for a while before a file is chosen)
    const wait = m === GM.fileSelect && (fileSelect === null || f % 256 < 128);
    if (m === GM.fileSelect) fileSelect = emu.snes.vram.slice(L3_MAP_VRAM * 2, L3_MAP_VRAM * 2 + 0x800);
    p.frame(!wait && m >= GM.title && f % 16 < 4 ? (m === GM.title ? PAD.start : PAD.a) : 0);
  }
  emu.snes.hook = null;
  for (let i = 0; i < 60; i++) p.frame();
  return { modes, levels, fileSelect, frames: f };
}
const startsWith = (modes: number[], seq: number[]) => seq.every((m, i) => modes[i] === m);

// ---- empty save files: the whole pre-game, the intro played ----
let emptySelect: Uint8Array | null = null;
{
  const p = PlaySession.powerOn(emu);
  check(p.mode === GM.presentsLoad && !p.ready && emu.snes.sram.every((v) => v === 0), 'power-on: the game at its first game mode, SRAM empty');
  const r = playThrough(p);
  emptySelect = r.fileSelect;
  check(startsWith(r.modes, [0, 1, 2, 3, 4, 5, 6, 7, 8]) && r.modes.includes(GM.playerSelect), `Nintendo Presents, the title screen, file select, player select in sequence (${r.modes.map(hex).join(' ')})`);
  check(same(r.levels, [0xc7, 0xc5]) && r.modes.includes(GM.level) && p.mode === GM.overworld, `the title screen level, then on the empty file the intro level, then the overworld (levels ${r.levels.map(hex).join(' ')}, ${r.frames} frames)`);
  check(w[RAM.introLevel] === 0 && w[RAM.lives] === 4, 'the intro over: a new file on its first overworld');
  // a rewind and a savestate work as in any session
  p.keepRewind();
  for (let i = 0; i < 30; i++) p.frame();
  const st = p.save();
  check(p.rewind() !== null && (p.load(st), p.mode === GM.overworld), 'rewind and savestate as in any play session');
  p.close();
}

// ---- the save file of an event progress ----
{
  // a save made up for the test: events 00–0B passed, three levels passed with ways open, a switch palace, 12 exits
  const progress = 12, levelFlags = new Array<number>(0x60).fill(0);
  levelFlags[0x29] = 0x85; levelFlags[0x2a] = 0x83; levelFlags[0x27] = 0x8a;
  const save: ProgressSave = { levelFlags, switchPalaces: [0, 1, 0, 0], eventsTriggered: 12 };
  const t0 = Date.now(), { sram, why } = progressSram(emu, progress, save), ms = Date.now() - t0;
  check(!!sram && sram.some((v) => v !== 0), `the save file of an event progress, made by the game's own save and loaded by it (${ms} ms${why ? `: ${why}` : ''})`);
  if (sram) {
    const p = PlaySession.powerOn(emu, sram);
    check(same(emu.snes.sram, sram), 'power-on with it: the SRAM the game finds');
    const r = playThrough(p);
    check(!!r.fileSelect && !!emptySelect && !same(r.fileSelect, emptySelect), 'the file select shows the file otherwise than an empty one (its exit count)');
    check(same(r.levels, [0xc7]) && !r.modes.includes(GM.level) && p.mode === GM.overworld, `the file loads without the intro (levels ${r.levels.map(hex).join(' ')})`);
    check(same(w.subarray(RAM.owEvents, RAM.owEvents + 15), eventBits(progress)), 'its events are passed');
    check(same(w.subarray(RAM.levelFlags, RAM.levelFlags + 0x60), levelFlags) && same(w.subarray(RAM.switchPalaces, RAM.switchPalaces + 4), save.switchPalaces) && w[RAM.eventsTriggered] === 12,
      'its level flags, switch palaces and exit count are the save\'s');
    const st = readStart(rom, 0);
    check(w[RAM.submap] === st.submap && get16(w, RAM.owPlayerTileX) === st.x && get16(w, RAM.owPlayerTileY) === st.y, 'Mario at the start position');
    p.close();
  }
  // any set of events, without a learned save
  const set = eventSetOf([1, 3, 9]), sram2 = progressSram(emu, set, undefined, 1).sram;
  if (sram2) {
    const p = PlaySession.powerOn(emu, sram2);
    // file B: the cursor moved down once
    let f = 0;
    for (; f < 3000 && p.mode !== GM.fileSelect; f++) p.frame(p.mode === GM.title && f % 16 < 4 ? PAD.start : 0);
    for (let i = 0; i < 40; i++) p.frame();
    p.frame(PAD.down); for (let i = 0; i < 8; i++) p.frame();
    for (f = 0; f < 3000 && p.mode !== GM.overworld; f++) p.frame(f % 16 < 4 ? PAD.a : 0);
    check(p.mode === GM.overworld && same(w.subarray(RAM.owEvents, RAM.owEvents + 15), set) && w[RAM.saveFile] === 1, 'a set of events saved as file B: chosen there, it loads with them');
    p.close();
  } else check(false, 'a set of events saved as file B');
  const none = progressSram(emu, 0, undefined, 0, { id: 'savePrompt', state: emu.bootState(), mode: GM.title, path: null });
  check(progressSram(emu, 0).sram !== null && none.sram === null && /wrote no SRAM/.test(none.why), `a game that saves nothing at the prompt given: no save file, with the reason (${none.why})`);
}

if (bad) { console.log(`${bad} FAILED`); process.exit(1); }
console.log('all ok');
