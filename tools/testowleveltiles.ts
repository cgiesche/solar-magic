// The overworld editor's Levels mode (owleveltiles.ts, ADR 0012) on the editor's test ROM: a level tile moved swaps
// with the tile where it is dropped (its translevel and settings with it, the path left whole), two level tiles swap;
// one removed leaves the stop tile 81 and its level without a level tile; one placed gets the look and translevel
// chosen, a look changed keeps the translevel. Each one ROM edit, undone in one step. The looks are the visible tiles
// the path kinds call "level" (56–80 without 5B, 5F), the stop tile the one Mario stops on.
// node tools/testowleveltiles.ts
import { Rom } from '../src/core/rom.ts';
import { RomEditSession } from '../src/core/romedit.ts';
import { readL1, readTranslevels, owTileWords, l1Index, l1XY, translevelToLevel, baseEvent, exitDirections } from '../src/core/overworld.ts';
import { levelTileTest } from '../src/core/owpaths.ts';
import { levelName } from '../src/core/levelnames.ts';
import { levelTileLooks, invisibleLevelTile, defaultLook, stopTile, levelsWithoutTile, moveLevelTile, removeLevelTile, placeLevelTile, STOP_TILE, DEFAULT_LOOK } from '../src/core/owleveltiles.ts';
import { editorImage, pathKinds } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const hx = (v: number) => v.toString(16).toUpperCase();
const same = (a: ArrayLike<number>, b: ArrayLike<number>) => a.length === b.length && Array.from(a).every((v, i) => v === b[i]);
const range = (a: number, b: number) => Array.from({ length: b - a }, (_, k) => a + k);

const image = await editorImage();
const kinds = pathKinds(new Rom(image.slice()));
const isLevel = levelTileTest(kinds);
const fresh = () => { const rom = new Rom(image.slice()); return { rom, s: new RomEditSession(rom) }; };

// ---- the looks, the stop tile, the default look ----
{
  const { rom } = fresh();
  const looks = levelTileLooks(rom, kinds);
  const zero = owTileWords(rom, 0).join(), drawn = (t: number) => owTileWords(rom, t).join() !== zero;
  const level = range(0x56, 0x81).filter((t) => kinds[t] === 'level');
  check(same(level, range(0x56, 0x81).filter((t) => t !== 0x5b && t !== 0x5f)), 'the level tiles of page 0: 56–80 without 5B, 5F');
  check(same(looks, level.filter(drawn)) && looks.includes(0x56) && looks.length >= 20, `the looks: the visible ones of them (${looks.map(hx).join(' ')})`);
  const inv = invisibleLevelTile(rom, kinds);
  check(inv === level.find((t) => !drawn(t)) && inv > 0, `the invisible look (a level drawn on layer 2): the first level tile drawn as 000 (${hx(inv)})`);
  check(range(0x156, 0x181).some((t) => kinds[t] === 'level') && looks.every((t) => t < 0x100), 'page 1\'s level tiles (invisible copies of 000) are no looks');
  check(stopTile(kinds) === STOP_TILE && kinds[STOP_TILE] === 'stop', 'the stop tile: 81, a tile Mario stops on');
  const k2 = kinds.slice(); k2[STOP_TILE] = 'walk';
  check(stopTile(k2) === k2.indexOf('stop') && k2.indexOf('stop') !== STOP_TILE, '81 doing something else: the first tile Mario stops on');
  check(defaultLook(looks) === DEFAULT_LOOK && defaultLook([0x60, 0x61]) === 0x60, 'the default look: 56, else the first look');
}

// a main map level tile with a walk path tile beside it (right, left, below, above)
const l1 = readL1(new Rom(image.slice())), tls0 = readTranslevels(new Rom(image.slice()));
let from = -1, to = -1;
for (let i = 0; i < 0x400 && from < 0; i++) {
  if (!isLevel(l1[i]) || !tls0[i]) continue;
  const { x, y } = l1XY(i);
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const j = l1Index(0, x + dx, y + dy);
    if (x + dx >= 0 && x + dx < 32 && y + dy >= 0 && y + dy < 32 && kinds[l1[j]] === 'walk') { from = i; to = j; break; }
  }
}
check(from >= 0, `a level tile with a path beside it (${hx(from)} → ${hx(to)})`);

