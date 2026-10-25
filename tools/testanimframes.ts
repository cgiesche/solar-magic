// Animation frames come from the Anim graphics only (ADR 0003): frames of other lists (a level file's,
// AN2's) are copied into an Anim graphic, identical frames once, the slots pointing there
// (localizeFrames).
import { Rom } from '../src/core/rom.ts';
import { loadAsar } from '../src/core/asar.ts';
import { installEditorPatch } from '../src/core/patches.ts';
import { emptyList, writeLevelList, readAltFile, writeAltFile, localizeFrames, usesAltFile, altFileUsers, ALT_FILE_MAX, type ExSlot } from '../src/core/exanim.ts';
import { editorImage } from './fixture.ts';

const EDITOR_IMAGE = await editorImage(); // the fixture as the editor opens it

await loadAsar();
let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const fresh = () => new Rom(EDITOR_IMAGE.slice());
const pattern = (n: number, k: number) => Uint8Array.from({ length: n }, (_, i) => (i * k + (i >> 5)) & 0xff);
const same = (a: Uint8Array, at: number, b: Uint8Array, from: number, n: number) => { for (let i = 0; i < n; i++) if (a[at + i] !== b[from + i]) return false; return true; };

// ---- localizeFrames ----
{
  const rom = fresh();
  installEditorPatch(rom);
  const an2 = pattern(0x1000, 7), alt = pattern(0x800, 13), ram = pattern(0x10000, 3);
  const tiles4 = (frames: number[], dest = 0x0400): ExSlot => ({ type: 0x04, trigger: 0, framesLess1: frames.length - 1, dest, frames });
  const slots = [
    tiles4([0xad00, 0xad80]), // AN2
    tiles4([0xad80]), // AN2, a frame of the first again
    tiles4([0x9100]), // RAM only (the game's graphics): stays
    tiles4([0x9100, 0xad00]), // RAM and AN2: both come along
    { ...tiles4([0x40]), dest: 0x8400 }, // the level file's own alternative file
    { type: 0x14, trigger: 0, framesLess1: 2, dest: 0x8121, frames: [0x104, 0x100, 0x108] }, // 2 colors from the alternative file
    { type: 0x14, trigger: 0, framesLess1: 0, dest: 0x8022, frames: [0x1f] }, // one color: the frame is the color
  ];
  const r = localizeFrames(rom, slots, { an2, alt, ram }, 0);
  const f = readAltFile(rom, 0)!;
  const [a, b, c, d, e, col, one] = r.slots;
  check(!!f && f.length === 0x80 * 4 + 0x20, `Anim graphic A: 4 distinct frames of 4 tiles, the colors (${f?.length.toString(16)})`);
  check(!!a && usesAltFile(a) && same(f, a.frames[0], an2, 0, 0x80) && same(f, a.frames[1], an2, 0x80, 0x80), 'AN2 frames copied, the slot reads the Anim graphic');
  check(!!b && b.frames[0] === a!.frames[1], 'the same frame stored once');
  check(!!c && c.dest === 0x0400 && c.frames[0] === 0x9100, 'a slot with RAM frames only stays');
  check(!!d && usesAltFile(d) && same(f, d.frames[0], ram, 0x9100, 0x80) && d.frames[1] === a!.frames[0], 'RAM frames of a slot with AN2 frames come from WRAM');
  check(!!e && same(f, e.frames[0], alt, 0x40, 0x80) && (e.dest & 0x7fff) === 0x0400, 'frames from the level file\'s alternative file');
  check(!!col && col.dest === 0x8121 && col.frames.join() === [0x204, 0x200, 0x208].join() && same(f, 0x200, alt, 0x100, 0xc), 'colors from an alternative file: the part the frames read copied together');
  check(!!one && one.frames.join() === '31' && !r.notes.length, `one color stays as it is (${r.notes.join(' ')})`);
  const again = localizeFrames(rom, slots.slice(0, 2), { an2, alt, ram }, 0);
  check(readAltFile(rom, 0)!.length === f.length && again.slots[0]!.frames.join() === a!.frames.join(), 'importing again adds nothing');
  const missing = localizeFrames(rom, [tiles4([0xad00])], { alt: null }, 0);
  check(missing.slots[0] === null && /AN2 that is missing/.test(missing.notes.join()), 'AN2 missing: left out with a note');
  const kept = localizeFrames(rom, [{ ...tiles4([0x20]), dest: 0x8400 }], {}, 0);
  check(kept.slots[0]?.frames[0] === 0x20, 'without a foreign alternative file the slot\'s frames stay');
  const copied = localizeFrames(rom, [tiles4([0x9100])], { ram }, 0, true);
  check(!!copied.slots[0] && usesAltFile(copied.slots[0]) && copied.slots[0].frames[0] === d!.frames[0], 'a RAM slot copied on request (Animations tab): its frame found in the graphic');
  const users = altFileUsers(rom, 0);
  check(users.levels.length === 0 && !users.global, 'no list uses Anim graphic A yet');
  const l = emptyList(); l.slots.set(0, a!); writeLevelList(rom, 0x106, l);
  check(altFileUsers(rom, 0).levels.join() === '262' && altFileUsers(rom, 1).levels.length === 0, 'level 106 uses Anim graphic A, none B');
  writeAltFile(rom, 1, pattern(ALT_FILE_MAX, 5));
  const full = localizeFrames(rom, [tiles4([0xad00])], { an2: pattern(0x1000, 11) }, 1);
  check(full.slots[0] === null && /Anim graphic B is full/.test(full.notes.join()) && readAltFile(rom, 1)!.length === ALT_FILE_MAX, 'a full Anim graphic: left out with a note, unchanged');
}

console.log(bad ? `${bad} failures` : 'all ok');
if (bad) process.exitCode = 1;
