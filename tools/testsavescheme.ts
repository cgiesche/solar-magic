// The save scheme (savefile.ts): which SRAM bytes a save of each file writes and a load reads, whose code does it, and
// whether the saved file loads as saved – learned by having the game save at its save prompt and load from power-on.
// The clean game's layout (3 files of 143 bytes at $700000 with their copies from $7001AD: the test's own knowledge);
// a game whose files are elsewhere (its table of the files' places changed: a made-up variant, standing in for
// patches that lay SRAM out anew – no fixture of SRAM and BW-RAM Plus is in the repository); Retry System 2.2.0
// (Kevin), which saves a table of its own beside the files with its own code; a game whose save its load does not
// find. The save file of an event progress (progressSram) under each.
import { readFileSync } from 'node:fs';
import { Rom, snesToPc } from '../src/core/rom.ts';
import { loadAsar } from '../src/core/asar.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { PlaySession } from '../src/core/playsession.ts';
import { learnSaveScheme, saveScheme, progressSram, loadSave, rangeBytes, type SaveScheme, type SramRange } from '../src/core/savefile.ts';
import { eventBits } from '../src/core/eventset.ts';
import type { ProgressSave } from '../src/core/owprogress.ts';
import { inspectUpload, installPackage, defaultAssignment } from '../src/core/packages.ts';
import { RAM, GM } from '../src/core/ram.ts';
import { editorImage } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const base = await editorImage();
const fresh = () => new Rom(base.slice());
const same = (a: ArrayLike<number>, b: ArrayLike<number>) => a.length === b.length && Array.from(a).every((x, i) => x === b[i]);
const hex = (n: number) => n.toString(16);
const text = (r: readonly SramRange[]) => r.map((x) => `${hex(x.from)}–${hex(x.to - 1)}`).join(' ');
const has = (r: readonly SramRange[], from: number, len: number) => r.some((x) => x.from <= from && x.to >= from + len);
const show = (s: SaveScheme) => s.files.map((f, k) => `${'ABC'[k]}: writes ${text(f.written)}, reads ${text(f.read)}${f.problem ? ` – ${f.problem}` : ''}`).join('; ');
// a save made up for the test: events 00–0B passed, levels passed, a switch palace, 12 exits
const levelFlags = new Array<number>(0x60).fill(0);
levelFlags[0x29] = 0x85; levelFlags[0x2a] = 0x83; levelFlags[0x27] = 0x8a;
const SAVE: ProgressSave = { levelFlags, switchPalaces: [0, 1, 0, 0], eventsTriggered: 12 };
// the save file of that progress made, loaded from power-on: the game has its events, flags and exit count
function progressLoads(emu: LevelEmulator, file: number): string {
  const { sram, why } = progressSram(emu, 12, SAVE, file);
  if (!sram) return why || 'none made';
  const l = loadSave(emu, sram, file), w = emu.snes.wram;
  const ok = l.reached && !l.intro && same(w.subarray(RAM.owEvents, RAM.owEvents + 15), eventBits(12)) && same(w.subarray(RAM.levelFlags, RAM.levelFlags + 0x60), levelFlags) && w[RAM.eventsTriggered] === 12 && w[RAM.switchPalaces + 1] === 1;
  return ok ? '' : 'loaded otherwise';
}

// ---- the clean game ----
{
  const rom = fresh(), emu = new LevelEmulator(rom);
  const t0 = Date.now(), s = saveScheme(emu), ms = Date.now() - t0;
  console.log(`  (${show(s)})`);
  check(s.files.length === 3 && !s.why, `the save scheme learned: three files (${ms} ms)`);
  check(s.files.every((f, k) => f.written.length === 2 && rangeBytes(f.written) === 286 && has(f.written, k * 143, 143) && has(f.written, 0x1ad + k * 143, 143)),
    'a save of a file writes its 143 bytes and their copy: files at $700000, $70008F, $70011E, the copies from $7001AD');
  check(s.files.every((f, k) => has(f.read, k * 143, 143) && !f.problem), 'a load reads the file\'s bytes; each saved file loads as saved');
  check(s.writers.length === 1 && s.writers[0] === '' && s.readers.length === 1 && s.readers[0] === '', 'saved and loaded by the game\'s own code');
  check(saveScheme(emu) === s && emu.snes.hook === null && same(rom.data, base), 'kept; the emulator left without a hook, the ROM as it was');
  check(progressLoads(emu, 0) === '' && progressLoads(emu, 2) === '', 'the save file of an event progress, as file A and as file C: loaded by the game with its events, flags and exit count');
}

