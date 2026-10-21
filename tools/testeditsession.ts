// The edit session (core/editsession.ts): one undo/redo serves level edits and ROM edits in the order they
// were made, a ROM edit saves a dirty level first (outside its undo step), and steps the histories dropped
// beyond their limits are passed over.
import { Rom } from '../src/core/rom.ts';
import { loadLevel, SPRITE_MEMORY } from '../src/core/level.ts';
import { EditSession } from '../src/core/editsession.ts';
import { editorImage } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };

const image = await editorImage();
const A = 0x00b0a0; // a palette word, not touched by saving a level
const N = 0x105;

function setup() {
  const rom = new Rom(image.slice());
  const runs = { changed: 0, saved: 0, written: 0 };
  const s = new EditSession(rom, {
    changed: () => { runs.changed++; },
    saved: () => { runs.saved++; },
    written: () => { runs.written++; },
  });
  s.open(N);
  return { rom, s, runs };
}
const mem = (s: EditSession) => s.level.spriteHeader & SPRITE_MEMORY;
const setMem = (s: EditSession, m: number) => s.editLevel(() => { s.level.spriteHeader = (s.level.spriteHeader & ~SPRITE_MEMORY) | m; });

// level edit, ROM edit, level edit: undone and redone in the order made
{
  const { rom, s, runs } = setup();
  const m0 = mem(s), a0 = rom.r16(A);
  setMem(s, m0 ^ 1);
  check(s.dirty && runs.changed === 1 && s.lastStep === 'level', 'level edit: dirty, an undo step');
  s.romEdit('Color', () => rom.w16(A, a0 ^ 0x1234));
  check(!s.dirty && runs.saved === 1 && (loadLevel(rom, N).spriteHeader & SPRITE_MEMORY) === (m0 ^ 1), 'ROM edit: the dirty level saved first');
  check(s.lastStep === 'rom' && s.romHistory.undoStack.length === 1, 'ROM edit: an undo step (the save is not part of it)');
  setMem(s, m0 ^ 3);

  const u1 = s.undo();
  check(u1?.kind === 'level' && mem(s) === (m0 ^ 1) && rom.r16(A) === (a0 ^ 0x1234), 'undo 1: the second level edit');
  const u2 = s.undo();
  check(u2?.kind === 'rom' && u2.edit.label === 'Color' && rom.r16(A) === a0 && mem(s) === (m0 ^ 1), 'undo 2: the ROM edit');
  const u3 = s.undo();
  check(u3?.kind === 'level' && mem(s) === m0, 'undo 3: the first level edit');
  check(s.undo() === null, 'undo 4: nothing left');

  const r1 = s.redo();
  check(r1?.kind === 'level' && mem(s) === (m0 ^ 1) && rom.r16(A) === a0, 'redo 1: the first level edit');
  const r2 = s.redo();
  check(r2?.kind === 'rom' && rom.r16(A) === (a0 ^ 0x1234) && mem(s) === (m0 ^ 1), 'redo 2: the ROM edit');
  const r3 = s.redo();
  check(r3?.kind === 'level' && mem(s) === (m0 ^ 3), 'redo 3: the second level edit');
  check(s.redo() === null, 'redo 4: nothing left');

  s.undo();
  setMem(s, m0 ^ 7);
  check(s.redo() === null, 'a new edit drops redo');
}

// a ROM edit with a clean level saves nothing; one that fails records nothing in the order
{
  const { rom, s, runs } = setup();
  s.romEdit('Color', () => rom.w16(A, 1));
  check(runs.saved === 0, 'clean level: not saved before a ROM edit');
  setMem(s, mem(s) ^ 1);
  s.romEdit('Failed', () => { rom.w16(A, 2); return { ok: false }; });
  check(runs.saved === 1 && rom.r16(A) === 1 && s.lastStep === 'level', 'a failed ROM edit: saved before, but no step');
  const u = s.undo();
  check(u?.kind === 'level', 'undo after the failed edit: the level edit');
}

// a cancelled level edit records nothing; restore puts the level back
{
  const { s } = setup();
  const m0 = mem(s);
  const e = s.beginLevelEdit();
  s.level.spriteHeader ^= 1;
  e.cancel(true);
  check(mem(s) === m0 && s.lastStep === null && s.levelGen === 0, 'cancel(restore): the level as before, no step');
  let threw = false;
  try { s.editLevel(() => { s.level.spriteHeader ^= 1; throw new Error('boom'); }); } catch { threw = true; }
  check(threw && mem(s) === m0 && s.lastStep === null, 'editLevel throwing: the level as before, error passed on');
  check(!s.editLevel(() => false) && s.lastStep === null, 'editLevel returning false: no step');
  setMem(s, m0 ^ 1);
  check(s.levelGen === 1, 'committed level edits counted');
}

