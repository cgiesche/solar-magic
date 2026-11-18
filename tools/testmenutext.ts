// The menus' texts (menutext.ts): each menu's stripe image found by what the game writes to VRAM (the clean game's
// addresses, here only to check), the cursor's cells and the cells the game writes over learned from the emulated
// game, a cell painted in place and shown by the game, a run painted as one, a menu drawn without a stripe image.
import { Rom, snesToPc } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { reachScreens, gameScreens, screenPicture, type GameScreenId } from '../src/core/pregame.ts';
import { learnMenuText, menuText, paintMenuCell, paintedOverwritten, writeMenuText, MENU_COLS, type MenuText } from '../src/core/menutext.ts';
import { editorImage } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const base = await editorImage();
const fresh = () => new Rom(base.slice());
const same = (a: ArrayLike<number>, b: ArrayLike<number>) => a.length === b.length && Array.from(a).every((x, i) => x === b[i]);
const cell = (vram: number) => vram - 0x5000;
const cells = (m: Uint8Array) => [...m].flatMap((v, c) => (v ? [c] : []));
const hex = (n: number) => n.toString(16);

// the clean game's menus: stripe image, its length, the cursor's first place, its choices
const MENUS: [GameScreenId, number, number, number, number][] = [
  ['fileSelect', 0x05b7c9, 169, 0x51e8, 4],
  ['fileErase', 0x05b6fe, 203, 0x51e5, 4],
  ['playerSelect', 0x05b872, 85, 0x5208, 2],
  ['savePrompt', 0x05b8c7, 85, 0x51c4, 2],
  ['gameOverPrompt', 0x05b91c, 31, 0x51cb, 2],
];

