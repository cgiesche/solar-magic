// Animation frames come from the Anim graphics only (ADR 0003): frames of other lists (a level file's,
// AN2's) are copied into an Anim graphic, identical frames once, the slots pointing there
// (localizeFrames); a ROM with the editor's former AN2 patch ("SMWN") gets its levels' AN2 frames moved
// there and the patch removed, the animations in the game unchanged.
import { readFileSync } from 'node:fs';
import { Rom } from '../src/core/rom.ts';
import { loadAsar } from '../src/core/asar.ts';
import { Asm } from '../src/core/asm.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { installEditorPatch } from '../src/core/patches.ts';
import { importGfxFile } from '../src/core/map16file.ts';
import { emptyList, writeLevelList, readLevelList, readAltFile, writeAltFile, localizeFrames, usesAltFile, altFileUsers, ALT_FILE_MAX, type ExSlot } from '../src/core/exanim.ts';
import { migrateAn2 } from '../src/core/an2legacy.ts';

await loadAsar();
let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const fresh = () => new Rom(new Uint8Array(readFileSync('test/fixtures/smw.smc')));
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
    { type: 0x14, trigger: 0, framesLess1: 0, dest: 0x8021, frames: [0x1f] }, // colors from the alternative file
  ];
  const r = localizeFrames(rom, slots, { an2, alt, ram }, 0);
  const f = readAltFile(rom, 0)!;
  const [a, b, c, d, e, col] = r.slots;
  check(!!f && f.length === 0x80 * 4, `Anim graphic A: 4 distinct frames of 4 tiles (${f?.length.toString(16)})`);
  check(!!a && usesAltFile(a) && same(f, a.frames[0], an2, 0, 0x80) && same(f, a.frames[1], an2, 0x80, 0x80), 'AN2 frames copied, the slot reads the Anim graphic');
  check(!!b && b.frames[0] === a!.frames[1], 'the same frame stored once');
  check(!!c && c.dest === 0x0400 && c.frames[0] === 0x9100, 'a slot with RAM frames only stays');
  check(!!d && usesAltFile(d) && same(f, d.frames[0], ram, 0x9100, 0x80) && d.frames[1] === a!.frames[0], 'RAM frames of a slot with AN2 frames come from WRAM');
  check(!!e && same(f, e.frames[0], alt, 0x40, 0x80) && (e.dest & 0x7fff) === 0x0400, 'frames from the level file\'s alternative file');
  check(col === null && r.notes.some((n) => /colors from an alternative file/.test(n)), 'colors from an alternative file left out with a note');
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

// ---- the former AN2 patch ----
// as the editor installed it (3 KB to $7EAD00 from the level load's JSL $05BE8A at $00A5BF)
function legacyAn2(rom: Rom): number {
  const p = installEditorPatch(rom);
  const a = new Asm();
  a.b(0x53, 0x4d, 0x57, 0x4e); a.fill(4);
  a.label('An2');
  a.b(0x08, 0xc2, 0x30, 0x48, 0xda, 0x5a, 0xa5, 0x00, 0x48, 0xa5, 0x01, 0x48, 0xe2, 0x20);
  a.b(0xaf, 0x00, 0x01, 0x7e, 0xc9, 0x0b); a.br(0x90, 'lv');
  a.b(0xc9, 0x0f); a.br(0x90, 'out');
  a.label('lv');
  a.b(0xc2, 0x20, 0xaf, 0x0b, 0x01, 0x7e, 0x29, 0xff, 0x01, 0xaa, 0xe2, 0x20);
  a.long(0xbf, 'Tbl');
  a.b(0xc9, 0xff); a.br(0xf0, 'out');
  a.b(0xc2, 0x20, 0x29, 0xff, 0x00, 0xaa, 0xe2, 0x20);
  a.b(0xbf).l(p.gfxFlags); a.br(0xf0, 'out');
  a.b(0xbf).l(p.gfxLo); a.b(0x85, 0x00);
  a.b(0xbf).l(p.gfxHi); a.b(0x85, 0x01);
  a.b(0xbf).l(p.gfxBank); a.b(0x85, 0x02);
  a.b(0xc2, 0x30, 0xa0).w(0xbfe);
  a.label('cp');
  a.b(0xb7, 0x00, 0xbb, 0x9f).l(0x7ead00);
  a.b(0x88, 0x88); a.br(0x10, 'cp');
  a.label('out');
  a.b(0xc2, 0x30, 0x68, 0x85, 0x01, 0x68, 0x85, 0x00, 0x7a, 0xfa, 0x68, 0x28);
  a.b(0x5c).l(0x05be8a);
  a.label('Tbl');
  a.fill(512, 0xff);
  const addr = rom.allocWrite(new Uint8Array(a.bytes.length));
  rom.writeBytes(addr, a.link(addr));
  rom.w24(addr + 4, a.addrOf('Tbl', addr));
  const t = a.addrOf('An2', addr);
  rom.writeBytes(0x00a5bf, Uint8Array.from([0x22, t & 0xff, (t >> 8) & 0xff, t >> 16]));
  return a.addrOf('Tbl', addr);
}
{
  const rom = fresh();
  const file = pattern(0x1000, 7);
  importGfxFile(rom, 0x90, file);
  const tbl = legacyAn2(rom);
  rom.w8(tbl + 0x105, 0x90);
  const list = emptyList();
  list.slots.set(0, { type: 0x04, trigger: 0, framesLess1: 0, dest: 0x0600, frames: [0xad80] }); // AN2 tiles 4-7 to FG tiles 60-63
  list.slots.set(1, { type: 0x01, trigger: 0, framesLess1: 0, dest: 0x0700, frames: [0x7d00] }); // the game's graphics only
  writeLevelList(rom, 0x105, list);
  const vramAfterPlay = (r: Rom) => { const e = new LevelEmulator(r); e.boot(); e.load(0x105); for (let i = 0; i < 30; i++) e.snes.runFrame(); return e.snes.vram.slice(); };
  const before = vramAfterPlay(rom);
  check(same(before, 0x0600 * 2, file, 0x80, 0x80), 'with the old patch: AN2 tiles 4-7 in VRAM $0600');
  const m = migrateAn2(rom);
  const hook = [...rom.bytes(0x00a5bf, 4)].join();
  check(!!m && m.levels.join() === '261' && hook === [0x22, 0x8a, 0xbe, 0x05].join(), `migrated level 105, hook back to JSL $05BE8A (${hook})`);
  const after = readLevelList(rom, 0x105)!;
  check(usesAltFile(after.slots.get(0)!) && !usesAltFile(after.slots.get(1)!) && after.slots.get(1)!.frames[0] === 0x7d00, 'the AN2 slot reads the Anim graphic, the other one RAM as before');
  const v = vramAfterPlay(rom);
  check(same(v, 0x0600 * 2, file, 0x80, 0x80) && same(v, 0x0700 * 2, before, 0x0700 * 2, 0x20), 'in the game: the same tiles in VRAM as before');
  check(migrateAn2(rom) === null, 'nothing left to migrate');
}

console.log(bad ? `${bad} failures` : 'all ok');
if (bad) process.exitCode = 1;