// ---- move: one cell along the path ----
{
  const { rom, s } = fresh();
  const before = rom.data.slice(), tl = tls0[from], name = levelName(rom, tl), ev = baseEvent(rom, tl), dirs = exitDirections(rom, tl).join();
  s.edit('move', () => moveLevelTile(rom, from, to), { key: null });
  const m1 = readL1(rom), t1 = readTranslevels(rom);
  check(m1[to] === l1[from] && t1[to] === tl, `moved: the level tile and translevel ${hx(tl)} (level ${hx(translevelToLevel(tl))}) at the new cell`);
  check(m1[from] === l1[to] && t1[from] === 0, 'moved: the path tile where the level tile was (the path whole), no translevel');
  check(levelName(rom, tl) === name && baseEvent(rom, tl) === ev && exitDirections(rom, tl).join() === dirs, 'moved: the level\'s settings with it (they are the translevel\'s)');
  check(m1.every((v, i) => i === from || i === to || v === l1[i]) && t1.every((v, i) => i === from || i === to || v === tls0[i]), 'moved: no other cell changed');
  check(s.history.undoStack.length === 1, 'moved: one ROM edit');
  s.undo();
  check(same(rom.data, before), 'moved: undo restores the ROM');
}

// ---- move: onto another level tile, the two swap ----
{
  const { rom } = fresh();
  const other = range(0, 0x400).find((i) => i !== from && isLevel(l1[i]) && tls0[i] && tls0[i] !== tls0[from])!;
  moveLevelTile(rom, from, other);
  const m1 = readL1(rom), t1 = readTranslevels(rom);
  check(m1[other] === l1[from] && t1[other] === tls0[from] && m1[from] === l1[other] && t1[from] === tls0[other], 'dropped on another level tile: the two swap with their translevels');
}

// ---- remove ----
{
  const { rom, s } = fresh();
  const before = rom.data.slice(), tl = tls0[from], name = levelName(rom, tl);
  check(!levelsWithoutTile(tls0).includes(tl), 'before: the level has a level tile');
  s.edit('remove', () => removeLevelTile(rom, from, stopTile(kinds)), { key: null });
  const m1 = readL1(rom), t1 = readTranslevels(rom);
  check(m1[from] === STOP_TILE && t1[from] === 0, 'removed: stop tile 81 in its place, no translevel');
  check(levelsWithoutTile(t1).includes(tl) && levelName(rom, tl) === name, 'removed: the level is without a level tile, its settings kept');
  s.undo();
  check(same(rom.data, before), 'removed: undo restores the ROM');
}

// ---- place, look ----
{
  const { rom, s } = fresh();
  const free = levelsWithoutTile(tls0);
  check(free.length > 0 && free.every((tl) => tl >= 1 && tl <= 0x5f && !tls0.includes(tl)), `levels without a level tile: translevels no tile holds (${free.length})`);
  const held = range(0, 0x800).filter((i) => tls0[i] && !isLevel(l1[i]));
  check(held.length > 0 && held.every((i) => !free.includes(tls0[i])), `a translevel held by a tile not a level tile before events (5F cells an event reveals) is not without a level tile (${held.map(hx).join(' ')})`);
  const tl = free[0], at = to; // (a path cell)
  const before = rom.data.slice();
  s.edit('place', () => placeLevelTile(rom, at, 0x5a, tl), { key: null });
  check(readL1(rom)[at] === 0x5a && readTranslevels(rom)[at] === tl && !levelsWithoutTile(readTranslevels(rom)).includes(tl), `placed: tile 5A entering translevel ${hx(tl)}`);
  s.edit('look', () => placeLevelTile(rom, at, 0x60, readTranslevels(rom)[at]), { key: null });
  check(readL1(rom)[at] === 0x60 && readTranslevels(rom)[at] === tl, 'look changed: the tile only, the translevel kept');
  check(s.history.undoStack.length === 2, 'place and look: a ROM edit each');
  s.undo(); s.undo();
  check(same(rom.data, before), 'undone: as before');
}

if (bad) { console.log(`${bad} failed`); process.exit(1); }
console.log('all ok');