// the order is limited to 400 steps: a level edit, then 450 ROM edits (the ROM history keeps 200). The
// level edit's place is dropped; once the ROM history is full every ROM step has the same length in the
// order (200), so undo reaches the latest one and the 149 from before it filled up, then falls back to the
// level history
{
  const { rom, s } = setup();
  const m0 = mem(s);
  setMem(s, m0 ^ 1);
  for (let i = 1; i <= 450; i++) s.romEdit(`Color ${i}`, () => rom.w16(A, i));
  let roms = 0;
  while (s.lastStep !== null) if (s.undo()?.kind === 'rom') roms++;
  check(roms === 150 && rom.r16(A) === 300 && s.romHistory.undoStack.length === 50, 'beyond the limit: the ROM steps the order kept undone');
  const u = s.undo();
  check(u?.kind === 'level' && mem(s) === m0, 'beyond the limit: then the level edit');
  check(s.undo() === null && rom.r16(A) === 300, 'beyond the limit: then nothing');
}

// level edits beyond the limit: the first ROM edit's place was dropped from the order, undo ends with
// the level history
{
  const { rom, s } = setup();
  const m0 = mem(s);
  s.romEdit('Color', () => rom.w16(A, 1));
  for (let i = 1; i <= 450; i++) setMem(s, (m0 + i) & SPRITE_MEMORY);
  let levels = 0;
  for (let i = 0; i < 200; i++) if (s.undo()?.kind === 'level') levels++;
  check(levels === 200 && mem(s) === ((m0 + 250) & SPRITE_MEMORY), 'beyond the limit: the 200 kept level steps undone');
  check(s.undo() === null && rom.r16(A) === 1, 'beyond the limit: the ROM edit no longer in the order');
}

// a level edit gets the open level: after a ROM edit saved the dirty level (a new object), a caller that
// held the level before changes the open one through it (#58)
{
  const { rom, s } = setup();
  const m0 = mem(s);
  setMem(s, m0 ^ 1);
  const held = s.level;
  s.romEdit('Color', () => rom.w16(A, 1));
  check(s.level !== held, 'ROM edit with a dirty level: the open level is a new object');
  s.editLevel((lv) => { lv.spriteHeader = (lv.spriteHeader & ~SPRITE_MEMORY) | (m0 ^ 3); });
  check(mem(s) === (m0 ^ 3) && s.lastStep === 'level', 'the passed level is the open one, the edit an undo step');
  const u = s.undo();
  check(u?.kind === 'level' && mem(s) === (m0 ^ 1) && rom.r16(A) === 1, 'undo: the level edit reverted, the ROM edit stays');
}

// opening a level saves the dirty one and starts a new level history
{
  const { rom, s, runs } = setup();
  setMem(s, mem(s) ^ 1);
  const s0 = s.level.spriteHeader;
  s.open(0x106);
  check(runs.saved === 1 && !s.dirty && s.level.number === 0x106, 'open: the dirty level saved');
  check(s.undo() === null && loadLevel(rom, N).spriteHeader === s0, 'open: the old level\'s steps are gone');
}

// replacing the open level (a level import, a package's sample level): one undo step (#59)
{
  const { rom, s, runs } = setup();
  const before = s.level, other = loadLevel(rom, 0x106);
  check(s.replaceLevel(other) && s.level === other && s.dirty && runs.changed === 1 && s.lastStep === 'level', 'replaceLevel: the open level, dirty, an undo step');
  const u = s.undo();
  check(u?.kind === 'level' && s.level.number === before.number && s.level.objects.length === before.objects.length, 'replaceLevel undone: the level before');
  check(s.redo()?.kind === 'level' && s.level.number === 0x106, 'replaceLevel redone');
}

// opening a level with discard: its unsaved changes are dropped, not saved (#59)
{
  const { rom, s, runs } = setup();
  const m0 = mem(s);
  setMem(s, m0 ^ 1);
  s.open(N, true);
  check(runs.saved === 0 && !s.dirty && mem(s) === m0 && (loadLevel(rom, N).spriteHeader & SPRITE_MEMORY) === m0, 'open(discard): unsaved changes dropped');
}

if (bad) { console.log(`${bad} FAILED`); process.exit(1); }
console.log('all ok');
