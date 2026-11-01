// Translevels stored per tile in Lunar Magic's table (overworld.ts, ADR 0005): the patched clean game enters every
// level from the same tile as before (by emulation, over all level tiles); placing a level tile anywhere changes no
// other tile's level, a new one gets a free translevel, one painted over frees its own, one moved keeps its own.
// A translevel's settings stay with its level: a new tile gets a free one that brings nothing along first, and the
// settings are reset only when asked.
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { RomEditSession } from '../src/core/romedit.ts';
import {
  OverworldEmulator, readL1, writeL1, readTranslevels, writeTranslevels, hasTranslevelTable,
  placeTile, freeTranslevel, sharedTranslevels, translevelUse, resetTranslevel, baseEvent,
  exitDirections, translevelToLevel, BASE_EVENTS, NO_EVENT, OW_EVENTS,
} from '../src/core/overworld.ts';
import { hasMessages } from '../src/core/messages.ts';
import { levelName, levelNameTiles, setLevelNameTiles, hasLevelName, encodeName } from '../src/core/levelnames.ts';
import { L1_PTRS } from '../src/core/level.ts';
import { GM, RAM } from '../src/core/ram.ts';
import { cleanImage, editorImage, levelTiles } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const same = (a: ArrayLike<number>, b: ArrayLike<number>) => a.length === b.length && Array.from(a).every((v, i) => v === b[i]);
const hx = (v: number) => v.toString(16).toUpperCase();

const clean = new Rom(cleanImage());
const image = await editorImage();
const patched = new Rom(image.slice());
const isLevelTile = levelTiles(patched); // (learned as the editor learns it)
// the translevel the clean game gives each tile (its scan, $7ED000 after loading the overworld)
const gameTranslevels = (rom: Rom) => new OverworldEmulator(rom).load(0, 0).wram.slice(RAM.owTranslevels, RAM.owTranslevelsEnd);
const cleanTl = gameTranslevels(clean);
const tiles = [...cleanTl.keys()].filter((i) => cleanTl[i]);

// ---- the table ----
check(!hasTranslevelTable(clean) && hasTranslevelTable(patched), 'the clean game scans, the patched one has the table');
check(same(readTranslevels(patched), cleanTl), `every level tile has the translevel the game's scan gives it (${tiles.length} tiles)`);

// ---- by emulation: the overworld's translevels and flags per tile, without and after all events ----
{
  const a = new OverworldEmulator(clean), b = new OverworldEmulator(patched);
  for (const all of [false, true]) {
    const ra = a.load(0, all ? OW_EVENTS : 0), rb = b.load(0, all ? OW_EVENTS : 0);
    const part = (r: { wram: Uint8Array }) => r.wram.subarray(RAM.owLayer1, RAM.owTileFlagsEnd);
    check(ra.ok && rb.ok && same(part(ra), part(rb)), `overworld ${all ? 'with every event passed' : 'of a new game'}: layer 1, translevels ($7ED000) and flags ($7ED800) as in the clean game`);
  }
}

// the translevel ($13BF) the game enters from tile i (A pressed on it); null: none entered
function enter(emu: LevelEmulator, i: number): number | null {
  emu.startGameAt(i);
  const s = emu.snes, w = s.wram;
  for (let f = 0; f < 400; f++) {
    s.joy1 = f % 8 < 2 ? 0x0080 : 0;
    s.runFrame();
    if (w[RAM.gameMode] === GM.levelLoad) {
      s.joy1 = 0;
      return w[RAM.translevel];
    }
  }
  s.joy1 = 0;
  return null;
}
{
  const ea = new LevelEmulator(clean), eb = new LevelEmulator(patched);
  const differ: string[] = [];
  let entered = 0;
  for (const i of tiles) {
    const a = enter(ea, i), b = enter(eb, i);
    if (a) entered++;
    if (a !== b) differ.push(`${hx(i)}: ${a === null ? '-' : hx(a)} / ${b === null ? '-' : hx(b)}`);
  }
  check(!differ.length && entered === tiles.length, `every level tile enters the same translevel as in the clean game (${entered} of ${tiles.length} entered from a new game) ${differ.join(', ')}`);
}

