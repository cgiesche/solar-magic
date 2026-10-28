// Layer 3 graphics and tilemap per level (layer3gfx.ts, Lunar Magic's layer 3 bypass): levels without them
// load layer 3 as in the clean game; LG1-LG4 put their files into VRAM $4000-$4FFF (raw and compressed
// ones), the next level without its own and the overworld get the game's 28-2B back; LT3 lands where
// Lunar Magic puts it for each destination and size (as observed in a Lunar Magic-saved ROM) instead of
// the image of the level's layer 3 setting.
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { importGfxFile } from '../src/core/gfxfiles.ts';
import { GM, RAM } from '../src/core/ram.ts';
import { PlaySession } from '../src/core/playsession.ts';
import { levelLayer3, setLevelLayer3, layer3Entry, fitsLayer3Slot, lt3SizeFor, LT3_SIZES, type Layer3Gfx } from '../src/core/layer3gfx.ts';
import { setGfxEntry } from '../src/core/patches.ts';
import { cleanImage, editorImage } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const ev = new LevelEmulator(new Rom(cleanImage())); ev.boot();
const base = await editorImage();
const fresh = () => new Rom(base.slice());

const word = (v: Uint8Array, a: number) => v[a * 2] | (v[a * 2 + 1] << 8);
// VRAM words [from, to) that differ between two images
const differ = (a: Uint8Array, b: Uint8Array, from: number, to: number) => { let n = 0; for (let i = from; i < to; i++) if (word(a, i) !== word(b, i)) n++; return n; };
const none: Layer3Gfx = { lt3: 0xff, dest: 0, size: 0, lg: [0xff, 0xff, 0xff, 0xff] };

{
  const rom = fresh();
  check(!!layer3Entry(rom), 'installed with the editor patches');
  const g = levelLayer3(rom, 0x105);
  check(g.lt3 === 0xff && g.lg.every((x) => x === 0xff), 'levels have no layer 3 files of their own');
  // layer 3 as in the clean game: graphics, tilemap (none, tides, images)
  const emu = new LevelEmulator(rom); emu.boot();
  let d = 0;
  for (const n of [0x105, 0x127, 0x002, 0x01f, 0x009, 0x011, 0x0c7]) {
    const a = ev.load(n), b = emu.load(n);
    const k = differ(a.vram, b.vram, 0x4000, 0x6000);
    if (k) console.log(`  level ${n.toString(16)}: ${k} words differ`);
    d += k;
  }
  check(!d, 'levels without them: layer 3 graphics and tilemap as in the clean game');
}

// LG1 a raw 2bpp file, LG2 the game's compressed file 2B, LG3/LG4 the game's own
{
  const rom = fresh();
  const lg = new Uint8Array(0x800); for (let i = 0; i < lg.length; i++) lg[i] = (i * 7 + 3) & 0xff;
  importGfxFile(rom, 0x80, lg);
  setLevelLayer3(rom, 0x105, { ...none, lg: [0x80, 0x2b, 0xff, 0xff] });
  const emu = new LevelEmulator(rom); emu.boot();
  const r = emu.load(0x105), c = ev.load(0x105);
  let eq = 0; for (let i = 0; i < 0x800; i++) if (r.vram[0x8000 + i] === lg[i]) eq++;
  check(r.ok && eq === 0x800, `LG1: the raw file in VRAM $4000 (${eq}/2048)`);
  check(!differ(r.vram, c.vram, 0x4c00, 0x5000) && !differ(r.vram.subarray(0x8800), c.vram.subarray(0x9800), 0, 0x400), 'LG2: file 2B (compressed) in VRAM $4400');
  check(!differ(r.vram, c.vram, 0x4800, 0x4c00), 'LG3: the game\'s file 2A');
  // from there into a level without its own files (through a sublevel exit, as a pipe), and to the
  // overworld: the game's files again
  const s = emu.snes, w = s.wram, inLevel = s.saveState(), p = PlaySession.resume(emu);
  w[RAM.sublevelCount] = 1; w[RAM.screenExitLo] = 0x06; w[RAM.useSecondaryExit] = 0; w[RAM.gameMode] = GM.levelLoad;
  check(p.follow() === 'level' && !differ(s.vram, c.vram, 0x4000, 0x5000), 'a level without them after it: layer 3 graphics 28-2B again');
  s.loadState(inLevel);
  w[RAM.gameMode] = GM.overworldLoad;
  const there = p.follow();
  const s0 = ev.snes;
  s0.wram[RAM.gameMode] = GM.overworldLoad;
  PlaySession.resume(ev).follow();
  check(there === 'overworld' && !differ(s.vram, s0.vram, 0x4000, 0x5000), 'the overworld after it: layer 3 graphics 28-2B as in the clean game');
}

