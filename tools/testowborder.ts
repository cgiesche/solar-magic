// The overworld border edited as a screen (issue #330, core/owlayer3.ts): every map's screen has all its 32x28 cells
// in the tilemap; the cells the game writes the lives and the level name over (owL3GameWrites) are those an emulated
// load draws over a border painted whole, and a brush leaves them out (borderStamp); where a submap's
// border is saved and who else uses its file (submapBorderFile); a file of its own for a submap sharing one
// (ownBorderFile: the others keep theirs, it shows the same); another submap's border taken (takeBorder);
// the game's border back (resetBorder); the screen behind the border as the game shows it (owScreen: without
// layer 3).
// node tools/testowborder.ts
import { Rom } from '../src/core/rom.ts';
import { OverworldEmulator, OverworldLoads } from '../src/core/overworld.ts';
import { levelLayer3, setLevelLayer3 } from '../src/core/layer3gfx.ts';
import { submapGfxEntry } from '../src/core/patches.ts';
import { gfxBytes, importGfxFile } from '../src/core/gfxfiles.ts';
import { layer3Word } from '../src/core/layer3map.ts';
import {
  submapLayer3, saveSubmapLayer3, owLayer3Grid, OW_L3_COLS, OW_L3_ROWS,
  owL3GameWrites, borderStamp, submapBorderFile, submapLt3Target, ownBorderFile, takeBorder, resetBorder, owScreen,
} from '../src/core/owlayer3.ts';
import { refusalOf } from '../src/core/owrefusal.ts';
import { editorImage } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const rom = new Rom(await editorImage());
const load = (m: number) => new OverworldEmulator(rom).load(m, 0);
const PAINT = 0x3955;
// the border's words on the screen, cell by cell (row 4's game cells left out: `game` false)
const screen = (m: number, game = true) => {
  const r = load(m), g = owLayer3Grid(r), out: number[] = [];
  for (let y = 0; y < OW_L3_ROWS; y++) for (let x = 0; x < OW_L3_COLS; x++) if (game || !owL3GameWrites(x, y)) out.push(layer3Word(r.vram, g.entry(x, y)));
  return out;
};
const same = (a: number[], b: number[]) => a.length === b.length && a.every((w, i) => w === b[i]);

const games = Array.from({ length: 7 }, (_, m) => screen(m));

// every cell of every map's screen is in the tilemap, each its own (Vanilla Dome's left columns too)
{
  const missing: string[] = [];
  for (let m = 0; m < 7; m++) {
    const g = owLayer3Grid(load(m)), seen = new Set<number>();
    for (let y = 0; y < OW_L3_ROWS; y++) for (let x = 0; x < OW_L3_COLS; x++) { const i = g.entry(x, y); if (i < 0 || seen.has(i)) missing.push(`${m}:${x},${y}`); seen.add(i); }
  }
  check(!missing.length, `all 32x28 cells of every map's screen in the tilemap${missing.length ? ` (not: ${missing.slice(0, 8).join(' ')})` : ''}`);
}

// a brush over row 4 paints around the game's cells; a cell showing the brush's word already isn't painted
{
  const r = load(1), g = owLayer3Grid(r), place = submapLt3Target(rom, 1).place;
  const b = { w: 4, h: 2, tiles: Array(8).fill(PAINT) };
  const cells = [...borderStamp(g, place, b, 7, 3, (i) => layer3Word(r.vram, i)).keys()].map((i) => `${i % 32},${i >> 5}`).sort();
  check(cells.join(' ') === ['7,3', '8,3', '9,3', '10,3', '7,4', '10,4'].sort().join(' '), `a 4x2 brush at (7, 3): row 4's lives (8, 9) left out (${cells.join(' ')})`);
  check(borderStamp(g, place, { w: 1, h: 1, tiles: [layer3Word(r.vram, g.entry(2, 10))] }, 2, 10, (i) => layer3Word(r.vram, i)).size === 0, 'the word shown already: nothing painted');
  check(borderStamp(g, place, b, 30, 26, () => -1).size === 4, 'a brush past the screen\'s edge: its cells on the screen only');
}

// the game's cells: a border painted whole, the load draws over these and only these
{
  const r = load(5), g = owLayer3Grid(r), map = submapLayer3(rom, 5, r.vram);
  for (let y = 0; y < OW_L3_ROWS; y++) for (let x = 0; x < OW_L3_COLS; x++) map[g.entry(x, y)] = PAINT;
  saveSubmapLayer3(rom, 5, map);
  const a = load(5), over: string[] = [], said: string[] = [];
  for (let y = 0; y < OW_L3_ROWS; y++) for (let x = 0; x < OW_L3_COLS; x++) {
    if (layer3Word(a.vram, g.entry(x, y)) !== PAINT) over.push(`${x},${y}`);
    if (owL3GameWrites(x, y)) said.push(`${x},${y}`);
  }
  check(over.join(' ') === said.join(' '), `the game's cells are those the load draws over (${said.length}: row 4, ${said.map((p) => p.split(',')[0]).join(' ')})`);
}

