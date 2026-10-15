// Editing a level's layer 3 tilemap (layer3map.ts): the edited tilemap lands in VRAM where the level's
// LT3 file is copied to – shown by the emulator before saving (the level view, test play), saved into the
// level's LT3 file (a new one under the status bar for a level without), the level then loading it from the
// ROM; a level pixel names the tilemap entry drawn there; erasing puts in a tile without visible pixels.
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { loadLevel } from '../src/core/level.ts';
import { saveLevel } from '../src/core/save.ts';
import { importGfxFile } from '../src/core/map16file.ts';
import { gfxEntry } from '../src/core/patches.ts';
import { renderLayer3, layer3Geometry } from '../src/core/render.ts';
import { levelLayer3, setLevelLayer3, lt3Copy, type Lt3Place } from '../src/core/layer3gfx.ts';
import { L3_MAP_VRAM, L3_MAP_WORDS, NEW_LT3, layer3Map, lt3File, lt3Covers, lt3Override, layer3CellAt, layer3Index, blankLayer3Tile } from '../src/core/layer3map.ts';
import { editorImage } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const base = await editorImage();
const fresh = () => new Rom(base.slice());
const word = (v: Uint8Array, a: number) => v[a * 2] | (v[a * 2 + 1] << 8);
const LEVEL = 0x011; // a layer 3 image (the setting's)

// a tilemap of distinct words
const pattern = (seed: number) => Uint16Array.from({ length: L3_MAP_WORDS }, (_, i) => (i * 37 + seed) & 0xffff);
// entries of `map` the level shows in VRAM where the LT3 file covers it (and how many it covers) – below
// the status bar's rows of the upper screens, which the game writes its status bar over
const below = (i: number) => i >= 0x800 || (i & 0x3ff) >> 5 >= 5;
const shown = (vram: Uint8Array, map: Uint16Array, place: Lt3Place) => {
  let n = 0, ok = 0;
  for (let i = 0; i < L3_MAP_WORDS; i++) if (lt3Covers(place, i) && below(i)) { n++; if (word(vram, L3_MAP_VRAM + i) === map[i]) ok++; }
  return { n, ok };
};

// where the patch copies a file: the destination, the status bar's part skipped, up to the tilemap's end
{
  const c = lt3Copy({ dest: 0, size: 0 }), d = lt3Copy({ dest: 3, size: 0 }), e = lt3Copy({ dest: 2, size: 2 });
  check(c.vram === 0x50a0 && c.skip === 0x140 && c.len === 0x1ec0, 'under the status bar: $50A0, 0x1EC0 bytes from 0x140');
  check(d.vram === 0x5800 && d.skip === 0 && d.len === 0x1000, 'bottom half: $5800, at most 0x1000 bytes');
  check(e.vram === 0x5080 && e.skip === 0x100 && e.len === 0x700, 'last line of the status bar, 256x256: 0x700 bytes');
}

// every destination and size: the file built from a tilemap shows that tilemap where it is copied to
{
  const rom = fresh();
  let all = true;
  for (let dest = 0; dest < 4; dest++) for (let size = 0; size < 3; size++) {
    const place = { dest, size }, map = pattern(dest * 3 + size);
    importGfxFile(rom, 0x80, lt3File(map, place));
    setLevelLayer3(rom, LEVEL, { ...levelLayer3(rom, LEVEL), lt3: 0x80, dest, size });
    const emu = new LevelEmulator(rom); emu.boot();
    const r = emu.load(LEVEL), s = shown(r.vram, map, place);
    if (!r.ok || !s.n || s.ok !== s.n) { all = false; console.log(`  dest ${dest} size ${size}: ${s.ok}/${s.n}`); }
  }
  check(all, 'an LT3 file built from a tilemap shows it, for every destination and size');
}

// before saving: the emulator shows the edited tilemap (the level view, test play), the ROM unchanged
{
  const rom = fresh(), before = rom.data.slice();
  const emu = new LevelEmulator(rom); emu.boot();
  const map = pattern(5), lv = loadLevel(rom, LEVEL);
  lv.layer3 = map;
  const r = emu.load(LEVEL, { layer3: lt3Override(rom, lv) }), s = shown(r.vram, map, NEW_LT3);
  check(r.ok && s.n > 0 && s.ok === s.n, `the edited tilemap in VRAM before saving (${s.ok}/${s.n})`);
  check(rom.data.every((b, i) => b === before[i]), 'the ROM is unchanged');
  const plain = emu.load(LEVEL);
  check(shown(plain.vram, map, NEW_LT3).ok < 100, 'without it: the level\'s own layer 3');
}