// ---- a made-up variant: the files elsewhere in SRAM (the game's table of their places, $009CCB high bytes and
// $009CCE low bytes: files at $700000, $700400, $700800) ----
{
  const rom = fresh();
  rom.writeAt(snesToPc(0x009ccb), Uint8Array.from([0x00, 0x04, 0x08, 0x00, 0x00, 0x00]));
  const emu = new LevelEmulator(rom), s = saveScheme(emu);
  console.log(`  (${show(s)})`);
  // (the game writes a copy only of a file below $7001AD: files B and C have none there – learned, not assumed)
  check(s.files.length === 3 && s.files.every((f, k) => has(f.written, k * 0x400, 143) && has(f.read, k * 0x400, 143) && !f.problem) && rangeBytes(s.files[0].written) === 286 && rangeBytes(s.files[1].written) === 143,
    'files laid out elsewhere: the scheme has their bytes where the game writes them (files B and C without a copy), each loads as saved');
  check(progressLoads(emu, 1) === '', 'the save file of an event progress under it, as file B: loaded by the game');
  // the same save in the clean game's layout is not what this game loads: the editor never lays a save out itself
  const clean = new LevelEmulator(fresh()), made = progressSram(clean, 12, SAVE, 1).sram!;
  const l = loadSave(emu, made, 1);
  check(l.reached && l.intro, 'a save in the clean game\'s layout is a new file to this game (what assuming the layout would give)');
}

// ---- a game whose load does not find its save (the save's checksum base changed: LDA #$5A5A in the save routine) ----
{
  const rom = fresh(), d = rom.data, from = snesToPc(0x009bc9);
  let at = -1;
  for (let o = from; o < from + 0x60 && at < 0; o++) if (d[o] === 0xa9 && d[o + 1] === 0x5a && d[o + 2] === 0x5a) at = o;
  rom.writeAt(at + 1, Uint8Array.of(0x5b));
  const emu = new LevelEmulator(rom), s = learnSaveScheme(emu), made = progressSram(emu, 12, SAVE);
  check(at >= 0 && s.files.length === 3 && s.files.every((f) => /new file/.test(f.problem)), `a save the game's load does not find: told per file (${s.files[0]?.problem})`);
  check(made.sram === null && /new file/.test(made.why), 'no save file of an event progress is handed out then, with the reason');
}

// ---- Retry System 2.2.0 (Kevin): its own SRAM table, saved and loaded by its code ----
{
  await loadAsar();
  const rom = fresh();
  const retry = inspectUpload('retry-system_v2.2.0.zip', new Uint8Array(readFileSync('test/fixtures/retry-system_v2.2.0.zip')));
  if (retry.status !== 'manual') throw new Error('Retry: no manual preview');
  const r = await installPackage(rom, retry, { level: 0x105, blank: [0, 0, 0, 0], tileWords: () => [0, 0, 0, 0], assignment: defaultAssignment(retry, 0x105) });
  const emu = new LevelEmulator(rom), s = saveScheme(emu);
  console.log(`  (${show(s)}; written by ${JSON.stringify(s.writers)}, read by ${JSON.stringify(s.readers)})`);
  check(r.ok && s.files.length === 3 && s.files.every((f, k) => has(f.written, k * 143, 143) && rangeBytes(f.written) > 286 && !f.problem),
    `Retry System installed: a save writes the file and more (${s.files.map((f) => rangeBytes(f.written)).join(', ')} bytes), each loads as saved`);
  check(s.writers.includes('') && s.writers.some((n) => n !== '') && s.readers.some((n) => n !== ''), `written by the game's code and a patch's, read by the patch's too (${s.writers.filter((n) => n).join(', ')})`);
  const own = s.files.map((f) => f.written.filter((x) => x.from >= 0x1ad + 3 * 143));
  check(own.every((o) => o.length > 0) && text(own[0]) !== text(own[1]) && text(own[1]) !== text(own[2]), `its table has a place per file (${own.map(text).join(' | ')})`);
  check(progressLoads(emu, 0) === '' && progressLoads(emu, 1) === '', 'the save file of an event progress under it: loaded by the game');
  // from power-on with it: the file select, the file chosen, the overworld with its events
  const sram = progressSram(emu, 12, SAVE).sram!, p = PlaySession.powerOn(emu, sram);
  for (let f = 0; f < 6000 && p.mode !== GM.overworld; f++) p.frame(p.mode >= GM.title && f % 16 < 4 ? (p.mode === GM.title ? 0x1000 : 0x0080) : 0);
  check(p.mode === GM.overworld && same(p.wram.subarray(RAM.owEvents, RAM.owEvents + 15), eventBits(12)), 'played from power-on with it: the file loads with its events');
  p.close();
}

if (bad) { console.log(`${bad} FAILED`); process.exit(1); }
console.log('all ok');