// where it is saved
{
  const yi = submapBorderFile(rom, 1);
  check(yi.file === null && !yi.others.length, 'Yoshi\'s Island: still the game\'s border, no file');
  const sw = submapBorderFile(rom, 5);
  check(sw.file !== null && !sw.others.length, `Special World: its own file ${sw.file?.toString(16)}`);
}

// a file shared by Forest of Illusion, Valley of Bowser and level 105: Valley of Bowser gets one of its own
{
  const f = new Uint8Array(0x800);
  for (let i = 0; i < f.length; i += 2) { f[i] = 0x95; f[i + 1] = 0x39; }
  importGfxFile(rom, 0xe81, f);
  for (const m of [3, 4]) setLevelLayer3(rom, submapGfxEntry(m), { ...levelLayer3(rom, submapGfxEntry(m)), lt3: 0xe81, dest: 1, size: 2 });
  setLevelLayer3(rom, 0x105, { ...levelLayer3(rom, 0x105), lt3: 0xe81, dest: 0, size: 2 });
  const shared = submapBorderFile(rom, 4);
  check(shared.file === 0xe81 && shared.others.join() === [0x105, submapGfxEntry(3)].join(), 'Valley of Bowser shares ExGFX E81 with level 105 and Forest of Illusion');
  const before = screen(4), said = ownBorderFile(rom, 4), own = levelLayer3(rom, submapGfxEntry(4));
  check(own.lt3 !== 0xe81 && own.lt3 !== 0xff && levelLayer3(rom, submapGfxEntry(3)).lt3 === 0xe81 && levelLayer3(rom, 0x105).lt3 === 0xe81,
    `own copy: Valley of Bowser uses a new file (${said}), the others keep E81`);
  const a = gfxBytes(rom, own.lt3)!.data, b = gfxBytes(rom, 0xe81)!.data;
  check(a.length === b.length && a.every((v, i) => v === b[i]) && own.dest === 1 && own.size === 2, 'the copy has the file\'s bytes and place');
  check(same(screen(4), before) && !submapBorderFile(rom, 4).others.length, 'and shows the same border, used by no one else');
  // painting it leaves Forest of Illusion's
  const fo = screen(3), r = load(4), map = submapLayer3(rom, 4, r.vram);
  map[owLayer3Grid(r).entry(3, 10)] = PAINT;
  saveSubmapLayer3(rom, 4, map);
  check(same(screen(3), fo), 'painting it leaves Forest of Illusion\'s border');
  let refused = false;
  try { ownBorderFile(rom, 1); } catch (e) { refused = JSON.stringify(refusalOf(e)) === JSON.stringify({ kind: 'borderNoFile', map: 'Yoshi\'s Island' }); }
  check(refused, 'no own copy where there is no file (Yoshi\'s Island: the game\'s border)');
}

// another submap's border taken: Vanilla Dome shows Special World's (painted whole), the game's cells the game's
{
  const said = takeBorder(rom, 2, 5, load(5).vram);
  check(same(screen(2, false), screen(5, false)), `Vanilla Dome shows Special World's border (${said})`);
  check(same(screen(1), games[1]) && same(screen(6), games[6]), 'Yoshi\'s Island and Star World keep theirs');
}

// the game's border back
{
  resetBorder(rom, 2);
  check(levelLayer3(rom, submapGfxEntry(2)).lt3 === 0xff && submapBorderFile(rom, 2).file === null, 'reset: Vanilla Dome uses no file');
  check(same(screen(2), games[2]), 'and shows the game\'s border again');
}

// the screen behind the border: the game's screen after the load, layer 3 left out
{
  const fresh = new Rom(await editorImage()), loads = new OverworldLoads(new OverworldEmulator(fresh), 4);
  const f = owScreen(loads, 2, false);
  check(f.length === 256 * 224 && new Set(f).size > 16, `the screen: 256x224, ${new Set(f).size} colors`);
  const again = owScreen(new OverworldLoads(new OverworldEmulator(fresh), 4), 2, false);
  check(f.every((v, i) => v === again[i]), 'the same each time');
  const sp = owScreen(loads, 2, true);
  check(sp.some((v, i) => v !== f[i]), 'after the special world: its colors');
}

if (bad) { console.log(`\n${bad} FAILED`); process.exit(1); }
console.log('\nall ok');