// ---- placing level tiles ----
{
  const l1 = readL1(patched), t = readTranslevels(patched);
  const first = tiles[0], last = tiles[tiles.length - 1];
  // a new level tile before every other one
  const at = [...l1.keys()].find((i) => i < first && !isLevelTile(l1[i]))!;
  const before = t.slice(), free = freeTranslevel(t);
  placeTile(l1, t, at, 0x56, isLevelTile);
  check(free > 0 && t[at] === free && !cleanTl.includes(free), `a new level tile gets a free translevel (${hx(free)})`);
  check(tiles.every((i) => t[i] === before[i]), 'no other tile\'s translevel changed');
  // anywhere: a new level tile on every other tile changes no level tile's translevel
  const moving = [...l1.keys()].filter((i) => !isLevelTile(l1[i]) && i !== at).filter((i) => {
    const m = l1.slice(), n = before.slice();
    placeTile(m, n, i, 0x56, isLevelTile);
    return tiles.some((k) => n[k] !== before[k]);
  });
  check(!moving.length, `a new level tile on any of the ${0x800 - tiles.length} other tiles changes no other level tile (${moving.length})`);
  // painted over: freed
  placeTile(l1, t, at, 0x00, isLevelTile);
  check(t[at] === 0 && freeTranslevel(t) === free, 'a level tile painted over: its translevel free again');
  // another level tile painted over a level tile: keeps its translevel
  placeTile(l1, t, last, l1[last] === 0x56 ? 0x57 : 0x56, isLevelTile);
  check(t[last] === cleanTl[last], 'a level tile painted over a level tile keeps its translevel');
  // moved: picked up with its translevel, placed elsewhere (both enter it), then the old one painted over
  const mv = tiles[3], to = [...l1.keys()].find((i) => i > last && !isLevelTile(l1[i]))!;
  placeTile(l1, t, to, l1[mv], isLevelTile, t[mv]);
  check(sharedTranslevels(l1, t, isLevelTile).get(cleanTl[mv])?.join() === `${mv},${to}`, 'picked up and placed: two tiles enter its translevel (warned)');
  placeTile(l1, t, mv, 0x00, isLevelTile);
  check(t[to] === cleanTl[mv] && !sharedTranslevels(l1, t, isLevelTile).size, 'moved: the new tile keeps the translevel, the old one has none');

  // as a ROM edit: written, read back, undone; the game enters the moved level from its new tile, and a new
  // level tile placed before the others changes no other tile's level (the clean game's scan would shift them)
  const rom = new Rom(image.slice()), s = new RomEditSession(rom);
  const was = rom.data.slice();
  placeTile(l1, t, at, 0x56, isLevelTile);
  s.edit('Paint layer 1', () => { writeL1(rom, l1); writeTranslevels(rom, t); });
  check(same(readTranslevels(rom), t) && same(readL1(rom), l1), 'written and read back');
  const e = new LevelEmulator(rom);
  const moved = enter(e, to), other = enter(e, first), added = enter(e, at);
  check(moved === cleanTl[mv], `the game enters translevel ${hx(cleanTl[mv])} from the moved tile (${moved === null ? "-" : hx(moved)})`);
  check(other === cleanTl[first], `the game enters translevel ${hx(cleanTl[first])} from the first level tile as before (${other === null ? "-" : hx(other)})`);
  check(added === free, `the game enters the new tile's translevel ${hx(free)} (${added === null ? "-" : hx(added)})`);
  const scanned = new Rom(cleanImage());
  writeL1(scanned, l1);
  check(gameTranslevels(scanned)[first] !== cleanTl[first], '(the clean game\'s scan shifts it, emulated)');
  s.undo();
  check(same(rom.data, was), 'undone');
  // unchanged: nothing written
  const gen = rom.gen;
  writeTranslevels(rom, readTranslevels(rom));
  check(rom.gen === gen, 'an unchanged table: nothing written');
}

// ---- a translevel's settings ----
{
  const rom = new Rom(image.slice()), s = new RomEditSession(rom);
  const use = (tl: number) => translevelUse(rom, tl);
  const free = [0x5d, 0x5e, 0x5f];
  check(free.every((tl) => !cleanTl.includes(tl) && use(tl) === 0), 'the clean game\'s free translevels (139–13B) bring nothing along');
  check(levelName(rom, 0x5d) === '(no name)' && !hasLevelName(rom, 0x5d), 'the game\'s name $FFFF (RAM shown as letters): no name');
  check(tiles.every((i) => use(cleanTl[i]) > 0), 'every entered level has settings or data of its own');
  // painted over: its level keeps its settings, a new tile prefers one that brings nothing
  const l1 = readL1(rom), t = readTranslevels(rom), del = tiles[0], tl = t[del];
  const name = levelNameTiles(rom, tl).join(), ev = baseEvent(rom, tl);
  placeTile(l1, t, del, 0x00, isLevelTile, 0, use);
  s.edit('Paint layer 1', () => { writeL1(rom, l1); writeTranslevels(rom, t); });
  check(levelNameTiles(rom, tl).join() === name && baseEvent(rom, tl) === ev && use(tl) === 2, `painted over: level ${hx(translevelToLevel(tl))} keeps its name and base event`);
  check(freeTranslevel(t) === tl && freeTranslevel(t, use) === 0x5d, `a new tile gets 5D, not the lower ${hx(tl)} with a level`);
  // the order: nothing, then settings only, then a level of its own
  setLevelNameTiles(rom, 0x5d, encodeName('A NAME').tiles); rom.w8(BASE_EVENTS + 0x5e, 0x10);
  check(use(0x5d) === 1 && use(0x5e) === 1 && freeTranslevel(t, use) === 0x5f, 'a name or base event: 5F first');
  setLevelNameTiles(rom, 0x5f, encodeName('A NAME').tiles);
  check(freeTranslevel(t, use) === 0x5d, 'all with settings: the lowest of them before a level of its own');
  // reset: as the clean game's unused ones, the level's data stays
  const msg = [...Array(0x60).keys()].find((n) => n && cleanTl.includes(n) && hasMessages(rom, n))!;
  const l1Ptr = rom.r24(L1_PTRS + translevelToLevel(msg) * 3), was = rom.data.slice();
  s.edit('Reset', () => resetTranslevel(rom, msg));
  check(!hasLevelName(rom, msg) && baseEvent(rom, msg) === NO_EVENT && exitDirections(rom, msg).every((d) => d === 0) && !hasMessages(rom, msg),
    `reset ${hx(msg)}: no name, no base event, exits revealing up, no message box`);
  check(rom.r24(L1_PTRS + translevelToLevel(msg) * 3) === l1Ptr && use(msg) === 2, 'reset: the level\'s data stays');
  s.undo();
  check(same(rom.data, was), 'reset undone');
}

// ---- the table moves to free space when it outgrows its block ----
{
  const rom = new Rom(image.slice());
  const t = new Uint8Array(0x800);
  for (let i = 0; i < t.length; i++) t[i] = (i * 37) % 0x60; // (no runs)
  writeTranslevels(rom, t);
  check(same(readTranslevels(rom), t), 'a table larger than its block: moved, read back');
}

if (bad) { console.log(`${bad} failed`); process.exit(1); }
console.log('level tiles ok');