{
  const rom = fresh(), emu = new LevelEmulator(rom), screens = reachScreens(emu), texts = new Map<GameScreenId, MenuText>();
  for (const [id, addr, length, cursor, choices] of MENUS) {
    const s = screens.find((x) => x.id === id)!, t0 = Date.now(), t = learnMenuText(emu, s, screens), ms = Date.now() - t0;
    if (!t) { check(false, `${id}: a stripe image found`); continue; }
    texts.set(id, t);
    check(t.addr === snesToPc(addr) && t.length === length, `${id}: its stripe image found at $${hex(addr)}, ${length} bytes (${ms} ms; at ${hex(t.addr)}, ${t.length})`);
    check(same(t.cursor, Array.from({ length: choices }, (_, k) => cell(cursor) + k * 64)), `${id}: the cursor's ${choices} cells, from $${hex(cursor)} down`);
    check(same(t.map, Array.from({ length: t.map.length }, (_, c) => { const v = s.state.vram as Uint8Array; return v[(0x5000 + c) * 2] | (v[(0x5000 + c) * 2 + 1] << 8); })), `${id}: the tilemap as the screen shows it`);
    const off = t.source.filter((o) => o >= 0);
    check(off.length > 0 && off.every((o) => o >= t.addr + 4 && o < t.addr + t.length - 1), `${id}: every cell of the image shows a word of it (${off.length} cells)`);
  }
  // the file select: over the image the game writes the cursor's column (where the image covers it) and, per file,
  // the exit count's two cells and the three cells left of "EMPTY" – the clean game's rows at $51E0, $5220, $5260
  {
    const t = texts.get('fileSelect')!, w = cells(t.written);
    const cursor = t.cursor.filter((c) => t.source[c] >= 0);
    const rows = [0x51e0, 0x5220, 0x5260].map((r) => w.filter((c) => c >= cell(r) && c < cell(r) + 32 && !t.cursor.includes(c)));
    console.log(`  (written over: ${w.map((c) => '$' + hex(c + 0x5000)).join(' ')})`);
    check(rows.every((r) => r.length === 5 && r[4] - r[0] === 4) && rows[1][0] - rows[0][0] === 64 && w.length === 15 + cursor.length,
      'file select: per file the five cells of the exit count and the blanked "EMPTY" are written over, and the cursor\'s cells in the image');
    check(same(t.cursor.map((c) => t.written[c]), t.cursor.map((c) => +(t.source[c] >= 0))), 'file select: the cursor\'s cells of the image count as written over');
    // a run (the blank rows of the image): painted as one
    const run = t.shared.findIndex((v, c) => v === 1 && !t.written[c]), map = t.map.slice();
    const mates = [...t.source].flatMap((o, c) => (o === t.source[run] ? [c] : []));
    check(run >= 0 && mates.length > 1 && paintMenuCell(t, map, run, 0x3971) && mates.every((c) => map[c] === 0x3971) && map.filter((v, c) => v !== t.map[c]).length === mates.length,
      `file select: a cell of a run painted paints the run's ${mates.length} cells`);
    check(!paintMenuCell(t, map, 0, 0x3d2e) && t.source[0] < 0, 'file select: a cell that is not of the image is not painted');
  }
  // the prompts and the player select: nothing written over but the cursor's cells the image covers
  for (const id of ['playerSelect', 'savePrompt', 'gameOverPrompt'] as const) {
    const t = texts.get(id)!;
    check(cells(t.written).every((c) => t.cursor.includes(c)), `${id}: only the cursor is written over the image (${cells(t.written).length} cells)`);
  }

  // painted in place: the word in the ROM, the image as long as before, the game shows it
  {
    const t = texts.get('fileSelect')!, map = t.map.slice();
    const c = t.source.findIndex((o, i) => o >= 0 && !t.shared[i] && !t.written[i]);
    check(paintMenuCell(t, map, c, 0x3d2e) && !paintMenuCell(t, map, c, 0x3d2e), 'a cell painted; painted again with the same word: no change');
    check(paintedOverwritten(t, map).length === 0, 'no warning for a cell the game leaves alone');
    const over = cells(t.written).find((x) => !t.cursor.includes(x))!;
    paintMenuCell(t, map, over, 0x3d2e);
    check(same(paintedOverwritten(t, map), [over]), 'a painted cell the game writes over is told');
    const before = rom.data.slice();
    const n = writeMenuText(rom, t, map);
    const diff = [...rom.data].flatMap((v, o) => (v !== before[o] ? [o] : []));
    check(n === 2 && diff.length > 0 && diff.every((o) => o >= t.addr && o < t.addr + t.length) && rom.data[t.source[c]] === 0x2e && rom.data[t.source[c] + 1] === 0x3d,
      `written in place: ${n} words, only bytes of the image changed (${diff.length})`);
    const again = gameScreens(emu), fs = again.find((x) => x.id === 'fileSelect')!, t2 = menuText(emu, fs, again)!;
    check(t2.map[c] === 0x3d2e && t2.addr === t.addr && t2.length === t.length, 'the game shows the painted cell; the image is where and as long as it was');
    check(menuText(emu, fs, again) === t2, 'kept: asked again, the same');
    // the picture with a painted tilemap: the painted cell's pixels change, where the game's layer 3 scroll has it
    const p0 = screenPicture(emu, fs.state), m2 = t2.map.slice();
    m2[c] = 0x38fc;
    const p1 = screenPicture(emu, fs.state, m2), ch = [...p0.frame].flatMap((v, i) => (v !== p1.frame[i] ? [i] : []));
    const x0 = (((c % MENU_COLS) * 8 - p0.l3Scroll.x) & 0xff), y0 = ((Math.floor(c / MENU_COLS) * 8 - p0.l3Scroll.y) & 0xff);
    check(ch.length > 0 && ch.every((i) => i % 256 >= x0 && i % 256 < x0 + 8 && Math.floor(i / 256) >= y0 && Math.floor(i / 256) < y0 + 8),
      `the picture with a painted cell changes in that cell only (layer 3 scrolled ${p0.l3Scroll.x}, ${p0.l3Scroll.y})`);
  }
}

// a menu the game draws without a stripe image: the player select's upload skipped (its stripe image's first byte
// ends it) – no menu text, no error
{
  const rom = fresh();
  rom.writeAt(snesToPc(0x05b872), Uint8Array.from([0xff]));
  const emu = new LevelEmulator(rom), screens = reachScreens(emu), s = screens.find((x) => x.id === 'playerSelect');
  check(!!s && learnMenuText(emu, s, screens) === null, 'a player select that draws no stripe image: no menu text');
}

if (bad) { console.log(`${bad} FAILED`); process.exit(1); }
console.log('all ok');
