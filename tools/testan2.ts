// AN2 (patches.ts, "SMWN"): the first 3 KB of a level's AN2 file are in RAM from $7EAD00 once the level
// has loaded and stay there while it is played, the level's BG tilemap after it stays intact; ExAnimation copies frames from it into VRAM; levels without AN2 are as before;
// only uncompressed 4bpp files can be AN2.
import { readFileSync } from 'node:fs';
import { Rom } from '../src/core/rom.ts';
import { loadAsar } from '../src/core/asar.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { installEditorPatch, setLevelAn2, levelAn2, fixAn2Patch, AN2_SIZE } from '../src/core/patches.ts';
import { importGfxFile } from '../src/core/map16file.ts';
import { emptyList, writeLevelList } from '../src/core/exanim.ts';

await loadAsar();
let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const fresh = () => new Rom(new Uint8Array(readFileSync('test/fixtures/smw.smc')));

const file = new Uint8Array(0x1000); for (let i = 0; i < file.length; i++) file[i] = (i * 7 + 3) & 0xff;
const rom = fresh();
installEditorPatch(rom);
importGfxFile(rom, 0x90, file);
importGfxFile(rom, 0x91, new Uint8Array(0xc00).fill(0x11)); // 3bpp
setLevelAn2(rom, 0x105, 0x90);
check(levelAn2(rom, 0x105) === 0x90 && levelAn2(rom, 0x106) === 0xff, 'AN2 of level 105 set, 106 none');
let err = '';
try { setLevelAn2(rom, 0x106, 0x91); } catch (e) { err = String(e); }
check(/only uncompressed 4bpp/.test(err), '3bpp file refused as AN2');

// a slot copying 4 tiles from $7EAD80 (the file's tiles 4-7) to VRAM $0400 (FG tiles 40-43), always
const list = emptyList();
list.count = 1;
list.slots.set(0, { type: 0x04, trigger: 0x00, framesLess1: 0, dest: 0x0400, frames: [0xad80] });
writeLevelList(rom, 0x105, list);

const e = new LevelEmulator(rom); e.boot();
const l = e.load(0x105);
const same = (w: Uint8Array, at: number, src: Uint8Array, from: number, n: number) => { for (let i = 0; i < n; i++) if (w[at + i] !== src[from + i]) return false; return true; };
check(l.ok && same(l.wram, 0xad00, file, 0, AN2_SIZE), 'level 105 loaded: its AN2 file at $7EAD00-$7EB8FF');
{
  const v = fresh();
  const ev = new LevelEmulator(v); ev.boot();
  const bg = ev.load(0x105).wram.slice(0xb900, 0xc100);
  check(bg.every((x, i) => x === l.wram[0xb900 + i]), 'the BG tilemap at $7EB900-$7EC0FF as without AN2');
}
const s = e.snes;
for (let i = 0; i < 120; i++) { s.joy1 = i % 40 < 30 ? 0x0100 : 0; s.runFrame(); }
check(same(s.wram, 0xad00, file, 0, AN2_SIZE), 'after 2 seconds of play: still there');
check(same(s.vram, 0x0400 * 2, file, 0x80, 0x80), 'ExAnimation copied tiles 4-7 of AN2 into VRAM $0400');

const l6 = e.load(0x106);
check(l6.ok && !same(l6.wram, 0xad00, file, 0, 0x100), 'level 106 (no AN2): RAM as in the game');
{
  const v = fresh();
  const ev = new LevelEmulator(v); ev.boot();
  const a = ev.load(0x106).wram.slice(0xad00, 0xbd00);
  check(a.every((x, i) => x === l6.wram[0xad00 + i]), 'level 106 with the patch: $7EAD00-$7EBCFF as without it');
}


// a patch of an earlier version copying 4 KB is fixed to 3 KB
{
  const r = fresh();
  installEditorPatch(r);
  importGfxFile(r, 0x90, file);
  setLevelAn2(r, 0x105, 0x90);
  const code = r.r24(0x00a5bf + 1);
  let at = -1;
  for (let a = code; a < code + 0x60 && at < 0; a++) if (r.r8(a) === 0xa0 && r.r8(a + 1) === 0xfe && r.r8(a + 2) === 0x0b) at = a;
  r.w8(at + 2, 0x0f); // as installed before
  check(fixAn2Patch(r) && r.r8(at + 2) === 0x0b && !fixAn2Patch(r), 'old 4 KB AN2 patch fixed once');
}

console.log(bad ? `${bad} failures` : 'all ok');
if (bad) process.exitCode = 1;