// saving: a level without an LT3 file gets a new one under the status bar; saving again writes into it
{
  const rom = fresh();
  const lv = loadLevel(rom, LEVEL);
  lv.layer3 = pattern(9);
  saveLevel(rom, lv);
  const g = levelLayer3(rom, LEVEL), e = g.lt3 !== 0xff ? gfxEntry(rom, g.lt3) : null;
  check(!!e && e.raw && e.size === 0x2000 && g.dest === NEW_LT3.dest && g.size === NEW_LT3.size, 'a new LT3 file (0x2000 bytes, under the status bar)');
  check(lv.layer3 === null, 'the level has no unsaved layer 3 edit after saving');
  let emu = new LevelEmulator(rom); emu.boot();
  let s = shown(emu.load(LEVEL).vram, pattern(9), NEW_LT3);
  check(s.n > 0 && s.ok === s.n, `the level loads the saved tilemap from the ROM (${s.ok}/${s.n})`);
  check(levelLayer3(rom, 0x105).lt3 === 0xff, 'other levels keep theirs');
  const lv2 = loadLevel(rom, LEVEL);
  lv2.layer3 = pattern(11);
  saveLevel(rom, lv2);
  const g2 = levelLayer3(rom, LEVEL);
  check(g2.lt3 === g.lt3 && gfxEntry(rom, g2.lt3)!.addr === e!.addr, 'saved again: into the same file');
  emu = new LevelEmulator(rom); emu.boot();
  s = shown(emu.load(LEVEL).vram, pattern(11), NEW_LT3);
  check(s.ok === s.n, 'the level shows it');
}

// a level with its own LT3 file (the bottom half, 0x1000 bytes): edits go into its bytes, its place stays
{
  const rom = fresh();
  const file = Uint8Array.from({ length: 0x1000 }, (_, i) => (i * 13) & 0xff);
  importGfxFile(rom, 0x81, file);
  const place = { dest: 3, size: 1 };
  setLevelLayer3(rom, LEVEL, { ...levelLayer3(rom, LEVEL), lt3: 0x81, ...place });
  const lv = loadLevel(rom, LEVEL);
  lv.layer3 = pattern(3);
  saveLevel(rom, lv);
  const g = levelLayer3(rom, LEVEL), e = gfxEntry(rom, 0x81)!;
  check(g.lt3 === 0x81 && g.dest === 3 && g.size === 1 && e.size === 0x1000, 'the level keeps its file and place');
  const emu = new LevelEmulator(rom); emu.boot();
  const s = shown(emu.load(LEVEL).vram, pattern(3), place);
  check(s.n === 0x800 && s.ok === s.n, `the bottom half shows the edit (${s.ok}/${s.n})`);
  check(!lt3Covers(place, 0) && lt3Covers(place, 0x800), 'only the part the file is copied to can be edited');
}

// a level pixel names the tilemap entry drawn there: erasing that entry clears just its 8x8 tile
{
  const rom = fresh();
  const emu = new LevelEmulator(rom); emu.boot();
  const r = emu.load(LEVEL), W = 512, H = 432;
  const img = renderLayer3(r, W, H)!;
  const g = layer3Geometry(r);
  let px = -1, py = -1;
  for (let i = 0; i < img.back.length && px < 0; i++) if (img.back[i] || img.front[i]) { px = i % W; py = Math.floor(i / W); }
  const c = layer3CellAt(g, px, py), at = layer3Index(g, c.cx, c.cy);
  const blank = blankLayer3Tile(r);
  const charBase = (r.ppuRegs[0x0c] & 0x0f) << 13;
  check(r.vram.subarray(charBase + blank * 16, charBase + blank * 16 + 16).every((b) => b === 0), `the blank tile (${blank.toString(16)}) has no visible pixel`);
  const lv = loadLevel(rom, LEVEL), map = layer3Map(r.vram);
  check(at >= 0 && map[at] === word(r.vram, L3_MAP_VRAM + at), 'the entry under a drawn pixel');
  map[at] = blank;
  lv.layer3 = map;
  const r2 = emu.load(LEVEL, { layer3: lt3Override(rom, lv) });
  const img2 = renderLayer3(r2, W, H)!;
  let changed = 0, outside = 0;
  for (let i = 0; i < W * H; i++) {
    if (img.back[i] === img2.back[i] && img.front[i] === img2.front[i]) continue;
    changed++;
    const q = layer3CellAt(g, i % W, Math.floor(i / W));
    if (layer3Index(g, q.cx, q.cy) !== at) outside++;
  }
  check(changed > 0 && !outside && !img2.back[py * W + px], `erasing it clears its tile only (${changed} pixels, ${outside} elsewhere)`);
  check(layer3Index(g, c.cx, 4) === -1 && layer3Index(g, c.cx, 5) >= 0, 'the status bar\'s rows are not part of it');
}

if (bad) { console.log(`${bad} FAILED`); process.exit(1); }
console.log('all ok');
