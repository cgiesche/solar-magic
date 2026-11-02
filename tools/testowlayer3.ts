// A submap's layer 3 tilemap edited in 8x8 tiles (issue #264, core/owlayer3.ts): an edit is saved into the submap's
// LT3 file – a new one at the start of layer 3 (0x800 bytes) where it has none, in place where it has one – and the
// overworld loads it there (emulated): the painted tiles where they were painted, the rest of the border as before,
// the level name and the lives drawn over it by the game; other submaps keep theirs. The grid places the screen's
// tiles at the load's camera. lt3Users names the submaps using a file.
// node tools/testowlayer3.ts
import { Rom } from '../src/core/rom.ts';
import { OverworldEmulator } from '../src/core/overworld.ts';
import { levelLayer3, setLevelLayer3 } from '../src/core/layer3gfx.ts';
import { gfxEntry, submapGfxEntry } from '../src/core/patches.ts';
import { importGfxFile } from '../src/core/gfxfiles.ts';
import { lt3Users, layer3Word } from '../src/core/layer3map.ts';
import { cameraX, cameraY } from '../src/core/ram.ts';
import { submapLt3Target, submapLayer3, saveSubmapLayer3, owLayer3Grid, lt3UserText, OW_L3_COLS, OW_L3_ROWS } from '../src/core/owlayer3.ts';
import { editorImage } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const rom = new Rom(await editorImage());
const MAP = 1; // Yoshi's Island
const load = (m = MAP) => new OverworldEmulator(rom).load(m, 0);
const words = (v: Uint8Array) => Array.from({ length: 0x400 }, (_, i) => layer3Word(v, i)); // the screen's quadrant
const PAINT = 0x3955;

const before = load(), other = load(2);
const g = owLayer3Grid(before);
check(g.x === ((cameraX(before.wram) << 16) >> 16) && g.y === ((cameraY(before.wram) << 16) >> 16) && g.entry(0, 0) === 0 && g.entry(31, 27) === 27 * 32 + 31,
  `the grid: the screen at the camera (${g.x}, ${g.y}), cell (c, r) entry r * 32 + c`);
check(submapLt3Target(rom, MAP).file === null, 'Yoshi\'s Island has no LT3 file');

// the cells painted: a block inside the border's window, and the level name's row
const block: number[] = [];
for (let r = 10; r < 13; r++) for (let c = 8; c < 14; c++) block.push(g.entry(c, r));
const nameRow = Array.from({ length: 19 }, (_, k) => g.entry(11 + k, 4));
{
  const map = submapLayer3(rom, MAP, before.vram);
  check(words(before.vram).every((w, i) => map[i] === w), 'with no file the edit starts from the border as shown');
  for (const i of [...block, ...nameRow]) map[i] = PAINT;
  const said = saveSubmapLayer3(rom, MAP, map);
  const l = levelLayer3(rom, submapGfxEntry(MAP)), e = gfxEntry(rom, l.lt3);
  check(l.lt3 !== 0xff && !!e && e.raw && e.size === 0x800 && l.dest === 1 && l.size === 2, `a new LT3 file at the start of layer 3, 0x800 bytes (${said})`);
}
let after = load();
{
  const a = words(after.vram), b = words(before.vram);
  check(block.every((i) => a[i] === PAINT), 'the painted tiles are shown where they were painted');
  check(nameRow.every((i) => a[i] === b[i]), 'the level name is drawn over them by the game');
  const set = new Set([...block, ...nameRow]);
  const off = a.flatMap((w, i) => (!set.has(i) && w !== b[i] ? [i] : []));
  check(!off.length, `the rest of the border as before, the lives too${off.length ? ` (differ: ${off.slice(0, 8).map((i) => i.toString(16)).join(' ')})` : ''}`);
  check(words(load(2).vram).every((w, i) => w === words(other.vram)[i]), 'Vanilla Dome keeps the game\'s border');
}

// editing again: into the same file; the file's words kept under what the game draws over them
{
  const file = levelLayer3(rom, submapGfxEntry(MAP)).lt3;
  const map = submapLayer3(rom, MAP, after.vram);
  check(nameRow.every((i) => map[i] === PAINT), 'the edit starts from the file\'s words, not the name drawn over them');
  map[g.entry(5, 20)] = PAINT;
  saveSubmapLayer3(rom, MAP, map);
  check(levelLayer3(rom, submapGfxEntry(MAP)).lt3 === file, 'saved again: into the same file');
  after = load();
  check(layer3Word(after.vram, g.entry(5, 20)) === PAINT && block.every((i) => layer3Word(after.vram, i) === PAINT), 'the overworld shows both edits');
}

// a file of its own (0x2000 bytes, the start of layer 3): edits go into its bytes, its place stays
{
  const f = new Uint8Array(0x2000);
  for (let i = 0; i < f.length; i += 2) { f[i] = 0xfe; f[i + 1] = 0x38; }
  importGfxFile(rom, 0xe81, f);
  setLevelLayer3(rom, submapGfxEntry(3), { ...levelLayer3(rom, submapGfxEntry(3)), lt3: 0xe81, dest: 1, size: 0 });
  const r = load(3), map = submapLayer3(rom, 3, r.vram);
  map[owLayer3Grid(r).entry(2, 2)] = PAINT;
  saveSubmapLayer3(rom, 3, map);
  const l = levelLayer3(rom, submapGfxEntry(3));
  check(l.lt3 === 0xe81 && l.dest === 1 && l.size === 0 && gfxEntry(rom, 0xe81)!.size === 0x2000, 'Forest of Illusion keeps its file and place');
  check(layer3Word(load(3).vram, owLayer3Grid(r).entry(2, 2)) === PAINT, 'and shows the edit');
  // the same file used by a level and another submap
  setLevelLayer3(rom, 0x105, { ...levelLayer3(rom, 0x105), lt3: 0xe81, dest: 0, size: 0 });
  setLevelLayer3(rom, submapGfxEntry(4), { ...levelLayer3(rom, submapGfxEntry(4)), lt3: 0xe81, dest: 1, size: 0 });
  const users = lt3Users(rom, 0xe81);
  check(users.join() === [0x105, submapGfxEntry(3), submapGfxEntry(4)].join() && lt3UserText(users) === 'level 105, Forest of Illusion, Valley of Bowser',
    `the file's users: ${lt3UserText(users)}`);
}

// every tile of the screen painted (Special World): the game draws over row 4 only – the lives and the level name
{
  const r = load(5), gr = owLayer3Grid(r), map = submapLayer3(rom, 5, r.vram);
  for (let y = 0; y < OW_L3_ROWS; y++) for (let x = 0; x < OW_L3_COLS; x++) map[gr.entry(x, y)] = PAINT;
  saveSubmapLayer3(rom, 5, map);
  const a = load(5), over: string[] = [];
  for (let y = 0; y < OW_L3_ROWS; y++) for (let x = 0; x < OW_L3_COLS; x++) if (layer3Word(a.vram, gr.entry(x, y)) !== PAINT) over.push(`${x},${y}`);
  check(over.every((p) => p.endsWith(',4')) && Array.from({ length: 19 }, (_, k) => `${11 + k},4`).every((p) => over.includes(p)),
    `the whole screen painted: the game draws over row 4 only, the lives and the name (${over.join(' ')})`);
}

if (bad) { console.log(`\n${bad} FAILED`); process.exit(1); }
console.log('\nall ok');