// which files the slots take: LG 2bpp graphics (uncompressed or the game's compressed ones), LT3 uncompressed
// files at least as long as the size; another size can't be stored as uncompressed
{
  const rom = fresh();
  importGfxFile(rom, 0x80, new Uint8Array(0x800)); importGfxFile(rom, 0x81, new Uint8Array(0x1000)); importGfxFile(rom, 0x82, new Uint8Array(0x2000));
  check(fitsLayer3Slot(rom, 'LG1', 0x80) && fitsLayer3Slot(rom, 'LG1', 0x2b) && !fitsLayer3Slot(rom, 'LG1', 0x81) && !fitsLayer3Slot(rom, 'LG1', 0x14), 'LG: 2bpp files only');
  check(fitsLayer3Slot(rom, 'LT3', 0x82, 0x2000) && !fitsLayer3Slot(rom, 'LT3', 0x81, 0x2000) && fitsLayer3Slot(rom, 'LT3', 0x81) && !fitsLayer3Slot(rom, 'LT3', 0x2b), 'LT3: uncompressed files of the size');
  check(LT3_SIZES[lt3SizeFor(0x1000)] === 0x1000 && LT3_SIZES[lt3SizeFor(0x2000)] === 0x2000 && LT3_SIZES[lt3SizeFor(0x800)] === 0x800, 'LT3: the size a file has room for');
  let thrown = false; try { setGfxEntry(rom, 0x83, 0x108000, true, 0x900); } catch { thrown = true; }
  check(thrown, 'an uncompressed file of another size is refused');
}

// LT3: each destination and size; level 105 (no layer 3 image) and 01F (its setting has one, which the
// file replaces)
{
  const exp = [ // destination: first VRAM word, words of the file skipped, last VRAM word + 1 at most
    { vram: 0x50a0, skip: 0xa0 }, { vram: 0x5000, skip: 0 }, { vram: 0x5080, skip: 0x80 }, { vram: 0x5800, skip: 0 },
  ];
  let fails = 0;
  for (const n of [0x105, 0x01f]) for (let dest = 0; dest < 4; dest++) for (let size = 0; size < 3; size++) {
    const rom = fresh();
    const bytes = LT3_SIZES[size];
    const file = new Uint8Array(bytes); for (let i = 0; i < bytes / 2; i++) { file[i * 2] = i & 0xff; file[i * 2 + 1] = 0x20 | ((i >> 8) & 0x1f); }
    importGfxFile(rom, 0x81, file);
    setLevelLayer3(rom, n, { ...none, lt3: 0x81, dest, size });
    const emu = new LevelEmulator(rom); emu.boot();
    const r = emu.load(n);
    const e = exp[dest], end = Math.min(0x6000, e.vram + bytes / 2 - e.skip);
    // the game writes the status bar's tile numbers (low bytes) each frame, also over a file at the start
    // of layer 3
    const c = ev.load(n);
    let wrong = 0;
    for (let a = e.vram; a < end; a++) if (word(r.vram, a) !== word(file, a - e.vram + e.skip) && !(a < 0x50a0 && r.vram[a * 2] === c.vram[a * 2] && r.vram[a * 2 + 1] === file[(a - e.vram + e.skip) * 2 + 1])) wrong++;
    // before the destination: as in the clean game (the status bar's part)
    const before = n === 0x105 ? differ(r.vram, c.vram, 0x5000, e.vram) : 0;
    if (!r.ok || wrong || before) { fails++; console.log(`  level ${n.toString(16)} destination ${dest} size ${size}: ${wrong} words wrong, ${before} before it`); }
  }
  check(!fails, 'LT3: every destination and size where Lunar Magic puts it');
}

console.log(bad ? `${bad} FAILED` : 'all ok');
process.exit(bad ? 1 : 0);
